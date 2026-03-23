const DEFAULT_SERVER_IP = '10.126.126.10:5000';
const invoke = window.__TAURI__?.core?.invoke
    ? (...args) => window.__TAURI__.core.invoke(...args)
    : async () => { throw new Error('Tauri invoke 不可用，请在 Tauri 环境运行'); };

let room;
let currentChannel = null;
let isInLobby = false;
let channels = ['day0', 'day1', 'day2'];
const channelParticipants = {};
let roomPollTimer = null;
let isMicOn = false;
let isScreenOn = false;
const userVolumes = {}; 
let screenBitrateMonitorTimer = null;
let lastScreenOutboundStats = null;
let currentScreenTargetBitrate = 0;
const localScreenControls = {};
let currentLocalScreenTrack = null;
let remoteAudioContext = null;
let localPcmAudioContext = null;
let localPcmWorkletNode = null;
let localPcmDestination = null;
let localPcmTrack = null;
let localPcmSocket = null;
let isLocalPcmPipelineReady = false;
let localAppAudioPublication = null;
let isAppAudioSharing = false;
const selectedAppAudioPids = new Set();
const remoteAudioGainNodes = {};
const activeSpeakerIdentities = new Set();
const activeSpeakerDebounceTimers = {};
const ACTIVE_SPEAKER_LEVEL_THRESHOLD = 0.05;  // 音频能量水平阈值，超过则认为是活跃说话者
const ACTIVE_SPEAKER_DEBOUNCE_MS = 100;        // 活跃说话者状态的防抖时间，避免频繁闪烁
let selectedAudioOutputId = localStorage.getItem('lk_audio_output') || 'default';

function clearActiveSpeakerDebounceTimers() {
    Object.keys(activeSpeakerDebounceTimers).forEach((identity) => {
        clearTimeout(activeSpeakerDebounceTimers[identity]);
        delete activeSpeakerDebounceTimers[identity];
    });
}

function markParticipantAsActiveSpeaker(identity) {
    if (!identity) return false;
    if (activeSpeakerDebounceTimers[identity]) {
        clearTimeout(activeSpeakerDebounceTimers[identity]);
        delete activeSpeakerDebounceTimers[identity];
    }
    if (activeSpeakerIdentities.has(identity)) return false;
    activeSpeakerIdentities.add(identity);
    return true;
}

function scheduleParticipantActiveSpeakerOff(identity) {
    if (!identity || !activeSpeakerIdentities.has(identity)) return;
    if (activeSpeakerDebounceTimers[identity]) return;

    activeSpeakerDebounceTimers[identity] = setTimeout(() => {
        delete activeSpeakerDebounceTimers[identity];
        const changed = activeSpeakerIdentities.delete(identity);
        if (changed) updateParticipantList();
    }, ACTIVE_SPEAKER_DEBOUNCE_MS);
}

function normalizeGainValue(rawValue) {
    const n = Number(rawValue);
    if (!Number.isFinite(n)) return 1;
    // Support both legacy 0~3 and current 0~300 slider formats.
    const gain = n > 3 ? (n / 100) : n;
    return Math.max(0, Math.min(gain, 3));
}

function gainToPercent(gain) {
    return Math.round(Math.max(0, Math.min(gain, 3)) * 100);
}

function isScreenShareSource(source) {
    return source === LivekitClient.Track.Source.ScreenShare || source === 'screen_share';
}

function removeLocalScreenRestoreCard(identity) {
    const card = document.getElementById(`screen-restore-${identity}`);
    if (card) card.remove();
}

function upsertLocalScreenRestoreCard(identity, displayName) {
    let card = document.getElementById(`screen-restore-${identity}`);
    if (!card) {
        card = document.createElement('div');
        card.className = 'screen-restore-card';
        card.id = `screen-restore-${identity}`;
        document.getElementById('video-container').appendChild(card);
    }

    card.innerHTML = `
        <div>${displayName} 的屏幕已在本地屏蔽</div>
        <button onclick="toggleLocalScreenSubscription('${identity}')">恢复屏幕</button>
    `;
}

async function toggleLocalScreenSubscription(identity) {
    const state = localScreenControls[identity];
    if (!state || !state.publication) return;

    try {
        if (!state.isBlocked) {
            await state.publication.setSubscribed(false);
            state.isBlocked = true;
            upsertLocalScreenRestoreCard(identity, state.displayName || identity);
        } else {
            await state.publication.setSubscribed(true);
            state.isBlocked = false;
            removeLocalScreenRestoreCard(identity);
        }
    } catch (e) {
        console.error('切换本地屏幕订阅状态失败:', e);
        alert('操作失败，请稍后重试。');
    }
}

// DOM加载完毕后恢复本地设置
document.addEventListener('DOMContentLoaded', () => {
    const savedUser = localStorage.getItem('lk_username');
    if (savedUser) document.getElementById('username').value = savedUser;

    const savedServerIp = localStorage.getItem('lk_server_ip');
    document.getElementById('server-ip').value = savedServerIp || DEFAULT_SERVER_IP;

    renderChannelList();
    updateAudioOutputList();
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function startCaptureWithRetry(pid, maxAttempts = 8, intervalMs = 150) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await invoke('start_capture', { pid });
        } catch (error) {
            lastError = error;
            const message = String(error?.message || error || '');
            const isChannelNotReady = message.includes('channel closed');
            if (!isChannelNotReady || attempt === maxAttempts) break;
            await sleep(intervalMs);
        }
    }
    throw lastError || new Error('start_capture 失败');
}

async function startCaptureMultiWithRetry(pids, maxAttempts = 8, intervalMs = 150) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await invoke('start_capture_multi', { pids });
        } catch (error) {
            lastError = error;
            const message = String(error?.message || error || '');
            const isChannelNotReady = message.includes('channel closed');
            if (!isChannelNotReady || attempt === maxAttempts) break;
            await sleep(intervalMs);
        }
    }
    throw lastError || new Error('start_capture_multi 失败');
}

function updateAppAudioButtons() {
    const shareBtn = document.getElementById('btn-app-audio');
    const stopBtn = document.getElementById('btn-stop-app-audio');
    if (!shareBtn || !stopBtn) return;

    const connected = !!(room && room.localParticipant);
    shareBtn.disabled = !connected || isAppAudioSharing;
    stopBtn.disabled = !connected || !isAppAudioSharing;

    if (isAppAudioSharing) {
        shareBtn.classList.add('active');
        shareBtn.innerHTML = '🎵 <span>正在共享应用音频</span>';
    } else {
        shareBtn.classList.remove('active');
        shareBtn.innerHTML = '🎵 <span>共享应用音频</span>';
    }
}

