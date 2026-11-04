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
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { normalizeText, splitSentences } = require("./chuan-hoa");
const { CommentFilter } = require("./filters");
const { TikTokSource } = require("./tiktok-source");

const BASE = __dirname;
const CONFIG_PATH = path.join(BASE, "config.json");
// Bộ nhớ đệm giọng cho câu TỰ CHÈN: các câu này lặp lại y hệt nhau nên voice
// chuyển được 1 lần sẽ lưu vào thư mục này, lần sau lấy ra phát luôn.
const CACHE_DIR = path.join(BASE, "voice-cache");
const CACHE_INDEX = path.join(CACHE_DIR, "index.json");
const PORT = 3220;
const PROXY = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY || "";

const DEFAULT_CONFIG = {
  username: "lelienreview2",
  // Nhường tiếng cho NPC trong game (MC đám cưới / thầy chùa qua LiveBridge):
  // NPC nói thì voice khán giả tự tắt tiếng + giữ hàng chờ, nói xong phát tiếp.
  npcMute: true,
  livebridgeUrl: "ws://localhost:8787",
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
    "súc vật", "ngu lồn", "thằng chó", "con chó", "đm", "dmm",
    "đệch", "mẹ kiếp", "tổ sư", "cha mày", "óc chó", "khốn nạn",
  ],
  // Từ đệm kiểu "vl", "vcl": thường chỉ là từ nhấn mạnh ("vui vl" = vui lắm),
  // không cấm cả câu — chỉ tự xoá khỏi câu trước khi đọc cho khỏi kỳ.
  softWords: ["vl", "vcl"],
  ignorePhrases: ["hoa rơi", "nam mô a di đà phật", "nam mô", "a di đà phật"],
  bannedUsers: [],
  // Tự chèn câu có sẵn: cứ mỗi autoInsertSeconds giây, lấy ngẫu nhiên 1 câu
  // trong nhóm đang chọn (activeGroupId) và đưa vào hàng chờ đọc.
  autoInsertEnabled: false,
  autoInsertSeconds: 180,
  activeGroupId: "chua",
  sentenceGroups: [
    { id: "chua", name: "Live chùa", sentences: [
      "Các bạn mới vào nhớ bấm theo dõi thầy để không lạc đường nhé",
      "Bạn nào chưa có pháp danh thì bấm theo dõi, thầy tặng pháp danh cho nhé",
      "Các bạn gõ Nam mô A Di Đà Phật để lạy Phật cùng thầy nhé",
    ] },
    { id: "banhang", name: "Live bán hàng", sentences: [
      "Các chị ưng mẫu nào thì comment size để em chốt đơn nhé",
      "Mẫu hôm nay số lượng có hạn, các chị nhanh tay kẻo hết nhé",
    ] },
  ],
};

