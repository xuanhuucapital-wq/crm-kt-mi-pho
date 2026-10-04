# CRM Nhà Xưởng

Website CRM nội bộ quản lý hai phân hệ độc lập trong cùng một dự án:

- `Xưởng Mì`: mì, da cảo, da hoành và các mặt hàng phụ hiện có.
- `Xưởng Phở`: phở sợi và phở cuốn.

Khi chuyển xưởng, toàn bộ tổng quan, khách hàng, đơn hàng, công nợ, báo cáo,
thông tin sản xuất, Excel và nhật ký được lọc theo phân hệ đang chọn.

## Nguồn dữ liệu

Nguồn dữ liệu production là Neon PostgreSQL được kết nối qua Vercel. File
`data/crm-database.json` dùng để chạy local, chạy test, sao lưu và nhập dữ liệu
ban đầu lên Neon.

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
npm run local:file
```

Mặc định local server mở tại `http://127.0.0.1:8888`. Có thể đổi cổng bằng `PORT=8889 npm run local`.

`npm run local:file` luôn ghi vào file trên máy. Dù `.env` cũ còn biến Supabase,
backend cũng không tự chọn Supabase. Chỉ khi đặt rõ
`CRM_DATABASE_DRIVER=supabase` thì đường kết nối cũ mới được dùng.

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
CRM_DATABASE_DRIVER=neon
DATABASE_URL=postgresql://<Neon cấp tự động trong Vercel>
NODE_ENV=production
```

`DATABASE_URL` chỉ được đặt trong biến môi trường của Vercel, tuyệt đối không
đưa vào frontend hoặc GitHub.

## Triển khai Vercel + Neon

```bash
vercel link
vercel integration add neon --plan free_v3 -m region=sin1 -m auth=false
npm run db:import:neon
npm run db:check:neon
npm run deploy:vercel
```

Neon lưu bản CRM dưới dạng JSONB và dùng cột `version` để khóa cập nhật. Khi hai
request cùng sửa dữ liệu, request đến sau sẽ đọc lại và thử lại, tránh ghi đè
thay đổi vừa được lưu.

## Triển khai Node.js hosting

Dự án có thể chạy bằng lệnh:

```bash
npm start
```

Lệnh này bind `0.0.0.0` để hosting có thể proxy request vào app. Trên hosting
cần đặt các biến môi trường production ở phần trên, đặc biệt là `APP_AUTH_SECRET`
và `DATABASE_URL`.

Khi nén ZIP để upload lên hosting như Tenten 1-Click Launch Website, cần nén
nội dung bên trong thư mục dự án để `package.json` nằm ngay thư mục gốc của
ZIP, không nằm trong một thư mục con.

## Công cụ Supabase cũ

Các script Supabase chỉ giữ lại để đọc hoặc phục hồi dữ liệu lịch sử. Website
production không tự dùng Supabase nữa.

## Khởi tạo Supabase cũ

1. Chạy lần lượt toàn bộ file SQL trong `supabase/migrations/` theo thứ tự tên.
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

Backend dùng version trên bản ghi Neon để tránh hai request ghi đè dữ liệu của
nhau. Khi có xung đột, request tự đọc lại và thử cập nhật tối đa 8 lần.

Xem checklist tại [SECURITY.md](SECURITY.md).

## Khởi tạo lại database

Chỉ chạy khi thực sự muốn tạo lại database từ snapshot:

```bash
node scripts/init-crm-database.js
```

Lệnh này sẽ ghi đè `data/crm-database.json`.

## Nhập liệu từ ảnh bàn giao (AI)

Menu **Ảnh bàn giao** (chỉ tài khoản Quản lý). Được dạy riêng cho tờ giao hàng Xưởng Phở.

Cách dùng hằng ngày bằng **ô chat**: thả ảnh (hoặc 📎 / dán ảnh) → bấm **🔍 Scan** → AI báo cáo bảng đọc được,
tổng cây, tiền mặt, đối chiếu số cuối tờ → bấm **✅ Cập nhật** (hoặc nhắn "ok") để ghi đơn, sản lượng, công nợ;
bấm **✏️ Chỉnh sửa** để mở bảng chi tiết, hoặc nhắn sửa ("dòng 3 là 5 cây") để AI sửa rồi báo cáo lại.

Nhắn "ok" (hoặc "ừ", "chốt", "cập nhật đi", "ok nha", "vẫn cập nhật") là ghi bảng đang duyệt vào sổ. Nếu câu đồng ý
viết kiểu khác ("bạn cập nhật giúp tôi nhé"), AI trả `capNhat: true` và trang tự bấm Cập nhật. Không có bảng nào đang
duyệt thì trang nói rõ **chưa ghi gì** và chỉ việc cần làm, AI cũng bị cấm nói "đã cập nhật" khi chưa ghi. Gặp cảnh báo
trùng đơn thì câu trả lời mở đầu bằng "Chưa ghi gì vào sổ" kèm nút **Vẫn cập nhật**.

Hỏi về sổ ngay trong ô chat (nút 💬 Trợ lý nhập liệu có ở mọi trang): "Đan Phượng Q4 có thiếu ngày nào không?",
"Kim Vân còn nợ bao nhiêu?". Với câu hỏi về ngày, máy chủ tự tính trước bằng code (không để AI đếm): ngày cả xưởng
có sổ kể từ đơn đầu tiên của khách, những ngày khách đó **vắng**, những ngày khách có **2 đơn trở lên** (nghi nhập
trùng), kèm danh sách ngày cả xưởng không có đơn nào trong 60 ngày qua (nghỉ hoặc tờ chưa nhập). Tên khách dò theo
tên, mã hoặc sổ viết tắt đã học.

Model: bấm ô chọn model để mở danh sách dạng mục lục (★ gợi ý, rồi theo hãng, có ô tìm). Danh sách lưu ở
`data/openrouter-models.json`, tự cập nhật mỗi ngày, có nút "↻ Cập nhật danh sách model". Khóa và model có nút lưu riêng.

1. **Cài đặt AI** → dán khóa OpenRouter, chọn model → **Lưu vào .env**. Khóa ghi vào
   `OPENROUTER_API_KEY` trong `.env` phía máy chủ; trình duyệt chỉ biết "đã có khóa", không bao giờ nhận lại khóa.
   Model lưu vào `OPENROUTER_MODEL` (mặc định `google/gemini-3.8-flash`). Danh sách model lấy trực tiếp từ
   OpenRouter, chỉ hiện model đọc được ảnh; ★ là model gợi ý cho chữ viết tay.
2. Chọn **ngày giao của ảnh**, tải ảnh lên → ảnh nằm ở `anh-ban-giao/cho-nhap-lieu/`.
   Ô ngày giao tự chọn **ngày gần nhất chưa có đơn nào** của phân hệ đang mở (hôm nay trước, rồi lùi dần, bỏ qua thời gian
   trước ngày đầu tiên có dữ liệu); bên dưới liệt kê các ngày cũ chưa nhập, bấm vào là nhảy tới ngày đó. Tự chọn ngày
   bằng tay thì trang không đổi lại nữa.
   Ảnh nào không cần nữa thì bấm **✕** ở dòng đó trong "Ảnh chờ nhập liệu": ảnh chuyển sang `anh-ban-giao/da-xoa/` (còn lấy lại được), không xóa hẳn.
3. Chọn ảnh → **AI đọc ảnh** (có thể chọn model khác cho riêng lần đọc này).
4. Duyệt bảng: khách, điểm giao, số cây, tiền mặt (nghìn đồng), đối chiếu tổng tiền mặt cuối tờ.
5. **Lưu đơn & chuyển ảnh** → tạo đơn công nợ, ghi tiền mặt shipper thu (trừ vào đơn vừa tạo, dư thì trừ nợ cũ),
   rồi chuyển ảnh sang `anh-ban-giao/da-nhap-lieu/YYYY-MM-DD_ten-anh.jpg` (ngày nhập liệu).
   Có một dòng lỗi thì không lưu dòng nào và ảnh vẫn ở thư mục chờ.

Quy ước đọc tờ phở: `TÊN — số điểm [- tiền mặt nghìn] — số cây`; dấu `"` = như trên; dấu `}` gom nhiều điểm về
một số cây; bỏ dòng khách mì (M Hảo, M29...), dòng "chành" và các số tổng cuối trang.
**Sổ viết tắt** (QTB, QBT, HN...) nằm trong Cài đặt AI; mỗi lần sửa khách rồi lưu, sổ tự học thêm.