function closeAppAudioModal(event) {
    if (event && event.target && event.target.id !== 'app-audio-modal') return;
    const modal = document.getElementById('app-audio-modal');
    if (modal) modal.classList.add('hidden');
    selectedAppAudioPids.clear();
}

async function openAppAudioModal() {
    if (!room || !room.localParticipant) {
        alert('请先进入语音分组后再共享应用音频。');
        return;
    }

    const modal = document.getElementById('app-audio-modal');
    const listEl = document.getElementById('app-audio-process-list');
    if (!modal || !listEl) return;

    modal.classList.remove('hidden');
    listEl.innerHTML = '<div class="modal-empty">正在扫描活跃进程...</div>';

    try {
        const processes = await invoke('get_active_processes');
        const rows = (Array.isArray(processes) ? processes : []).filter((p) => {
            const name = (p?.name || '').trim();
            return name.length > 0;
        });

        if (rows.length === 0) {
            listEl.innerHTML = '<div class="modal-empty">未发现可用进程，请先启动目标应用后重试。</div>';
            return;
        }

        listEl.innerHTML = rows.map((p) => {
            const safeName = sanitizeText(p.name);
            const pid = Number(p.pid) || 0;
            const mem = Number(p.memory_mb) || 0;
            return `
                <button id="process-item-${pid}" class="process-item" onclick="toggleAppAudioProcessSelection(${pid})" title="选择 ${safeName}">
                    <span class="process-name">${safeName}</span>
                    <span class="process-meta">PID ${pid} · ${mem} MB</span>
                </button>
            `;
        }).join('');
    } catch (error) {
        console.error('获取活跃进程失败:', error);
        listEl.innerHTML = `<div class="modal-empty">获取进程列表失败：${sanitizeText(error?.message || String(error))}</div>`;
    }
}

function toggleAppAudioProcessSelection(pid) {
    if (!Number.isFinite(pid) || pid <= 0) return;
    const item = document.getElementById(`process-item-${pid}`);
    if (selectedAppAudioPids.has(pid)) {
        selectedAppAudioPids.delete(pid);
        if (item) item.classList.remove('selected');
    } else {
        selectedAppAudioPids.add(pid);
        if (item) item.classList.add('selected');
    }
}

async function confirmAppAudioSelection() {
    const pids = Array.from(selectedAppAudioPids.values());
    if (pids.length === 0) {
        alert('请至少选择一个应用进程。');
        return;
    }

    if (!room || !room.localParticipant) {
        alert('房间未连接，无法共享应用音频。');
        return;
    }

    const listEl = document.getElementById('app-audio-process-list');
    if (listEl) {
        listEl.innerHTML = '<div class="modal-empty">正在启动多应用音频截流并发布轨道，请稍候...</div>';
    }

    try {
        if (localAppAudioPublication) {
            try {
                await room.localParticipant.unpublishTrack(localAppAudioPublication.track);
            } catch (_) {}
            localAppAudioPublication = null;
        }

        const realSampleRate = pids.length === 1
            ? await startCaptureWithRetry(pids[0])
            : await startCaptureMultiWithRetry(pids);

        const track = await initLocalPcmPipeline(realSampleRate);
        if (!track) throw new Error('未拿到 localPcmTrack');

        await sleep(500);

        localAppAudioPublication = await room.localParticipant.publishTrack(track, { name: 'app-audio' });
        isAppAudioSharing = true;
        updateAppAudioButtons();
        closeAppAudioModal();
    } catch (error) {
        console.error('共享应用音频失败:', error);
        alert(`共享应用音频失败：${error?.message || error}`);
        isAppAudioSharing = false;
        updateAppAudioButtons();
    }
}

async function stopAppAudioShare() {
    try {
        if (room && room.localParticipant && localAppAudioPublication) {
            await room.localParticipant.unpublishTrack(localAppAudioPublication.track);
        }
    } catch (error) {
        console.warn('停止应用音频发布失败:', error);
    } finally {
        localAppAudioPublication = null;
        isAppAudioSharing = false;
        teardownLocalPcmPipeline();
        closeAppAudioModal();
        updateAppAudioButtons();
    }
}

function normalizeServerInput(rawValue) {
    let val = (rawValue || '').trim();
    if (!val) return DEFAULT_SERVER_IP;
    val = val.replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '');
    val = val.replace(/\/$/, '');
    return val;
}

function getServerConfig() {
    const inputEl = document.getElementById('server-ip');
    const normalized = normalizeServerInput(inputEl ? inputEl.value : '');

    // token服务默认走输入端口；LiveKit默认在同IP下7880
    let host = normalized;
    let apiPort = '5000';

    if (normalized.includes(':')) {
        const parts = normalized.split(':');
        host = parts[0];
        apiPort = parts[1] || '5000';
    }

    const apiBase = `http://${host}:${apiPort}`;
    const livekitWs = `ws://${host}:7880`;
    return { apiBase, livekitWs, persistValue: `${host}:${apiPort}` };
}

function ensureAudioContext() {
    if (!remoteAudioContext) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) remoteAudioContext = new Ctx();
    }
    if (remoteAudioContext && remoteAudioContext.state === 'suspended') {
        remoteAudioContext.resume().catch(() => {});
    }
    return !!remoteAudioContext;
}

function getLocalPcmTrack() {
    return localPcmTrack;
}

async function initLocalPcmPipeline(sampleRate) {
    const targetSampleRate = Number(sampleRate);
    const resolvedSampleRate = Number.isFinite(targetSampleRate) && targetSampleRate >= 8000
        ? Math.round(targetSampleRate)
        : 48000;

    if (isLocalPcmPipelineReady && localPcmAudioContext) {
        const currentRate = Number(localPcmAudioContext.sampleRate || 0);
        if (Math.round(currentRate) === resolvedSampleRate) {
            return localPcmTrack;
        }
        teardownLocalPcmPipeline();
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
        console.warn('当前环境不支持 AudioContext，无法初始化 PCM 管线');
        return null;
    }

    try {
        localPcmAudioContext = new Ctx({ sampleRate: resolvedSampleRate });
        await localPcmAudioContext.audioWorklet.addModule('./pcm-worker.js');

        localPcmWorkletNode = new AudioWorkletNode(localPcmAudioContext, 'pcm-ring-buffer-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
                capacityFrames: resolvedSampleRate * 10
            }
        });

        localPcmDestination = localPcmAudioContext.createMediaStreamDestination();
        localPcmWorkletNode.connect(localPcmDestination);
        //localPcmWorkletNode.connect(localPcmAudioContext.destination);  这行代码是监听

        const tracks = localPcmDestination.stream.getAudioTracks();
        localPcmTrack = tracks.length > 0 ? tracks[0] : null;

        localPcmSocket = new WebSocket('ws://127.0.0.1:9001');
        localPcmSocket.binaryType = 'arraybuffer';

        localPcmSocket.onopen = () => {
            console.log('[PCM WS] 已连接 ws://127.0.0.1:9001');
        };

        localPcmSocket.onmessage = async (event) => {
            if (!localPcmWorkletNode) return;
            if (event.data instanceof ArrayBuffer) {
                localPcmWorkletNode.port.postMessage(event.data, [event.data]);
                return;
            }
            if (event.data instanceof Blob) {
                const arr = await event.data.arrayBuffer();
                localPcmWorkletNode.port.postMessage(arr, [arr]);
            }
        };

        localPcmSocket.onerror = (err) => {
            console.error('[PCM WS] 连接错误:', err);
        };

        localPcmSocket.onclose = () => {
            console.warn('[PCM WS] 连接已关闭');
        };

        window.getLocalPcmTrack = getLocalPcmTrack;
        isLocalPcmPipelineReady = true;
        console.log(`[PCM] 管线已初始化(sampleRate=${resolvedSampleRate})，可通过 window.getLocalPcmTrack() 获取 MediaStreamTrack`);

        return localPcmTrack;
    } catch (error) {
        console.error('[PCM] 管线初始化失败:', error);
        return null;
    }
}

