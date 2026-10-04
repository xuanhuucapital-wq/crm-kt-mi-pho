// Luồng nhập liệu từ ảnh bàn giao của bên giao hàng:
// tải ảnh lên → AI (OpenRouter) đọc số liệu → quản lý xem lại → lưu đơn → chuyển ảnh sang da-nhap-lieu.
const fs = require("fs");
const path = require("path");
const { authErrorResponse, requireRole, requireBusinessUnit } = require("./_auth");
const { appendAudit, nextId, normalizeBusinessUnit, normalizeText, readDatabase, recalculate, updateDatabase } = require("./_database");
const { jsonResponse } = require("./_sheets");
const { parseJsonBody } = require("./_validation");
const {
  cleanModel, listVisionModels, openRouterApiKey, openRouterModel, saveSettings, settingsStatus,
} = require("./_openrouter-env");
const { createOrderFromPayload } = require("./orders");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const AI_TIMEOUT_MS = 55000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_ROWS = 50;
const IMAGE_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function httpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function rootDir() {
  return process.env.BAN_GIAO_DIR
    ? path.resolve(process.env.BAN_GIAO_DIR)
    : path.join(__dirname, "..", "anh-ban-giao");
}

function pendingDir() {
  return path.join(rootDir(), "cho-nhap-lieu");
}

function doneDir() {
  return path.join(rootDir(), "da-nhap-lieu");
}

function trashDir() {
  return path.join(rootDir(), "da-xoa");
}

// Bấm ✕: không xóa hẳn, chuyển ảnh sang thư mục da-xoa để còn lấy lại được.
function removePending(payload) {
  ensureDirs();
  const file = pendingFile(payload.imageName);
  fs.mkdirSync(trashDir(), { recursive: true });
  const name = path.basename(file);
  const target = uniquePath(trashDir(), `${todayInVietnam()}_${path.parse(name).name}`, path.extname(name));
  fs.renameSync(file, target);
  return { ok: true, name, movedTo: `da-xoa/${path.basename(target)}` };
}

function ensureDirs() {
  if (process.env.VERCEL) {
    throw httpError("Bản trên Vercel không có ổ đĩa lâu dài để giữ ảnh. Hãy chạy luồng này bằng npm run local hoặc trên hosting Node.js.", 409);
  }
  fs.mkdirSync(pendingDir(), { recursive: true });
  fs.mkdirSync(doneDir(), { recursive: true });
}

function todayInVietnam() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function safeBaseName(fileName) {
  const parsed = path.parse(String(fileName || "anh-ban-giao"));
  const ext = parsed.ext.toLowerCase();
  if (!IMAGE_TYPES[ext]) throw httpError("Chỉ nhận ảnh JPG, PNG hoặc WEBP.");
  const base = parsed.name
    .normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d")
    .toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 80) || "anh-ban-giao";
  return { base, ext: ext === ".jpeg" ? ".jpg" : ext };
}

function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, `${base}${ext}`);
  for (let index = 2; fs.existsSync(candidate); index += 1) {
    candidate = path.join(dir, `${base}-${index}${ext}`);
  }
  return candidate;
}

// Chỉ cho phép tên file nằm ngay trong thư mục chờ, chặn ../ và đường dẫn tuyệt đối.
function pendingFile(name) {
  const fileName = String(name || "");
  if (!fileName || fileName !== path.basename(fileName) || !IMAGE_TYPES[path.extname(fileName).toLowerCase()]) {
    throw httpError("Tên ảnh không hợp lệ.");
  }
  const full = path.join(pendingDir(), fileName);
  if (!fs.existsSync(full)) throw httpError("Không tìm thấy ảnh trong thư mục chờ nhập liệu (có thể đã được nhập).", 404);
  return full;
}

function detectImageType(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length > 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length > 12 && buffer.slice(0, 4).toString() === "RIFF" && buffer.slice(8, 12).toString() === "WEBP") return "image/webp";
  return "";
}

function listImages(dir, limit = 200) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => IMAGE_TYPES[path.extname(name).toLowerCase()] && !name.startsWith("."))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
    .slice(0, limit);
}

function uploadImage(payload) {
  ensureDirs();
  const { base, ext } = safeBaseName(payload.fileName);
  const raw = String(payload.dataBase64 || "").replace(/^data:[^,]*,/, "");
  if (!raw || !/^[A-Za-z0-9+/=\s]+$/.test(raw)) throw httpError("Dữ liệu ảnh không hợp lệ.");
  const buffer = Buffer.from(raw, "base64");
  if (!buffer.length) throw httpError("Ảnh rỗng.");
  if (buffer.length > MAX_IMAGE_BYTES) throw httpError("Ảnh quá lớn (tối đa 12MB).");
  const type = detectImageType(buffer);
  if (!type) throw httpError("File tải lên không phải ảnh JPG, PNG hoặc WEBP.");
  const realExt = type === "image/png" ? ".png" : type === "image/webp" ? ".webp" : ".jpg";
  const target = uniquePath(pendingDir(), base, ext === realExt ? ext : realExt);
  fs.writeFileSync(target, buffer, { flag: "wx", mode: 0o600 });
  return path.basename(target);
}