function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      for (const k of Object.keys(DEFAULT_CONFIG)) if (k in saved) cfg[k] = saved[k];
      // Di trú config cũ: "vl"/"vcl" từng nằm trong từ cấm, nay là từ đệm.
      // Config nào chưa có softWords thì tự chuyển 2 từ này sang nhóm từ đệm;
      // người dùng muốn cấm hẳn lại thì cứ thêm lại vào ô Từ cấm trên giao diện.
      if (!("softWords" in saved) && Array.isArray(cfg.blockedWords)) {
        cfg.blockedWords = cfg.blockedWords.filter(w => !["vl", "vcl"].includes(String(w).trim().toLowerCase()));
      }
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
    this.npcHold = false;   // NPC trong game đang nói (qua LiveBridge) -> giữ mọi voice khán giả
    this.current = null;
    this._currentDoneResolve = null;
    this._seq = 0;
    this.stats = { received: 0, accepted: 0, played: 0, dropped: 0, tu_cam: 0, bo_qua: 0,
                   spam_trung: 0, cooldown: 0, hang_day: 0, tts_error: 0, khac: 0, tu_chen: 0 };
    this._autoTimer = null;
    this._autoLastIdx = -1;
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
    if (this.logs.length > 50) this.logs = this.logs.slice(-50);
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
      npcHold: this.npcHold,
      current: this.current ? { user: this.current.user, text: this.current.text } : null,
      rawWaiting: this.rawQueue.size,
      audioWaiting: this.audioQueue.size,
      waitingConvert: this.rawQueue.items.map(i => ({ user: i.auto ? "🔁 Tự chèn" : i.user, text: i.text })),
      waitingPlay: [
        ...(this._heldItem && this._heldItem._held ? [{ user: this._heldItem.auto ? "🔁 Tự chèn" : this._heldItem.user, text: this._heldItem.text }] : []),
        ...this.audioQueue.items.map(i => ({ user: i.auto ? "🔁 Tự chèn" : i.user, text: i.text })),
      ],
      stats: this.stats,
      logs: this.logs.slice(-30),
    });
  }

  // ---------------- tầng 1: bắt comment + lọc ----------------
  // opts.owner: câu do CHỦ PHÒNG tự thêm (comment giả bấm tay) — được ưu tiên:
  // bỏ qua cooldown/chống trùng và KHÔNG bị chặn bởi "số voice chờ tối đa".
  // Các luật nội dung (từ cấm, lệnh game, link...) vẫn áp dụng như comment thật.
  ingestComment(uniqueId, nickname, text, opts = {}) {
    const owner = !!opts.owner;
    this.stats.received++;
    const { ok, reason, text: cleaned } = this.filter.check(
      uniqueId || nickname, nickname, text, undefined, { skipSpamRules: owner });
    if (!ok) {
      this.stats.dropped++;
      this.stats[reason in this.stats ? reason : "khac"]++;
      this.log("drop", `bỏ (${reason}): ${text}`, nickname);
      this.pushState();
      return { accepted: false, reason };
    }
    if (!owner) {
      const waiting = this.audioQueue.size + this.rawQueue.size + (this.current ? 1 : 0);
      if (waiting >= parseInt(this.cfg.maxQueue ?? 6)) {
        this.stats.dropped++; this.stats.hang_day++;
        this.log("drop", `bỏ (hàng chờ đầy): ${cleaned}`, nickname);
        this.pushState();
        return { accepted: false, reason: "hang_day" };
      }
    }
    if (this.rawQueue.size >= 100) { // chốt an toàn chống tràn bộ nhớ, không phải giới hạn người dùng
      this.stats.dropped++; this.stats.hang_day++;
      return { accepted: false, reason: "hang_day" };
    }
    this.rawQueue.push({ uid: uniqueId || nickname, user: nickname || uniqueId, text: cleaned, owner });
    if (!owner) this.filter.markRead(uniqueId || nickname);
    this.stats.accepted++;
    this.log("ok", (opts.fake ? "(comment giả) " : "") + cleaned, nickname);
    this.pushState();
    return { accepted: true };
  }

  // ---------------- tự chèn câu có sẵn ----------------
  restartAutoInsert() {
    if (this._autoTimer) { clearTimeout(this._autoTimer); this._autoTimer = null; }
    if (!this.cfg.autoInsertEnabled) return;
    const sec = Math.min(3600, Math.max(15, parseInt(this.cfg.autoInsertSeconds ?? 180) || 180));
    this._autoTimer = setTimeout(() => {
      this._autoTimer = null;
      try { this.maybeAutoInsert(); } catch { /* lỗi 1 vòng thì thôi, vòng sau lại chạy */ }
      this.restartAutoInsert();
    }, sec * 1000);
    if (this._autoTimer.unref) this._autoTimer.unref();
  }

  maybeAutoInsert() {
    if (!this.cfg.autoInsertEnabled) return;
    if (!this.clients.size) return; // panel không mở thì chèn cũng không ai phát
    const groups = Array.isArray(this.cfg.sentenceGroups) ? this.cfg.sentenceGroups : [];
    const g = groups.find(x => x && x.id === this.cfg.activeGroupId) || groups[0];
    if (!g) return;
    const sentences = (g.sentences || []).map(s => String(s).trim()).filter(Boolean);
    if (!sentences.length || this.rawQueue.size >= 100) return;
    let idx = Math.floor(Math.random() * sentences.length);
    if (sentences.length > 1 && idx === this._autoLastIdx) idx = (idx + 1) % sentences.length;
    this._autoLastIdx = idx;
    const text = sentences[idx];
    // Câu của chủ phòng: vào thẳng hàng chờ, không qua bộ lọc, không bị giới hạn hàng chờ.
    this.rawQueue.push({ uid: "__auto__", user: "", text, auto: true });
    this.stats.tu_chen++;
    this.log("auto", `Tự chèn (${g.name}): ${text}`);
    this.pushState();
  }

  // ---------------- tầng 2: chuyển giọng ----------------
  spokenText(item) {
    let text = normalizeText(item.text);
    if (item.auto) return text; // câu tự chèn: đọc nguyên câu, không gắn tên ai cả
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

  // ---------------- bộ nhớ đệm giọng cho câu tự chèn ----------------
  // Khoá cache gồm cả giọng + tốc độ: đổi giọng/tốc độ là tự dùng khoá mới,
  // không bao giờ phát nhầm voice của thiết lập cũ.
  _cacheKey(spoken) {
    const raw = `${this.cfg.voice}|${parseInt(this.cfg.ratePercent ?? 0)}|${spoken}`;
    return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
  }

  _loadVoiceCache(spoken) {
    try {
      const f = path.join(CACHE_DIR, this._cacheKey(spoken) + ".mp3");
      if (fs.existsSync(f)) {
        const buf = fs.readFileSync(f);
        if (buf.length > 500) return buf;
      }
    } catch { /* file hỏng/không đọc được -> coi như chưa có cache */ }
    return null;
  }

  _saveVoiceCache(spoken, buf, originalText) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      const key = this._cacheKey(spoken);
      fs.writeFileSync(path.join(CACHE_DIR, key + ".mp3"), buf);
      let idx = {};
      try { idx = JSON.parse(fs.readFileSync(CACHE_INDEX, "utf-8")); } catch { idx = {}; }
      idx[key] = { text: originalText, spoken, voice: this.cfg.voice,
                   rate: parseInt(this.cfg.ratePercent ?? 0), savedAt: new Date().toISOString() };
      fs.writeFileSync(CACHE_INDEX, JSON.stringify(idx, null, 1), "utf-8");
      this.log("auto", `Đã lưu voice vào bộ nhớ đệm: ${originalText}`);
    } catch (e) {
      this.log("error", "Không lưu được voice vào bộ nhớ đệm: " + String((e && e.message) || e));
    }
  }

  clearVoiceCache() {
    let removed = 0;
    try {
      if (fs.existsSync(CACHE_DIR)) {
        for (const name of fs.readdirSync(CACHE_DIR)) {
          try { fs.unlinkSync(path.join(CACHE_DIR, name)); removed++; } catch { /* bỏ qua */ }
        }
      }
    } catch { /* thư mục không có thì thôi */ }
    return removed;
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
        // Câu tự chèn: có voice sẵn trong bộ nhớ đệm thì dùng luôn, khỏi chuyển lại
        let audio = item.auto ? this._loadVoiceCache(spoken) : null;
        if (audio) {
          this.log("auto", `Dùng voice có sẵn trong bộ nhớ đệm: ${item.text}`);
        } else {
          audio = await this.synthesize(spoken);
          if (audio && item.auto) this._saveVoiceCache(spoken, audio, item.text);
        }
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
        while (this.paused || this.npcHold || this.clients.size === 0) await sleep(400);
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

  // NPC trong game (MC / thầy) bắt đầu / nói xong — LiveBridge báo qua WS.
  // Đang phát dở thì trang phát tự pause (xem static/index.html), câu chưa
  // phát thì dispatcher giữ nguyên trong hàng chờ tới khi NPC nói xong.
  setNpcHold(hold, text = "") {
    if (!this.cfg.npcMute) hold = false;
    if (this.npcHold === hold) return;
    this.npcHold = hold;
    this.log("status", hold ? `NPC đang nói, tạm giữ voice khán giả: ${text}` : "NPC nói xong, phát tiếp voice khán giả.");
    this.broadcast({ type: "npc_hold", hold });
    this.pushState();
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
      for (const key of ["blockedWords", "softWords", "ignorePhrases", "bannedUsers"]) {
        if (typeof data[key] === "string")
          APP.cfg[key] = data[key].split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      }
      if (Array.isArray(data.sentenceGroups)) {
        APP.cfg.sentenceGroups = data.sentenceGroups.slice(0, 20).map((g, i) => ({
          id: String((g && g.id) || ("g" + i)).slice(0, 40),
          name: String((g && g.name) || ("Nhóm " + (i + 1))).slice(0, 60),
          sentences: Array.isArray(g && g.sentences)
            ? g.sentences.map(s => String(s).trim()).filter(Boolean).slice(0, 200) : [],
        }));
      }
      saveConfig(APP.cfg);
      APP.filter.cfg = APP.cfg;
      APP.restartAutoInsert();
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
    if (req.method === "POST" && p === "/api/clear-voice-cache") {
      const removed = APP.clearVoiceCache();
      APP.log("status", `Đã xoá bộ nhớ đệm giọng (${removed} file).`);
      APP.pushState();
      return json(res, 200, { ok: true, removed });
    }
    if (req.method === "POST" && p === "/api/test-comment") {
      const data = await readJson(req);
      const user = String(data.user || "Người test").trim() || "Người test";
      const text = String(data.text || "").trim();
      if (!text) return json(res, 400, { ok: false, error: "Chưa nhập comment test" });
      const r = APP.ingestComment(user, user, text, { owner: true, fake: true });
      return json(res, 200, { ok: true, accepted: r.accepted, reason: r.reason || null });
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

/* Kết nối nghe trạng thái NPC từ LiveBridge (role=voice-monitor, không nhận
   sự kiện game). LiveBridge chưa chạy thì cứ thử lại nhẹ nhàng, không lỗi. */
function connectNpcMonitor() {
  const url = String(APP.cfg.livebridgeUrl || "ws://localhost:8787").replace(/\/$/, "") + "/?role=voice-monitor";
  let ws;
  try { ws = new WebSocket(url); } catch { setTimeout(connectNpcMonitor, 5000); return; }
  ws.on("message", raw => {
    try {
      const m = JSON.parse(String(raw));
      if (m.type === "npc-voice") APP.setNpcHold(m.state === "start", m.text || "");
    } catch { /* bỏ qua */ }
  });
  const retry = () => { APP.setNpcHold(false); setTimeout(connectNpcMonitor, 3000); };
  ws.on("close", retry);
  ws.on("error", () => { try { ws.close(); } catch { /* bỏ qua */ } });
}

server.listen(PORT, () => {
  console.log("=".repeat(58));
  console.log("  ToolVoiceTikTok (Node.js) — đọc comment TikTok LIVE thành giọng nói");
  console.log(`  Mở trình duyệt:  http://localhost:${PORT}`);
  console.log("  (Giữ nguyên cửa sổ này khi dùng, đóng là tắt tool)");
  console.log("=".repeat(58));
  APP.ttsWorker();
  APP.playerDispatcher();
  APP.restartAutoInsert();
  connectNpcMonitor();
});
