# VMOS pool (table `vmos`)

## API (Render.com)

Deploy service từ `render.yaml` hoặc chạy locally:

```bash
DATABASE_URL=postgres://... API_KEY=... npm run api
```

Env bắt buộc:
- `DATABASE_URL`: Postgres connection string.
- `API_KEY` (hoặc `API_KEYS`, phân cách bằng dấu phẩy).

Env tuỳ chọn:
- `VMOS_DB_TABLE` (mặc định `vmos`)
- `VMOS_MAX_ACCOUNTS` (mặc định `300`)
- `VMOS_TTL_SECONDS` (mặc định `1036800` = 12 ngày)
- `PORT` (Render tự inject)

Endpoints:
- `GET /health` — stats pool (không cần key).
- `GET /register?apikey=<key>` hoặc header `x-api-key` — lấy account **cũ nhất**, xoá ngay khỏi DB. Thêm `?format=raw` để trả `email|password`.
- `POST /cleanup?apikey=<key>` — xoá account cũ hơn 12 ngày.

Policy mặc định (mirror VSPhone): account phải có tuổi >= 5 phút và còn hạn >= 5 phút mới được lấy.

## Producer (máy có display)

```bash
DATABASE_URL=postgres://... npm run producer
```

- **Bắt buộc headed**: `HEADLESS=false` (mặc định). Script sẽ thoát nếu bạn set `HEADLESS=true` mà không đặt `VMOS_ALLOW_HEADLESS=1`, vì headless dính Cloudflare.
- Cần Xvfb nếu máy không có display; `lib/env-check.js` tự start Xvfb.
- Lưu kết quả `runBot()` vào bảng `vmos`, dừng khi đạt 300 account.
- Sau khi bot báo `relogin-success` (đăng nhập lại chính thống: captcha → OTP → login), producer spawn một tiến trình mới rồi tự exit.

## Re-login thủ công

```bash
DATABASE_URL=postgres://... npm run relogin
# hoặc chỉ định account: VMOS_RELOGIN_ACCOUNT='email|inboxToken' npm run relogin
```

Script mở browser headed, giải captcha, nhận OTP qua inbox token, đăng nhập, sau đó spawn producer mới.

## Tests

```bash
npm test
```