function teardownLocalPcmPipeline() {
    if (localPcmSocket) {
        try { localPcmSocket.close(); } catch (_) {}
        localPcmSocket = null;
    }

    if (localPcmWorkletNode) {
        try { localPcmWorkletNode.disconnect(); } catch (_) {}
        localPcmWorkletNode = null;
    }

    localPcmDestination = null;
    localPcmTrack = null;

    if (localPcmAudioContext) {
        localPcmAudioContext.close().catch(() => {});
        localPcmAudioContext = null;
    }

    isLocalPcmPipelineReady = false;
}

function addRemoteGainNode(identity, source, track, audioEl) {
    const gain = userVolumes[identity] && userVolumes[identity][source] !== undefined ? userVolumes[identity][source] : 1;
    ensureAudioContext();
    if (!remoteAudioContext) {
        audioEl.volume = Math.max(0, Math.min(gain, 1));
        return;
    }

    const mediaTrack = track && track.mediaStreamTrack;
    if (!mediaTrack) return;

    try {
        const streamSource = remoteAudioContext.createMediaStreamSource(new MediaStream([mediaTrack]));
        const gainNode = remoteAudioContext.createGain();
        streamSource.connect(gainNode);
        gainNode.connect(remoteAudioContext.destination);

        audioEl.__gainAttached = true;
        audioEl.__gainNode = gainNode;
        audioEl.__streamSource = streamSource;
        audioEl.__trackSid = track.sid;
        gainNode.gain.value = gain;
    } catch (e) {
        audioEl.volume = Math.max(0, Math.min(gain, 1));
        return;
    }

    const key = `${identity}:${source}`;
    if (!remoteAudioGainNodes[key]) remoteAudioGainNodes[key] = [];
    remoteAudioGainNodes[key].push(audioEl);
}

function clearRemoteGainNodes() {
    Object.keys(remoteAudioGainNodes).forEach(key => {
        remoteAudioGainNodes[key].forEach((audioEl) => {
            try { audioEl.__streamSource && audioEl.__streamSource.disconnect(); } catch (_) {}
            try { audioEl.__gainNode && audioEl.__gainNode.disconnect(); } catch (_) {}
        });
        delete remoteAudioGainNodes[key];
    });
}

function removeRemoteAudioRouteByTrackSid(trackSid) {
    if (!trackSid) return;
    Object.keys(remoteAudioGainNodes).forEach((key) => {
        remoteAudioGainNodes[key] = remoteAudioGainNodes[key].filter((audioEl) => {
            if (audioEl.__trackSid !== trackSid) return true;
            try { audioEl.__streamSource && audioEl.__streamSource.disconnect(); } catch (_) {}
            try { audioEl.__gainNode && audioEl.__gainNode.disconnect(); } catch (_) {}
            return false;
        });
        if (remoteAudioGainNodes[key].length === 0) delete remoteAudioGainNodes[key];
    });
}

function renderChannelList() {
    const list = document.getElementById('channel-list');
    if (!list) return;
    list.innerHTML = channels.map(name => {
        const active = currentChannel === name ? 'active' : '';
        const escapedName = name.replace(/'/g, "\\'");
        const participants = Array.isArray(channelParticipants[name]) ? channelParticipants[name] : [];
        const participantsHTML = participants.length > 0
            ? participants.map(p => sanitizeText(p)).join('、')
            : '暂无在线成员';
        const participantsClass = participants.length > 0 ? 'channel-participants' : 'channel-participants empty';
        return `
            <div class="channel-row">
                <button class="channel-item ${active}" onclick="switchChannel('${escapedName}')"># ${sanitizeText(name)}</button>
                <div class="${participantsClass}">${participantsHTML}</div>
            </div>
        `;
    }).join('');
}

function sanitizeText(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function refreshRoomsFromServer() {
    const serverConfig = getServerConfig();
    const response = await fetch(`${serverConfig.apiBase}/api/rooms`);
    if (!response.ok) throw new Error(`获取房间失败: ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) return;

    const nextChannels = [];
    const nextParticipants = {};
    rows.forEach((row) => {
        const roomName = (row && row.name ? String(row.name) : '').trim();
        if (!roomName) return;
        nextChannels.push(roomName);
        nextParticipants[roomName] = Array.isArray(row.participants) ? row.participants : [];
    });

    if (nextChannels.length > 0) channels = nextChannels;

    Object.keys(channelParticipants).forEach((key) => delete channelParticipants[key]);
    Object.keys(nextParticipants).forEach((key) => {
        channelParticipants[key] = nextParticipants[key];
    });

    renderChannelList();
}

function startRoomPolling() {
    if (roomPollTimer) clearInterval(roomPollTimer);
    roomPollTimer = setInterval(() => {
        if (!isInLobby) return;
        refreshRoomsFromServer().catch((err) => {
            console.warn('轮询房间列表失败:', err);
        });
    }, 3000);
}

function stopRoomPolling() {
    if (roomPollTimer) {
        clearInterval(roomPollTimer);
        roomPollTimer = null;
    }
}

async function createChannel() {
    const value = prompt('输入新频道名（英文字母/数字/短横线）:');
    if (!value) return;
    const name = value.trim();
    if (!name) return;

    const serverConfig = getServerConfig();
    const action = {
        "action": "create_channel",
        "name": name
    };
    try {
        const response = await fetch(`${serverConfig.apiBase}/api/rooms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(action)
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.error || '创建房间失败');
        }
        await refreshRoomsFromServer();
        await switchChannel(name);
    } catch (e) {
        console.error('创建房间失败:', e);
        alert(e.message || '创建房间失败，请稍后重试。');
    }
}

