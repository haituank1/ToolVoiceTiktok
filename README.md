# ToolVoiceTikTok — Đọc comment TikTok LIVE thành giọng nói (Node.js)

Giống chức năng đọc comment của Tikfinity nhưng chỉ làm đúng 1 việc: **đọc comment**.
Comment bắt được → lọc spam/từ cấm → chuyển giọng ngay → phát nối tiếp từng câu,
phát xong mới sang câu tiếp theo. Âm thanh giữ trong RAM, **không lưu file**.

## Cách chạy (Windows)

1. Cài [Node.js bản LTS](https://nodejs.org/) (cài mặc định là đủ)
2. Nhấp đúp **`ChayTool.bat`** — lần đầu nó tự `npm install` (~1-2 phút)
3. Trình duyệt mở `http://localhost:3220` → nhập @tên phòng live → **Kết nối**
4. Bấm 1 lần vào trang để trình duyệt cho phép phát tiếng
5. Để LIVE Studio / OBS bắt tiếng từ loa máy như bình thường

Giữ cửa sổ đen (console) mở suốt buổi live — đóng là tắt tool.

## Kiến trúc 3 tầng tách rời

| Tầng | Việc | Chi tiết |
|---|---|---|
| Bắt comment | Nhận comment ngay khi xuất hiện | `tiktok-source.js` — thư viện tiktok-live-connector (không chính thức, chỉ cần @tên phòng, không cần mật khẩu) |
| Lọc + chuyển giọng | Bỏ spam/từ cấm, gọi TTS ngay khi comment tới | `filters.js` + worker TTS trong `server.js`: giọng Microsoft HoaiMy/NamMinh (node-edge-tts, stream thẳng vào RAM), lỗi thì retry rồi rơi về giọng Google |
| Phát | Phát nối tiếp tuyệt đối | Trang web nhận từng voice một, phát xong báo lại server mới gửi voice tiếp theo — không bao giờ chồng tiếng |

Các tầng nối nhau bằng hàng đợi có giới hạn: hàng chờ đầy thì bỏ comment mới
(kèm cooldown từng người + chống trùng câu) để voice không bao giờ đọc lại
comment cũ từ nhiều phút trước.

## Cấu hình (sửa trên giao diện, lưu vào `config.json`)

- Giọng đọc (HoaiMy/NamMinh), tốc độ, đọc kèm tên hay không, **mẫu đọc tên tuỳ chỉnh**
  (`{ten} nói:` / `Bạn {ten} nhắn:` / để trống = chỉ đọc tên…)
- Hàng chờ tối đa, cooldown mỗi người, thời gian chống trùng câu, độ dài tối đa
- **Từ cấm**: comment chứa là bỏ hẳn (tự bắt cả viết né: bỏ dấu, `đ.m`, `dmm`, chữ lặp).
- **Từ đệm** (mặc định `vl`, `vcl`): không cấm câu — thường chỉ là từ nhấn mạnh ("vui vl" = vui lắm), tool chỉ tự xoá từ đó trước khi đọc. Muốn cấm hẳn thì chuyển lên ô Từ cấm.
  Bộ lọc phân biệt được các cặp dễ nhầm — `các`≠`cặc`, `đi`≠`đĩ`, `buổi`≠`buồi`,
  `con đi`/`đồ chơi cho` vẫn được đọc bình thường
- **Cụm từ bỏ qua**: cho lệnh game / câu lặp lại (mặc định: `hoa rơi`, `nam mô a di đà phật`…)
- **Người dùng bị chặn**: không bao giờ đọc comment của họ
- Bỏ comment chứa link, cắt/bỏ comment quá dài

Có sẵn ô **gửi comment giả** và **đọc thử 1 câu** để test khi chưa live.

## Lưu ý thật

- Phần bắt comment dùng đường **không chính thức** (TikTok không có API chính thức
  cho việc này) — TikTok thay đổi hệ thống thì có thể phải cập nhật thư viện.
- Giọng Microsoft/Google đều là dịch vụ online: cần mạng, và việc gọi quá dày
  có thể bị giới hạn tạm thời — tool đã có retry + giọng dự phòng cho trường hợp đó.
- Trần vật lý: 1 comment đọc ~4-6 giây → tối đa ~10 comment/phút. Phòng đông
  thì bộ lọc/cooldown/hàng chờ chính là thứ giữ tool không bị ngập.
