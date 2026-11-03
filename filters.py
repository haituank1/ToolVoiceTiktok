# -*- coding: utf-8 -*-
"""Bộ lọc comment: chống spam + lọc từ cấm/từ bỏ qua. Tất cả ngưỡng lấy từ config
(người dùng sửa được trên giao diện), module này không giữ ngưỡng cứng nào.

Cách soi từ cấm: chuẩn hoá comment (bỏ dấu, thường hoá, bỏ ký tự chen, gộp chữ lặp)
rồi so khớp theo 2 kiểu:
- theo từ (token): "đ m" tách dấu vẫn bắt được qua dạng rút gọn không khoảng trắng
- theo cụm rút gọn: xoá hết khoảng trắng/ký tự đặc biệt rồi tìm chuỗi con,
  bắt được kiểu "đ.m", "dmm", "địtmẹ" viết liền.
"""
import re
import time
import unicodedata

_LEET = {"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s"}


def strip_accents(s):
    s = s.replace("đ", "d").replace("Đ", "D")
    s = unicodedata.normalize("NFD", s)
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def normalize_for_match(s):
    """Trả về (tokens, compact): tokens = danh sách từ đã bỏ dấu/thường hoá,
    compact = chuỗi liền mạch chỉ gồm chữ cái (để bắt viết chèn ký tự)."""
    s = strip_accents(str(s or "").lower())
    s = "".join(_LEET.get(c, c) for c in s)
    tokens_raw = re.findall(r"[a-z0-9]+", s)
    tokens = []
    for tok in tokens_raw:
        # gộp chữ lặp 3+ lần: "đẹppp" -> "dep", "vãii" -> "vai"
        tok = re.sub(r"([a-z])\1{2,}", r"\1", tok)
        tokens.append(tok)
    compact = re.sub(r"([a-z])\1{2,}", r"\1", "".join(tokens_raw))
    return tokens, compact


def _phrase_forms(phrase):
    """Một dòng trong danh sách chặn -> các dạng so khớp của nó."""
    tokens, compact = normalize_for_match(phrase)
    return tokens, compact


def tokens_accented(s):
    """Tokens giữ nguyên dấu (thường hoá, tách bằng ký tự không phải chữ/số,
    gộp chữ lặp 3+). Dùng để phân biệt 'cặc' với 'các', 'đĩ' với 'đi'."""
    s = str(s or "").lower()
    toks = re.findall(r"[0-9a-zà-ỹđ]+", s)
    return [re.sub(r"([a-zà-ỹđ])\1{2,}", r"\1", t) for t in toks]


# Các dạng bỏ dấu MƠ HỒ: trùng với từ lành quá phổ biến nên không được dùng
# so khớp bỏ dấu, chỉ so khớp khi người comment gõ đúng dấu.
# cac=các/cặc, di=đi/đĩ, du=dù/đụ, lon=lon/lồn, deo=đeo/đéo, buoi=buổi/buồi
_AMBIGUOUS_STRIPPED = {"cac", "di", "du", "lon", "deo", "buoi"}


