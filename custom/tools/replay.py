#!/usr/bin/env python3
"""
OpenClaw 重启消息回放脚本
在 openclaw-gateway 启动后执行，自动检测并重放未处理的飞书消息。

逻辑：
1. 读取 feishu_gateway_timestamp.last_shutdown_ts（上次关闭时间）
2. 扫描 feishu_processed_messages 获取所有活跃 chat_id
3. 调用飞书 API 拉取从"关闭前5分钟"到"现在"的消息
4. 对比 feishu_processed_messages，找出未处理的用户消息
5. 通过 CLI 重新注入给 front 处理
"""
import sqlite3
import json
import time
import subprocess
import sys
import urllib.request
import urllib.parse

# ─── 配置 ───────────────────────────────────────────────────────────────
DB_PATH      = '/root/.openclaw/feishu-history.db'
CONFIG_PATH  = '/root/.openclaw/openclaw.json'
OPENCLAW_BIN = '/root/openclaw-deploy/dist/index.js'
LOG_FILE     = '/tmp/openclaw-replay.log'

# 往前多看5分钟（防止时钟误差/处理延迟）
LOOKBACK_EXTRA_MS = 5 * 60 * 1000
# 最多往回追查30分钟（防止无限追溯）
MAX_LOOKBACK_MS   = 30 * 60 * 1000


def log(msg):
    ts   = time.strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, 'a') as f:
        f.write(line + '\n')


