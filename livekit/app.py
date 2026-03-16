from flask import Flask, request, jsonify, render_template_string
from livekit.api import LiveKitAPI, AccessToken, VideoGrants, ListRoomsRequest, ListParticipantsRequest
from flask_cors import CORS
import uuid
import sqlite3
import os
import asyncio

app = Flask(__name__)
CORS(app)

API_KEY = "devkey"
API_SECRET = "secret"
ROOM_NAME = "team-meeting-room"
LIVEKIT_URL = os.environ.get('LIVEKIT_URL', 'http://127.0.0.1:7880')
DB_PATH = os.path.join(os.path.dirname(__file__), 'rooms.db')
DEFAULT_ROOMS = ['day0', 'day1', 'day2']


def get_db_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db_conn()
    try:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS rooms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                room_name TEXT NOT NULL UNIQUE
            )
        ''')
        count = conn.execute('SELECT COUNT(*) AS cnt FROM rooms').fetchone()['cnt']
        if count == 0:
            conn.executemany('INSERT OR IGNORE INTO rooms (room_name) VALUES (?)', [(name,) for name in DEFAULT_ROOMS])
        conn.commit()
    finally:
        conn.close()


def get_all_rooms_from_db():
    conn = get_db_conn()
    try:
        rows = conn.execute('SELECT room_name FROM rooms ORDER BY id ASC').fetchall()
        return [row['room_name'] for row in rows]
    finally:
        conn.close()


def add_room_to_db(room_name: str):
    conn = get_db_conn()
    try:
        conn.execute('INSERT OR IGNORE INTO rooms (room_name) VALUES (?)', (room_name,))
        conn.commit()
    finally:
        conn.close()


def list_livekit_rooms_and_participants():
    """使用最新版 LiveKitAPI 和 asyncio 语法的标准请求"""
    async def fetch_data():
        result = {}
        # 实例化新的 LiveKitAPI 客户端
        async with LiveKitAPI(LIVEKIT_URL, API_KEY, API_SECRET) as lkapi:
            try:
                # 获取所有活跃房间
                rooms_resp = await lkapi.room.list_rooms(ListRoomsRequest())
                for room in rooms_resp.rooms:
                    # 获取该房间内的所有用户
                    parts_resp = await lkapi.room.list_participants(ListParticipantsRequest(room=room.name))
                    # 提取名字，如果没有设置 name 则回退使用 identity
                    names = [p.name if p.name else p.identity for p in parts_resp.participants]
                    result[room.name] = names
            except Exception as e:
                print(f"[rooms] 获取 LiveKit 数据出错: {e}")
        return result
    
    # 因为 Flask 是同步框架，这里使用 asyncio.run 将异步跑在同步线程里
    return asyncio.run(fetch_data())


init_db()


def build_token(user_name: str, room_name: str):
    """更新 Token 生成语法"""
    unique_identity = f"{user_name}-{uuid.uuid4().hex[:8]}"
    token = AccessToken(API_KEY, API_SECRET) \
        .with_identity(unique_identity) \
        .with_name(user_name) \
        .with_grants(VideoGrants(
            room_join=True,
            room=room_name,
        ))
    return token.to_jwt()


@app.route('/')
def index():
    with open('index.html', 'r', encoding='utf-8') as f:
        return render_template_string(f.read())


@app.route('/api/get_token')
@app.route('/token')
def get_token():
    user_name = request.args.get('user', '访客')
    room_name = request.args.get('room', ROOM_NAME)

    token_jwt = build_token(user_name, room_name)
    return jsonify({"token": token_jwt, "room": room_name})


@app.route('/api/rooms', methods=['POST'])
def create_room():
    body = request.get_json(silent=True) or {}
    room_name = (body.get('name') or body.get('room_name') or '').strip()

    if not room_name:
        return jsonify({'error': '房间名不能为空'}), 400
    if len(room_name) > 64:
        return jsonify({'error': '房间名过长（最多64字符）'}), 400

    add_room_to_db(room_name)
    return jsonify({'ok': True, 'name': room_name})


@app.route('/api/rooms', methods=['GET'])
def get_rooms():
    db_rooms = get_all_rooms_from_db()
    livekit_map = {}

    try:
        livekit_map = list_livekit_rooms_and_participants()
    except Exception as e:
        print('[rooms] LiveKit room sync failed:', e)

    merged_names = []
    seen = set()
    # 合并数据库中的房间和 LiveKit 活跃的房间
    for name in db_rooms + list(livekit_map.keys()):
        if name in seen:
            continue
        seen.add(name)
        merged_names.append(name)

    payload = [{'name': name, 'participants': livekit_map.get(name, [])} for name in merged_names]
    return jsonify(payload)


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)