function resetRoomUIAfterDisconnect() {
    document.getElementById('video-container').innerHTML = '';
    document.getElementById('audio-container').innerHTML = '';
    document.getElementById('participant-list').innerHTML = '<div style="font-size: 12px; color: #80848e; text-align: center; margin-top: 20px;">加入频道后显示在线人员</div>';
    document.getElementById('user-count').innerText = '0';
    document.getElementById('btn-mic').disabled = true;
    document.getElementById('mic-select').disabled = true;
    document.getElementById('audio-output-select').disabled = true;
    document.getElementById('btn-screen').disabled = true;
    document.getElementById('screen-res').disabled = true;
    document.getElementById('screen-fps').disabled = true;
    document.getElementById('screen-bitrate').disabled = true;
    document.getElementById('chat-input').disabled = true;
    document.getElementById('btn-send').disabled = true;
    document.getElementById('btn-app-audio').disabled = true;
    document.getElementById('btn-stop-app-audio').disabled = true;
    isMicOn = false;
    isScreenOn = false;
    isAppAudioSharing = false;
    localAppAudioPublication = null;
    clearActiveSpeakerDebounceTimers();
    activeSpeakerIdentities.clear();
    clearRemoteGainNodes();
    hideLocalScreenPreview();
    closeAppAudioModal();
}

function setParticipantVolume(identity, source, volumeValue) {
    ensureAudioContext();
    if (!userVolumes[identity]) {
        userVolumes[identity] = { mic: 1, screen: 1 };
    }
    userVolumes[identity][source] = normalizeGainValue(volumeValue);
    const key = `${identity}:${source}`;
    const gain = userVolumes[identity][source];
    const gains = remoteAudioGainNodes[key] || [];
    gains.forEach((audioEl) => {
        if (audioEl.__gainNode) audioEl.__gainNode.gain.value = gain;
    });

    // Fallback: if GainNode chain is unavailable, still allow native element volume control.
    document.querySelectorAll(`[data-audio-identity="${identity}"][data-audio-source="${source}"]`).forEach((audioEl) => {
        if (!audioEl.__gainAttached) {
            audioEl.volume = Math.max(0, Math.min(gain, 1));
        }
    });
}

function getMicCaptureOptions() {
    return {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
    };
}

function updateParticipantList() {
    const listEl = document.getElementById('participant-list');
    listEl.innerHTML = ''; 
    let count = 0;
    
    const renderUser = (p, isSelf) => {
        count++;
        const name = p.name || p.identity;
        const initial = name ? name.charAt(0).toUpperCase() : '?';
        const displayName = isSelf ? `${name} (我)` : name;
        const isSpeaking = activeSpeakerIdentities.has(p.identity);
        
        if (!userVolumes[p.identity]) {
            userVolumes[p.identity] = { mic: 1, screen: 1 };
        }
        
        let volumeControlsHTML = '';
        if (!isSelf) {
            const micVol = userVolumes[p.identity].mic;
            volumeControlsHTML += `<div style="display: flex; align-items: center; gap: 5px; font-size: 12px;"><span title="麦克风音量">🎤</span><input type="range" class="volume-slider" min="0" max="300" step="1" value="${gainToPercent(micVol)}" oninput="setParticipantVolume('${p.identity}', 'mic', this.value);this.nextElementSibling.innerText=this.value+'%'"><span style="width:38px; text-align:right; color:#b5bac1;">${gainToPercent(micVol)}%</span></div>`;
            
            const hasScreenAudio = Array.from(p.audioTrackPublications.values()).some(pub => pub.source === LivekitClient.Track.Source.ScreenShareAudio || pub.source === 'screen_share_audio');
            if (hasScreenAudio) {
                const screenVol = userVolumes[p.identity].screen;
                volumeControlsHTML += `<div style="display: flex; align-items: center; gap: 5px; font-size: 12px;"><span title="共享音量">💻</span><input type="range" class="volume-slider" min="0" max="300" step="1" value="${gainToPercent(screenVol)}" oninput="setParticipantVolume('${p.identity}', 'screen', this.value);this.nextElementSibling.innerText=this.value+'%'"><span style="width:38px; text-align:right; color:#b5bac1;">${gainToPercent(screenVol)}%</span></div>`;
            }
        }

        const isMicMuted = !p.isMicrophoneEnabled;
        const statusIcon = isMicMuted ? '<span style="color: #f23f42; font-size: 16px;" title="已闭麦">🔇</span>' : '<span style="color: #23a559; font-size: 16px;" title="已开麦">🎙️</span>';

        const userBottomHTML = volumeControlsHTML ? `<div class="user-bottom">${volumeControlsHTML}</div>` : '';

        return `
            <div class="user-item${isSpeaking ? ' active-speaker' : ''}">
                <div class="user-avatar">${initial}</div>
                <div class="user-info">
                    <div class="user-top">
                        <div class="user-name" title="${displayName}">${displayName} ${statusIcon}</div>
                        <div class="user-status"></div>
                    </div>
                    ${userBottomHTML}
                </div>
            </div>
        `;
    };
    
    if (room.localParticipant) listEl.innerHTML += renderUser(room.localParticipant, true);
    if (room.remoteParticipants) room.remoteParticipants.forEach(p => listEl.innerHTML += renderUser(p, false));
    document.getElementById('user-count').innerText = count;
}

async function updateMicList() {
    try {
        const devices = await LivekitClient.Room.getLocalDevices('audioinput');
        const selectEl = document.getElementById('mic-select');
        selectEl.innerHTML = ''; 
        if (devices.length === 0) { selectEl.innerHTML = '<option value="">未找到麦克风</option>'; return; }
        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `未知设备 (${device.deviceId.substring(0, 5)}...)`;
            selectEl.appendChild(option);
        });
        const savedMic = localStorage.getItem('lk_mic');
        if (savedMic && devices.some(d => d.deviceId === savedMic)) {
            selectEl.value = savedMic;
        }
    } catch (e) { console.error('获取麦克风列表失败:', e); }
}

async function switchMic(deviceId) {
    if (!room) return;
    localStorage.setItem('lk_mic', deviceId);
    try { await room.switchActiveDevice('audioinput', deviceId); } 
    catch (e) { console.error('切换麦克风失败:', e); alert('切换失败，该设备可能被独占或拔出。'); }
}

