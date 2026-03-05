from flask import Flask, request, jsonify, render_template_string
from livekit import api
import uuid  # 新增：引入生成随机唯一ID的库

app = Flask(__name__)

API_KEY = "devkey"
API_SECRET = "secret"
ROOM_NAME = "team-meeting-room"

@app.route('/')
def index():
    with open('index.html', 'r', encoding='utf-8') as f:
        return render_template_string(f.read())

@app.route('/api/get_token')
def get_token():
    user_name = request.args.get('user', '访客')
    
    # 核心修改：利用 uuid 自动生成一个随机短串，拼接在名字后面作为底层唯一 Identity
    # 比如：测试人员-a1b2c3d4
    unique_identity = f"{user_name}-{uuid.uuid4().hex[:8]}"
    
    # 签发 Token 时，Identity 用唯一的，Name 用用户填写的
    token = api.AccessToken(API_KEY, API_SECRET) \
        .with_identity(unique_identity) \
        .with_name(user_name) \
        .with_grants(api.VideoGrants(
            room_join=True,
            room=ROOM_NAME,
        ))
    
    return jsonify({"token": token.to_jwt()})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)