"use strict";
/**
 * ToolVoiceTikTok (Node.js) — đọc comment TikTok LIVE thành giọng nói, phát nối tiếp.
 *
 * Kiến trúc 3 tầng tách rời, nối bằng hàng đợi:
 *   [Bắt comment] -> lọc spam/từ cấm -> [Hàng chờ chuyển giọng]
 *     -> worker TTS (chuyển ngay, giữ audio trong RAM, KHÔNG lưu file)
 *     -> [Hàng chờ phát] -> gửi từng voice tới trang web, voice sau chỉ gửi
 *        khi trang web báo đã phát XONG voice trước.
 *
 * Chạy:  node server.js   rồi mở http://localhost:3220
 * Mọi tuỳ chỉnh sửa trên giao diện, lưu vào config.json cạnh file này.
 */
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { normalizeText, splitSentences } = require("./chuan-hoa");
const { CommentFilter } = require("./filters");
const { TikTokSource } = require("./tiktok-source");

const BASE = __dirname;
const CONFIG_PATH = path.join(BASE, "config.json");
const PORT = 3220;
const PROXY = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || "";

const DEFAULT_CONFIG = {
  username: "lelienreview2",
  voice: "vi-VN-HoaiMyNeural",
  ratePercent: 0,
  readName: true,
  nameTemplate: "{ten} nói:",
  nameMaxChars: 15,
  cooldownSeconds: 20,
  dedupeSeconds: 60,
  maxQueue: 6,
  minChars: 2,
  maxChars: 120,
  truncateLong: true,
  dropLinks: true,
  blockedWords: [
    "địt", "đụ", "lồn", "cặc", "buồi", "chịch", "đéo", "vãi lồn", "vãi cặc",
    "con đĩ", "đĩ", "cave", "đồ chó", "chó đẻ", "mẹ mày", "bố mày", "cứt",
    "súc vật", "ngu lồn", "thằng chó", "con chó", "đm", "dmm", "vcl", "vl",
    "đệch", "mẹ kiếp", "tổ sư", "cha mày", "óc chó", "khốn nạn",
  ],
  ignorePhrases: ["hoa rơi", "nam mô a di đà phật", "nam mô", "a di đà phật"],
  bannedUsers: [],
};

function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      for (const k of Object.keys(DEFAULT_CONFIG)) if (k in saved) cfg[k] = saved[k];
    } catch { /* config hỏng -> dùng mặc định */ }
  }
  return cfg;
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Hàng đợi async tối giản: take() chờ tới khi có phần tử.
class AsyncQueue {
  constructor() { this.items = []; this.waiters = []; }
  push(item) {
    if (this.waiters.length) this.waiters.shift()(item);
    else this.items.push(item);
  }
  take() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    return new Promise(res => this.waiters.push(res));
  }
  get size() { return this.items.length; }
  clear() { this.items = []; }
}

// ----------------------------------------------------------------------
class App {
  constructor() {
    this.cfg = loadConfig();
    this.filter = new CommentFilter(this.cfg);
    this.rawQueue = new AsyncQueue();
    this.audioQueue = new AsyncQueue();
    this.clients = new Set();
    this.paused = false;
    this.current = null;
    this._currentDoneResolve = null;
    this._seq = 0;
    this.stats = { received: 0, accepted: 0, played: 0, dropped: 0, tu_cam: 0, bo_qua: 0,
                   spam_trung: 0, cooldown: 0, hang_day: 0, tts_error: 0, khac: 0 };
    this.logs = [];
    this.tiktokStatus = { state: "idle", message: "Chưa kết nối TikTok." };
    this.source = new TikTokSource(
      (uid, nick, text) => this.ingestComment(uid, nick, text),
      status => {
        this.tiktokStatus = status;
        this.log("status", status.message || "");
        this.pushState();
      });
  }

