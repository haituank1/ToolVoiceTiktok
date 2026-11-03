# -*- coding: utf-8 -*-
"""ToolVoiceTikTok — đọc comment TikTok LIVE thành giọng nói, phát nối tiếp.

Kiến trúc 3 tầng tách rời, nối bằng hàng đợi:
  [Bắt comment] -> lọc spam/từ cấm -> [Hàng chờ chuyển giọng]
      -> worker TTS (chuyển ngay, giữ audio trong RAM, KHÔNG lưu file)
      -> [Hàng chờ phát] -> dispatcher gửi từng voice tới trang web,
         voice sau chỉ gửi khi trang web báo đã phát XONG voice trước.

Chạy:  python server.py   rồi mở http://localhost:3220
Mọi tuỳ chỉnh sửa trên giao diện, lưu vào config.json cạnh file này.
"""
import asyncio
import base64
import io
import json
import os
import sys
import time
import uuid

from aiohttp import web

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from normalize_vi import normalize_text          # noqa: E402
from filters import CommentFilter                # noqa: E402
from tiktok_source import TikTokSource           # noqa: E402

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE, "config.json")
PORT = 3220

DEFAULT_CONFIG = {
    "username": "lelienreview2",
    "voice": "vi-VN-HoaiMyNeural",          # hoặc vi-VN-NamMinhNeural
    "ratePercent": 0,                        # tốc độ đọc -50..+100 (%)
    "readName": True,                        # đọc kèm tên người comment
    "nameMaxChars": 15,                      # tên dài hơn thì cắt
    "cooldownSeconds": 20,                   # mỗi người: tối thiểu X giây giữa 2 lần được đọc
    "dedupeSeconds": 60,                     # cùng 1 câu lặp lại trong X giây -> bỏ
    "maxQueue": 6,                           # tối đa số voice chờ phát; đầy -> bỏ comment mới
    "minChars": 2,
    "maxChars": 120,
    "truncateLong": True,                    # câu dài: cắt bớt (True) hay bỏ hẳn (False)
    "dropLinks": True,
    "blockedWords": [
        "địt", "đụ", "lồn", "cặc", "buồi", "chịch", "đéo", "vãi lồn", "vãi cặc",
        "con đĩ", "đĩ", "cave", "đồ chó", "chó đẻ", "mẹ mày", "bố mày", "cứt",
        "súc vật", "ngu lồn", "thằng chó", "con chó", "đm", "dmm", "vcl", "vl",
        "đệch", "mẹ kiếp", "tổ sư", "cha mày", "óc chó", "khốn nạn",
    ],
    "ignorePhrases": [
        "hoa rơi", "nam mô a di đà phật", "nam mô", "a di đà phật",
    ],
    "bannedUsers": [],
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                saved = json.load(f)
            cfg.update({k: v for k, v in saved.items() if k in DEFAULT_CONFIG})
        except Exception:
            pass
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


# ----------------------------------------------------------------------
class App:
    def __init__(self):
        self.cfg = load_config()
        self.filter = CommentFilter(self.cfg)
        self.raw_queue = asyncio.Queue(maxsize=100)     # comment đã qua lọc, chờ chuyển giọng
        self.audio_queue = asyncio.Queue()              # voice đã chuyển, chờ phát (giới hạn bằng maxQueue)
        self.clients = set()                            # websocket của các trang điều khiển đang mở
        self.paused = False
        self.current = None                             # voice đang phát {id, user, text}
        self._current_done = None                       # asyncio.Event cho voice đang phát
        self._seq = 0
        self.stats = {"received": 0, "accepted": 0, "played": 0, "dropped": 0,
                      "tu_cam": 0, "bo_qua": 0, "spam_trung": 0, "cooldown": 0,
                      "hang_day": 0, "tts_error": 0, "khac": 0}
        self.logs = []                                  # nhật ký gần nhất cho giao diện
        self.tiktok_status = {"state": "idle", "message": "Chưa kết nối TikTok."}
        self.source = TikTokSource(self._on_tiktok_comment, self._on_tiktok_status)

    # ---------------- nhật ký / phát trạng thái ----------------
    def log(self, kind, text, user=""):
        self.logs.append({"t": time.strftime("%H:%M:%S"), "kind": kind, "text": text, "user": user})
        self.logs = self.logs[-80:]

    async def broadcast(self, msg):
        if not self.clients:
            return
        data = json.dumps(msg, ensure_ascii=False)
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_str(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    async def push_state(self):
        await self.broadcast({
            "type": "state",
            "tiktok": self.tiktok_status,
            "paused": self.paused,
            "current": ({"user": self.current["user"], "text": self.current["text"]}
                        if self.current else None),
            "rawWaiting": self.raw_queue.qsize(),
            "audioWaiting": self.audio_queue.qsize(),
            "stats": self.stats,
            "logs": self.logs[-30:],
        })

    # ---------------- tầng 1: bắt comment + lọc ----------------
    def _on_tiktok_status(self, status):
        self.tiktok_status = status
        self.log("status", status.get("message", ""))
        asyncio.ensure_future(self.push_state())

    def _on_tiktok_comment(self, unique_id, nickname, text):
        self.ingest_comment(unique_id, nickname, text)

    def ingest_comment(self, unique_id, nickname, text):
        """Điểm vào chung cho comment thật từ TikTok và comment test từ giao diện."""
        self.stats["received"] += 1
        ok, reason, cleaned = self.filter.check(unique_id or nickname, nickname, text)
        if not ok:
            self.stats["dropped"] += 1
            key = reason if reason in self.stats else "khac"
            self.stats[key] += 1
            self.log("drop", f"bỏ ({reason}): {text}", user=nickname)
            asyncio.ensure_future(self.push_state())
            return False
        # giới hạn hàng chờ phát: đang chờ + đang chuyển + đang phát
        waiting = self.audio_queue.qsize() + self.raw_queue.qsize() + (1 if self.current else 0)
        if waiting >= int(self.cfg.get("maxQueue", 6)):
            self.stats["dropped"] += 1
            self.stats["hang_day"] += 1
            self.log("drop", f"bỏ (hàng chờ đầy): {cleaned}", user=nickname)
            asyncio.ensure_future(self.push_state())
            return False
        try:
            self.raw_queue.put_nowait({
                "uid": unique_id or nickname, "user": nickname or unique_id,
                "text": cleaned,
            })
        except asyncio.QueueFull:
            self.stats["dropped"] += 1
            self.stats["hang_day"] += 1
            return False
        self.filter.mark_read(unique_id or nickname)
        self.stats["accepted"] += 1
        self.log("ok", cleaned, user=nickname)
        asyncio.ensure_future(self.push_state())
        return True

    # ---------------- tầng 2: chuyển giọng (worker riêng) ----------------
    async def tts_worker(self):
        while True:
            item = await self.raw_queue.get()
            try:
                spoken = self._spoken_text(item)
                audio = await self._synthesize(spoken)
                if audio:
                    item = dict(item, spoken=spoken, audio=audio)
                    await self.audio_queue.put(item)
                else:
                    self.stats["tts_error"] += 1
                    self.log("error", "không chuyển được giọng: " + item["text"], user=item["user"])
            except Exception as e:
                self.stats["tts_error"] += 1
                self.log("error", "lỗi TTS: " + str(e), user=item.get("user", ""))
            finally:
                self.raw_queue.task_done()
                await self.push_state()

    def _spoken_text(self, item):
        text = normalize_text(item["text"])
        if self.cfg.get("readName"):
            name = (item["user"] or "").strip()
            name = name[: int(self.cfg.get("nameMaxChars", 15))]
            # tên toàn ký tự lạ/emoji thì bỏ qua, đọc nội dung thôi
            if name and any(c.isalnum() for c in name):
                text = f"{name} nói: {text}"
        return text

    async def _synthesize(self, text):
        """Edge TTS (giọng Microsoft) trước, lỗi thì retry, vẫn lỗi thì Google.
        Trả về bytes MP3 trong RAM — không ghi file."""
        rate = int(self.cfg.get("ratePercent", 0))
        rate_str = f"{rate:+d}%"
        last_err = None
        for attempt, wait in enumerate([0, 1, 2]):
            if wait:
                await asyncio.sleep(wait)
            try:
                import edge_tts
                comm = edge_tts.Communicate(text, self.cfg["voice"], rate=rate_str)
                buf = bytearray()
                async for chunk in comm.stream():
                    if chunk["type"] == "audio":
                        buf.extend(chunk["data"])
                if buf:
                    return bytes(buf)
                last_err = "Edge TTS trả về rỗng"
            except Exception as e:
                last_err = str(e)
        # fallback Google
        try:
            from gtts import gTTS
            def _gen():
                b = io.BytesIO()
                gTTS(text=text, lang="vi").write_to_fp(b)
                return b.getvalue()
            data = await asyncio.get_running_loop().run_in_executor(None, _gen)
            if data:
                self.log("status", "Đã dùng giọng Google dự phòng (giọng Microsoft lỗi: %s)" % (last_err or "?"))
                return data
        except Exception as e:
            self.log("error", "Cả giọng Google cũng lỗi: " + str(e))
        return None

    # ---------------- tầng 3: phát nối tiếp ----------------
    async def player_dispatcher(self):
        while True:
            item = await self.audio_queue.get()
            # chờ tới khi: không tạm dừng + có trang web đang mở để phát
            while self.paused or not self.clients:
                await asyncio.sleep(0.4)
            self.current = item
            self._current_done = asyncio.Event()
            item["id"] = item.get("id") or self._next_id()
            payload = {
                "type": "play", "id": item["id"],
                "user": item["user"], "text": item["text"], "spoken": item.get("spoken", item["text"]),
                "audio": base64.b64encode(item["audio"]).decode(),
            }
            await self.broadcast(payload)
            await self.push_state()
            try:
                await asyncio.wait_for(self._current_done.wait(), timeout=600)
                self.stats["played"] += 1
            except asyncio.TimeoutError:
                self.log("error", "Trang phát không phản hồi 10 phút, bỏ qua voice này.")
            self.current = None
            self.audio_queue.task_done()
            await self.push_state()

    def _next_id(self):
        self._seq += 1
        return f"v{self._seq}-{uuid.uuid4().hex[:6]}"

    def play_done(self, vid):
        if self.current and self.current.get("id") == vid and self._current_done:
            self._current_done.set()

    def clear_queues(self):
        for q in (self.raw_queue, self.audio_queue):
            while not q.empty():
                try:
                    q.get_nowait()
                    q.task_done()
                except Exception:
                    break


APP = App()


# ----------------------------------------------------------------------
# HTTP + WebSocket
async def index(request):
    return web.FileResponse(os.path.join(BASE, "static", "index.html"))


async def ws_handler(request):
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    APP.clients.add(ws)
    await APP.push_state()
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except Exception:
                    continue
                if data.get("type") == "play_done":
                    APP.play_done(data.get("id"))
                elif data.get("type") == "ping":
                    await ws.send_str(json.dumps({"type": "pong"}))
    finally:
        APP.clients.discard(ws)
    return ws


async def api_config_get(request):
    return web.json_response(APP.cfg)


async def api_config_post(request):
    data = await request.json()
    for k, v in data.items():
        if k in DEFAULT_CONFIG:
            APP.cfg[k] = v
    # các danh sách dạng chuỗi (mỗi dòng 1 mục) từ giao diện
    for list_key in ("blockedWords", "ignorePhrases", "bannedUsers"):
        if list_key in data and isinstance(data[list_key], str):
            APP.cfg[list_key] = [s.strip() for s in data[list_key].splitlines() if s.strip()]
    save_config(APP.cfg)
    APP.filter.cfg = APP.cfg  # filter đọc config mới ngay, giữ nguyên trạng thái cooldown/trùng
    APP.log("status", "Đã lưu cấu hình.")
    await APP.push_state()
    return web.json_response({"ok": True, "config": APP.cfg})


async def api_connect(request):
    data = await request.json()
    username = str(data.get("username", "")).strip().lstrip("@")
    if not username:
        return web.json_response({"ok": False, "error": "Chưa nhập tên phòng TikTok"}, status=400)
    APP.cfg["username"] = username
    save_config(APP.cfg)
    await APP.source.start(username)
    return web.json_response({"ok": True})


async def api_disconnect(request):
    await APP.source.stop()
    APP.tiktok_status = {"state": "idle", "message": "Đã ngắt kết nối TikTok."}
    APP.log("status", "Đã ngắt kết nối TikTok.")
    await APP.push_state()
    return web.json_response({"ok": True})


async def api_pause(request):
    data = await request.json()
    APP.paused = bool(data.get("paused"))
    APP.log("status", "Đã tạm dừng phát." if APP.paused else "Đã phát tiếp.")
    await APP.push_state()
    return web.json_response({"ok": True, "paused": APP.paused})


async def api_skip(request):
    # trang web tự dừng tiếng đang phát và gửi play_done; ở đây chỉ cần ghi nhận
    await APP.broadcast({"type": "stop_current"})
    return web.json_response({"ok": True})


async def api_clear(request):
    APP.clear_queues()
    await APP.broadcast({"type": "stop_current"})
    APP.log("status", "Đã xoá toàn bộ hàng chờ.")
    await APP.push_state()
    return web.json_response({"ok": True})


async def api_test_comment(request):
    data = await request.json()
    user = str(data.get("user", "Người test")).strip() or "Người test"
    text = str(data.get("text", "")).strip()
    if not text:
        return web.json_response({"ok": False, "error": "Chưa nhập comment test"}, status=400)
    ok = APP.ingest_comment(user, user, text)
    return web.json_response({"ok": ok})


async def api_speak_text(request):
    """Đọc thử 1 câu tự nhập (không qua bắt comment, vẫn qua hàng phát nối tiếp)."""
    data = await request.json()
    text = str(data.get("text", "")).strip()
    if not text:
        return web.json_response({"ok": False, "error": "Chưa nhập câu đọc thử"}, status=400)
    item = {"uid": "__test__", "user": "", "text": text}
    spoken = APP._spoken_text({"user": "", "text": text})
    audio = await APP._synthesize(spoken)
    if not audio:
        return web.json_response({"ok": False, "error": "Chuyển giọng thất bại"}, status=502)
    await APP.audio_queue.put(dict(item, spoken=spoken, audio=audio))
    await APP.push_state()
    return web.json_response({"ok": True})


async def on_startup(app):
    app["tts_task"] = asyncio.ensure_future(APP.tts_worker())
    app["player_task"] = asyncio.ensure_future(APP.player_dispatcher())


def build_app():
    app = web.Application()
    app.router.add_get("/", index)
    app.router.add_get("/ws", ws_handler)
    app.router.add_get("/api/config", api_config_get)
    app.router.add_post("/api/config", api_config_post)
    app.router.add_post("/api/connect", api_connect)
    app.router.add_post("/api/disconnect", api_disconnect)
    app.router.add_post("/api/pause", api_pause)
    app.router.add_post("/api/skip", api_skip)
    app.router.add_post("/api/clear", api_clear)
    app.router.add_post("/api/test-comment", api_test_comment)
    app.router.add_post("/api/speak", api_speak_text)
    app.on_startup.append(on_startup)
    return app


if __name__ == "__main__":
    print("=" * 58)
    print("  ToolVoiceTikTok — đọc comment TikTok LIVE thành giọng nói")
    print(f"  Mở trình duyệt:  http://localhost:{PORT}")
    print("  (Giữ nguyên cửa sổ này khi dùng, đóng là tắt tool)")
    print("=" * 58)
    web.run_app(build_app(), port=PORT, print=None)