// Viết tắt có sẵn cho Xưởng Phở (theo cách anh shipper ghi). Viết tắt học thêm được lưu trong database.
const BUILTIN_ALIASES = {
  pho: [
    ["Đan Phượng Q5 / Q5", "danphuong-q5"],
    ["Đan Phượng Q4 / Q4", "danphuong-q4"],
    ["Đan Phượng Q11 / Q11", "danphuong-q11"],
    ["Đan Phượng QTB / QTB (Quận Tân Bình)", "danphuong-tanbinh"],
    ["Đan Phượng QBT / QBT (Quận Bình Thạnh)", "danphuong-binhthanh"],
    ["Đan Phượng Q10 / Q10", "danphuong-q10-hoahung"],
    ["Đan Phượng Thủ Đức / TĐ", "danphuong-thuduc-23einstein"],
    ["HN (Phở Hà Nội)", "phohanoi"],
    ["Thịnh (Phở Thịnh Cao Lãnh)", "phothinhcaolanh"],
    ["Kim Vân (có thể đọc nhầm thành Kim Dân)", "kimvan"],
    ["Ngô Gia Tự", "ngogiatu"],
    ["Hoa Hồi", "hoahoi"],
    ["Thảo", "thaopho"],
  ],
  mi: [],
};

function learnedAliases(database, businessUnit) {
  return ((database.handoverAliases || {})[businessUnit] || []);
}

function aliasLines(database, businessUnit, customers) {
  const codes = new Set(customers.map((customer) => normalizeText(customer.MaKH)));
  const builtin = (BUILTIN_ALIASES[businessUnit] || []).map(([text, code]) => ({ text, customerCode: code }));
  return [...builtin, ...learnedAliases(database, businessUnit)]
    .filter((item) => codes.has(normalizeText(item.customerCode)))
    .map((item) => `"${item.text}" → ${item.customerCode}`)
    .join("\n");
}

function productSpec(businessUnit) {
  if (businessUnit === "pho") {
    return { fields: ["phoSoiKg", "phoCuonKg"] };
  }
  return { fields: ["miKg", "caoKg", "hoanhKg", "huTieu", "voBanhGoi", "thungXop"] };
}

const PHO_PROMPT = `Ảnh là TỜ GIAO HÀNG VIẾT TAY của anh shipper XƯỞNG PHỞ. Mỗi dòng có dạng:
  TÊN KHÁCH ——— SỐ ĐIỂM GIAO [- TIỀN MẶT ĐÃ THU] ——— SỐ CÂY PHỞ
- SỐ ĐIỂM GIAO (1, 2, 3...) chỉ là thứ tự điểm giao trong chuyến, KHÔNG phải số lượng.
- TIỀN MẶT (nếu có) ghi theo NGHÌN ĐỒNG: 130 = 130.000đ, 520 = 520.000đ. Không có số tiền nghĩa là khách nợ (0).
- SỐ CUỐI DÒNG (bên phải, sau gạch ngang dài) là SỐ CÂY phở sợi (1 cây = 5kg).
- Dấu nháy (") hoặc (ll) ở đầu dòng nghĩa là "như trên", tức là cùng tên với dòng trên: "Đan Phượng Q5" rồi dòng dưới " Q4" = Đan Phượng Q4.
- Dấu ngoặc nhọn } gom nhiều dòng về MỘT số cây: ví dụ QTB điểm 5 và QTB điểm 6 gom lại 12 cây ⇒ MỘT dòng kết quả, 12 cây, diemGiao [5,6].
- Cùng một khách xuất hiện ở nhiều điểm mà chỉ có một dòng ghi số cây/tiền (ví dụ Kim Vân điểm 1 không có số, Kim Vân điểm 10 ghi 520 - 8) ⇒ gộp thành MỘT dòng: 8 cây, tiền mặt 520, diemGiao [1,10].
- Cùng một khách mà MỖI dòng đều có số cây riêng (ví dụ Ngô Gia Tự điểm 2: 130 - 2 và điểm 12: 130 - 2) ⇒ giữ HAI dòng riêng.
- Dòng chỉ có tên và số tiền, không có số điểm (ví dụ "HN ——— 70 —— 1") ⇒ 70 là tiền mặt, 1 là số cây.
- BỎ QUA: các dòng khách bắt đầu bằng chữ M (M Hảo, M Lagi, M Bảo, M29...) vì đó là khách xưởng mì; dòng "chành" (tiền chành xe, ví dụ "20 chành"); các số cộng trừ tổng cuối trang (850, 660, 190...); chữ ký.
- Ngày thường ghi ở góc dạng ngày/tháng (16/9).
- Nếu cuối trang có con số tổng tiền mặt (thường là số đầu tiên của phép tính cuối trang) thì ghi vào tongTienMatCuoiTrang (nghìn đồng), không thì để 0.

Trả về DUY NHẤT JSON:
{"ngay":"16/9","tongTienMatCuoiTrang":850,"dong":[{"khachTrenAnh":"Ngô Gia Tự","maKhach":"ngogiatu","diemGiao":[2],"tienMatNghin":130,"soCay":2,"phoCuonKg":0,"chacChan":true,"ghiChu":""}],"ghiChuChung":""}
- chacChan = false nếu có chữ/số đọc không rõ, và nói rõ lý do trong ghiChu.`;

