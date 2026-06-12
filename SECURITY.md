# Security Baseline

## Đã áp dụng

- Không còn tài khoản hoặc password hash cố định trong source.
- Mật khẩu dùng `scrypt` và salt ngẫu nhiên riêng cho từng user.
- Đăng ký email mới mặc định chờ quản lý duyệt.
- RBAC được kiểm tra tại backend cho vai trò `delivery` và `manager`.
- Token hết hạn sau 12 giờ và bị thu hồi khi user đổi quyền hoặc bị khóa.
- Giới hạn đăng nhập sai, giới hạn request body và thêm security headers/CSP.
- Database, snapshot, file Excel và `.env` bị loại khỏi Git.
- Toàn bộ thư mục `data/` và file backup `.bak` bị loại khỏi Git.
- Ghi audit log cho tạo/copy đơn và thay đổi quyền user.
- API Cloudflare legacy trả `410 Gone`; backend nghiệp vụ duy nhất là Netlify Functions.
- Đơn nợ mới không nhận trường `paid` từ frontend; thu tiền chỉ đi qua API thanh toán.
- Local server chỉ bind `127.0.0.1`; mở ra LAN phải bật rõ `LOCAL_ALLOW_NETWORK=true`.

## Bắt buộc trước khi public internet

1. Chuyển `crm-database.json` sang PostgreSQL managed.
2. Bật HTTPS và đặt `APP_AUTH_SECRET` ngẫu nhiên tối thiểu 64 ký tự.
3. Lưu secrets trong Netlify/Cloudflare secret manager, không lưu trong Git.
4. Thiết lập backup tự động, kiểm thử phục hồi và retention.
5. Thêm rate limit dùng Redis/KV ở gateway; rate limit trong RAM hiện chỉ phù hợp một instance.
6. Chuyển bearer token phía trình duyệt sang cookie `HttpOnly; Secure; SameSite=Strict`.
7. Bật MFA cho tài khoản quản lý.
8. Gửi audit log sang kho append-only, không để chung database nghiệp vụ.
9. Chạy dependency audit, secret scanning và SAST trong CI.
10. Chỉ cho phép domain production, không public localhost hoặc file database.

## Phân quyền

- `delivery`: đọc danh sách khách tối thiểu và tạo đơn.
- `manager`: toàn quyền nghiệp vụ, duyệt/khóa user và thay đổi vai trò.

Mọi API mới phải gọi `requireAuth` hoặc `requireRole`; không dựa vào việc ẩn nút trên frontend.
