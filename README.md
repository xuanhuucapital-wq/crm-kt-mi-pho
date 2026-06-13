# CRM Nhà Xưởng

Website CRM nội bộ quản lý hai phân hệ độc lập trong cùng một dự án:

- `Xưởng Mì`: mì, da cảo, da hoành và các mặt hàng phụ hiện có.
- `Xưởng Phở`: phở sợi và phở cuốn.

Khi chuyển xưởng, toàn bộ tổng quan, khách hàng, đơn hàng, công nợ, báo cáo,
thông tin sản xuất, Excel và nhật ký được lọc theo phân hệ đang chọn.

## Nguồn dữ liệu

Nguồn dữ liệu production là Supabase PostgreSQL. File `data/crm-database.json`
chỉ còn dùng để phát triển local, chạy test và làm nguồn import ban đầu.

- Tạo/sửa khách hàng ghi vào database CRM.
- Tạo/sửa đơn hàng ghi vào database CRM.
- Ghi nhận thanh toán và phân bổ công nợ ghi vào database CRM.
- Thêm/sửa/khớp thông tin sản xuất ghi vào database CRM.
- Tiền hàng và công nợ được tính lại trong backend CRM.
- Dữ liệu cũ không có `businessUnit` được tự nhận là dữ liệu Xưởng Mì.
- Người dùng có thể được cấp quyền Xưởng Mì, Xưởng Phở hoặc cả hai.
- Excel công nợ của Xưởng Phở dùng bảng chi tiết riêng cho phở sợi và phở cuốn.

Google Sheets không còn được dùng để đọc, ghi hoặc đối chiếu dữ liệu.

## Chạy local

```bash
export APP_AUTH_SECRET="$(openssl rand -hex 32)"
PORT=8889 node local-server.js
```

Mở `http://localhost:8889`.

Lần đầu, chọn **Đăng ký tài khoản giao hàng** và đăng ký email chủ doanh nghiệp. Khi chạy local, tài khoản đầu tiên sẽ trở thành `Quản lý`. Các tài khoản đăng ký sau mặc định là `Giao hàng / Chờ duyệt`.

## Tài khoản và phân quyền

- `Giao hàng`: chỉ được xem danh sách khách cần thiết và tạo đơn mới.
- `Quản lý`: xem toàn bộ CRM, sửa dữ liệu, công nợ, báo cáo, xuất Excel và quản lý user.
- Mật khẩu được băm bằng `scrypt` với salt riêng, không lưu mật khẩu rõ.
- Khi đổi quyền hoặc khóa user, toàn bộ token cũ của user đó mất hiệu lực.
- API kiểm tra quyền ở backend; ẩn menu chỉ là lớp giao diện bổ sung.

## Cấu hình production

Tạo biến môi trường:

```bash
APP_AUTH_SECRET=<chuỗi ngẫu nhiên tối thiểu 64 ký tự>
CRM_ADMIN_EMAIL=<email chủ doanh nghiệp>
ALLOW_ADMIN_BOOTSTRAP=false
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=<sb_secret_backend-key>
NODE_ENV=production
```

`SUPABASE_SECRET_KEY` chỉ được đặt trong secret của backend, tuyệt đối không
đưa vào frontend hoặc GitHub.

## Triển khai Cloudflare

Dự án dùng một Cloudflare Worker để phục vụ cả frontend trong `public/` và API
trong `/api/*`. API gọi Supabase ở backend nên secret không xuất hiện trong
trình duyệt.

### Kết nối GitHub

1. Vào Cloudflare Dashboard, chọn **Workers & Pages** rồi **Create application**.
2. Chọn **Import a repository** và repo `crm-kt-mi-pho`.
3. Chọn nhánh `main`.
4. Build command: `npm run build`.
5. Deploy command: `npm run deploy:cloudflare`.
6. Thêm các biến/secret production:

```text
SUPABASE_URL
SUPABASE_SECRET_KEY
APP_AUTH_SECRET
CRM_ADMIN_EMAIL
```

`APP_AUTH_SECRET` phải dùng đúng giá trị đang chạy hiện tại để các phiên đăng
nhập không bị đổi khóa. Không thêm `SUPABASE_ACCESS_TOKEN` lên Cloudflare vì
token đó chỉ phục vụ script thiết lập database.

Sau khi deploy, Cloudflare cấp địa chỉ dạng:

```text
https://nhap-so-sach-mi.<tai-khoan>.workers.dev
```

Mỗi lần push nhánh `main`, Cloudflare sẽ tự build và triển khai lại.

### Triển khai bằng terminal

```bash
npm run deploy:cloudflare
```

Trước lần đầu chạy, đăng nhập Wrangler và khai báo các secret bằng
`npx wrangler secret put <TEN_SECRET>`.

## Khởi tạo Supabase

1. Chạy SQL trong `supabase/migrations/202606130001_create_crm_state.sql`.
2. Khai báo `SUPABASE_URL` và `SUPABASE_SECRET_KEY`.
3. Import dữ liệu hiện tại:

```bash
npm run db:import:supabase
npm run db:check:supabase
```

Hoặc dùng Management API để chạy migration và import trong một lệnh. Đặt tạm
`SUPABASE_ACCESS_TOKEN` và `SUPABASE_PROJECT_REF` trong `.env`, sau đó chạy:

```bash
npm run db:setup:supabase
```

## Lưu ý database

Backend dùng version trên bản ghi Supabase để tránh hai request ghi đè dữ liệu của
nhau. Khi có xung đột, request tự đọc lại và thử cập nhật tối đa 8 lần.

Xem checklist tại [SECURITY.md](SECURITY.md).

## Khởi tạo lại database

Chỉ chạy khi thực sự muốn tạo lại database từ snapshot:

```bash
node scripts/init-crm-database.js
```

Lệnh này sẽ ghi đè `data/crm-database.json`.
