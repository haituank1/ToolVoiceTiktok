"use strict";
// Chuẩn hoá văn bản tiếng Việt trước khi đọc: số, ngày tháng, giờ, tiền, % -> chữ.
const DIGITS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];

function twoDigits(n, full) {
  if (n === 0) return "";
  if (n < 10) return (full ? "lẻ " : "") + DIGITS[n];
  const tens = Math.floor(n / 10), unit = n % 10;
  let out = tens === 1 ? "mười" : DIGITS[tens] + " mươi";
  if (unit === 0) return out;
  if (unit === 1) return out + (tens > 1 ? " mốt" : " một");
  if (unit === 5) return out + " lăm";
  if (unit === 4) return out + " bốn";
  return out + " " + DIGITS[unit];
}

function threeDigits(n, full) {
  if (n === 0) return "";
  const hund = Math.floor(n / 100), rest = n % 100;
  const parts = [];
  if (hund > 0) parts.push(DIGITS[hund] + " trăm");
  else if (full) parts.push("không trăm");
  const tail = twoDigits(rest, full || hund > 0);
  if (tail) parts.push(tail);
  return parts.join(" ");
}

function numToWords(n) {
  n = Math.trunc(n);
  if (n === 0) return "không";
  if (n < 0) return "âm " + numToWords(-n);
  const units = ["", " nghìn", " triệu", " tỷ", " nghìn tỷ", " triệu tỷ"];
  const groups = [];
  let x = n;
  while (x > 0) { groups.push(x % 1000); x = Math.floor(x / 1000); }
  const parts = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue;
    const first = i === groups.length - 1;
    parts.push(threeDigits(groups[i], !first) + units[i]);
  }
  return parts.join(" ").trim();
}

function digitsToWords(s) {
  return [...s].filter(c => /\d/.test(c)).map(c => DIGITS[Number(c)]).join(" ");
}

function decimalToWords(intPart, fracPart) {
  const left = numToWords(parseInt(intPart, 10));
  const right = (fracPart.length <= 3 && parseInt(fracPart, 10) !== 0)
    ? numToWords(parseInt(fracPart, 10))
    : digitsToWords(fracPart);
  return left + " phẩy " + right;
}

function normalizeText(text) {
  let t = " " + String(text || "").trim() + " ";

  // Ngày tháng đầy đủ: 02/11/2026 ; 2-11-2026 (không lặp 'ngày' nếu đã có)
  t = t.replace(/(ngày\s+)?(?<!\d)(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?!\d)/g,
    (m, pre, d, mo, y) => ` ${pre || "ngày "}${numToWords(+d)} tháng ${numToWords(+mo)} năm ${numToWords(+y)} `);

  // Ngày tháng không năm: 02/11
  t = t.replace(/(ngày\s+)?(?<!\d)(\d{1,2})\/(\d{1,2})(?!\d)(?!\/\d)/g,
    (m, pre, d, mo) => ` ${pre || "ngày "}${numToWords(+d)} tháng ${numToWords(+mo)} `);

  // Giờ: 14:30 ; 9:05
  t = t.replace(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g,
    (m, h, mi) => +mi === 0 ? ` ${numToWords(+h)} giờ ` : ` ${numToWords(+h)} giờ ${numToWords(+mi)} phút `);

  // Phần trăm: 15% ; 3,5%
  t = t.replace(/(\d+(?:[.,]\d+)?)\s*%/g, (m, raw) => {
    let val;
    if (raw.includes(",") || (raw.includes(".") && raw.split(".").pop().length !== 3)) {
      const [ip, fp] = raw.split(/[,.]/);
      val = decimalToWords(ip, fp);
    } else {
      val = numToWords(parseInt(raw.replace(/\./g, ""), 10));
    }
    return ` ${val} phần trăm `;
  });

  // Tiền viết tắt: 500k ; 1,5tr
  t = t.replace(/(?<![\p{L}\d])(\d+)\s*k(?![\p{L}\d])/gu,
    (m, n) => ` ${numToWords(+n * 1000)} đồng `);
  t = t.replace(/(?<![\p{L}\d])(\d+(?:,\d+)?)\s*tr(?![\p{L}\d])/gu,
    (m, raw) => {
      const val = raw.includes(",") ? decimalToWords(...raw.split(",")) : numToWords(+raw);
      return ` ${val} triệu đồng `;
    });

  // Tiền có đơn vị: 1.500.000đ ; 200000 VNĐ ; 50 USD ; $100
  const money = (raw, unit) => ` ${numToWords(parseInt(raw.replace(/\./g, ""), 10))} ${unit} `;
  t = t.replace(/(\d{1,3}(?:\.\d{3})+|\d+)\s*(đ|VNĐ|VND|đồng)(?![\p{L}\d])/gu, (m, v) => money(v, "đồng"));
  t = t.replace(/(\d{1,3}(?:\.\d{3})+|\d+)\s*(USD|usd|\$)(?![\p{L}\d])/gu, (m, v) => money(v, "đô la"));
  t = t.replace(/\$\s*(\d{1,3}(?:\.\d{3})+|\d+)/g, (m, v) => money(v, "đô la"));

  // Số điện thoại 10 số bắt đầu bằng 0 -> đọc từng số
  t = t.replace(/(?<!\d)0\d{9}(?!\d)/g, m => " " + digitsToWords(m) + " ");

  // Số thập phân dấu phẩy: 3,14 ; 0,5
  t = t.replace(/(?<!\d)(\d+),(\d+)(?!\d)/g, (m, a, b) => " " + decimalToWords(a, b) + " ");

  // Số có dấu chấm phân cách nghìn: 1.500.000
  t = t.replace(/(?<!\d)(\d{1,3}(?:\.\d{3})+)(?!\d)/g,
    (m, v) => " " + numToWords(parseInt(v.replace(/\./g, ""), 10)) + " ");

  // Số nguyên còn lại
  t = t.replace(/(?<!\d)(\d+)(?!\d)/g, (m, v) => " " + numToWords(parseInt(v, 10)) + " ");

  return t.replace(/\s+/g, " ").replace(/\s+([,.!?…;:])/g, "$1").trim();
}

function splitSentences(text, maxLen = 180) {
  const raw = String(text).split(/(?<=[.!?…])\s+|\n+/);
  const chunks = [];
  for (let piece of raw) {
    piece = piece.trim();
    if (!piece) continue;
    while (piece.length > maxLen) {
      let cut = Math.max(piece.lastIndexOf(", ", maxLen), piece.lastIndexOf(" ", maxLen));
      if (cut <= 0) cut = maxLen;
      chunks.push(piece.slice(0, cut).trim());
      piece = piece.slice(cut).trim();
    }
    if (piece) chunks.push(piece);
  }
  return chunks;
}

module.exports = { normalizeText, splitSentences, numToWords };
