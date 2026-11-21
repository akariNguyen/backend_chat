# Brand Search

Tra brand của một URL bằng ChatGPT (bật tìm kiếm web) mà **không dùng OpenAI API**: một extension Chrome
làm worker, tự mở ChatGPT trong hồ sơ Chrome đã đăng nhập, gửi câu hỏi, lấy câu trả lời về rồi đóng tab.
Kết quả gồm tên brand, công ty sở hữu, alias, domain chính thức, logo (đã kiểm tra là ảnh thật) và nguồn.

```
brand_search/
├── backend/      FastAPI: hàng đợi việc (SQLite), soạn câu hỏi, đọc câu trả lời, kiểm tra logo/domain
├── frontend/     Trang web nhập URL, xem tiến trình, kết quả và lịch sử (backend phục vụ tại /)
├── extension/    Extension Chrome "Brand Search Worker"
└── tests/        test_backend.py (offline) và e2e_worker.py (Chromium + extension + ChatGPT giả)
```

## Luồng chạy

```
Trang web ──POST /api/jobs──► Backend (hàng đợi SQLite: backend/brand_jobs.sqlite3)
                                   ▲  │ worker hỏi việc mỗi 3 giây (GET /api/worker/next)
                                   │  ▼
                         Extension worker (Chrome đã đăng nhập ChatGPT)
                           1. mở tab chatgpt.com/?hints=search&q=<câu hỏi>
                           2. chèn engine_chatgpt.js vào đúng tab đó
                           3. gửi câu hỏi nếu ChatGPT chưa tự gửi
                           4. chờ đến khi có khối JSON trả lời trọn vẹn và ChatGPT ngừng viết
                           5. nộp JSON ─► backend kiểm tra logo, so domain chính thức
                           6. đóng tab, nghỉ 5 giây, nhận việc tiếp
```

Worker làm từng việc một, gửi heartbeat 20 giây/lần (trang web hiện số worker online). Việc treo quá
5 phút bị đánh lỗi; bấm **Hủy** trên trang thì worker bỏ việc và đóng tab.

## Cài đặt

Cần Python 3.10+ và Chrome 120+.

```powershell
python -m pip install -r backend\requirements.txt
cd backend
python app.py               # http://127.0.0.1:8765  (API docs: /docs)
```

Extension: `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục `extension/`.
Nên dùng một hồ sơ Chrome riêng, đã đăng nhập ChatGPT, vì worker tự mở và đóng tab. Popup của extension
có công tắc bật/tắt worker, trạng thái, nhật ký và nút **Tra brand trang này**.

## Deploy lên VPS (máy khác dùng chung)

Backend chạy trên VPS; trang web mở từ máy bất kỳ; worker là Chrome có extension ở máy bất kỳ
(kể cả trên chính VPS), miễn là đã đăng nhập ChatGPT.

1. Trên VPS:
   ```powershell
   git clone https://github.com/akariNguyen/backend_chat.git C:\backend_chat
   cd C:\backend_chat
   python -m pip install -r backend\requirements.txt
   Copy-Item backend\.env.example backend\.env          # BRAND_API_HOST=0.0.0.0: nhận máy khác
   New-NetFirewallRule -DisplayName "Brand Search 8765" -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Allow
   cd backend
   python app.py
   ```
   Nếu nhà cung cấp VPS có tường lửa riêng (security group), mở thêm cổng 8765 ở đó.
2. Trang web: mở `http://<IP-VPS>:8765`.
3. Worker: popup extension → **Kết nối backend** → URL `http://<IP-VPS>:8765` (API key để trống) → **Lưu & kiểm tra**.

Mặc định không cần key: máy nào vào được `IP-VPS:8765` cũng tạo được việc (dùng tài khoản ChatGPT của worker)
và xem lịch sử. Muốn hạn chế mà vẫn không dùng key, chỉ mở cổng cho IP các máy của mình:
`New-NetFirewallRule ... -LocalPort 8765 -RemoteAddress 1.2.3.4,5.6.7.8 -Action Allow`. Muốn dùng key: điền
`BRAND_API_KEY` trong `backend\.env`, chạy lại backend; trang web sẽ hỏi key, popup có ô API key.

## Dùng

Mở http://127.0.0.1:8765, nhập URL, bấm **Tìm brand**. Có thể mở thẳng
`http://127.0.0.1:8765/?url=https%3A%2F%2Fwww.example.com%2F` để tra ngay.

## API chính

| Phương thức | Route | Công dụng |
|---|---|---|
| POST | `/api/jobs` | Tạo việc `{"url": "..."}` (URL đang chờ thì dùng lại việc cũ) |
| GET | `/api/jobs`, `/api/jobs/{id}` | Lịch sử, chi tiết + kết quả |
| POST | `/api/jobs/{id}/cancel` | Hủy |
| GET | `/api/workers` | Worker và trạng thái online |
| GET | `/api/worker/next?worker_id=` | Worker nhận việc (204 nếu không có) |
| POST | `/api/worker/jobs/{id}/answer`, `/fail` | Worker nộp câu trả lời / báo lỗi |
| POST | `/api/worker/heartbeat` | Worker báo online, nhận lệnh hủy |
| POST | `/api/prompt`, `/api/brand/parse` | Soạn câu hỏi / đọc một câu trả lời dán tay |

## Cấu hình

- `backend\.env` (mẫu: `backend\.env.example`, không đưa lên git): `BRAND_API_HOST` (`127.0.0.1` = chỉ máy
  này, `0.0.0.0` = nhận máy khác), `BRAND_API_PORT` (8765), `BRAND_API_KEY`, `BRAND_JOBS_DB`.
- `BRAND_API_KEY` (tùy chọn, mặc định để trống = không cần key): khi đặt, mọi route `/api/*` cần header
  `X-API-Key`; trang web, `/health`, `/docs` vẫn mở.
- Extension: URL backend (và API key nếu có) đặt trong popup (**Kết nối backend**), mặc định `http://127.0.0.1:8765`.
- `extension/background.js`: `OPEN_IN_BACKGROUND` (mở tab ChatGPT mà không chuyển sang), `JOB_TIMEOUT_MS`,
  `PAUSE_BETWEEN_JOBS_MS`.

## Test

```powershell
python tests\test_backend.py     # offline, ~15 giây
python tests\e2e_worker.py       # cần playwright + chromium; dùng cổng 8775 và 8766, ChatGPT giả
```

## Lưu ý

- Giao diện ChatGPT không phải API công khai. Engine tìm câu trả lời theo nội dung (khối JSON cuối có
  `brand_name`) thay vì theo cấu trúc trang, nhưng ChatGPT đổi giao diện vẫn có thể làm hỏng việc gửi câu
  hỏi. Khi lỗi, thông báo của việc có kèm mô tả trang (`path`, nút trong ô chat, `data-testid`…) để sửa selector.
- Điều khoản của OpenAI không cho phép tự động lấy câu trả lời từ ChatGPT: rủi ro với tài khoản thuộc về
  người chạy worker.
- Câu hỏi gửi lên ChatGPT có URL và title của trang; title được đánh dấu là dữ liệu không tin cậy.
- `upload.wikimedia.org` chặn request từ server: logo từ đó trả về với `verified: false` để trình duyệt tự tải.