  log(kind, text, user = "") {
    const d = new Date();
    const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, "0")).join(":");
    this.logs.push({ t, kind, text, user });
    if (this.logs.length > 500) this.logs = this.logs.slice(-500);
    // lưu lại vào file nhat-ky.log cạnh server để tắt tool vẫn xem lại được
    try {
      const day = d.toISOString().slice(0, 10);
      fs.appendFileSync(path.join(BASE, "nhat-ky.log"),
        `[${day} ${t}] ${kind}${user ? " " + user : ""}: ${text}\n`, "utf-8");
    } catch { /* ghi log lỗi thì thôi, không làm gián đoạn tool */ }
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of [...this.clients]) {
      try { ws.send(data); } catch { this.clients.delete(ws); }
    }
  }

  pushState() {
    this.broadcast({
      type: "state",
      tiktok: this.tiktokStatus,
      paused: this.paused,
      current: this.current ? { user: this.current.user, text: this.current.text } : null,
      rawWaiting: this.rawQueue.size,
      audioWaiting: this.audioQueue.size,
      waitingConvert: this.rawQueue.items.map(i => ({ user: i.user, text: i.text })),
      waitingPlay: [
        ...(this._heldItem && this._heldItem._held ? [{ user: this._heldItem.user, text: this._heldItem.text }] : []),
        ...this.audioQueue.items.map(i => ({ user: i.user, text: i.text })),
      ],
      stats: this.stats,
      logs: this.logs.slice(-100),
    });
  }

  // ---------------- tầng 1: bắt comment + lọc ----------------
  ingestComment(uniqueId, nickname, text) {
    this.stats.received++;
    const { ok, reason, text: cleaned } = this.filter.check(uniqueId || nickname, nickname, text);
    if (!ok) {
      this.stats.dropped++;
      this.stats[reason in this.stats ? reason : "khac"]++;
      this.log("drop", `bỏ (${reason}): ${text}`, nickname);
      this.pushState();
      return false;
    }
    const waiting = this.audioQueue.size + this.rawQueue.size + (this.current ? 1 : 0);
    if (waiting >= parseInt(this.cfg.maxQueue ?? 6)) {
      this.stats.dropped++; this.stats.hang_day++;
      this.log("drop", `bỏ (hàng chờ đầy): ${cleaned}`, nickname);
      this.pushState();
      return false;
    }
    if (this.rawQueue.size >= 100) {
      this.stats.dropped++; this.stats.hang_day++;
      return false;
    }
    this.rawQueue.push({ uid: uniqueId || nickname, user: nickname || uniqueId, text: cleaned });
    this.filter.markRead(uniqueId || nickname);
    this.stats.accepted++;
    this.log("ok", cleaned, nickname);
    this.pushState();
    return true;
  }

  // ---------------- tầng 2: chuyển giọng ----------------
  spokenText(item) {
    let text = normalizeText(item.text);
    if (this.cfg.readName) {
      let name = String(item.user || "").trim().slice(0, parseInt(this.cfg.nameMaxChars ?? 15));
      if (name && /[0-9a-zA-Zà-ỹÀ-Ỹ]/.test(name)) {
        // Mẫu đọc tên tuỳ chỉnh: "{ten} nói:" / "Bạn {ten} nhắn:" / "{ten} bảo:"...
        // Mẫu trống = chỉ đọc tên rồi tới nội dung; mẫu không có {ten} thì tên đứng trước mẫu.
        const tpl = String(this.cfg.nameTemplate ?? "{ten} nói:").trim();
        let prefix;
        if (!tpl) prefix = name;
        else if (tpl.includes("{ten}")) prefix = tpl.split("{ten}").join(name).trim();
        else prefix = (name + " " + tpl).trim();
        if (prefix) text = `${prefix} ${text}`;
      }
    }
    return text;
  }

  async synthesize(text) {
    const rate = parseInt(this.cfg.ratePercent ?? 0);
    let lastErr = null;
    for (const wait of [0, 1000, 2000]) {
      if (wait) await sleep(wait);
      try {
        const buf = await this._edgeSynthesize(text, rate);
        if (buf && buf.length) return buf;
        lastErr = "Edge TTS trả về rỗng";
      } catch (e) { lastErr = String((e && e.message) || e); }
    }
    try {
      const buf = await this._googleSynthesize(text);
      if (buf && buf.length) {
        this.log("status", "Đã dùng giọng Google dự phòng (giọng Microsoft lỗi: " + (lastErr || "?") + ")");
        return buf;
      }
    } catch (e) {
      this.log("error", "Cả giọng Google cũng lỗi: " + String((e && e.message) || e));
    }
    return null;
  }

  async _edgeSynthesize(text, rate) {
    const { EdgeTTS } = require("node-edge-tts");
    const tts = new EdgeTTS({
      voice: this.cfg.voice,
      lang: "vi-VN",
      rate: rate === 0 ? "default" : (rate > 0 ? `+${rate}%` : `${rate}%`),
      proxy: PROXY || undefined,
      timeout: 45000,
    });
    const bufs = [];
    for await (const chunk of tts.streamAudio(text)) {
      if (Buffer.isBuffer(chunk)) bufs.push(chunk);
    }
    return Buffer.concat(bufs);
  }

  _googleChunk(chunk) {
    const url = "https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=vi&q=" + encodeURIComponent(chunk);
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, timeout: 30000 }, res => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error("Google TTS HTTP " + res.statusCode)); }
        const bufs = [];
        res.on("data", d => bufs.push(d));
        res.on("end", () => resolve(Buffer.concat(bufs)));
      });
      req.on("timeout", () => req.destroy(new Error("Google TTS quá thời gian chờ")));
      req.on("error", reject);
    });
  }

  async _googleSynthesize(text) {
    const parts = [];
    for (const chunk of splitSentences(text, 180)) parts.push(await this._googleChunk(chunk));
    return Buffer.concat(parts);
  }

  async ttsWorker() {
    while (true) {
      const item = await this.rawQueue.take();
      try {
        const spoken = this.spokenText(item);
        const audio = await this.synthesize(spoken);
        if (audio) this.audioQueue.push({ ...item, spoken, audio });
        else {
          this.stats.tts_error++;
          this.log("error", "không chuyển được giọng: " + item.text, item.user);
        }
      } catch (e) {
        this.stats.tts_error++;
        this.log("error", "lỗi TTS: " + String((e && e.message) || e), item.user || "");
      }
      this.pushState();
    }
  }

  // ---------------- tầng 3: phát nối tiếp ----------------
  async playerDispatcher() {
    while (true) {
      const item = await this.audioQueue.take();
      item.id = item.id || `v${++this._seq}-${Math.random().toString(16).slice(2, 8)}`;
      item._held = true;              // đang được dispatcher giữ (chờ phát/tạm dừng)
      this._heldItem = item;
      // Gửi voice tới trang phát; nếu trang mất kết nối giữa chừng (đóng tab,
      // rớt mạng, trình duyệt treo) thì GIỮ NGUYÊN voice này và gửi lại khi
      // trang kết nối lại — không chờ vô hạn, không mất voice.
      let finished = false;
      while (!finished) {
        while (this.paused || this.clients.size === 0) await sleep(400);
        this.current = item;
        item._held = false;           // đã gửi đi phát -> không còn tính là "chờ"
        const donePromise = new Promise(res => { this._currentDoneResolve = res; });
        this.broadcast({
          type: "play", id: item.id, user: item.user, text: item.text,
          spoken: item.spoken || item.text, audio: item.audio.toString("base64"),
        });
        this.pushState();
        let timer, watcher;
        const timeout = new Promise(res => { timer = setTimeout(() => res("timeout"), 120000); });
        const noClients = new Promise(res => {
          watcher = setInterval(() => { if (this.clients.size === 0) res("retry"); }, 1000);
        });
        const result = await Promise.race([donePromise, timeout, noClients]);
        clearTimeout(timer); clearInterval(watcher);
        this._currentDoneResolve = null;
        if (result === "done") {
          this.stats.played++;
          finished = true;
        } else if (result === "timeout") {
          this.log("error", "Trang phát không phản hồi 2 phút, bỏ qua voice này.");
          finished = true;
        } else {
          // "retry": trang phát vừa mất kết nối — vòng lại, chờ trang nối lại rồi gửi lại
          this.log("status", "Trang phát mất kết nối, giữ voice chờ gửi lại...");
          this.current = null;
          this.pushState();
          await sleep(600);
        }
      }
      this.current = null;
      this._heldItem = null;
      this.pushState();
    }
  }

  playDone(id) {
    if (this.current && this.current.id === id && this._currentDoneResolve) this._currentDoneResolve("done");
  }

  clearQueues() {
    this.rawQueue.clear();
    this.audioQueue.clear();
  }
}

