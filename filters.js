"use strict";
// Bộ lọc comment: chống spam + lọc từ cấm/từ bỏ qua. Mọi ngưỡng lấy từ config
// (người dùng sửa trên giao diện). Bản Node.js của filters.py, logic giống hệt.
//
// Soi từ cấm 3 lớp: (1) giữ dấu — phân biệt cặc/các, đĩ/đi, buổi/buồi;
// (2) bỏ dấu theo token/cụm token; (3) dạng rút gọn cho từ đơn — bắt viết chèn
// ký tự "đ.m", viết liền "dmm", chữ lặp "địttt". Các dạng bỏ dấu mơ hồ
// (cac, di, du, lon, deo, buoi) không dùng để kết luận ở lớp bỏ dấu.

const LEET = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s" };
const AMBIGUOUS_STRIPPED = new Set(["cac", "di", "du", "lon", "deo", "buoi"]);

function stripAccents(s) {
  return String(s || "").replace(/đ/g, "d").replace(/Đ/g, "D")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function collapseRepeats(tok) {
  return tok.replace(/([a-z])\1{2,}/g, "$1");
}

function normalizeForMatch(s) {
  let t = stripAccents(String(s || "").toLowerCase());
  t = [...t].map(c => LEET[c] || c).join("");
  const rawTokens = t.match(/[a-z0-9]+/g) || [];
  const tokens = rawTokens.map(collapseRepeats);
  const compact = collapseRepeats(rawTokens.join(""));
  return { tokens, compact };
}

function tokensAccented(s) {
  const toks = String(s || "").toLowerCase().match(/[0-9a-zà-ỹđ]+/gu) || [];
  return toks.map(t => t.replace(/([a-zà-ỹđ])\1{2,}/gu, "$1"));
}

function phraseForms(phrase) {
  return normalizeForMatch(phrase);
}

function seqIn(seq, toks) {
  const n = seq.length;
  if (!n) return false;
  for (let i = 0; i + n <= toks.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) if (toks[i + j] !== seq[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

class CommentFilter {
  constructor(config) {
    this.cfg = config;
    this._userLastTime = new Map();
    this._userLastText = new Map();
    this._globalLastText = new Map();
  }

  _matchList(tokens, compact, phrases, accTokens, strictAmbiguous = true) {
    const tokenSet = new Set(tokens);
    const acc = accTokens || [];
    const accSet = new Set(acc);
    const glued = new Set();
    for (let i = 0; i < tokens.length; i++) {
      if (i + 1 < tokens.length) glued.add(tokens[i] + tokens[i + 1]);
      if (i + 2 < tokens.length) glued.add(tokens[i] + tokens[i + 1] + tokens[i + 2]);
    }
    for (const phRaw of phrases || []) {
      const ph = String(phRaw).trim();
      if (!ph) continue;
      const { tokens: pTokens, compact: pCompact } = phraseForms(ph);
      const pAcc = tokensAccented(ph);
      if (!pTokens.length && !pAcc.length) continue;
      // lớp 1: giữ dấu
      if (pAcc.length === 1 && accSet.has(pAcc[0])) return ph;
      if (pAcc.length > 1 && seqIn(pAcc, acc)) return ph;
      // cụm chứa token mơ hồ: chỉ tin lớp giữ dấu (chỉ với danh sách từ cấm)
      if (strictAmbiguous && pTokens.length > 1 && pTokens.some(t => AMBIGUOUS_STRIPPED.has(t))) continue;
      // lớp 2: bỏ dấu theo token
      if (pTokens.length === 1 && tokenSet.has(pTokens[0])) {
        if (!AMBIGUOUS_STRIPPED.has(pCompact)) return ph;
        continue;
      }
      if (pTokens.length > 1 && seqIn(pTokens, tokens)) return ph;
      // lớp 3: dạng rút gọn — chỉ từ đơn
      if (pTokens.length !== 1) continue;
      if (AMBIGUOUS_STRIPPED.has(pCompact)) continue;
      if (pCompact.length >= 3 && compact.includes(pCompact)) return ph;
      if (glued.has(pCompact)) return ph;
    }
    return null;
  }

  check(uniqueId, nickname, text, now) {
    const cfg = this.cfg;
    now = now === undefined ? Date.now() / 1000 : now;
    text = String(text || "").trim();
    if (!text) return { ok: false, reason: "rong", text };

    const banned = (cfg.bannedUsers || []).map(u => String(u).trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
    if (uniqueId && banned.includes(String(uniqueId).toLowerCase().replace(/^@/, "")))
      return { ok: false, reason: "nguoi_bi_chan", text };

    if (cfg.dropLinks !== false && /(https?:\/\/|www\.|\.com|\.net|\.io|\.vn)\b/i.test(text))
      return { ok: false, reason: "link", text };

    let { tokens, compact } = normalizeForMatch(text);
    const accTokens = tokensAccented(text);

    if (!tokens.length || !/[a-z]/.test(compact))
      return { ok: false, reason: "chi_emoji", text };

    const minChars = parseInt(cfg.minChars ?? 2), maxChars = parseInt(cfg.maxChars ?? 120);
    if (text.length < minChars) return { ok: false, reason: "qua_ngan", text };
    if (text.length > maxChars) {
      if (cfg.truncateLong !== false) {
        text = text.slice(0, maxChars).replace(/\s+\S*$/, "").trim() || text.slice(0, maxChars);
        ({ tokens, compact } = normalizeForMatch(text));
      } else return { ok: false, reason: "qua_dai", text };
    }

    if (/^(.)\1{4,}$/.test(compact || ""))
      return { ok: false, reason: "spam_lap", text };

    if (this._matchList(tokens, compact, cfg.blockedWords, accTokens))
      return { ok: false, reason: "tu_cam", text };

    if (this._matchList(tokens, compact, cfg.ignorePhrases, accTokens, false))
      return { ok: false, reason: "bo_qua", text };

    const dedupeSec = parseInt(cfg.dedupeSeconds ?? 60);
    const lastU = this._userLastText.get(uniqueId);
    if (lastU && lastU.compact === compact && now - lastU.ts < dedupeSec)
      return { ok: false, reason: "spam_trung", text };
    const lastG = this._globalLastText.get(compact);
    if (lastG !== undefined && now - lastG < Math.max(5, Math.floor(dedupeSec / 2)))
      return { ok: false, reason: "spam_trung", text };

    const cooldown = parseInt(cfg.cooldownSeconds ?? 20);
    const lastRead = this._userLastTime.get(uniqueId);
    if (lastRead !== undefined && now - lastRead < cooldown)
      return { ok: false, reason: "cooldown", text };

    this._userLastText.set(uniqueId, { compact, ts: now });
    this._globalLastText.set(compact, now);
    if (this._globalLastText.size > 2000) this._globalLastText.clear();
    return { ok: true, reason: null, text };
  }

  markRead(uniqueId, now) {
    this._userLastTime.set(uniqueId, now === undefined ? Date.now() / 1000 : now);
  }
}

module.exports = { CommentFilter, normalizeForMatch, tokensAccented, stripAccents };
