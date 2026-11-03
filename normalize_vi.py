# -*- coding: utf-8 -*-
"""Chuẩn hoá văn bản tiếng Việt trước khi đọc: số, ngày tháng, giờ, tiền, % -> chữ.
Port từ chuan-hoa.js của tool đọc tiếng Việt v1.1 (đã kiểm chứng với người dùng)."""
import re

DIGITS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"]


def _two_digits(n, full):
    if n == 0:
        return ""
    if n < 10:
        return ("lẻ " if full else "") + DIGITS[n]
    tens, unit = divmod(n, 10)
    out = "mười" if tens == 1 else DIGITS[tens] + " mươi"
    if unit == 0:
        return out
    if unit == 1:
        return out + (" mốt" if tens > 1 else " một")
    if unit == 5:
        return out + " lăm"
    if unit == 4:
        return out + " bốn"
    return out + " " + DIGITS[unit]


def _three_digits(n, full):
    if n == 0:
        return ""
    hund, rest = divmod(n, 100)
    parts = []
    if hund > 0:
        parts.append(DIGITS[hund] + " trăm")
    elif full:
        parts.append("không trăm")
    tail = _two_digits(rest, full or hund > 0)
    if tail:
        parts.append(tail)
    return " ".join(parts)


def num_to_words(n):
    n = int(n)
    if n == 0:
        return "không"
    if n < 0:
        return "âm " + num_to_words(-n)
    units = ["", " nghìn", " triệu", " tỷ", " nghìn tỷ", " triệu tỷ"]
    groups = []
    x = n
    while x > 0:
        groups.append(x % 1000)
        x //= 1000
    parts = []
    for i in range(len(groups) - 1, -1, -1):
        if groups[i] == 0:
            continue
        first = i == len(groups) - 1
        parts.append((_three_digits(groups[i], not first) + units[i]).strip())
    return " ".join(parts).strip()


def _digits_to_words(s):
    return " ".join(DIGITS[int(c)] for c in s if c.isdigit())


def _decimal_to_words(int_part, frac_part):
    left = num_to_words(int(int_part))
    if len(frac_part) <= 3 and int(frac_part) != 0:
        right = num_to_words(int(frac_part))
    else:
        right = _digits_to_words(frac_part)
    return left + " phẩy " + right


def normalize_text(text):
    t = " " + str(text or "").strip() + " "

    # Ngày tháng đầy đủ: 02/11/2026 ; 2-11-2026
    def _full_date(m):
        pre, d, mo, y = m.group(1), int(m.group(2)), int(m.group(3)), int(m.group(4))
        return " %s%s tháng %s năm %s " % (pre or "ngày ", num_to_words(d), num_to_words(mo), num_to_words(y))
    t = re.sub(r"(ngày\s+)?(?<!\d)(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?!\d)", _full_date, t)

    # Ngày tháng không năm: 02/11
    def _short_date(m):
        pre, d, mo = m.group(1), int(m.group(2)), int(m.group(3))
        return " %s%s tháng %s " % (pre or "ngày ", num_to_words(d), num_to_words(mo))
    t = re.sub(r"(ngày\s+)?(?<!\d)(\d{1,2})/(\d{1,2})(?!\d)(?!/\d)", _short_date, t)

    # Giờ: 14:30 ; 9:05
    def _time(m):
        h, mi = int(m.group(1)), int(m.group(2))
        if mi == 0:
            return " %s giờ " % num_to_words(h)
        return " %s giờ %s phút " % (num_to_words(h), num_to_words(mi))
    t = re.sub(r"(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)", _time, t)

    # Phần trăm: 15% ; 3,5%
    def _percent(m):
        raw = m.group(1)
        if "," in raw or ("." in raw and len(raw.split(".")[-1]) != 3):
            ip, fp = re.split(r"[,.]", raw)
            val = _decimal_to_words(ip, fp)
        else:
            val = num_to_words(int(raw.replace(".", "")))
        return " %s phần trăm " % val
    t = re.sub(r"(\d+(?:[.,]\d+)?)\s*%", _percent, t)

    # Tiền viết tắt: 500k ; 1,5tr
    t = re.sub(r"(?<![\w])(\d+)\s*k(?![\w])",
               lambda m: " %s đồng " % num_to_words(int(m.group(1)) * 1000), t, flags=re.UNICODE)

    def _tr(m):
        raw = m.group(1)
        if "," in raw:
            val = _decimal_to_words(*raw.split(","))
        else:
            val = num_to_words(int(raw))
        return " %s triệu đồng " % val
    t = re.sub(r"(?<![\w])(\d+(?:,\d+)?)\s*tr(?![\w])", _tr, t, flags=re.UNICODE)

    # Tiền có đơn vị: 1.500.000đ ; 200000 VNĐ ; 50 USD ; $100
    def _money(unit):
        return lambda m: " %s %s " % (num_to_words(int(m.group(1).replace(".", ""))), unit)
    t = re.sub(r"(\d{1,3}(?:\.\d{3})+|\d+)\s*(?:đ|VNĐ|VND|đồng)(?![\w])", _money("đồng"), t, flags=re.UNICODE | re.IGNORECASE)
    t = re.sub(r"(\d{1,3}(?:\.\d{3})+|\d+)\s*(?:USD|usd|\$)(?![\w])", _money("đô la"), t, flags=re.UNICODE)
    t = re.sub(r"\$\s*(\d{1,3}(?:\.\d{3})+|\d+)", _money("đô la"), t)

    # Số điện thoại 10 số bắt đầu bằng 0 -> đọc từng số
    t = re.sub(r"(?<!\d)0\d{9}(?!\d)", lambda m: " " + _digits_to_words(m.group(0)) + " ", t)

    # Số thập phân dấu phẩy: 3,14 ; 0,5
    t = re.sub(r"(?<!\d)(\d+),(\d+)(?!\d)",
               lambda m: " " + _decimal_to_words(m.group(1), m.group(2)) + " ", t)

    # Số có dấu chấm phân cách nghìn: 1.500.000
    t = re.sub(r"(?<!\d)(\d{1,3}(?:\.\d{3})+)(?!\d)",
               lambda m: " " + num_to_words(int(m.group(1).replace(".", ""))) + " ", t)

    # Số nguyên còn lại
    t = re.sub(r"(?<!\d)(\d+)(?!\d)", lambda m: " " + num_to_words(int(m.group(1))) + " ", t)

    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"\s+([,.!?…;:])", r"\1", t)
    return t.strip()