async function updateAudioOutputList() {
    const selectEl = document.getElementById('audio-output-select');
    if (!selectEl) return;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
        selectEl.innerHTML = '<option value="default">当前浏览器不支持输出设备切换</option>';
        return;
    }

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === 'audiooutput');
        selectEl.innerHTML = '';

        const defaultOption = document.createElement('option');
        defaultOption.value = 'default';
        defaultOption.text = '默认扬声器';
        selectEl.appendChild(defaultOption);

        outputs.forEach((device) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `音频输出设备 (${device.deviceId.slice(0, 6)}...)`;
            selectEl.appendChild(option);
        });

        const hasSaved = Array.from(selectEl.options).some(opt => opt.value === selectedAudioOutputId);
        selectEl.value = hasSaved ? selectedAudioOutputId : 'default';
    } catch (e) {
        console.warn('枚举音频输出设备失败:', e);
        selectEl.innerHTML = '<option value="default">输出设备不可用</option>';
    }
}

async function switchAudioOutput(deviceId) {
    selectedAudioOutputId = deviceId || 'default';
    localStorage.setItem('lk_audio_output', selectedAudioOutputId);

    if (remoteAudioContext && typeof remoteAudioContext.setSinkId === 'function') {
        try {
            await remoteAudioContext.setSinkId(selectedAudioOutputId);
        } catch (e) {
            console.warn('AudioContext.setSinkId 切换失败:', e);
        }
    }

    const audioEls = document.querySelectorAll('#audio-container audio');
    for (const audioEl of audioEls) {
        if (typeof audioEl.setSinkId === 'function') {
            try {
                await audioEl.setSinkId(selectedAudioOutputId);
            } catch (e) {
                console.warn('audio.setSinkId 切换失败:', e);
            }
        }
    }
}

async function joinRoom() {
    const username = document.getElementById('username').value.trim();
    if (!username) return alert('起个响亮的名字吧！');

    // join button is a user gesture, use it to unlock audio context when needed.
    ensureAudioContext();
    if (localPcmAudioContext && localPcmAudioContext.state === 'suspended') {
        localPcmAudioContext.resume().catch(() => {});
    }

    localStorage.setItem('lk_username', username);
    const serverConfig = getServerConfig();
    localStorage.setItem('lk_server_ip', serverConfig.persistValue);

    isInLobby = true;
    document.getElementById('btn-connect').innerText = '🏛️ 已进入大厅';
    document.getElementById('btn-connect').style.backgroundColor = '#1a6334';
    document.getElementById('header').innerText = '# 🏛️ DoNiChannel 电竞大厅（选择左侧语音分组）';

    await refreshRoomsFromServer().catch((err) => {
        console.warn('进入大厅时拉取房间列表失败:', err);
        renderChannelList();
    });
    startRoomPolling();
}

async function switchChannel(roomName) {
    if (!isInLobby) {
        await joinRoom();
        if (!isInLobby) return;
    }

    if (currentChannel === roomName && room) return;

    if (room) {
        room.disconnect();
        room = null;
        resetRoomUIAfterDisconnect();
    }

    currentChannel = roomName;
    renderChannelList();
    await connectToChannel(roomName);
}

