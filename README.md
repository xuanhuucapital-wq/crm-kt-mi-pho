# Nhập Liệu Hàng Hóa

Website nhập liệu nội bộ chạy trên Netlify hoặc Cloudflare Pages, ghi dữ liệu vào Google Sheet qua serverless functions.

## Cấu hình cần có

Tạo file `.env` từ `.env.example`, rồi điền:

```env
GOOGLE_SHEET_ID=your_google_sheet_id
GOOGLE_SERVICE_ACCOUNT_EMAIL=your_service_account_email
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
MAIN_SHEET_NAME=Tiền Khách Nợ
CUSTOMERS_SHEET_NAME=DanhSachKhach
LOG_SHEET_NAME=LichSuNhap
APP_AUTH_SECRET=your_random_secret
```

`GOOGLE_PRIVATE_KEY` lấy từ file JSON Service Account đã tải về. Không commit file `.env` hoặc file JSON.

## Tab Google Sheet

`DanhSachKhach` cần có dòng tiêu đề:

```text
MaKH | TenKH | GiaMi | GiaCao | GiaHoanh | NhaXeMacDinh | TrangThai
```

`LichSuNhap` cần có dòng tiêu đề:

```text
ThoiGian | EmailNguoiNhap | MaKH | TenKH | Ngay | MiKg | CaoKg | HoanhKg | HuTieu | VoBanhGoi | TienUng | ThungXop | NhaXe | GhiChu | TrangThai
```

## Chạy thử

```bash
npm install
npm run dev
```

Mở `http://localhost:8888`.

## Deploy Cloudflare Pages

Cloudflare Pages cần:

```text
Build command: npm run build
Build output directory: public
Functions directory: functions
```

Trong phần Environment variables của Cloudflare, thêm đủ các key giống phần cấu hình ở trên. Các giá trị nhạy cảm như `GOOGLE_PRIVATE_KEY` và `APP_AUTH_SECRET` nên để dạng secret.
