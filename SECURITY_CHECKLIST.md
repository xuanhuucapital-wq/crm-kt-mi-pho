# Checklist bảo mật CRM

Cập nhật: 2026-06-15.

## Đã triển khai

- Supabase: bật và ép buộc RLS cho `crm_state`; thu hồi toàn bộ quyền của
  `public`, `anon`, `authenticated`; chỉ backend `service_role` được đọc/ghi.
- Database không cho client truy cập trực tiếp. Phân quyền xưởng và role được
  kiểm tra tại Cloudflare Worker trước khi đọc hoặc sửa dữ liệu.
- Mật khẩu dùng `scrypt` với salt ngẫu nhiên. Không lưu mật khẩu rõ, API key
  hoặc session token trong bảng user.
- Session 12 giờ dùng cookie `HttpOnly; Secure; SameSite=Strict`. Token cũ trong
  `localStorage` được dùng một lần để nâng cấp phiên rồi bị xóa.
- Backend kiểm tra trạng thái user, role và phân hệ ở mọi API nghiệp vụ.
- Login và toàn bộ API có rate limit theo IP. Login có thêm chặn dồn dập
  `3 lần / 10 giây`; đăng nhập sai `5 lần / 5 phút` bị khóa tạm theo IP + email.
- Request thay đổi dữ liệu phải cùng origin, dùng JSON và không quá 64 KiB.
- Input quan trọng có giới hạn độ dài, miền số và định dạng ngày.
- Frontend escape dữ liệu trước khi đưa vào HTML; CSP chặn script ngoài.
- Service key chỉ được đọc từ biến môi trường backend. `.env`, database, backup,
  Excel và certificate bị loại khỏi Git.
- HTTPS được ép ở production. Có HSTS, CSP, frame protection, MIME sniffing
  protection, COOP, CORP và Permissions Policy.
- Thao tác quản lý user, khách hàng, đơn, thanh toán và sản xuất có audit log.
- GitHub Actions chạy test, audit toàn bộ dependency và Worker dry-run.

## Không áp dụng cho dự án hiện tại

- Membership (`plan_id`, `expired_at`, `is_member`, subscription): dự án không
  có gói thành viên.
- Moderator/Member và bài viết/comment: dự án chỉ có `manager` và `delivery`.
- Upload file: hiện không có chức năng upload.
- AI API: giao diện gợi ý hiện xử lý local, không gọi OpenAI/Claude/Gemini.
- Supabase Auth: dự án dùng auth riêng tại backend; vì vậy email verification,
  reset password và MFA chưa có sẵn.
- “User chỉ đọc dữ liệu của chính mình”: CRM là dữ liệu dùng chung theo xưởng,
  nên quyền được chia theo role và `businessUnit`, không theo chủ sở hữu từng row.

## Cần bật hoặc xác nhận thủ công

- Cloudflare Dashboard: bật WAF managed rules, Bot Fight Mode và rate limiting
  rules cho `/api/login` và `/api/register`.
- CAPTCHA/Turnstile cho form đăng nhập nếu website mở public rộng rãi. Nên dùng
  Cloudflare Turnstile hoặc reCAPTCHA thật, không dùng CAPTCHA tự chế ở frontend.
- Supabase Dashboard: chạy migration mới, bật backup hằng ngày/PITR phù hợp gói,
  cấu hình budget alert và kiểm tra restore mỗi tháng.
- Cloudflare: tạo budget/usage alert và email cảnh báo 50%, 80%, 100%.
- GitHub: bật Secret scanning, Push protection, Dependabot alerts và bảo vệ
  nhánh `main`.
- Sao lưu secrets bằng kho mật khẩu doanh nghiệp; không lưu bản sao `.env` trong
  Git hoặc ổ đĩa chia sẻ.
- Xây dựng reset password, xác thực email và MFA trước khi mở rộng số lượng user.