async function connectToChannel(targetRoomName) {
    const username = document.getElementById('username').value.trim();
    if (!username) return;
    const serverConfig = getServerConfig();

    try {
        const response = await fetch(`${serverConfig.apiBase}/api/get_token?user=${encodeURIComponent(username)}&room=${encodeURIComponent(targetRoomName)}`);
        const data = await response.json();
        const token = data.token;

        room = new LivekitClient.Room({
            audioCaptureDefaults: getMicCaptureOptions(),
            publishDefaults: {
                videoCodec: 'h264',
                // 全局音频发布默认走高音质音乐预设（麦克风/系统音频均受益）
                audioPreset: (LivekitClient.AudioPresets && (LivekitClient.AudioPresets.musicHighQuality || LivekitClient.AudioPresets.music)) || undefined
            }
        });

        // 🌟 核心修改：接收到视频流时，包装盒子并打上名字标签
        room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === 'video') {
                const isRemoteScreen = isScreenShareSource(publication?.source) && participant?.identity !== room.localParticipant?.identity;
                const videoEl = track.attach();
                
                // 创建包装盒
                const wrapper = document.createElement('div');
                wrapper.className = 'video-wrapper';
                wrapper.id = 'video-wrapper-' + track.sid; // 使用 track.sid 精准绑定包装盒
                wrapper.dataset.videoIdentity = participant.identity; // 用于离线时清理整个盒子
                wrapper.title = "双击全屏放大观看";
                
                // 获取分享者的名字
                const displayName = participant.name || participant.identity || '未知成员';
                
                // 创建名字标签
                const nameLabel = document.createElement('div');
                nameLabel.className = 'video-name-label';
                nameLabel.innerText = `${displayName} 的屏幕`;

                // 本地屏蔽按钮：仅对远端屏幕共享显示，点击后取消订阅以节省本地带宽
                if (isRemoteScreen) {
                    localScreenControls[participant.identity] = {
                        publication,
                        displayName,
                        isBlocked: false
                    };

                    removeLocalScreenRestoreCard(participant.identity);

                    const toggleBtn = document.createElement('button');
                    toggleBtn.className = 'screen-local-toggle-btn';
                    toggleBtn.innerText = '屏蔽屏幕';
                    toggleBtn.onclick = async (event) => {
                        event.stopPropagation();
                        await toggleLocalScreenSubscription(participant.identity);
                    };
                    wrapper.appendChild(toggleBtn);
                }
                
                // 双击全屏事件现在绑定在包装盒上（这样全屏时名字标签也能显示！）
                wrapper.ondblclick = () => {
                    if (!document.fullscreenElement) {
                        if (wrapper.requestFullscreen) wrapper.requestFullscreen();
                        else if (wrapper.webkitRequestFullscreen) wrapper.webkitRequestFullscreen();
                    } else {
                        if (document.exitFullscreen) document.exitFullscreen();
                    }
                };
                
                // 把视频和名字放进盒子里
                wrapper.appendChild(videoEl);
                wrapper.appendChild(nameLabel);
                
                // 把盒子放入主界面
                document.getElementById('video-container').appendChild(wrapper);

            } else if (track.kind === 'audio') {
                const audioEl = track.attach();
                // Prevent double output from native <audio>; route sound only through AudioContext.
                audioEl.muted = true;
                audioEl.volume = 0;
                audioEl.dataset.audioIdentity = participant.identity;
                
                const source = (track.source === LivekitClient.Track.Source.ScreenShareAudio || track.source === 'screen_share_audio') ? 'screen' : 'mic';
                audioEl.dataset.audioSource = source;

                if (!userVolumes[participant.identity]) {
                    userVolumes[participant.identity] = { mic: 1, screen: 1 };
                }
                // 交给 GainNode 处理，支持 100% 以上的本地增益
                addRemoteGainNode(participant.identity, source, track, audioEl);
                
                document.getElementById('audio-container').appendChild(audioEl);
                if (typeof audioEl.setSinkId === 'function') {
                    audioEl.setSinkId(selectedAudioOutputId).catch((e) => {
                        console.warn('新音频轨道切换输出设备失败:', e);
                    });
                }
            }
        });

        // 🌟 核心修改：如果有人单独关掉了屏幕共享，要把他的包装盒一起删掉
        room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach(element => element.remove());
            removeRemoteAudioRouteByTrackSid(track.sid);
            
            // 精准狙击并删除对应的包装盒
            const wrapper = document.getElementById('video-wrapper-' + track.sid);
            if (wrapper) wrapper.remove();

            // 如果是本地手动屏蔽导致的取消订阅，保留恢复卡片；其它情况不处理
        });

        // 退出房间暴力清场，利用之前的 dataset 删除整个盒子
        room.on(LivekitClient.RoomEvent.ParticipantDisconnected, (participant) => {
            document.querySelectorAll(`[data-video-identity="${participant.identity}"]`).forEach(el => el.remove());
            document.querySelectorAll(`[data-audio-identity="${participant.identity}"]`).forEach(el => el.remove());
            removeLocalScreenRestoreCard(participant.identity);
            delete localScreenControls[participant.identity];
            updateParticipantList();
        });

        room.on(LivekitClient.RoomEvent.ParticipantConnected, updateParticipantList);
        // 活跃说话者检测：根据音频能量水平更新状态，带防抖避免频闪
        room.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
            const nextActiveIdentities = new Set();
            (speakers || []).forEach((participant) => {
                if (!participant || !participant.identity) return;
                const audioLevel = Number(participant.audioLevel || 0);
                if (audioLevel >= ACTIVE_SPEAKER_LEVEL_THRESHOLD) {
                    nextActiveIdentities.add(participant.identity);
                }
            });

            let hasImmediateChange = false;
            nextActiveIdentities.forEach((identity) => {
                if (markParticipantAsActiveSpeaker(identity)) {
                    hasImmediateChange = true;
                }
            });

            Array.from(activeSpeakerIdentities).forEach((identity) => {
                if (!nextActiveIdentities.has(identity)) {
                    scheduleParticipantActiveSpeakerOff(identity);
                }
            });

            if (hasImmediateChange) updateParticipantList();
        });

        // 监听静音状态变化以刷新列表
        room.on(LivekitClient.RoomEvent.TrackMuted, (pub) => { if(pub.kind === 'audio') updateParticipantList(); });
        room.on(LivekitClient.RoomEvent.TrackUnmuted, (pub) => { if(pub.kind === 'audio') updateParticipantList(); });
        room.on(LivekitClient.RoomEvent.LocalTrackMuted, (pub) => { if(pub.kind === 'audio') updateParticipantList(); });
        room.on(LivekitClient.RoomEvent.LocalTrackUnmuted, (pub) => { if(pub.kind === 'audio') updateParticipantList(); });
        room.on(LivekitClient.RoomEvent.LocalTrackPublished, (pub) => {
            if (isScreenShareSource(pub?.source) && pub.track) {
                showLocalScreenPreview(pub.track);
            }
        });
        room.on(LivekitClient.RoomEvent.LocalTrackUnpublished, (pub) => {
            if (isScreenShareSource(pub?.source)) {
                hideLocalScreenPreview();
            }
        });
        room.on(LivekitClient.RoomEvent.TrackPublished, (pub) => { if(pub.kind === 'audio') updateParticipantList(); });
        room.on(LivekitClient.RoomEvent.TrackUnpublished, (pub, participant) => {
            if(pub.kind === 'audio') updateParticipantList();

            if (isScreenShareSource(pub?.source)) {
                const identity = participant?.identity || Object.keys(localScreenControls).find(key => {
                    return localScreenControls[key]?.publication?.trackSid === pub?.trackSid;
                });

                if (identity) {
                    removeLocalScreenRestoreCard(identity);
                    delete localScreenControls[identity];
                }
            }
        });

        // 监听文字聊天消息
        room.on(LivekitClient.RoomEvent.DataReceived, (payload, participant) => {
            try {
                const text = new TextDecoder().decode(payload);
                const data = JSON.parse(text);
                if (data.msg) {
                    renderChatMessage(participant ? (participant.name || participant.identity) : '未知', data.msg, false);
                }
            } catch(e) { console.error('Data channel 解析失败:', e); }
        });

        await room.connect(serverConfig.livekitWs, token);
        document.getElementById('header').innerText = `# 🔊 ${targetRoomName} 语音分组`;
        
        document.getElementById('username').disabled = true;
        
        document.getElementById('btn-mic').disabled = false;
        document.getElementById('mic-select').disabled = false;
        document.getElementById('audio-output-select').disabled = false;
        document.getElementById('btn-screen').disabled = false;
        document.getElementById('screen-res').disabled = false;
        document.getElementById('screen-fps').disabled = false;
        document.getElementById('screen-bitrate').disabled = false;
        document.getElementById('btn-app-audio').disabled = false;
        document.getElementById('btn-stop-app-audio').disabled = true;
        document.getElementById('btn-leave').style.display = 'flex';

        // 加入后自动开麦（失败仅记录，不中断进房流程）
        try {
            await room.localParticipant.setMicrophoneEnabled(true, getMicCaptureOptions());
            isMicOn = true;
            const micBtn = document.getElementById('btn-mic');
            micBtn.classList.add('active');
            micBtn.innerHTML = '🔇 <span>关闭麦克风</span>';
        } catch (e) {
            console.warn('自动开麦失败:', e);
        }
        
        document.getElementById('chat-input').disabled = false;
        document.getElementById('btn-send').disabled = false;

        updateParticipantList();
        await updateMicList();
        await updateAudioOutputList();
        await switchAudioOutput(document.getElementById('audio-output-select').value || selectedAudioOutputId);
        updateAppAudioButtons();

    } catch (error) {
        console.error('频道连接失败:', error);
        alert('连接服务器失败，请检查网络。');
        currentChannel = null;
        renderChannelList();
        document.getElementById('header').innerText = '# 🏛️ DoNiChannel 电竞大厅（连接失败，请重试）';
    }
}

async function toggleMic() {
    isMicOn = !isMicOn;
    if (isMicOn) {
        await room.localParticipant.setMicrophoneEnabled(true, getMicCaptureOptions());
    } else {
        await room.localParticipant.setMicrophoneEnabled(false);
    }
    const btn = document.getElementById('btn-mic');
    if (isMicOn) {
        btn.classList.add('active');
        btn.innerHTML = '🔇 <span>关闭麦克风</span>';
        await updateMicList();
    } else {
        btn.classList.remove('active');
        btn.innerHTML = '🎤 <span>开启麦克风</span>';
    }
}

