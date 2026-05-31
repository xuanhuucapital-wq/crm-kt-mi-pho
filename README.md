# Nhập Liệu Hàng Hóa

Website nhập liệu nội bộ chạy trên Netlify, ghi dữ liệu vào Google Sheet qua Netlify Functions.

## Cấu hình cần có

Tạo file `.env` từ `.env.example`, rồi điền:

```env
GOOGLE_SHEET_ID=1TspCw9YkKQyxYC_qct0801nfvGoccqhPhxlQAewbVIU
GOOGLE_SERVICE_ACCOUNT_EMAIL=nhap-lieu-hang-hoa@poised-resource-497915-s0.iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
MAIN_SHEET_NAME=Tiền Khách Nợ
CUSTOMERS_SHEET_NAME=DanhSachKhach
LOG_SHEET_NAME=LichSuNhap
ALLOWED_USERS=email-admin@gmail.com,email-nhan-vien@gmail.com
ADMIN_USERS=email-admin@gmail.com
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