def get_feishu_token(app_id, app_secret):
    url  = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
    data = json.dumps({'app_id': app_id, 'app_secret': app_secret}).encode()
    req  = urllib.request.Request(
        url, data=data, headers={'Content-Type': 'application/json'}
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        resp = json.loads(r.read())
    token = resp.get('tenant_access_token', '')
    if not token:
        raise RuntimeError(f'Failed to get tenant_access_token: {resp}')
    return token


def feishu_list_messages(token, chat_id, start_ts_sec, end_ts_sec):
    """拉取飞书会话内的消息列表（自动分页）"""
    messages   = []
    page_token = ''

    # p2p 私聊用 p2p，群聊用 chat
    container_type = 'p2p' if chat_id.startswith('oc_') else 'chat'

    while True:
        params = {
            'container_id_type': container_type,
            'container_id':      chat_id,
            'start_time':        str(int(start_ts_sec)),
            'end_time':          str(int(end_ts_sec)),
            'page_size':         '50',
            'sort_type':         'ByCreateTimeAsc',
        }
        if page_token:
            params['page_token'] = page_token

        url = ('https://open.feishu.cn/open-apis/im/v1/messages?'
               + urllib.parse.urlencode(params))
        req = urllib.request.Request(url, headers={
            'Authorization': f'Bearer {token}',
            'Content-Type':  'application/json',
        })
        with urllib.request.urlopen(req, timeout=10) as r:
            resp = json.loads(r.read())

        code = resp.get('code', 0)
        if code != 0:
            log(f'  飞书 API 错误 chat={chat_id} code={code}: {resp.get("msg")}')
            break

        data  = resp.get('data', {})
        items = data.get('items', [])
        messages.extend(items)

        if not data.get('has_more') or not data.get('page_token'):
            break
        page_token = data['page_token']

    return messages


def main():
    log('=== OpenClaw 回放脚本启动 ===')

    # 等待 gateway 完成初始化
    time.sleep(8)

    # ─── 读取配置 ────────────────────────────────────────────────────────
    try:
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
        feishu_cfg = cfg.get('channels', {}).get('feishu', {})
        app_id     = feishu_cfg.get('appId', '')
        app_secret = feishu_cfg.get('appSecret', '')
        if not app_id or not app_secret:
            log('ERROR: 无法读取飞书 appId/appSecret，退出')
            sys.exit(1)
    except Exception as e:
        log(f'ERROR: 读取配置失败: {e}')
        sys.exit(1)

    # ─── 读取数据库 ──────────────────────────────────────────────────────
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row

        row = conn.execute(
            'SELECT last_shutdown_ts FROM feishu_gateway_timestamp WHERE id=1'
        ).fetchone()

        if not row or not row['last_shutdown_ts']:
            log('INFO: 没有 last_shutdown_ts 记录，可能是首次启动，跳过回放')
            sys.exit(0)

        shutdown_ts_ms  = row['last_shutdown_ts']
        now_ms          = int(time.time() * 1000)
        window_start_ms = max(
            shutdown_ts_ms - LOOKBACK_EXTRA_MS,
            now_ms - MAX_LOOKBACK_MS
        )

        log(f'上次关闭: {time.strftime("%H:%M:%S", time.localtime(shutdown_ts_ms/1000))}')
        log(f'回放窗口: {time.strftime("%H:%M:%S", time.localtime(window_start_ms/1000))}'
            f' ~ {time.strftime("%H:%M:%S", time.localtime(now_ms/1000))}')

        # 回放窗口内出现过的所有 chat_id
        rows = conn.execute(
            'SELECT DISTINCT chat_id FROM feishu_processed_messages WHERE processed_at >= ?',
            (window_start_ms - LOOKBACK_EXTRA_MS,)
        ).fetchall()
        active_chats = [r['chat_id'] for r in rows]
        log(f'活跃会话数: {len(active_chats)}  {active_chats}')

        if not active_chats:
            log('INFO: 回放窗口内无活跃会话，跳过')
            sys.exit(0)

        # 已处理的 message_id 集合
        rows = conn.execute(
            'SELECT message_id FROM feishu_processed_messages WHERE processed_at >= ?',
            (window_start_ms - LOOKBACK_EXTRA_MS,)
        ).fetchall()
        processed = {r['message_id'] for r in rows}
        log(f'已处理消息数: {len(processed)}')

    except Exception as e:
        log(f'ERROR: 读取数据库失败: {e}')
        sys.exit(1)

    # ─── 获取飞书 Token ──────────────────────────────────────────────────
    try:
        token = get_feishu_token(app_id, app_secret)
        log('飞书 Token 获取成功')
    except Exception as e:
        log(f'ERROR: 获取飞书 Token 失败: {e}')
        sys.exit(1)

    # ─── 拉取每个会话的消息，找出未处理的 ──────────────────────────────
    missed = []
    for chat_id in active_chats:
        try:
            msgs = feishu_list_messages(
                token, chat_id,
                window_start_ms / 1000,
                now_ms / 1000,
            )
            for msg in msgs:
                mid         = msg.get('message_id', '')
                sender_type = msg.get('sender', {}).get('sender_type', '')
                # 只关注真实用户发的消息，跳过 bot 自己的回复
                if sender_type != 'user':
                    continue
                if mid and mid not in processed:
                    missed.append({'chat_id': chat_id, 'message_id': mid, 'msg': msg})
                    log(f'  发现未处理消息: {mid}  chat={chat_id}')
        except Exception as e:
            log(f'  WARN: 拉取 chat_id={chat_id} 失败: {e}')

    if not missed:
        log('✅ 没有未处理消息，无需回放')
        conn.close()
        sys.exit(0)

    log(f'共发现 {len(missed)} 条未处理消息，开始回放...')

    # ─── 重新注入给 front ────────────────────────────────────────────────
    replayed = 0
    for item in missed:
        msg = item['msg']
        mid = item['message_id']

        # 提取消息文本内容
        try:
            body = json.loads(msg.get('body', {}).get('content', '{}'))
            text = body.get('text', '').strip()
        except Exception:
            text = msg.get('body', {}).get('content', '').strip()

        if not text:
            log(f'  SKIP 无文本内容: {mid}')
            continue

        log(f'  回放: {mid}  "{text[:60]}"')
        try:
            result = subprocess.run(
                ['node', OPENCLAW_BIN, 'agent',
                 '--to', item['chat_id'],
                 '--message', f'[回放消息] {text}'],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode == 0:
                log(f'  ✅ 回放成功: {mid}')
                replayed += 1
            else:
                log(f'  ❌ 回放失败: {mid}  {result.stderr[:200]}')
        except Exception as e:
            log(f'  ❌ 回放异常: {mid}  {e}')

        # 每条消息间隔2秒，给 front 处理缓冲
        time.sleep(2)

    log(f'=== 回放完成: 成功 {replayed}/{len(missed)} 条 ===')
    conn.close()


if __name__ == '__main__':
    main()