function getShareAudioErrorMessage(err) {
    const name = err?.name || 'UnknownError';
    if (name === 'NotAllowedError') return '你取消了系统音频授权，或未勾选“分享系统音频”。';
    if (name === 'NotReadableError') return '浏览器无法启动系统音频采集（常见于系统限制、驱动占用或浏览器能力限制）。';
    if (name === 'AbortError') return '共享窗口被关闭或共享流程被中断。';
    return `系统音频共享失败：${name}`;
}

function getSystemAudioPreflight() {
    const issues = [];
    const ua = navigator.userAgent || '';
    const isWindows = /Windows/i.test(ua);
    const isChromium = /Chrome|Edg/i.test(ua);
    const hasGetDisplayMedia = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

    if (!hasGetDisplayMedia) issues.push('当前浏览器不支持屏幕共享 API（getDisplayMedia）。');
    if (!window.isSecureContext) issues.push('当前页面不是安全上下文（建议使用 HTTPS 或 localhost）。');
    if (!isWindows) issues.push('系统音频共享在非 Windows 平台上支持不稳定。');
    if (!isChromium) issues.push('建议使用最新版 Chrome 或 Edge 进行系统音频共享。');

    return { canTryAudio: hasGetDisplayMedia, issues };
}

function getDisplayMediaConstraints(withAudio = true) {
    const video = { frameRate: { ideal: 60, max: 60 }, width: { ideal: 1920 }, height: { ideal: 1080 }, displaySurface: 'monitor' };
    if (!withAudio) return { video, audio: false };
    return {
        video,
        audio: {
            echoCancellation: false, noiseSuppression: false, autoGainControl: false,
            channelCount: 2, sampleRate: 48000, sampleSize: 16,
            suppressLocalAudioPlayback: false, systemAudio: 'include'
        }
    };
}

function hasPublishedScreenAudioTrack() {
    if (!room || !room.localParticipant) return false;
    const pubs = Array.from(room.localParticipant.audioTrackPublications.values());
    return pubs.some(pub => {
        const source = pub?.source;
        return source === LivekitClient.Track.Source.ScreenShareAudio || source === 'screen_share_audio';
    });
}

function getLocalScreenPublication() {
    if (!room || !room.localParticipant) return null;
    const pubs = Array.from(room.localParticipant.videoTrackPublications.values());
    return pubs.find(pub => {
        const source = pub?.source;
        return source === LivekitClient.Track.Source.ScreenShare || source === 'screen_share';
    }) || null;
}

function showLocalScreenPreview(track) {
    const previewBox = document.getElementById('local-screen-preview-box');
    const previewVideo = document.getElementById('local-screen-preview');
    if (!previewBox || !previewVideo || !track) return;

    previewVideo.muted = true;

    if (currentLocalScreenTrack && currentLocalScreenTrack !== track) {
        currentLocalScreenTrack.detach(previewVideo);
    }

    track.attach(previewVideo);
    currentLocalScreenTrack = track;
    previewBox.style.display = 'block';
}

function hideLocalScreenPreview() {
    const previewBox = document.getElementById('local-screen-preview-box');
    const previewVideo = document.getElementById('local-screen-preview');
    if (!previewBox || !previewVideo) return;

    if (currentLocalScreenTrack) {
        currentLocalScreenTrack.detach(previewVideo);
        currentLocalScreenTrack = null;
    }

    previewVideo.srcObject = null;
    previewBox.style.display = 'none';
}

function stopScreenBitrateMonitor() {
    if (screenBitrateMonitorTimer) {
        clearInterval(screenBitrateMonitorTimer);
        screenBitrateMonitorTimer = null;
    }
    lastScreenOutboundStats = null;
    currentScreenTargetBitrate = 0;
}

async function logCurrentScreenBitrate() {
    const pub = getLocalScreenPublication();
    const targetText = currentScreenTargetBitrate > 0
        ? `${(currentScreenTargetBitrate / 1000000).toFixed(2)} Mbps`
        : '未设置';

    if (!pub || !pub.track) {
        console.log(`[ScreenShare Stats] 目标码率=${targetText}，实际码率=暂无（未找到屏幕视频轨道）`);
        return;
    }

    if (typeof pub.track.getRTCStatsReport !== 'function') {
        console.log(`[ScreenShare Stats] 目标码率=${targetText}，实际码率=暂无（SDK未暴露RTC stats接口）`);
        return;
    }

    try {
        const report = await pub.track.getRTCStatsReport();
        let outbound = null;

        const pickOutbound = (stat) => {
            if (!stat || stat.type !== 'outbound-rtp') return;
            const kind = stat.kind || stat.mediaType;
            if (kind !== 'video') return;
            if (!outbound || (stat.bytesSent || 0) > (outbound.bytesSent || 0)) {
                outbound = stat;
            }
        };

        if (Array.isArray(report)) {
            report.forEach(pickOutbound);
        } else if (report && typeof report.forEach === 'function') {
            report.forEach(pickOutbound);
        }

        if (!outbound) {
            console.log(`[ScreenShare Stats] 目标码率=${targetText}，实际码率=暂无（未抓到outbound-rtp/video）`);
            return;
        }

        const ts = outbound.timestamp instanceof Date ? outbound.timestamp.getTime() : Number(outbound.timestamp);
        const bytes = Number(outbound.bytesSent || 0);
        let actualBps = null;

        if (lastScreenOutboundStats && ts > lastScreenOutboundStats.ts && bytes >= lastScreenOutboundStats.bytes) {
            const deltaBytes = bytes - lastScreenOutboundStats.bytes;
            const deltaMs = ts - lastScreenOutboundStats.ts;
            if (deltaMs > 0) actualBps = (deltaBytes * 8 * 1000) / deltaMs;
        }

        lastScreenOutboundStats = { ts, bytes };

        if (actualBps === null) {
            console.log(`[ScreenShare Stats] 目标码率=${targetText}，实际码率=采集中...`);
        } else {
            console.log(`[ScreenShare Stats] 目标码率=${targetText}，实际码率=${(actualBps / 1000000).toFixed(2)} Mbps`);
        }
    } catch (err) {
        console.warn('[ScreenShare Stats] 读取RTC stats失败:', err);
    }
}

function startScreenBitrateMonitor(targetBitrate) {
    stopScreenBitrateMonitor();
    currentScreenTargetBitrate = targetBitrate;
    console.log(`[ScreenShare Stats] 开始监控，目标码率=${(targetBitrate / 1000000).toFixed(2)} Mbps`);
    logCurrentScreenBitrate();
    screenBitrateMonitorTimer = setInterval(logCurrentScreenBitrate, 2000);
}