Lưu ý: luồng này cần ổ đĩa lâu dài nên chạy bằng `npm run local` hoặc hosting Node.js, không chạy trên Vercel.
Đổi thư mục ảnh bằng `BAN_GIAO_DIR`. Khi chạy local, database là file `data/crm-database.json` trừ khi
đặt `CRM_DATABASE_DRIVER=neon` và `DATABASE_URL` để ghi thẳng vào database production.

## Nhập hàng bằng giọng nói (Xưởng Mì)

Menu **🎤 Nhập bằng giọng nói**. Quản lý cấp tài khoản cho nhân viên đóng hàng: nhân viên tự đăng ký, quản lý vào
**Người dùng** chọn vai trò **Đóng hàng (giọng nói)**, phân hệ Mì, trạng thái Hoạt động. Tài khoản này chỉ thấy màn hình
giọng nói (không thấy công nợ, không vào Ảnh bàn giao).

- Bấm 🎤 nói: "Long Xuyên, xe Ba Nhi, chành 20, mì 28 ký, cảo 24 ký" (nhiều khách một lượt cũng được).
- AI (`/api/giong-noi`, dùng khóa OpenRouter trong .env) tách thành thẻ đơn: khách, xe (tự khớp với xe trong sổ,
  "Ba Nhi" → "Bany"), tiền chành (vào Tiền ứng chành xe), số ký. Thiếu gì thì hỏi lại và đọc to câu hỏi.