function buildPrompt(businessUnit, customers, database) {
  const customerLines = customers.map((customer) => `${customer.MaKH} | ${customer.TenKH}`).join("\n");
  const aliases = aliasLines(database, businessUnit, customers);
  const common = `Danh sách khách hàng (mã | tên):
${customerLines || "(chưa có khách)"}

Sổ viết tắt đã học (chữ trên giấy → mã khách):
${aliases || "(chưa có)"}

maKhach chỉ điền khi khớp được khách trong danh sách hoặc sổ viết tắt; không chắc thì để rỗng.
Chỉ ghi số thật sự đọc được, không đoán. Số thập phân dùng dấu chấm.`;
  if (businessUnit === "pho") {
    return `Bạn là nhân viên nhập liệu người Việt, rất quen chữ viết tay.\n${PHO_PROMPT}\n\n${common}`;
  }
  return `Bạn là nhân viên nhập liệu của xưởng mì ở Việt Nam.
Ảnh là phiếu/sổ bàn giao hàng viết tay. Đọc TỪNG DÒNG giao cho từng khách.
Trả về DUY NHẤT JSON:
{"ngay":"dd/mm","tongTienMatCuoiTrang":0,"dong":[{"khachTrenAnh":"","maKhach":"","miKg":0,"caoKg":0,"hoanhKg":0,"huTieu":0,"voBanhGoi":0,"thungXop":0,"tienMatNghin":0,"chacChan":true,"ghiChu":""}],"ghiChuChung":""}
miKg = kg mì; caoKg = kg da cảo ("cảo"); hoanhKg = kg da hoành thánh ("hoành"); tienMatNghin = tiền mặt đã thu, theo nghìn đồng.
Bỏ qua dòng tổng cộng, tiêu đề, chữ ký.

${common}`;
}

function extractJson(text) {
  const cleaned = String(text || "").replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw httpError("AI không trả về dữ liệu đúng định dạng. Hãy thử đọc lại.", 502);
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw httpError("AI trả về JSON lỗi. Hãy thử đọc lại.", 502);
  }
}

function toNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : 0;
  const raw = String(value ?? "").trim().replace(/[^\d.,]/g, "");
  if (!raw) return 0;
  const normalized = /^\d{1,3}(?:\.\d{3})+$/.test(raw) ? raw.replace(/\./g, "") : raw.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 1000000 ? parsed : 0;
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (!match) return "";
  const today = todayInVietnam();
  let year = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : today.slice(0, 4);
  const month = match[2].padStart(2, "0");
  const day = match[1].padStart(2, "0");
  // Tờ không ghi năm: nếu ra ngày ở tương lai (vd tờ 28/12 nhập vào tháng 1) thì lùi về năm trước.
  if (!match[3] && `${year}-${month}-${day}` > today) year = String(Number(year) - 1);
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.getUTCDate() !== Number(day) ? "" : `${year}-${month}-${day}`;
}

function matchCustomer(row, customers, aliases) {
  const byCode = (code) => customers.find((customer) => normalizeText(customer.MaKH) === normalizeText(code));
  const aiCode = byCode(row.maKhach);
  if (aiCode) return aiCode.MaKH;
  const text = normalizeText(row.khachTrenAnh);
  if (!text) return "";
  const learned = aliases.find((item) => normalizeText(item.text) === text && byCode(item.customerCode));
  if (learned) return byCode(learned.customerCode).MaKH;
  const exact = customers.filter((customer) => (
    normalizeText(customer.TenKH) === text || normalizeText(customer.MaKH) === text
  ));
  if (exact.length === 1) return exact[0].MaKH;
  const partial = customers.filter((customer) => {
    const name = normalizeText(customer.TenKH);
    return name && (name.includes(text) || text.includes(name));
  });
  return partial.length === 1 ? partial[0].MaKH : "";
}

function uniqueNumbers(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(/[^\d]+/);
  return [...new Set(list.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0 && item < 1000))];
}

async function callOpenRouter(model, content) {
  const apiKey = openRouterApiKey();
  if (!apiKey) throw httpError("Chưa có khóa OpenRouter. Vào mục Cài đặt AI để nhập khóa.", 409);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-title": "CRM Nha Xuong - nhap lieu anh ban giao",
      },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: "user", content }] }),
    });
  } catch (error) {
    if (error.name === "AbortError") throw httpError("AI trả lời quá lâu, thử lại hoặc chọn model nhanh hơn.", 504);
    throw httpError("Không kết nối được OpenRouter. Kiểm tra mạng của máy chủ.", 502);
  } finally {
    clearTimeout(timer);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = response.status === 401 ? "khóa API sai hoặc đã bị thu hồi"
      : response.status === 402 ? "tài khoản OpenRouter hết tiền"
        : response.status === 429 ? "gọi quá nhanh, chờ một chút rồi thử lại"
          : String(data?.error?.message || `HTTP ${response.status}`).slice(0, 200);
    throw httpError(`OpenRouter báo lỗi (${model}): ${reason}.`, 502);
  }
  const message = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(message) ? message.map((part) => part.text || "").join("") : message;
  return { json: extractJson(text), cost: Number(data.usage?.cost || 0) || null };
}

async function customerContext(businessUnit) {
  const database = await readDatabase();
  const customers = (database.crm?.customers || [])
    .filter((customer) => normalizeBusinessUnit(customer.businessUnit) === businessUnit);
  const aliases = [
    ...(BUILTIN_ALIASES[businessUnit] || []).map(([text, customerCode]) => ({ text, customerCode })),
    ...learnedAliases(database, businessUnit),
  ];
  return { database, customers, aliases };
}