class CommentFilter:
    def __init__(self, config):
        self.cfg = config
        self._user_last_time = {}      # unique_id -> ts lần cuối ĐƯỢC ĐỌC
        self._user_last_text = {}      # unique_id -> (compact, ts) comment gần nhất của người đó
        self._global_last_text = {}    # compact -> ts, chống nhiều người spam cùng 1 câu

    # -- tiện ích nội bộ -------------------------------------------------
    def _match_list(self, tokens, compact, phrases, acc_tokens=None, strict_ambiguous=True):
        """So khớp 3 lớp:
        1) giữ dấu: token/cụm token trùng khít (phân biệt cặc/các, đĩ/đi)
        2) bỏ dấu theo token/cụm token
        3) bỏ dấu dạng rút gọn (bắt viết chèn ký tự, viết liền, tách từng chữ)
           — trừ các dạng mơ hồ trong _AMBIGUOUS_STRIPPED."""
        token_set = set(tokens)
        acc = acc_tokens or []
        acc_set = set(acc)

        def seq_in(seq, toks):
            """Cụm token có xuất hiện liên tiếp (đúng biên từ) trong toks không."""
            n = len(seq)
            return n > 0 and any(toks[i:i + n] == seq for i in range(len(toks) - n + 1))
        # các cặp/ba token kề nhau ghép liền: "đ.m" -> tokens d,m -> "dm"
        glued = set()
        for i in range(len(tokens)):
            if i + 1 < len(tokens):
                glued.add(tokens[i] + tokens[i + 1])
            if i + 2 < len(tokens):
                glued.add(tokens[i] + tokens[i + 1] + tokens[i + 2])
        for ph in phrases or []:
            ph = str(ph).strip()
            if not ph:
                continue
            p_tokens, p_compact = _phrase_forms(ph)
            p_acc = tokens_accented(ph)
            if not p_tokens and not p_acc:
                continue
            # lớp 1: giữ dấu
            if len(p_acc) == 1 and p_acc[0] in acc_set:
                return ph
            if len(p_acc) > 1 and seq_in(p_acc, acc):
                return ph
            # cụm có chứa token mơ hồ (vd "con đĩ" ~ "con đi"): chỉ tin lớp giữ dấu
            # (chỉ áp cho danh sách từ cấm; danh sách bỏ qua thì thả lỏng hơn)
            if strict_ambiguous and len(p_tokens) > 1 and any(t in _AMBIGUOUS_STRIPPED for t in p_tokens):
                continue
            # lớp 2: bỏ dấu theo token
            if len(p_tokens) == 1 and p_tokens[0] in token_set:
                # token bỏ dấu đơn độc chỉ tin được khi dạng đó không mơ hồ,
                # hoặc bản thân từ chặn có dấu phân biệt thì đã xử lý ở lớp 1
                if p_compact not in _AMBIGUOUS_STRIPPED:
                    return ph
                continue
            if len(p_tokens) > 1 and seq_in(p_tokens, tokens):
                return ph
            # lớp 3: dạng rút gọn — chỉ cho từ đơn (cụm từ đã xử lý ở lớp 1-2)
            if len(p_tokens) != 1:
                continue
            if p_compact in _AMBIGUOUS_STRIPPED:
                continue
            if len(p_compact) >= 3 and p_compact in compact:
                return ph
            if p_compact in glued:
                return ph
        return None

    # -- hàm chính --------------------------------------------------------
    def check(self, unique_id, nickname, text, now=None):
        """Trả về (ok: bool, reason: str|None, cleaned_text: str).
        reason là mã ngắn để thống kê: 'tu_cam', 'bo_qua', 'spam_trung', 'cooldown',
        'nguoi_bi_chan', 'chi_emoji', 'link', 'qua_ngan', 'qua_dai'..."""
        cfg = self.cfg
        now = now if now is not None else time.time()
        text = str(text or "").strip()

        if not text:
            return False, "rong", text

        # người bị chặn đích danh
        banned = [str(u).strip().lower().lstrip("@") for u in cfg.get("bannedUsers", []) if str(u).strip()]
        if unique_id and unique_id.lower().lstrip("@") in banned:
            return False, "nguoi_bi_chan", text

        # chứa link -> bỏ (spam quảng cáo)
        if cfg.get("dropLinks", True) and re.search(r"(https?://|www\.|\.com|\.net|\.io|\.vn)\b", text, re.I):
            return False, "link", text

        tokens, compact = normalize_for_match(text)
        acc_tokens = tokens_accented(text)

        # chỉ emoji / ký tự, không có chữ nào
        if not tokens or not re.search(r"[a-z]", compact):
            return False, "chi_emoji", text

        # độ dài
        min_chars = int(cfg.get("minChars", 2))
        max_chars = int(cfg.get("maxChars", 120))
        if len(text) < min_chars:
            return False, "qua_ngan", text
        if len(text) > max_chars:
            if cfg.get("truncateLong", True):
                text = text[:max_chars].rsplit(" ", 1)[0].strip() or text[:max_chars]
                tokens, compact = normalize_for_match(text)
            else:
                return False, "qua_dai", text

        # 1 chữ lặp lại kiểu "aaaaaa", "kkkkk"
        if re.fullmatch(r"(.)\1{4,}", compact or ""):
            return False, "spam_lap", text

        # từ cấm (chửi tục / nhạy cảm): chứa là bỏ cả comment, không đọc gì hết
        hit = self._match_list(tokens, compact, cfg.get("blockedWords", []), acc_tokens)
        if hit:
            return False, "tu_cam", text

        # từ/cụm bỏ qua (lệnh game, câu cửa miệng lặp lại...)
        hit = self._match_list(tokens, compact, cfg.get("ignorePhrases", []), acc_tokens, strict_ambiguous=False)
        if hit:
            return False, "bo_qua", text

        # cùng một người gửi lại đúng câu cũ
        dedupe_sec = int(cfg.get("dedupeSeconds", 60))
        last_u = self._user_last_text.get(unique_id)
        if last_u and last_u[0] == compact and now - last_u[1] < dedupe_sec:
            return False, "spam_trung", text
        # nhiều người cùng spam 1 câu trong thời gian ngắn
        last_g = self._global_last_text.get(compact)
        if last_g is not None and now - last_g < max(5, dedupe_sec // 2):
            return False, "spam_trung", text

        # cooldown từng người: vừa được đọc xong thì phải chờ
        cooldown = int(cfg.get("cooldownSeconds", 20))
        last_read = self._user_last_time.get(unique_id)
        if last_read is not None and now - last_read < cooldown:
            return False, "cooldown", text

        # qua lọc -> ghi nhận
        self._user_last_text[unique_id] = (compact, now)
        self._global_last_text[compact] = now
        if len(self._global_last_text) > 2000:
            self._global_last_text.clear()
        return True, None, text

    def mark_read(self, unique_id, now=None):
        """Gọi khi comment thực sự được đưa đi chuyển giọng (bắt đầu đếm cooldown)."""
        self._user_last_time[unique_id] = now if now is not None else time.time()
