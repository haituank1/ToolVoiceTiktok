"use strict";
// Nguồn bắt comment TikTok LIVE qua thư viện tiktok-live-connector
// (không chính thức, chỉ cần @tên phòng, không cần đăng nhập/mật khẩu TikTok).
// Sự kiện đẩy ra qua callback: onComment(uniqueId, nickname, text), onStatus({state, message}).

let TLC = null, LOAD_ERROR = "";
try {
  TLC = require("tiktok-live-connector");
} catch (e) {
  LOAD_ERROR = String(e && e.message || e);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class TikTokSource {
  constructor(onComment, onStatus) {
    this.onComment = onComment;
    this.onStatus = onStatus;
    this.conn = null;
    this._stop = true;
    this.username = "";
    this._loopPromise = null;
  }

  get available() { return !!TLC; }

  async start(username) {
    if (!TLC) {
      this.onStatus({ state: "error", message: "Chưa cài được thư viện tiktok-live-connector: " + LOAD_ERROR });
      return;
    }
    await this.stop();
    this._stop = false;
    this.username = String(username || "").trim().replace(/^@/, "");
    this._loopPromise = this._runLoop();
  }

  async stop() {
    this._stop = true;
    if (this.conn) {
      try { this.conn.disconnect(); } catch { /* bỏ qua */ }
      this.conn = null;
    }
    if (this._loopPromise) {
      try { await Promise.race([this._loopPromise, sleep(3000)]); } catch { /* bỏ qua */ }
      this._loopPromise = null;
    }
  }

  async _runLoop() {
    let attempt = 0;
    while (!this._stop) {
      attempt++;
      try {
        this.onStatus({ state: "connecting", message: `Đang kết nối tới @${this.username} (lần ${attempt})...` });
        const conn = new TLC.TikTokLiveConnection("@" + this.username, {});
        this.conn = conn;

        const disconnected = new Promise(resolve => {
          conn.on(TLC.ControlEvent.CONNECTED, () => {
            this.onStatus({ state: "connected", message: `Đã kết nối phòng @${this.username}` + (conn.roomId ? ` (room ${conn.roomId})` : "") });
          });
          conn.on(TLC.WebcastEvent.CHAT, data => {
            try {
              const user = data.user || {};
              const uid = user.uniqueId || user.displayId || data.uniqueId || user.nickname || "";
              const nick = user.nickname || uid;
              const text = data.content || data.comment || "";
              if (text) this.onComment(uid, nick, text);
            } catch { /* bỏ qua comment lỗi */ }
          });
          conn.on(TLC.ControlEvent.DISCONNECTED, () => resolve("disconnected"));
          conn.on(TLC.ControlEvent.ERROR, () => { /* lỗi chi tiết xử lý ở connect() */ });
        });

        await Promise.race([
          conn.connect(),
          sleep(30000).then(() => { throw new Error("timeout khi kết nối TikTok"); }),
        ]);
        // đã kết nối: chờ tới khi mất kết nối / live kết thúc
        const why = await Promise.race([
          disconnected,
          (async () => { while (!this._stop && conn.isConnected) await sleep(1000); return "closed"; })(),
        ]);
        if (!this._stop) {
          this.onStatus({ state: "ended", message: why === "disconnected" ? "Mất kết nối / live đã kết thúc." : "Kết nối đã đóng." });
        }
      } catch (e) {
        if (this._stop) break;
        const msg = String((e && e.message) || e);
        const low = msg.toLowerCase();
        if (e && e.name === "UserOfflineError" || low.includes("not live") || low.includes("offline") || low.includes("useroffline")) {
          this.onStatus({ state: "not_live", message: `@${this.username} hiện không live (hoặc sai tên). Tool sẽ tự thử lại sau 20 giây.` });
        } else if (low.includes("timeout") || low.includes("connect") || low.includes("network") || low.includes("econn") || low.includes("socket") || low.includes("eproto") || low.includes("ssl") || low.includes("wrong version") || low.includes("tls")) {
          this.onStatus({ state: "error", message: "Không tới được máy chủ TikTok (mạng chậm hoặc bị chặn). Tool sẽ tự thử lại sau 20 giây." });
        } else {
          this.onStatus({ state: "error", message: "Lỗi kết nối TikTok: " + msg });
        }
      }
      if (this.conn) { try { this.conn.disconnect(); } catch { /* bỏ qua */ } this.conn = null; }
      for (let i = 0; i < 20 && !this._stop; i++) await sleep(1000);
    }
  }
}

module.exports = { TikTokSource };