async function toggleScreen() {
    if (!room) return;

    try {
        if (!isScreenOn) {
            const resVal = document.getElementById('screen-res').value.split('x');
            const customWidth = parseInt(resVal[0]);
            const customHeight = parseInt(resVal[1]);
            const customFps = parseInt(document.getElementById('screen-fps').value);
            const customBitrate = parseInt(document.getElementById('screen-bitrate').value) * 1000;

            const captureOptions = {
                audio: true,
                // 显式使用 getDisplayMedia 音频约束，禁用麦克风向的音频处理，避免系统音频发闷/忽大忽小
                captureOptions: getDisplayMediaConstraints(true),
                resolution: { width: customWidth, height: customHeight, frameRate: customFps }
            };
            
            const publishOptions = {
                screenShareEncoding: { maxBitrate: customBitrate, maxFramerate: customFps },
                simulcast: false,
                videoCodec: 'h264',
                // 屏幕共享音频轨道优先使用高音质音乐预设
                audioPreset: (LivekitClient.AudioPresets && (LivekitClient.AudioPresets.musicHighQuality || LivekitClient.AudioPresets.music)) || undefined
            };

            let audioShareFailed = false;
            let audioShareError = null;
            const preflight = getSystemAudioPreflight();
            const shouldTryAudio = preflight.canTryAudio && window.isSecureContext;

            try {
                await room.localParticipant.setScreenShareEnabled(true, captureOptions, publishOptions);
            } catch (err) {
                console.error('抓取屏幕音视频流失败:', err);
                audioShareFailed = true;
                audioShareError = err;
                
                const fallbackCaptureOptions = {
                    audio: false,
                    captureOptions: getDisplayMediaConstraints(false),
                    resolution: { width: customWidth, height: customHeight, frameRate: customFps }
                };

                await room.localParticipant.setScreenShareEnabled(true, fallbackCaptureOptions, publishOptions);
            }

            const tracks = Array.from(room.localParticipant.videoTrackPublications.values());
            tracks.forEach(pub => {
                if (pub.source === LivekitClient.Track.Source.ScreenShare && pub.track) {
                    pub.track.mediaStreamTrack.contentHint = 'motion';
                }
            });

            const localScreenPub = getLocalScreenPublication();
            if (localScreenPub && localScreenPub.track) {
                showLocalScreenPreview(localScreenPub.track);
            }

            isScreenOn = true;
            const btn = document.getElementById('btn-screen');
            btn.classList.add('active');
            btn.innerHTML = '🛑 <span>停止共享</span>';
            startScreenBitrateMonitor(customBitrate);
            
            document.getElementById('screen-res').disabled = true;
            document.getElementById('screen-fps').disabled = true;
            document.getElementById('screen-bitrate').disabled = true;

            if (shouldTryAudio && !audioShareFailed && !hasPublishedScreenAudioTrack()) {
                audioShareFailed = true;
                audioShareError = { name: 'NotReadableError', message: 'Screen share started but no system-audio track was published' };
            }

            if (!shouldTryAudio && preflight.issues.length > 0) {
                alert(
                    '已开启屏幕共享（仅画面）。\n\n' +
                    '当前环境不满足系统音频共享条件：\n- ' + preflight.issues.join('\n- ') +
                    '\n\n推荐方案：\n' +
                    '1. 用 HTTPS 打开此页面（不要用 http://内网IP）；\n' +
                    '2. 使用最新版 Chrome/Edge；\n' +
                    '3. 重新共享时选择“整个屏幕”并勾选“分享系统音频”。'
                );
            } else if (audioShareFailed) {
                alert(
                    '已开启屏幕共享（仅画面）。\n\n' +
                    getShareAudioErrorMessage(audioShareError) +
                    '\n\n如需共享系统声音，请确认：\n' +
                    '1. 选择“整个屏幕”而不是“窗口”；\n' +
                    '2. 勾选“分享系统音频”；\n' +
                    '3. 关闭可能独占音频设备的软件后重试；\n' +
                    '4. Windows 声音设置中关闭播放设备“独占模式”；\n' +
                    '5. 尽量改为 HTTPS 访问页面（http://内网IP 常见失败）。'
                );
            }
        } else {
            await room.localParticipant.setScreenShareEnabled(false);
            isScreenOn = false;
            const btn = document.getElementById('btn-screen');
            btn.classList.remove('active');
            btn.innerHTML = '💻 <span>共享屏幕</span>';
            stopScreenBitrateMonitor();
            hideLocalScreenPreview();
            
            document.getElementById('screen-res').disabled = false;
            document.getElementById('screen-fps').disabled = false;
            document.getElementById('screen-bitrate').disabled = false;
        }
    } catch (e) {
        console.error('屏幕共享未知错误', e);
        isScreenOn = false;
        stopScreenBitrateMonitor();
        hideLocalScreenPreview();
        document.getElementById('screen-res').disabled = false;
        document.getElementById('screen-fps').disabled = false;
        document.getElementById('screen-bitrate').disabled = false;
    }
}

function leaveRoom() {
    stopAppAudioShare();
    stopRoomPolling();
    stopScreenBitrateMonitor();
    hideLocalScreenPreview();
    if(room) room.disconnect();
    teardownLocalPcmPipeline();
    window.location.reload(); 
}

async function sendChatMessage() {
    if (!room || !room.localParticipant) return;
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    
    try {
        const data = JSON.stringify({ msg: text });
        await room.localParticipant.publishData(new TextEncoder().encode(data), { reliable: true });
        
        const myName = room.localParticipant.name || room.localParticipant.identity;
        renderChatMessage(myName, text, true);
        input.value = '';
    } catch (e) {
        console.error('发送消息失败:', e);
    }
}

function renderChatMessage(sender, text, isSelf) {
    const messagesDiv = document.getElementById('chat-messages');
    const msgEl = document.createElement('div');
    msgEl.className = 'chat-message' + (isSelf ? ' self' : '');
    
    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
    
    msgEl.innerHTML = `
        <div class="chat-meta">${sender} ${timeStr}</div>
        <div class="chat-content">${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
    `;
    messagesDiv.appendChild(msgEl);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

/*
// Tauri v2 标准的 invoke 引入方式
const { invoke } = window.__TAURI__.core;

// 阶段一测试函数
async function testRadar() {
    try {
        console.log(" Rust扫描进程...");
        const processes = await invoke('get_active_processes');
        
        console.log("活跃进程：");
        console.table(processes); // 以表格形式漂亮地打印出来
        
    } catch (error) {
        console.error("扫描失败:", error);
    }
}

// 页面加载后直接执行测试
testRadar();
*/