function normalizeAiRow(row, businessUnit, customers, aliases) {
  const item = {
    khachTrenAnh: String(row.khachTrenAnh || row.khach || "").slice(0, 200),
    customerCode: matchCustomer(row, customers, aliases),
    points: uniqueNumbers(row.diemGiao),
    cashThousand: toNumber(row.tienMatNghin),
    sure: row.chacChan !== false,
    nhaXe: String(row.nhaXe || "").slice(0, 150),
    ghiChu: String(row.ghiChu || "").slice(0, 500),
  };
  productSpec(businessUnit).fields.forEach((field) => { item[field] = toNumber(row[field]); });
  if (businessUnit === "pho") {
    item.phoSoiUnit = row.phoSoiUnit === "kg" ? "kg" : "cay";
    item.phoSoiKg = toNumber(row.soCay ?? row.phoSoiKg);
  }
  return item;
}

// Trò chuyện tự do với trợ lý nhập liệu: trả lời câu hỏi (công nợ, sản lượng...) hoặc sửa bảng đang duyệt.
// Hỏi kiểu "Đan Phượng Q4 có thiếu ngày nào không": tính sẵn bằng code cho chính xác, AI chỉ đọc lại.
function customerDayReport(orders, customers, aliases, message) {
  const said = normalizeText(message);
  const named = customers.filter((customer) => {
    const name = normalizeText(customer.TenKH);
    const code = normalizeText(customer.MaKH);
    if (name && said.includes(name)) return true;
    if (code && said.includes(code)) return true;
    return aliases.some((item) => item.customerCode === customer.MaKH && normalizeText(item.text).length > 2 && said.includes(normalizeText(item.text)));
  });
  if (!named.length || named.length > 4) return "";
  const dayHasSheet = new Set(orders.filter((order) => order.date).map((order) => order.date));
  return named.map((customer) => {
    const mine = orders.filter((order) => order.customerName === customer.TenKH && order.date);
    if (!mine.length) return `${customer.TenKH}: chưa có đơn nào trong sổ.`;
    const dates = mine.map((order) => order.date).sort();
    const first = dates[0];
    const mineSet = new Set(dates);
    const sheetDays = [...dayHasSheet].filter((date) => date >= first).sort();
    const missing = sheetDays.filter((date) => !mineSet.has(date));
    const twice = [...new Set(dates.filter((date, index) => dates.indexOf(date) !== index))];
    const qty = (order) => Number(order.phoSoiKg || 0) + Number(order.phoCuonKg || 0) + Number(order.miKg || 0) + Number(order.caoKg || 0) + Number(order.hoanhKg || 0);
    const average = Math.round(mine.reduce((sum, order) => sum + qty(order), 0) / mine.length);
    return [
      `${customer.TenKH} (${customer.MaKH}): ${mine.length} đơn, từ ${first} tới ${dates.at(-1)}, trung bình ${average} kg/đơn.`,
      `- Ngày sổ có ghi hàng (cả xưởng) từ ${first}: ${sheetDays.length} ngày; khách này có đơn ${sheetDays.length - missing.length} ngày.`,
      `- VẮNG (ngày cả xưởng có sổ mà khách này không có đơn, ${missing.length} ngày): ${missing.length ? missing.join(", ") : "không có"}.`,
      twice.length ? `- Ngày có TỪ 2 ĐƠN trở lên (coi chừng nhập trùng): ${twice.join(", ")}.` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

async function chatWithAi(payload, businessUnit) {
  const message = String(payload.message || "").trim().slice(0, 2000);
  if (!message) throw httpError("Chưa có nội dung.");
  const rows = (Array.isArray(payload.rows) ? payload.rows : []).slice(0, MAX_ROWS);
  const { database, customers, aliases } = await customerContext(businessUnit);
  recalculate(database);
  const model = cleanModel(payload.model) || openRouterModel();
  const today = todayInVietnam();
  const orders = (database.crm?.orders || []).filter((order) => normalizeBusinessUnit(order.businessUnit) === businessUnit);
  const since = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const recentDays = {};
  orders.filter((order) => order.date >= since).forEach((order) => {
    const day = recentDays[order.date] || (recentDays[order.date] = { don: 0, kg: 0, tien: 0, no: 0 });
    day.don += 1;
    day.kg += Number(order.phoSoiKg || 0) + Number(order.phoCuonKg || 0) + Number(order.miKg || 0) + Number(order.caoKg || 0) + Number(order.hoanhKg || 0);
    day.tien += Number(order.total || 0);
    day.no += Number(order.debt || 0);
  });
  const dayReport = customerDayReport(orders, customers, aliases, message);
  // Ngày cả xưởng không có đơn nào (có thể là ngày nghỉ, cũng có thể là tờ chưa nhập).
  const allDays = new Set(orders.filter((order) => order.date).map((order) => order.date));
  const blankDays = [];
  for (let back = 1; back <= 60; back += 1) {
    const date = new Date(Date.parse(`${today}T00:00:00Z`) - back * 86400000).toISOString().slice(0, 10);
    if (!allDays.has(date)) blankDays.push(date);
  }
  const customerTable = customers.map((customer) => [
    customer.MaKH, customer.TenKH,
    `giá ${businessUnit === "pho" ? `${customer.GiaPhoSoi}/kg sợi` : `mì ${customer.GiaMi}`}`,
    `nợ ${Math.round(Number(customer.debt || 0))}`,
    `đơn gần nhất ${customer.lastOrderDate || "-"}`,
  ].join(" | ")).join("\n");
  const history = (Array.isArray(payload.history) ? payload.history : []).slice(-10)
    .map((item) => `${item.role === "me" ? "Chủ xưởng" : "Trợ lý"}: ${String(item.text || "").slice(0, 400)}`).join("\n");
  const tableJson = rows.map((row, index) => ({
    dong: index + 1,
    khachTrenAnh: row.khachTrenAnh || "",
    maKhach: row.customerCode || "",
    diemGiao: uniqueNumbers(row.points),
    tienMatNghin: toNumber(row.cashThousand),
    ...(businessUnit === "pho"
      ? { soCay: toNumber(row.phoSoiKg), phoSoiUnit: row.phoSoiUnit === "kg" ? "kg" : "cay", phoCuonKg: toNumber(row.phoCuonKg) }
      : Object.fromEntries(productSpec(businessUnit).fields.map((field) => [field, toNumber(row[field])]))),
    ghiChu: row.ghiChu || "",
  }));
  const prompt = `Bạn là trợ lý nhập liệu của ${businessUnit === "pho" ? "xưởng phở" : "xưởng mì"} (Việt Nam). Hôm nay ${today}. Trả lời ngắn gọn, thân thiện, xưng "tôi", gọi "anh".
Phở sợi bán theo cây, 1 cây = 5kg. Tiền trong bảng đang duyệt tính theo NGHÌN đồng. Tiền trong dữ liệu khách tính theo đồng.

Khách hàng (mã | tên | giá | tổng nợ hiện tại | đơn gần nhất):
${customerTable || "(chưa có)"}

${dayReport ? `KIỂM TRA NGÀY CỦA KHÁCH ĐƯỢC HỎI (đã tính sẵn bằng máy, số này ĐÚNG, cứ đọc lại, đừng tự đếm lại):
${dayReport}

` : ""}${blankDays.length ? `Ngày cả xưởng KHÔNG có đơn nào trong 60 ngày qua (nghỉ, hoặc tờ chưa nhập): ${blankDays.join(", ")}

` : ""}Tổng theo ngày 14 ngày gần đây (ngày: số đơn, kg, tiền hàng, còn nợ): ${JSON.stringify(recentDays)}

${rows.length ? `BẢNG ĐANG DUYỆT (chưa ghi vào sổ, ngày giao ${payload.date || "?"}):\n${JSON.stringify(tableJson)}` : "Hiện không có bảng nào đang duyệt."}

Hội thoại gần đây:
${history || "(mới bắt đầu)"}

Chủ xưởng nhắn: "${message.replace(/"/g, "'")}"

Nếu tin nhắn yêu cầu sửa BẢNG ĐANG DUYỆT (thêm, xóa, đổi khách, số cây, tiền...), đặt suaBang = true và trả về toàn bộ bảng sau khi sửa trong "dong" (cùng cấu trúc, bỏ trường dong), chỉ đổi những gì được nhắc.
Hỏi "khách X có thiếu ngày nào không / ngày nào chưa nhập": trả lời theo mục KIỂM TRA NGÀY ở trên — nói rõ vắng bao nhiêu ngày, liệt kê ngày (nhiều quá thì nói tổng số rồi liệt kê 10 ngày gần nhất), và nhắc nếu ngày đó cả xưởng cũng không có đơn (tờ chưa nhập) hay chỉ mình khách đó vắng. Có ngày 2 đơn thì nhắc anh coi chừng nhập trùng.
Nếu chủ xưởng ĐỒNG Ý ghi bảng đang duyệt vào sổ ("ok", "ừ đúng rồi", "cập nhật đi", "lưu giúp tôi", "chốt", "nhập luôn"), đặt capNhat = true (và suaBang = false), traLoi ngắn kiểu "Tôi ghi vào sổ ngay." — trang sẽ tự bấm Cập nhật. Nếu KHÔNG có bảng nào đang duyệt thì capNhat = false và nói rõ: chưa có bảng nào đang chờ, anh chọn ảnh rồi bấm Scan.
Không bao giờ nói "đã cập nhật/đã ghi sổ" khi capNhat = false — anh sẽ tưởng đã ghi mà thật ra chưa.
Nếu chỉ là câu hỏi/trò chuyện, đặt suaBang = false, không trả "dong". Chỉ dùng số liệu có ở trên, không bịa; không có dữ liệu thì nói không có.
Bạn KHÔNG tự ghi sổ được; muốn ghi thì anh bấm Cập nhật hoặc nhắn "ok".
Trả về DUY NHẤT JSON: {"traLoi":"...","suaBang":false,"capNhat":false,"dong":[]}`;
  const { json, cost } = await callOpenRouter(model, [{ type: "text", text: prompt }]);
  const edit = Boolean(json.suaBang) && rows.length > 0 && Array.isArray(json.dong);
  return {
    model,
    cost,
    reply: String(json.traLoi || (edit ? "Đã sửa theo yêu cầu." : "Tôi chưa hiểu ý anh.")).slice(0, 2000),
    edited: edit,
    commit: Boolean(json.capNhat) && !edit && rows.length > 0,
    rows: edit ? json.dong.slice(0, MAX_ROWS).map((row) => normalizeAiRow(row, businessUnit, customers, aliases)) : undefined,
  };
}

// Sửa bảng đã đọc theo lời nhắn trong ô chat (không gửi lại ảnh).
async function editWithAi(payload, businessUnit) {
  const message = String(payload.message || "").trim().slice(0, 2000);
  if (!message) throw httpError("Chưa có nội dung cần sửa.");
  const rows = (Array.isArray(payload.rows) ? payload.rows : []).slice(0, MAX_ROWS);
  const { customers, aliases } = await customerContext(businessUnit);
  const model = cleanModel(payload.model) || openRouterModel();
  const current = rows.map((row, index) => ({
    dong: index + 1,
    khachTrenAnh: row.khachTrenAnh || "",
    maKhach: row.customerCode || "",
    diemGiao: uniqueNumbers(row.points),
    tienMatNghin: toNumber(row.cashThousand),
    ...(businessUnit === "pho"
      ? { soCay: toNumber(row.phoSoiKg), phoSoiUnit: row.phoSoiUnit === "kg" ? "kg" : "cay", phoCuonKg: toNumber(row.phoCuonKg) }
      : Object.fromEntries(productSpec(businessUnit).fields.map((field) => [field, toNumber(row[field])]))),
    nhaXe: row.nhaXe || "",
    ghiChu: row.ghiChu || "",
  }));
  const prompt = `Bạn là trợ lý nhập liệu. Đây là bảng đơn hàng đã đọc từ tờ giao hàng (JSON):
${JSON.stringify(current)}

Danh sách khách (mã | tên):
${customers.map((customer) => `${customer.MaKH} | ${customer.TenKH}`).join("\n")}

Chủ xưởng nhắn: "${message.replace(/"/g, "'")}"

Hãy sửa bảng đúng theo lời nhắn (thêm, xóa, đổi khách, đổi số cây, tiền mặt theo NGHÌN đồng...). Không đổi những gì không được nhắc.
Trả về DUY NHẤT JSON: {"traLoi":"một câu ngắn tiếng Việt nói đã sửa gì","dong":[ ...cùng cấu trúc như trên, bỏ trường dong... ]}`;
  const { json, cost } = await callOpenRouter(model, [{ type: "text", text: prompt }]);
  if (!Array.isArray(json.dong)) throw httpError("AI không trả về bảng sau khi sửa. Thử nói rõ hơn.", 502);
  return {
    model,
    cost,
    reply: String(json.traLoi || "Đã sửa theo yêu cầu.").slice(0, 500),
    rows: json.dong.slice(0, MAX_ROWS).map((row) => normalizeAiRow(row, businessUnit, customers, aliases)),
  };
}

async function readWithAi(imageName, businessUnit, requestedModel) {
  if (!openRouterApiKey()) throw httpError("Chưa có khóa OpenRouter. Vào mục Cài đặt AI để nhập khóa.", 409);
  const file = pendingFile(imageName);
  const buffer = fs.readFileSync(file);
  const mime = detectImageType(buffer) || IMAGE_TYPES[path.extname(file).toLowerCase()];
  const { database, customers, aliases } = await customerContext(businessUnit);
  const model = cleanModel(requestedModel) || openRouterModel();
  const { json: parsed, cost } = await callOpenRouter(model, [
    { type: "text", text: buildPrompt(businessUnit, customers, database) },
    { type: "image_url", image_url: { url: `data:${mime};base64,${buffer.toString("base64")}` } },
  ]);
  const rows = (Array.isArray(parsed.dong) ? parsed.dong : []).slice(0, MAX_ROWS)
    // Xưởng phở: dòng "M Hảo", "M29"... là khách xưởng mì ghi chung tờ → bỏ.
    .filter((row) => !(businessUnit === "pho" && /^M\s*[\p{Lu}\d]/u.test(String(row.khachTrenAnh || "").trim())))
    .map((row) => normalizeAiRow(row, businessUnit, customers, aliases));
  return {
    model,
    date: normalizeDate(parsed.ngay),
    pageCashThousand: toNumber(parsed.tongTienMatCuoiTrang),
    note: String(parsed.ghiChuChung || "").slice(0, 1000),
    cost,
    rows,
  };
}

function moveToDone(imageName) {
  const source = pendingFile(imageName);
  const { name, ext } = path.parse(source);
  const target = uniquePath(doneDir(), `${todayInVietnam()}_${name}`, ext);
  fs.renameSync(source, target);
  return path.basename(target);
}

// Ghi tiền mặt shipper đã thu: trừ vào đơn vừa tạo trước, dư thì trừ các đơn nợ cũ nhất của khách.
function applyCash(database, { customer, order, amount, businessUnit, date, imageName }) {
  const debtOrders = database.crm.orders
    .filter((item) => (
      normalizeBusinessUnit(item.businessUnit) === businessUnit
      && normalizeText(item.customerName) === normalizeText(customer.TenKH)
      && Number(item.debt) > 0
    ))
    .sort((first, second) => (
      (Number(first.id) === Number(order.id) ? 0 : 1) - (Number(second.id) === Number(order.id) ? 0 : 1)
      || (first.date || "9999").localeCompare(second.date || "9999")
      || Number(first.id) - Number(second.id)
    ));
  const totalDebt = debtOrders.reduce((sum, item) => sum + Number(item.debt), 0);
  if (amount > totalDebt) {
    throw new Error(`tiền mặt ${amount.toLocaleString("vi-VN")}đ lớn hơn tổng nợ ${totalDebt.toLocaleString("vi-VN")}đ của ${customer.TenKH}`);
  }
  let remaining = amount;
  const allocations = [];
  debtOrders.forEach((item) => {
    if (remaining <= 0) return;
    const applied = Math.min(remaining, Number(item.debt));
    item.paid = Number(item.paid || 0) + applied;
    item.debt = Number(item.debt) - applied;
    remaining -= applied;
    allocations.push({ orderId: item.id, amount: applied });
  });
  if (!allocations.some((item) => Number(item.orderId) !== Number(order.id))) {
    order.paymentMethod = order.paid >= order.total ? "cash" : order.paymentMethod;
  }
  const payments = database.payments || (database.payments = []);
  const payment = {
    id: nextId(payments),
    customerCode: customer.MaKH,
    customerName: customer.TenKH,
    amount,
    date,
    method: "cash",
    note: `Tiền mặt shipper thu (ảnh bàn giao ${imageName}).`,
    allocations,
    businessUnit,
    createdAt: new Date().toISOString(),
  };
  payments.unshift(payment);
  return payment;
}

function learnAliases(database, businessUnit, rows) {
  const store = database.handoverAliases || (database.handoverAliases = {});
  const list = store[businessUnit] || (store[businessUnit] = []);
  let learned = 0;
  rows.forEach((row) => {
    const text = String(row.khachTrenAnh || "").trim().slice(0, 100);
    if (!text || !row.customerCode) return;
    const existing = list.find((item) => normalizeText(item.text) === normalizeText(text));
    if (existing) {
      if (existing.customerCode !== row.customerCode) {
        existing.customerCode = row.customerCode;
        learned += 1;
      }
      return;
    }
    const builtin = (BUILTIN_ALIASES[businessUnit] || []).some(([alias, code]) => (
      code === row.customerCode && normalizeText(alias).includes(normalizeText(text))
    ));
    if (builtin) return;
    list.push({ text, customerCode: row.customerCode, learnedAt: new Date().toISOString() });
    learned += 1;
  });
  if (list.length > 300) list.splice(0, list.length - 300);
  return learned;
}

async function saveRows(payload, businessUnit, sessionUser) {
  ensureDirs();
  const imageName = String(payload.imageName || "");
  pendingFile(imageName);
  const rows = Array.isArray(payload.orders) ? payload.orders : [];
  if (!rows.length) throw httpError("Chưa có dòng nào để lưu.");
  if (rows.length > MAX_ROWS) throw httpError(`Chỉ lưu tối đa ${MAX_ROWS} dòng mỗi ảnh.`);
  const spec = productSpec(businessUnit);

  // Lưu kiểu "tất cả hoặc không": có một dòng lỗi thì không ghi dòng nào, ảnh vẫn nằm ở thư mục chờ.
  const result = await updateDatabase((database) => {
    const errors = [];
    const orders = [];
    const payments = [];
    rows.forEach((row, index) => {
      const orderPayload = {
        businessUnit,
        customerCode: String(row.customerCode || ""),
        orderDate: String(row.orderDate || ""),
        nhaXe: String(row.nhaXe || ""),
        extraShipCustomer: "",
        tienUng: 0,
        taxPayer: "customer",
        customerResting: row.customerResting === true,
        ghiChu: String(row.ghiChu || ""),
        paymentMethod: "debt",
        miKg: 0, caoKg: 0, hoanhKg: 0, huTieu: 0, voBanhGoi: 0, thungXop: 0,
        phoSoiKg: 0, phoSoiUnit: row.phoSoiUnit === "kg" ? "kg" : "cay", phoCuonKg: 0,
      };
      spec.fields.forEach((field) => { orderPayload[field] = row[field] ?? 0; });
      try {
        if (!orderPayload.customerCode) throw new Error("chưa chọn khách hàng");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(orderPayload.orderDate)) throw new Error("ngày giao không hợp lệ");
        const cash = Math.round(toNumber(row.cash));
        const order = createOrderFromPayload(database, orderPayload, businessUnit, sessionUser);
        order.sourceImage = imageName;
        if (cash > 0) {
          const customer = database.crm.customers.find((item) => (
            normalizeBusinessUnit(item.businessUnit) === businessUnit
            && normalizeText(item.MaKH) === normalizeText(orderPayload.customerCode)
          ));
          payments.push(applyCash(database, {
            customer, order, amount: cash, businessUnit, date: orderPayload.orderDate, imageName,
          }));
        }
        orders.push(order);
      } catch (error) {
        errors.push(`Dòng ${index + 1}: ${error.message}`);
      }
    });
    if (errors.length) throw httpError(`Chưa lưu gì cả. ${errors.join("; ")}`);
    const learned = learnAliases(database, businessUnit, rows);
    appendAudit(database, {
      action: "handover-image-imported",
      actorUserId: sessionUser.id,
      actorEmail: sessionUser.email,
      actorName: sessionUser.displayName,
      summary: `${sessionUser.displayName} nhập ${orders.length} đơn từ ảnh bàn giao ${imageName}.`,
      businessUnit,
      details: {
        imageName,
        orderIds: orders.map((order) => order.id),
        cashTotal: payments.reduce((sum, item) => sum + item.amount, 0),
        learnedAliases: learned,
      },
    });
    const touchedIds = new Set(payments.flatMap((payment) => payment.allocations.map((item) => Number(item.orderId))));
    const touched = database.crm.orders.filter((order) => touchedIds.has(Number(order.id)));
    return { orders: [...orders, ...touched.filter((order) => !orders.includes(order))], payments, learned };
  });

  let movedTo = "";
  let warning = "";
  try {
    movedTo = moveToDone(imageName);
  } catch (error) {
    warning = `Đã lưu đơn nhưng chưa chuyển được ảnh: ${error.message}`;
  }
  return { ...result, movedTo, warning };
}

async function listAliases(businessUnit) {
  const database = await readDatabase();
  return {
    builtin: (BUILTIN_ALIASES[businessUnit] || []).map(([text, customerCode]) => ({ text, customerCode })),
    learned: learnedAliases(database, businessUnit),
  };
}

async function updateAliases(payload, businessUnit, sessionUser) {
  const text = String(payload.text || "").trim().slice(0, 100);
  if (!text) throw httpError("Chưa nhập chữ viết tắt.");
  return updateDatabase((database) => {
    const store = database.handoverAliases || (database.handoverAliases = {});
    const list = store[businessUnit] || (store[businessUnit] = []);
    const index = list.findIndex((item) => normalizeText(item.text) === normalizeText(text));
    if (payload.remove) {
      if (index >= 0) list.splice(index, 1);
    } else {
      const code = String(payload.customerCode || "");
      const exists = database.crm.customers.some((customer) => (
        normalizeBusinessUnit(customer.businessUnit) === businessUnit && customer.MaKH === code
      ));
      if (!exists) throw httpError("Khách hàng không thuộc phân hệ đang chọn.");
      if (index >= 0) list[index].customerCode = code;
      else list.push({ text, customerCode: code, learnedAt: new Date().toISOString() });
    }
    appendAudit(database, {
      action: "handover-alias-updated",
      actorUserId: sessionUser.id,
      actorEmail: sessionUser.email,
      actorName: sessionUser.displayName,
      summary: `${sessionUser.displayName} ${payload.remove ? "xóa" : "cập nhật"} viết tắt "${text}".`,
      businessUnit,
      details: { text, customerCode: payload.customerCode || "" },
    });
    return list;
  });
}

// Gợi ý ngày giao: ưu tiên hôm nay nếu chưa có đơn nào, rồi lùi dần tới ngày cũ chưa nhập.
async function suggestDate(businessUnit, days = 45) {
  const database = await readDatabase();
  const orders = (database.crm?.orders || []).filter((order) => normalizeBusinessUnit(order.businessUnit) === businessUnit);
  const entered = new Set(orders.map((order) => order.date));
  const today = todayInVietnam();
  const start = Date.parse(`${today}T00:00:00Z`);
  const missing = [];
  let lastEntered = "";
  for (let back = 0; back < days; back += 1) {
    const date = new Date(start - back * 86400000).toISOString().slice(0, 10);
    if (entered.has(date)) { if (!lastEntered) lastEntered = date; } else missing.push(date);
  }
  // Ngày quá cũ mà chưa bao giờ nhập (trước khi bắt đầu dùng phần mềm) thì bỏ qua.
  const firstEver = orders.map((order) => order.date).filter(Boolean).sort()[0] || today;
  const useful = missing.filter((date) => date >= firstEver);
  return { suggested: useful[0] || today, missing: useful.slice(0, 12), lastEntered, today };
}

function imageResponse(name) {
  const file = pendingFile(name);
  const buffer = fs.readFileSync(file);
  return {
    statusCode: 200,
    headers: {
      "content-type": detectImageType(buffer) || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
    isBase64Encoded: true,
    body: buffer.toString("base64"),
  };
}

exports.handler = async (event) => {
  try {
    const sessionUser = await requireRole(event, "manager");
    const query = event.queryStringParameters || {};

    if (event.httpMethod === "GET") {
      const action = String(query.action || "pending");
      if (action === "settings") return jsonResponse(200, settingsStatus());
      if (action === "image") return imageResponse(query.name);
      if (action === "models") return jsonResponse(200, await listVisionModels({ force: query.refresh === "1" }));
      if (action === "aliases") {
        const businessUnit = requireBusinessUnit(sessionUser, query.businessUnit);
        return jsonResponse(200, await listAliases(businessUnit));
      }
      if (action === "pending") {
        const unit = requireBusinessUnit(sessionUser, query.businessUnit);
        return jsonResponse(200, {
          storage: process.env.VERCEL ? "vercel" : "disk",
          dateSuggestion: await suggestDate(unit),
          pending: process.env.VERCEL ? [] : listImages(pendingDir()),
          done: process.env.VERCEL ? [] : listImages(doneDir(), 15),
        });
      }
      return jsonResponse(400, { error: "Thao tác không hợp lệ." });
    }
    if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });

    const payload = parseJsonBody(event);
    if (payload.action === "settings") {
      return jsonResponse(200, { ok: true, ...saveSettings(payload) });
    }
    const businessUnit = requireBusinessUnit(sessionUser, payload.businessUnit || query.businessUnit);
    if (payload.action === "upload") {
      return jsonResponse(201, { ok: true, name: uploadImage(payload) });
    }
    if (payload.action === "read") {
      return jsonResponse(200, { ok: true, ...(await readWithAi(payload.imageName, businessUnit, payload.model)) });
    }
    if (payload.action === "chat") {
      return jsonResponse(200, { ok: true, ...(await chatWithAi(payload, businessUnit)) });
    }
    if (payload.action === "chat-edit") {
      return jsonResponse(200, { ok: true, ...(await editWithAi(payload, businessUnit)) });
    }
    if (payload.action === "alias") {
      return jsonResponse(200, { ok: true, learned: await updateAliases(payload, businessUnit, sessionUser) });
    }
    if (payload.action === "delete-pending") return jsonResponse(200, removePending(payload));
    if (payload.action === "save") {
      const result = await saveRows(payload, businessUnit, sessionUser);
      return jsonResponse(201, { ok: true, ...result });
    }
    return jsonResponse(400, { error: "Thao tác không hợp lệ." });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(400, { error: error.message });
  }
};

// Dùng chung cho luồng nhập liệu bằng giọng nói.
exports.shared = { callOpenRouter, httpError, todayInVietnam, toNumber, normalizeDate, learnedAliases, matchCustomer, cleanModel };
