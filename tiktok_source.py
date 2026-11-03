# -*- coding: utf-8 -*-
"""Nguồn bắt comment TikTok LIVE qua thư viện TikTokLive (không chính thức,
chỉ cần @tên phòng, không cần đăng nhập/mật khẩu TikTok).

Mọi sự kiện được đẩy ra qua callback để server.py không phụ thuộc trực tiếp
vào thư viện này: on_comment(unique_id, nickname, text), on_status(dict).
"""
import asyncio
import os

# Một số môi trường đặt NO_PROXY chứa địa chỉ IPv6 trần khiến thư viện HTTP
# lỗi "Invalid port" khi đọc biến môi trường — lọc bỏ các mục đó cho an toàn.
for _k in ("no_proxy", "NO_PROXY"):
    if _k in os.environ:
        os.environ[_k] = ",".join(p for p in os.environ[_k].split(",")
                                  if ":" not in p.strip().strip("[]") or p.strip() in ("::1", "[::1]"))

try:
    from TikTokLive import TikTokLiveClient
    from TikTokLive.events import CommentEvent, ConnectEvent, DisconnectEvent, LiveEndEvent
    _HAS_TIKTOK = True
    _IMPORT_ERROR = ""
except Exception as e:  # thư viện chưa cài / lỗi import
    _HAS_TIKTOK = False
    _IMPORT_ERROR = str(e)


class TikTokSource:
    def __init__(self, on_comment, on_status):
        self.on_comment = on_comment
        self.on_status = on_status
        self._client = None
        self._task = None
        self._stop = False
        self.username = ""

    @property
    def available(self):
        return _HAS_TIKTOK

    async def start(self, username):
        if not _HAS_TIKTOK:
            self.on_status({"state": "error", "message": "Chưa cài được thư viện TikTokLive: " + _IMPORT_ERROR})
            return
        await self.stop()
        self._stop = False
        self.username = username.strip().lstrip("@")
        self._task = asyncio.ensure_future(self._run_loop())

    async def stop(self):
        self._stop = True
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:
                pass
            self._client = None
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except Exception:
                pass
            self._task = None

    async def _run_loop(self):
        attempt = 0
        while not self._stop:
            attempt += 1
            try:
                self.on_status({"state": "connecting",
                                "message": f"Đang kết nối tới @{self.username} (lần {attempt})..."})
                client = TikTokLiveClient(unique_id="@" + self.username)
                self._client = client

                @client.on(ConnectEvent)
                async def _on_connect(event):
                    room = getattr(event, "room_id", "") or ""
                    self.on_status({"state": "connected",
                                    "message": f"Đã kết nối phòng @{self.username}" + (f" (room {room})" if room else "")})

                @client.on(CommentEvent)
                async def _on_comment(event):
                    try:
                        user = event.user
                        uid = (getattr(user, "unique_id", "") or getattr(user, "display_id", "")
                               or getattr(user, "nickname", ""))
                        nick = getattr(user, "nickname", "") or uid
                        # TikTokLive v7: nội dung nằm ở .content; bản cũ ở .comment
                        text = getattr(event, "content", "") or getattr(event, "comment", "")
                        if text:
                            self.on_comment(uid, nick, text)
                    except Exception:
                        pass

                @client.on(LiveEndEvent)
                async def _on_live_end(event):
                    self.on_status({"state": "ended", "message": "Buổi live đã kết thúc."})

                @client.on(DisconnectEvent)
                async def _on_disconnect(event):
                    self.on_status({"state": "disconnected", "message": "Mất kết nối tới phòng live."})

                await client.start()
                # client.start() trở về khi live kết thúc / ngắt kết nối
                if not self._stop:
                    self.on_status({"state": "ended", "message": "Kết nối đã đóng (live kết thúc?)."})
            except asyncio.CancelledError:
                raise
            except Exception as e:
                msg = str(e) or e.__class__.__name__
                low = msg.lower()
                if "timeout" in low or "connect" in low:
                    self.on_status({"state": "error",
                                    "message": "Không tới được máy chủ TikTok (mạng chậm hoặc bị chặn). Tool sẽ tự thử lại sau 20 giây."})
                elif "not live" in low or "offline" in low or "failed to find room" in low or "room id" in low:
                    self.on_status({"state": "not_live",
                                    "message": f"@{self.username} hiện không live (hoặc sai tên). Tool sẽ tự thử lại sau 20 giây."})
                else:
                    self.on_status({"state": "error", "message": "Lỗi kết nối TikTok: " + msg})
            if self._stop:
                break
            # tự kết nối lại sau 20 giây chừng nào người dùng chưa bấm Dừng
            for _ in range(20):
                if self._stop:
                    break
                await asyncio.sleep(1)
