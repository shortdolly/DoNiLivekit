# HTML

## sidebar块
左侧边栏，显示服务器ip地址、用户名称、频道分组等信息。

## main-area块
主显示区，包括屏幕共享画面和调节按钮。

## chat-panel块
右边栏，文字聊天区。

# CSS

# JS

### 监听```DOMContentLoaded```事件

```javascript
const savedUser = localStorage.getItem('lk_username');
if (savedUser) document.getElementById('username').value = savedUser;
```
读取```localStorage```中保存的用户名，若存在则填充进页面中。

```javascript
const savedServerIp = localStorage.getItem('lk_server_ip');
document.getElementById('server-ip').value = savedServerIp || DEFAULT_SERVER_IP;
```
读取```localStorage```中保存的服务器IP地址，将该IP地址或默认IP地址填充进页面中。

```javascript
const savedNoise = localStorage.getItem('lk_noise');
if (savedNoise !== null) {
    isNoiseSuppressionOn = savedNoise === 'true'; // 降噪是否打开
    const btn = document.getElementById('btn-noise');
    btn.innerHTML = isNoiseSuppressionOn ? '🔊 <span>降噪: 开</span>' : '📢 <span>降噪: 关</span>';
    btn.classList.toggle('active', !isNoiseSuppressionOn); // 在class列表中添加或删除active
}
```
读取```localStorage```中保存的降噪设置，调整页面中降噪设置的显示。

```javascript
renderChannelList();
```
渲染语音频道列表

```javascript
updateAudioOutputList();
```

## 变量

```room```

```currentChannel```
当前所在频道名

```isInLobby```

```channels```
频道分组列表

```channelParticipants```
频道中的成员

```roomPollTimer```
```isMicOn```
```isScreenOn```
```isNoiseSuppressionOn```
```userVolumes```
```screenBitrateMonitorTimer```
```lastScreenOutboundStats```
```currentScreenTargetBitrate```
```localScreenControls```
```currentLocalScreenTrack```
```remoteAudioContext```
```remoteAudioGainNodes```
```activeSpeakerIdentities```
```activeSpeakerDebounceTimers```
```ACTIVE_SPEAKER_LEVEL_THRESHOLD```
```ACTIVE_SPEAKER_DEBOUNCE_MS```

```selectedAudioOutputId```
选择的音频输出设备

## 函数

### ```renderChannelList```
渲染频道分组列表

```javascript
const list = document.getElementById('channel-list');
if (!list) return;
```
查找文档列表对象，若为空则返回。

```javascript
list.innerHTML = channels.map(name => {
    const active = currentChannel === name ? 'active' : '';
    const escapedName = name.replace(/'/g, "\\'"); // 单引号添加转义字符
    const participants = Array.isArray(channelParticipants[name]) ? channelParticipants[name] : []; // 频道成员
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
```
通过```channels```创建频道列表，返回对应HTML块。

### ```updateAudioOutputList```
更新音频输出选择列表

```javascript
const selectEl = document.getElementById('audio-output-select');
if (!selectEl) return;
if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== 'function') { // 检查媒体设备
    selectEl.innerHTML = '<option value="default">当前浏览器不支持输出设备切换</option>';
    return;
}
```
检查运行环境。

```javascript
try {
    const devices = await navigator.mediaDevices.enumerateDevices(); // 获取可用的媒体输入和输出设备的列表
    const outputs = devices.filter(d => d.kind === 'audiooutput');
    selectEl.innerHTML = '';

    const defaultOption = document.createElement('option'); // 创建option元素
    defaultOption.value = 'default';
    defaultOption.text = '默认扬声器';
    selectEl.appendChild(defaultOption); // 添加子元素

    // 遍历输出设备添加选项到下拉列表中
    outputs.forEach((device) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.text = device.label || `音频输出设备 (${device.deviceId.slice(0, 6)}...)`;
        selectEl.appendChild(option);
    });

    const hasSaved = Array.from(selectEl.options).some(opt => opt.value === selectedAudioOutputId); // 存储的已选择的输出设备
    selectEl.value = hasSaved ? selectedAudioOutputId : 'default';
} catch (e) {
    console.warn('枚举音频输出设备失败:', e);
    selectEl.innerHTML = '<option value="default">输出设备不可用</option>';
}
```
获取音频输出设备，渲染输出设备下拉列表。