const APP = new App();

// ----------------------------------------------------------------------
function readJson(req) {
  return new Promise(resolve => {
    const bufs = [];
    req.on("data", d => bufs.push(d));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(bufs).toString("utf-8") || "{}")); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  try {
    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(BASE, "static", "index.html")));
    }
    if (req.method === "GET" && p === "/api/config") return json(res, 200, APP.cfg);

    if (req.method === "POST" && p === "/api/config") {
      const data = await readJson(req);
      for (const [k, v] of Object.entries(data)) if (k in DEFAULT_CONFIG) APP.cfg[k] = v;
      for (const key of ["blockedWords", "ignorePhrases", "bannedUsers"]) {
        if (typeof data[key] === "string")
          APP.cfg[key] = data[key].split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      }
      saveConfig(APP.cfg);
      APP.filter.cfg = APP.cfg;
      APP.log("status", "Đã lưu cấu hình.");
      APP.pushState();
      return json(res, 200, { ok: true, config: APP.cfg });
    }
    if (req.method === "POST" && p === "/api/connect") {
      const data = await readJson(req);
      const username = String(data.username || "").trim().replace(/^@/, "");
      if (!username) return json(res, 400, { ok: false, error: "Chưa nhập tên phòng TikTok" });
      APP.cfg.username = username;
      saveConfig(APP.cfg);
      await APP.source.start(username);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/disconnect") {
      await APP.source.stop();
      APP.tiktokStatus = { state: "idle", message: "Đã ngắt kết nối TikTok." };
      APP.log("status", "Đã ngắt kết nối TikTok.");
      APP.pushState();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/pause") {
      const data = await readJson(req);
      APP.paused = !!data.paused;
      APP.log("status", APP.paused ? "Đã tạm dừng phát." : "Đã phát tiếp.");
      APP.pushState();
      return json(res, 200, { ok: true, paused: APP.paused });
    }
    if (req.method === "POST" && p === "/api/skip") {
      APP.broadcast({ type: "stop_current" });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/clear") {
      APP.clearQueues();
      APP.broadcast({ type: "stop_current" });
      APP.log("status", "Đã xoá toàn bộ hàng chờ.");
      APP.pushState();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/test-comment") {
      const data = await readJson(req);
      const user = String(data.user || "Người test").trim() || "Người test";
      const text = String(data.text || "").trim();
      if (!text) return json(res, 400, { ok: false, error: "Chưa nhập comment test" });
      return json(res, 200, { ok: APP.ingestComment(user, user, text) });
    }
    if (req.method === "POST" && p === "/api/speak") {
      const data = await readJson(req);
      const text = String(data.text || "").trim();
      if (!text) return json(res, 400, { ok: false, error: "Chưa nhập câu đọc thử" });
      const spoken = APP.spokenText({ user: "", text });
      const audio = await APP.synthesize(spoken);
      if (!audio) return json(res, 502, { ok: false, error: "Chuyển giọng thất bại" });
      APP.audioQueue.push({ uid: "__test__", user: "", text, spoken, audio });
      APP.pushState();
      return json(res, 200, { ok: true });
    }
    json(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });
// Heartbeat: phát hiện kết nối chết ngầm (treo/rớt mạng mà không đóng hẳn)
// để loại khỏi danh sách trang phát sau tối đa ~60 giây thay vì kẹt vô hạn.
setInterval(() => {
  for (const ws of [...APP.clients]) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch { /* bỏ qua */ }
      APP.clients.delete(ws);
      continue;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* bỏ qua */ }
  }
}, 30000);
wss.on("connection", ws => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  APP.clients.add(ws);
  APP.pushState();
  ws.on("message", raw => {
    try {
      const data = JSON.parse(String(raw));
      if (data.type === "play_done") APP.playDone(data.id);
      else if (data.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    } catch { /* bỏ qua */ }
  });
  ws.on("close", () => APP.clients.delete(ws));
  ws.on("error", () => APP.clients.delete(ws));
});

server.listen(PORT, () => {
  console.log("=".repeat(58));
  console.log("  ToolVoiceTikTok (Node.js) — đọc comment TikTok LIVE thành giọng nói");
  console.log(`  Mở trình duyệt:  http://localhost:${PORT}`);
  console.log("  (Giữ nguyên cửa sổ này khi dùng, đóng là tắt tool)");
  console.log("=".repeat(58));
  APP.ttsWorker();
  APP.playerDispatcher();
});