- Nói tiếp để sửa ("Châu Đốc thêm cảo 31 ký"), hoặc sửa tay trên thẻ. Bấm **Lưu đơn này** / **Lưu tất cả**.
  Đơn lưu dạng công nợ theo giá từng khách, đánh dấu `source: "voice"`, nhật ký ghi lại lời nói.
- Chọn tay khách cho một cách gọi mới thì lần sau tự nhận ra (sổ viết tắt Xưởng Mì).
- Micro của trình duyệt chỉ chạy trên https hoặc http://127.0.0.1. Mở bằng IP mạng LAN (http://192.168...) thì dùng
  nút micro trên bàn phím điện thoại để đọc vào ô chữ.
- **🗣 Nói chuyện rảnh tay** (cho người không quen chữ): trợ lý chào và hỏi "hôm nay báo hàng cho khách nào", tự nghe
  → đọc lại từng đơn → nói "lưu" để lưu, "hướng dẫn" để nghe cách báo, "bỏ hết" để làm lại, "xong rồi" để kết thúc.
- **Nghe bằng**: Chrome (nhanh, miễn phí) hoặc "AI nghe ghi âm" (ghi âm WAV 16kHz gửi thẳng cho model có 🎧, chỗ ồn
  nghe tốt hơn, có tính phí). Model riêng cho giọng nói lưu ở `OPENROUTER_VOICE_MODEL` (chưa đặt thì dùng model chung).
- **Kiểm tra bằng ghi âm (kế thừa trang ghi âm):** ô 🎧 *Kiểm tra bằng ghi âm* bật thì Đọc một loạt dùng ghi âm;
  mô hình nghe âm thanh là `OPENROUTER_LISTEN_MODEL` (mặc định `google/gemini-2.5-flash`). Bản ghi (đã bỏ khoảng lặng)
  lưu ở `ghi-am-giong-noi/<ngày>_<phiên>_<người>_phanN.wav` (không lưu trên Vercel), tên file ghi vào nhật ký.
- **Nghe trước rồi mới nhập:** lời nói hiện ngay lên chat (🎙). Ghi âm AI: `action: "transcribe"` gọi mô hình nghe
  âm thanh HAI lần — lần 1 chép lời, lần 2 nghe lại ghi âm để soát bản chép (sửa chữ sai, xóa câu bịa, biên tập nhẹ).
  Không đưa danh sách khách vào bước chép (đưa vào thì AI hay bịa khách). Bản chép có số chữ vượt mức nói được
  (> 5 chữ/giây + 10) bị bỏ. Trình duyệt cắt bỏ khoảng lặng trước khi gửi. Sau đó `parse` bằng chữ và hiện
  **📝 Hiểu là: khách · 📅 ngày · số ký · xe · chành** trước khi vào bảng.
- **Ngày nói ra:** "15 tháng 9", "ngày 15/9" → 15/09 của năm gần nhất tính tới hôm nay (cho phép trước 2 ngày).
  Bảng hiện 📅 từng dòng, dòng sửa có ô chọn ngày.
- **📋 Đọc một loạt (bản đơn giản):** lúc đọc chỉ ghi âm cả lượt (chữ Chrome hiện mờ để xem, không phân tích).
  Bấm ⏹ Đọc xong → bỏ khoảng lặng → chép + soát (mỗi phần ≤ 90 giây) → hiện bản chép, tô chữ khác bản nghe nhanh →
  `parse` MỘT lần với `multi: true` (chỉ tạo đơn cho khách thật sự được đọc; dòng có tên không thấy trong lời nói bị
  gắn cảnh báo) → 📝 Hiểu là → bảng. Nút Lưu khóa từ lúc ghi âm tới lúc phân tích xong.
- Quản lý chọn 2 mô hình trong ô cài đặt: 🧠 *Mô hình hiểu chữ* (`OPENROUTER_VOICE_MODEL`) và 🎧 *Mô hình nghe âm thanh*
  (`OPENROUTER_LISTEN_MODEL`).
- AI dò khách bằng cả mã và tên ("Wiki Fresh M69"), dựa vào hàng khách hay lấy để hỏi lại khi nói thiếu tên hàng hoặc số
  ký lệch bất thường.
- **Chọn micro** ngay trên trang (máy tính): danh sách micro gắn sẵn/cắm ngoài, "Mặc định của máy", nút **Thử** có vạch
  âm lượng; rút micro thì tự về mặc định; không có micro thì báo. Chrome chỉ nghe micro mặc định nên chọn micro khác sẽ
  tự chuyển sang "AI nghe ghi âm". Điện thoại luôn dùng micro của máy.
- Đơn chờ hiện thành **bảng, mỗi khách một dòng** (khách, xe, chành, mì, cảo, hoành, thuế, hàng khác, thành tiền — chỉ
  quản lý thấy tiền). Không nói xe/chành thì để trống, không tự điền xe mặc định. Thuế không nói thì theo mặc định khách.
- Mục **📖 Hướng dẫn sử dụng** (mở sẵn lần đầu) có nút **🔊 Nghe hướng dẫn**.

