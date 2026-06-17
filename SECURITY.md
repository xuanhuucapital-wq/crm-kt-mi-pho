# Security Baseline

## Đã áp dụng

- Không còn tài khoản hoặc password hash cố định trong source.
- Mật khẩu dùng `scrypt` và salt ngẫu nhiên riêng cho từng user.
- Đăng ký email mới mặc định chờ quản lý duyệt.
- RBAC được kiểm tra tại backend cho vai trò `delivery` và `manager`.
- Session cookie `HttpOnly; Secure; SameSite=Strict` hết hạn sau 12 giờ và bị
  thu hồi khi user đổi quyền hoặc bị khóa.
- Giới hạn đăng nhập/API theo IP, giới hạn request body, kiểm tra same-origin và
  thêm security headers/CSP/HSTS.
- Database, snapshot, file Excel và `.env` bị loại khỏi Git.
- Toàn bộ thư mục `data/` và file backup `.bak` bị loại khỏi Git.
- Ghi audit log cho tạo/copy đơn và thay đổi quyền user.
- Cloudflare Worker là backend nghiệp vụ và phục vụ toàn bộ route `/api/*`.
- Đơn nợ mới không nhận trường `paid` từ frontend; thu tiền chỉ đi qua API thanh toán.
- `npm run local` chỉ bind `127.0.0.1`; `npm start` bind `0.0.0.0` để phù hợp
  Node.js hosting.

## Bắt buộc trước khi public internet

1. Chuyển `crm-database.json` sang PostgreSQL managed.
2. Bật HTTPS và đặt `APP_AUTH_SECRET` ngẫu nhiên tối thiểu 64 ký tự.
3. Lưu secrets trong Cloudflare secret manager, không lưu trong Git.
4. Thiết lập backup tự động, kiểm thử phục hồi và retention.
5. Bật Cloudflare WAF/Bot Protection và rate limiting rule tại edge.
6. Bật MFA cho tài khoản quản lý khi bổ sung nhà cung cấp xác thực hỗ trợ MFA.
7. Gửi audit log sang kho append-only, không để chung database nghiệp vụ.
8. Bật GitHub secret scanning, push protection và Dependabot.
9. Chỉ cho phép domain production, không public localhost hoặc file database.

Trạng thái đầy đủ theo checklist nằm trong `SECURITY_CHECKLIST.md`.

## Phân quyền

- `delivery`: đọc danh sách khách tối thiểu và tạo đơn.
- `manager`: toàn quyền nghiệp vụ, duyệt/khóa user và thay đổi vai trò.

Mọi API mới phải gọi `requireAuth` hoặc `requireRole`; không dựa vào việc ẩn nút trên frontend.
