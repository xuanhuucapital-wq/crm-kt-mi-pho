// Nhập đơn Xưởng Mì bằng giọng nói: nhân viên đóng hàng nói → AI tách đơn → hỏi lại chỗ thiếu → người nói xác nhận → lưu.
const { authErrorResponse, requireAuth, requireBusinessUnit } = require("./_auth");
const { appendAudit, normalizeBusinessUnit, normalizeText, readDatabase, updateDatabase } = require("./_database");
const { jsonResponse } = require("./_sheets");
const { parseJsonBody } = require("./_validation");
const fs = require("fs");
const path = require("path");
const {
  openRouterApiKey, openRouterListenModel, openRouterVoiceModel, saveSettings, settingsStatus,
} = require("./_openrouter-env");
const { createOrderFromPayload } = require("./orders");
const {
  callOpenRouter, httpError, todayInVietnam, toNumber, normalizeDate, learnedAliases, matchCustomer, cleanModel,
} = require("./ban-giao").shared;

const MAX_ORDERS = 30;
const QTY_FIELDS = ["miKg", "caoKg", "hoanhKg", "huTieu", "voBanhGoi", "thungXop"];
const ALLOWED_ROLES = ["manager", "packer", "delivery"];
const MAX_AUDIO_BASE64 = 6 * 1024 * 1024;
exports.spokenDate = spokenDate;
const QTY_NAMES = { miKg: "mì", caoKg: "cảo", hoanhKg: "hoành", huTieu: "hủ tiếu", voBanhGoi: "vỏ bánh gối", thungXop: "thùng xốp" };

// Ngày nói ra ("15 tháng 9", "ngày 15/9", "15-9-2026") → YYYY-MM-DD.
// Không nói năm thì lấy năm gần nhất tính tới hôm nay (cho phép trước tối đa 2 ngày, ví dụ đơn ngày mai).
function spokenDate(value, today = todayInVietnam()) {
  const text = normalizeText(value).replace(/^ngay\s*/, "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return normalizeDate(text);
  const match = text.match(/^(\d{1,2})\s*(?:thang|th|[/.-])\s*(\d{1,2})(?:\s*(?:nam|[/.-])\s*(\d{2,4}))?$/);
  if (!match) return "";
  const day = Number(match[1]);
  const month = Number(match[2]);
  const valid = (year) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : "";
  };
  if (match[3]) return valid(Number(match[3].length === 2 ? `20${match[3]}` : match[3]));
  const limit = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
  const thisYear = Number(today.slice(0, 4));
  for (const year of [thisYear, thisYear - 1, thisYear - 2]) {
    const date = valid(year);
    if (date && date <= limit) return date;
  }
  return "";
}

function dayMonthYear(iso) {
  const [year, month, day] = String(iso || "").split("-");
  return year && month && day ? `${day}/${month}/${year}` : "";
}

// Mặt hàng khách hay lấy (trung bình 3 đơn gần nhất) để gợi ý khi nhân viên nói thiếu tên hàng.
function usualGoods(orders, customerName) {
  const recent = orders
    .filter((order) => normalizeText(order.customerName) === normalizeText(customerName) && !order.customerResting)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, 3);
  if (!recent.length) return "";
  return QTY_FIELDS.map((field) => {
    const average = recent.reduce((sum, order) => sum + Number(order[field] || 0), 0) / recent.length;
    return average > 0 ? `${QTY_NAMES[field]} ~${Math.round(average)}` : "";
  }).filter(Boolean).join(", ");
}

function recentTrucks(orders, customerName, since) {
  const counts = new Map();
  orders.forEach((order) => {
    if (order.date < since || normalizeText(order.customerName) !== normalizeText(customerName) || !order.truck) return;
    const key = String(order.truck).trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([truck]) => truck);
}

async function context(businessUnit) {
  const database = await readDatabase();
  const customers = (database.crm?.customers || [])
    .filter((customer) => normalizeBusinessUnit(customer.businessUnit) === businessUnit);
  const orders = (database.crm?.orders || [])
    .filter((order) => normalizeBusinessUnit(order.businessUnit) === businessUnit);
  const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const trucks = new Map(customers.map((customer) => [customer.MaKH, recentTrucks(orders, customer.TenKH, since)]));
  const usual = new Map(customers.map((customer) => [customer.MaKH, usualGoods(orders, customer.TenKH)]));
  const aliases = learnedAliases(database, businessUnit);
  return { database, customers, orders, trucks, usual, aliases };
}

function buildPrompt({ customers, trucks, usual, aliases }, payload, today, hasAudio) {
  const customerLines = customers.map((customer) => {
    const list = [customer.NhaXeMacDinh, ...(trucks.get(customer.MaKH) || [])].filter(Boolean);
    return `${customer.MaKH} | ${customer.TenKH} | xe: ${[...new Set(list)].join(", ") || "-"} | hay lấy: ${usual.get(customer.MaKH) || "-"}`;
  }).join("\n");
  const aliasLines = aliases.map((item) => `"${item.text}" → ${item.customerCode}`).join("\n");
  const pending = (Array.isArray(payload.pending) ? payload.pending : []).slice(0, MAX_ORDERS).map((row, index) => ({
    so: index + 1,
    tenKhachNoi: row.tenKhachNoi || "",
    maKhach: row.customerCode || "",
    nhaXe: row.nhaXe || "",
    tienChanh: toNumber(row.tienUng),
    thue: row.taxRate === null || row.taxRate === undefined || row.taxRate === "" ? null : Number(row.taxRate),
    ...Object.fromEntries(QTY_FIELDS.map((field) => [field, toNumber(row[field])])),
    ngay: dayMonthYear(row.orderDate),
    ghiChu: row.ghiChu || "",
  }));
  const history = (Array.isArray(payload.history) ? payload.history : []).slice(-8)
    .map((item) => `${item.role === "me" ? "Nhân viên" : "Trợ lý"}: ${String(item.text || "").slice(0, 300)}`).join("\n");
  const said = hasAudio
    ? "(nghe ĐOẠN GHI ÂM đính kèm; ghi lại nguyên văn vào trường \"nghe\")"
    : `"${String(payload.text || "").replace(/"/g, "'")}"`;
  return `Bạn là trợ lý nhập đơn của XƯỞNG MÌ (Việt Nam), nói chuyện với nhân viên đóng hàng, có người KHÔNG biết chữ nên mọi câu trả lời sẽ được ĐỌC TO.
${hasAudio ? "Nhân viên nói bằng giọng (ghi âm đính kèm, có thể ồn, giọng miền Tây/miền Nam)." : "Lời nói đã được chuyển thành chữ, có thể sai chính tả, không dấu, số viết bằng chữ."}
Hôm nay ${today}.

Cách nói thường gặp:
- "M29 Châu Đốc Huệ Nghĩa, mì 10 ký, cảo 2 ký" = khách M29 (Châu Đốc), đi XE Huệ Nghĩa.
- "Long Xuyên Ba Nhi chành 20, mì 15 ký" = khách có tên chứa Long Xuyên, xe Ba Nhi, tiền chành (tiền ứng chành xe) 20.000đ.
- Tên địa danh (Long Xuyên, Châu Đốc, La Gi...) thường là một phần TÊN KHÁCH. Tên còn lại sau tên khách thường là NHÀ XE; so với cột "xe" của khách.
- Máy nghe hay sai chữ: "cạo/cáo/kháo/cao" = cảo; "vành/hoàn/hoằn/doanh/thành" (đứng sau con số) = hoành; "mỳ/mi/mê" = mì; "em hai ba/mờ hai ba/M hai ba" = M23.
- Kiểu nói gọn: "bốn cảo một hoành" = caoKg 4, hoanhKg 1 (số đứng TRƯỚC tên hàng, không cần chữ ký). "mì hai chục" = miKg 20. "rưỡi" = ,5.
- "cảo" = da cảo (caoKg), "hoành"/"hoành thánh" = da hoành (hoanhKg), "mì" = miKg, "ký/kí/kg/cân" là kg. "hủ tiếu", "vỏ bánh gối", "thùng xốp" (số thùng).
- Tiền chành: "chành 20", "20 nghìn", "hai chục" = 20000 đồng (trả về số ĐỒNG). "chành hai trăm" = 200000.
- KHÔNG nói xe thì nhaXe để rỗng, KHÔNG nói chành thì tienChanh = 0 (không phải đơn nào cũng gửi chành). Không tự điền.
- Thuế: "thuế 8", "8 phần trăm" = thue 8; "không thuế" = thue 0; không nhắc tới thuế thì thue = null.
- NGÀY: "15 tháng 9", "ngày 15/9", "mười lăm tháng chín" = ngay "15/09". Chỉ ghi năm khi nhân viên NÓI năm; không nói năm thì CHỈ ghi "dd/mm" (máy tự lấy năm gần nhất tính tới hôm nay). "hôm nay", "hôm qua", "hôm kia", "ngày mai" → tự tính từ hôm nay ra "dd/mm". Không nói ngày thì ngay rỗng (lấy ngày đang chọn: ${dayMonthYear(payload.date) || today}).
- Con số trong ngày ("15 tháng 9") và con số trong mã khách ("M67") KHÔNG phải số ký. Số ký là số đi với "ký/kí/kg" hoặc đứng trước/sau tên hàng (mì, cảo, hoành). "M67 lấy 18 ký mì" = khách M67, miKg 18. Không chắc số nào là số ký thì hỏi lại, không đoán.
- Nhân viên có thể nhắc lại mã khách trước và sau ngày ("M67, 15 tháng 9, M67 lấy 18 ký mì") → vẫn là MỘT đơn của M67 ngày 15/09.
- Đơn đang chờ đã có "ngay" thì GIỮ NGUYÊN "ngay" đó trừ khi nhân viên nói đổi ngày.
- Nhiều khách trong một lần nói → nhiều đơn. "như trên", "giống vậy" = giống đơn trước.
- Nói "sửa", "không phải", "đổi" = sửa đơn đang chờ. Nói "bỏ đơn 2" = xóa đơn đó.
- Nhân viên hay nói DƯ thông tin để chắc: "Wiki Fresh M69 30 ký" = cả tên và mã. Dùng cả hai để dò khách; nếu tên và mã chỉ về hai khách khác nhau thì để maKhach rỗng, đưa cả hai vào ungVien và hỏi lại.
- Nói số ký mà KHÔNG nói hàng gì: nếu khách chỉ hay lấy một loại (cột "hay lấy") thì ghi vào loại đó và nói rõ trong loiNoi để nhân viên xác nhận; nếu khách lấy nhiều loại thì để 0 và hỏi "30 ký là mì, cảo hay hoành?".
- Số ký lệch nhiều so với "hay lấy" (gấp 3 lần trở lên, hoặc chỉ bằng 1/3) thì hỏi lại cho chắc.

${payload.relisten ? `NGHE LẠI BẢN GHI ÂM (phần ${Number(payload.part) || 1}/${Number(payload.parts) || 1}):
- Danh sách "đang chờ" ở trên là BẢN NHÁP do máy nghe nhanh, có thể sai tên khách, sai số, thiếu khách hoặc thừa khách.
- ${hasAudio ? "Nghe KỸ đoạn ghi âm" : "Câu \"nhân viên vừa nói\" bên dưới là BẢN NGHE LẠI cả phiên (chính xác hơn bản nháp)"}; trả về danh sách ĐÚNG theo đó. Không hỏi lại (cauHoi rỗng). ${Number(payload.parts) > 1 ? "Đơn thuộc các phần khác (không có trong đoạn này) thì GIỮ NGUYÊN." : "Đơn nháp không có trong ghi âm thì bỏ."}
- Ghi những chỗ đã sửa so với bản nháp vào "gioiThich" (ngắn, ví dụ: "M23 cảo 4 → 5; thêm Hằng mì 5").
- Bản chữ nháp của Chrome (chỉ tham khảo): ${String(payload.draft || "").slice(0, 3000) || "(không có)"}
` : ""}${payload.multi ? `ĐỌC MỘT LOẠT: câu nói bên dưới là CẢ LƯỢT ĐỌC (đã chép từ ghi âm và soát lại).
- CHỈ tạo đơn cho khách THẬT SỰ được nhắc trong câu nói. Không tự thêm khách từ danh sách, không lặp đơn.
- Ngày nói ở đầu (hoặc giữa) áp cho các khách đọc SAU nó, tới khi nói ngày khác.
- Một khách nhắc lại nhiều lần trong cùng ngày → gộp thành MỘT đơn.
- Chỗ ghi [không rõ] thì để trống phần đó và hỏi lại trong cauHoi.
- Đơn đang chờ cũ (nếu có) giữ nguyên, thêm đơn mới vào sau.
` : ""}${payload.batch ? `ĐANG ĐỌC MỘT LOẠT: nhân viên đọc liền nhiều khách, lời nói bị cắt thành từng đoạn theo chỗ ngừng.
- Đoạn chỉ có số lượng mà không có tên khách → cộng/ghi vào ĐƠN CUỐI CÙNG trong danh sách đang chờ.
- Đoạn chỉ có tên khách → tạo đơn mới cho khách đó (số lượng sẽ tới ở đoạn sau).
- Đoạn nhắc lại khách đã có trong danh sách → sửa đơn đó, không tạo đơn trùng.
- Đoạn chỉ nói ngày → áp ngày đó cho đơn cuối cùng nếu đơn đó chưa có số lượng, và cho các khách đọc SAU (ngày đang đọc). Ghi ngày đó vào "ngayDangDoc".
- Ngày đang đọc hiện tại: ${payload.spokenDate ? dayMonthYear(spokenDate(payload.spokenDate)) || "(chưa nói)" : "(chưa nói)"} → khách mới không nói ngày thì dùng ngày này.
- KHÔNG hỏi lại trong lúc đọc: cauHoi để rỗng, loiNoi chỉ ghi ngắn "đã ghi <tên khách>".
` : ""}
LỆNH (trường "lenh"):
- "luu": nhân viên xác nhận đúng, muốn lưu ("đúng rồi", "lưu đi", "ok", "chốt", "được rồi") và KHÔNG nói thêm đơn/sửa gì.
- "huy": muốn bỏ hết đơn đang chờ ("bỏ hết", "làm lại").
- "huongdan": không biết nói sao, hỏi cách báo cáo, nói lộn xộn không ra đơn.
- "ketthuc": muốn nghỉ/xong việc ("xong rồi", "hết rồi", "tạm biệt") và không còn đơn chờ.
- "": các trường hợp còn lại (thêm/sửa đơn, trả lời câu hỏi).

Khách hàng (mã | tên | xe hay đi):
${customerLines}

Viết tắt đã học (lời nói → mã khách):
${aliasLines || "(chưa có)"}

ĐƠN ĐANG CHỜ XÁC NHẬN (chưa lưu):
${pending.length ? JSON.stringify(pending) : "(không có)"}

Hội thoại:
${history || "(mới)"}

Nhân viên vừa nói: ${said}

Trả về DUY NHẤT JSON là TOÀN BỘ danh sách đơn đang chờ sau khi xử lý câu vừa nói (giữ nguyên đơn cũ không bị nhắc tới):
{"don":[{"tenKhachNoi":"chữ nhân viên dùng để gọi khách","maKhach":"mã nếu chắc chắn, không chắc để rỗng","ungVien":["tối đa 4 mã có thể đúng"],"nhaXe":"","tienChanh":0,"thue":null,"miKg":0,"caoKg":0,"hoanhKg":0,"huTieu":0,"voBanhGoi":0,"thungXop":0,"ngay":"dd/mm nếu có nói ngày, không thì rỗng","ghiChu":""}],
"cauHoi":"một câu hỏi ngắn nếu còn thiếu/không rõ (khách nào, bao nhiêu ký, hàng gì...), không thì rỗng",
"loiNoi":"câu nói tự nhiên để ĐỌC TO: đọc lại từng đơn đang chờ (tên khách, xe, tiền chành, số ký từng loại, số viết bằng chữ số), rồi hỏi 'Đúng chưa? Đúng thì nói lưu.' hoặc hỏi phần còn thiếu. Nếu lenh là huongdan thì hướng dẫn: 'Bạn nói tên khách, xe gì, tiền chành bao nhiêu, rồi mì, cảo, hoành bao nhiêu ký. Ví dụ: Long Xuyên, xe Ba Nhi, chành 20, mì 28 ký.'",
"traLoi":"một câu ngắn để HIỂN THỊ tóm tắt",
"lenh":"",
${hasAudio ? '"nghe":"nguyên văn nhân viên nói",' : ""}
"gioiThich":"",
"ngayDangDoc":"dd/mm nếu vừa nói một ngày áp cho các khách sau, không thì rỗng"}
Không bịa số. Không nói gì về hàng hóa thì để 0. Câu nói dùng từ ngữ đơn giản như nói chuyện ngoài đời, không ký hiệu, không viết tắt, xưng "tôi", gọi "bạn".`;
}

// "Ba Nhi" nói ra → "Bany" trong sổ: so khớp bỏ dấu, bỏ khoảng trắng, coi y = i, bỏ chữ "xe".
function truckKey(value) {
  return normalizeText(value).replace(/^xe\s+/, "").replace(/\s+/g, "").replace(/y/g, "i");
}

function snapTruck(spoken, ctx) {
  const key = truckKey(spoken);
  if (!key) return "";
  const known = [
    ...ctx.customers.map((customer) => customer.NhaXeMacDinh),
    ...[...ctx.trucks.values()].flat(),
  ].filter(Boolean);
  const exact = known.find((truck) => truckKey(truck) === key);
  if (exact) return exact;
  // Nói sai một chữ (Ba Nhi ↔ Bany) thì vẫn nhận nếu chỉ có đúng một xe gần giống.
  const near = [...new Set(known)].filter((truck) => key.length >= 4 && editDistance(truckKey(truck), key) <= 1);
  return near.length === 1 ? near[0] : spoken;
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

function normalizeOrders(json, ctx, payload, today) {
  const { customers, trucks, aliases } = ctx;
  const byCode = (code) => customers.find((customer) => normalizeText(customer.MaKH) === normalizeText(code));
  const list = Array.isArray(json.don) ? json.don : [];
  const pending = Array.isArray(payload.pending) ? payload.pending : [];
  const fallbackDate = spokenDate(payload.spokenDate, today) || String(payload.date || "") || today;
  return list.slice(0, MAX_ORDERS).map((row, index) => {
    const before = pending.find((item) => normalizeText(item.tenKhachNoi) === normalizeText(row.tenKhachNoi)) || pending[index];
    const keptDate = before && normalizeText(before.tenKhachNoi) === normalizeText(row.tenKhachNoi) ? normalizeDate(before.orderDate) : "";
    const code = matchCustomer({ maKhach: row.maKhach, khachTrenAnh: row.tenKhachNoi }, customers, aliases);
    const candidates = [...new Set([code, ...(Array.isArray(row.ungVien) ? row.ungVien : [])])]
      .map((item) => byCode(item)?.MaKH).filter(Boolean).slice(0, 5);
    const customer = byCode(code);
    const order = {
      tenKhachNoi: String(row.tenKhachNoi || "").slice(0, 100),
      customerCode: customer ? customer.MaKH : "",
      candidates,
      nhaXe: snapTruck(String(row.nhaXe || "").trim().slice(0, 150), ctx),
      taxRate: [0, 5, 8, 10].includes(Number(row.thue)) && row.thue !== null && row.thue !== "" ? Number(row.thue) : null,
      tienUng: Math.round(toNumber(row.tienChanh)),
      orderDate: spokenDate(row.ngay, today) || keptDate || fallbackDate,
      ghiChu: String(row.ghiChu || "").slice(0, 300),
    };
    QTY_FIELDS.forEach((field) => { order[field] = toNumber(row[field]); });
    return order;
  });
}

function warnings(order, ctx, spoken) {
  const list = [];
  if (spoken && order.tenKhachNoi) {
    const said = normalizeText(spoken).replace(/\s+/g, "");
    const name = normalizeText(order.tenKhachNoi).replace(/\s+/g, "");
    if (name && !said.includes(name)) list.push("không thấy tên này trong lời nói");
  }
  const customer = ctx.customers.find((item) => item.MaKH === order.customerCode);
  if (!customer) list.push("chưa rõ khách");
  if (!QTY_FIELDS.some((field) => order[field] > 0)) list.push("chưa có số lượng");
  if (customer && ctx.orders.some((item) => item.date === order.orderDate && normalizeText(item.customerName) === normalizeText(customer.TenKH))) {
    list.push("khách đã có đơn ngày này");
  }
  if (order.tienUng > 500000) list.push("tiền chành lớn bất thường");
  return list;
}

async function parseSpeech(payload, businessUnit, sessionUser) {
  const text = String(payload.text || "").trim().slice(0, payload.relisten || payload.multi ? 12000 : 3000);
  const audio = payload.audio && typeof payload.audio === "object" ? payload.audio : null;
  if (audio) {
    const data = String(audio.data || "").replace(/^data:[^,]*,/, "");
    if (!data || data.length > MAX_AUDIO_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(data)) throw httpError("Đoạn ghi âm không hợp lệ hoặc quá dài (tối đa khoảng 1 phút).");
    audio.data = data;
    audio.format = ["wav", "mp3"].includes(audio.format) ? audio.format : "wav";
  }
  if (!text && !audio) throw httpError("Chưa nghe được gì.");
  if (!openRouterApiKey()) throw httpError("Chưa có khóa AI. Nhờ quản lý vào Ảnh bàn giao → Cài đặt AI để nhập khóa.", 409);
  const ctx = await context(businessUnit);
  const today = todayInVietnam();
  const model = (sessionUser.role === "manager" && cleanModel(payload.model))
    || (payload.relisten ? openRouterListenModel() : openRouterVoiceModel());
  if (payload.relisten && audio) payload.savedAudio = saveRecording(audio, payload, sessionUser);
  const content = [{ type: "text", text: buildPrompt(ctx, payload, today, Boolean(audio)) }];
  if (audio) content.push({ type: "input_audio", input_audio: { data: audio.data, format: audio.format } });
  let json;
  let cost;
  try {
    ({ json, cost } = await callOpenRouter(model, content));
  } catch (error) {
    if (audio && /audio|modalit|input/i.test(error.message)) {
      throw httpError(`Model ${model} không nghe được ghi âm. Chọn model có 🎧 hoặc chuyển sang chế độ nghe bằng Chrome.`, 400);
    }
    throw error;
  }
  const oldNames = new Set((Array.isArray(payload.pending) ? payload.pending : []).map((row) => normalizeText(row.tenKhachNoi)));
  const orders = normalizeOrders(json, ctx, payload, today).map((order) => ({ ...order, warnings: warnings(order, ctx, payload.multi && !oldNames.has(normalizeText(order.tenKhachNoi)) ? text : "") }));
  const names = Object.fromEntries(ctx.customers.map((customer) => [customer.MaKH, customer.TenKH]));
  return {
    model,
    cost: sessionUser.role === "manager" ? cost : null,
    question: String(json.cauHoi || "").slice(0, 300),
    reply: String(json.traLoi || "").slice(0, 500),
    speech: String(json.loiNoi || json.traLoi || "").slice(0, 1500),
    command: ["luu", "huy", "huongdan", "ketthuc"].includes(json.lenh) ? json.lenh : "",
    changes: String(json.gioiThich || "").slice(0, 1000),
    heard: audio ? String(json.nghe || "").slice(0, 3000) : text,
    savedAudio: payload.savedAudio || "",
    spokenDate: spokenDate(json.ngayDangDoc, today) || (payload.batch ? spokenDate(payload.spokenDate, today) : ""),
    orders,
    names,
  };
}

// Giống trang ghi âm: (1) mô hình nghe âm thanh chép lời, (2) cùng mô hình nghe lại ghi âm để soát bản chép.
// Không đưa danh sách khách vào đây: đưa vào thì AI hay "chép" ra khách không hề được đọc.
const RULES = `- Chỉ chép những gì THẬT SỰ nghe thấy, đúng thứ tự. Không thêm, không đoán, không tóm tắt, không lặp lại.
- Chỗ nghe không rõ thì ghi [không rõ]. Không có tiếng người nói thì trả chuỗi rỗng.
- Số viết bằng chữ số: "mười tám ký" → "18 ký", "hai chục" → "20", "rưỡi" → ",5".
- Mã khách viết liền: "em sáu bảy", "mờ 67", "M sáu mươi bảy" → "M67".
- Ngày viết "15 tháng 9"; có nói năm mới ghi năm.
- Tên hàng: mì, cảo ("cạo/cáo" → cảo), hoành ("vành/hoàn" sau con số → hoành), hủ tiếu, vỏ bánh gối, thùng xốp. "ký/kí/kg" viết "ký".`;

function transcribePrompt(payload, today) {
  return `Chép lại NGUYÊN VĂN tiếng Việt đoạn ghi âm của người báo hàng xưởng mì (giọng miền Nam, có thể ồn). Hôm nay ${dayMonthYear(today)}.
${RULES}
${Number(payload.parts) > 1 ? `Đây là phần ${Number(payload.part) || 1}/${Number(payload.parts)} của bản ghi; câu đầu/cuối có thể bị cắt dở.\n` : ""}Trả về DUY NHẤT JSON: {"nghe":"nguyên văn"}`;
}

function verifyPrompt(draft) {
  return `Đây là bản chép tự động của đoạn ghi âm đính kèm (người báo hàng xưởng mì):
"""${draft}"""
Nghe LẠI THẬT KỸ đoạn ghi âm và SOÁT bản chép:
- Sửa chữ, tên, con số, ngày, tên hàng bị chép sai cho ĐÚNG với ghi âm.
- XÓA những câu/đơn KHÔNG có trong ghi âm (bản chép có thể bị bịa thêm). Thêm phần có nói mà bị sót.
- Biên tập nhẹ: bỏ tiếng đệm (à, ờ, ừm), chấm câu, mỗi khách một câu. Không đổi nội dung.
${RULES}
Trả về DUY NHẤT JSON: {"banDung":"bản chép đã soát","daSua":"liệt kê ngắn những chỗ đã sửa, không sửa thì rỗng"}`;
}

const wordCount = (text) => String(text || "").split(/\s+/).filter(Boolean).length;

async function transcribeSpeech(payload, businessUnit, sessionUser) {
  const audio = payload.audio && typeof payload.audio === "object" ? payload.audio : null;
  const data = String(audio?.data || "").replace(/^data:[^,]*,/, "");
  if (!data || data.length > MAX_AUDIO_BASE64 || !/^[A-Za-z0-9+/=]+$/.test(data)) throw httpError("Đoạn ghi âm không hợp lệ hoặc quá dài (tối đa khoảng 1 phút rưỡi).");
  const clip = { data, format: ["wav", "mp3"].includes(audio.format) ? audio.format : "wav" };
  if (!openRouterApiKey()) throw httpError("Chưa có khóa AI. Nhờ quản lý vào Ảnh bàn giao → Cài đặt AI để nhập khóa.", 409);
  const today = todayInVietnam();
  const model = (sessionUser.role === "manager" && cleanModel(payload.listenModel)) || openRouterListenModel();
  const savedAudio = payload.keep ? saveRecording(clip, payload, sessionUser) : "";
  // WAV 16kHz mono 16-bit = 32000 byte/giây.
  const seconds = Number(payload.seconds) > 0 ? Number(payload.seconds) : (data.length * 0.75 - 44) / 32000;
  const tooMany = (text) => wordCount(text) > seconds * 5 + 10;
  const ask = async (prompt) => {
    try {
      return await callOpenRouter(model, [
        { type: "text", text: prompt },
        { type: "input_audio", input_audio: clip },
      ]);
    } catch (error) {
      if (/audio|modalit|input/i.test(error.message)) {
        throw httpError(`Mô hình nghe âm thanh ${model} không nghe được ghi âm. Quản lý chọn mô hình có 🎧 trong cài đặt.`, 400);
      }
      throw error;
    }
  };
  const first = await ask(transcribePrompt(payload, today));
  const raw = String(first.json?.nghe || "").trim().slice(0, 6000);
  let text = raw;
  let checked = false;
  let fixes = "";
  let cost = Number(first.cost || 0);
  if (raw) {
    try {
      const second = await ask(verifyPrompt(raw));
      cost += Number(second.cost || 0);
      const fixed = String(second.json?.banDung ?? "").trim().slice(0, 6000);
      if (second.json && typeof second.json.banDung === "string" && !tooMany(fixed)) {
        text = fixed;
        checked = true;
        fixes = String(second.json.daSua || "").slice(0, 500);
      }
    } catch (error) {
      if (error.statusCode === 400) throw error;
    }
  }
  // Chữ nhiều hơn mức người ta nói được trong khoảng thời gian đó → AI bịa, bỏ.
  if (tooMany(text)) throw httpError(`AI chép ra nhiều chữ hơn lời nói (${wordCount(text)} chữ cho ${Math.round(seconds)} giây) nên tôi bỏ đoạn này. Đọc lại giúp tôi.`);
  return {
    model,
    cost: sessionUser.role === "manager" ? cost : null,
    raw,
    text: text.replace(/\[không rõ\]/gi, "[không rõ]"),
    checked,
    fixes,
    savedAudio,
  };
}

// Lưu bản ghi âm để đối chiếu sau (chỉ khi chạy trên máy có ổ đĩa, không lưu trên Vercel).
function saveRecording(audio, payload, sessionUser) {
  if (process.env.VERCEL) return "";
  try {
    const dir = process.env.GHI_AM_DIR
      ? path.resolve(process.env.GHI_AM_DIR)
      : path.join(__dirname, "..", "ghi-am-giong-noi");
    fs.mkdirSync(dir, { recursive: true });
    const session = String(payload.session || Date.now()).replace(/[^\w-]/g, "").slice(0, 40);
    const who = String(sessionUser.email || "nguoi").split("@")[0].replace(/[^\w-]/g, "").slice(0, 30);
    const name = `${normalizeDate(payload.date) || todayInVietnam()}_${session}_${who}_phan${Number(payload.part) || 1}.${audio.format === "mp3" ? "mp3" : "wav"}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(audio.data, "base64"), { mode: 0o600 });
    return name;
  } catch {
    return "";
  }
}

async function saveOrders(payload, businessUnit, sessionUser) {
  const rows = (Array.isArray(payload.orders) ? payload.orders : []).slice(0, MAX_ORDERS);
  if (!rows.length) throw httpError("Chưa có đơn để lưu.");
  const result = await updateDatabase((database) => {
    const created = [];
    const errors = [];
    rows.forEach((row, index) => {
      try {
        if (!row.customerCode) throw new Error("chưa chọn khách");
        const orderDate = normalizeDate(row.orderDate);
        if (!orderDate) throw new Error("ngày không hợp lệ");
        const quantities = Object.fromEntries(QTY_FIELDS.map((field) => [field, toNumber(row[field])]));
        if (!Object.values(quantities).some((value) => value > 0)) throw new Error("chưa có số lượng");
        const order = createOrderFromPayload(database, {
          businessUnit,
          customerCode: String(row.customerCode),
          orderDate,
          nhaXe: String(row.nhaXe || ""),
          keepEmptyTruck: true,
          extraShipCustomer: "",
          tienUng: Math.round(toNumber(row.tienUng)),
          ...([0, 5, 8, 10].includes(Number(row.taxRate)) && row.taxRate !== null && row.taxRate !== "" ? { taxRate: Number(row.taxRate) } : {}),
          taxPayer: "customer",
          customerResting: false,
          ghiChu: String(row.ghiChu || ""),
          paymentMethod: "debt",
          ...quantities,
          phoSoiKg: 0,
          phoSoiUnit: "kg",
          phoCuonKg: 0,
        }, businessUnit, sessionUser);
        order.source = "voice";
        created.push(order);
      } catch (error) {
        errors.push(`Đơn ${index + 1}: ${error.message}`);
      }
    });
    if (errors.length) throw httpError(`Chưa lưu gì cả. ${errors.join("; ")}`);
    // Học cách gọi khách: lần sau nói y chang thì tự nhận ra.
    const store = database.handoverAliases || (database.handoverAliases = {});
    const aliases = store[businessUnit] || (store[businessUnit] = []);
    rows.forEach((row) => {
      const text = String(row.tenKhachNoi || "").trim().slice(0, 100);
      if (!text || !row.learn) return;
      const existing = aliases.find((item) => normalizeText(item.text) === normalizeText(text));
      if (existing) existing.customerCode = row.customerCode;
      else aliases.push({ text, customerCode: row.customerCode, learnedAt: new Date().toISOString(), source: "voice" });
    });
    if (aliases.length > 300) aliases.splice(0, aliases.length - 300);
    appendAudit(database, {
      action: "voice-orders-created",
      actorUserId: sessionUser.id,
      actorEmail: sessionUser.email,
      actorName: sessionUser.displayName,
      summary: `${sessionUser.displayName} nhập ${created.length} đơn bằng giọng nói.`,
      businessUnit,
      details: {
        orderIds: created.map((order) => order.id),
        spoken: String(payload.transcript || "").slice(0, 2000),
        recordings: (Array.isArray(payload.recordings) ? payload.recordings : []).map(String).slice(0, 20),
      },
    });
    return created;
  });
  const isManager = sessionUser.role === "manager";
  return {
    orders: result.map((order) => (isManager ? order : {
      id: order.id,
      date: order.date,
      customerName: order.customerName,
      truck: order.truck,
      advance: order.advance,
      ...Object.fromEntries(QTY_FIELDS.map((field) => [field, order[field]])),
      createdAt: order.createdAt,
    })),
  };
}

async function todayOrders(businessUnit, sessionUser, date) {
  const database = await readDatabase();
  const day = normalizeDate(date) || todayInVietnam();
  const orders = (database.crm?.orders || []).filter((order) => (
    normalizeBusinessUnit(order.businessUnit) === businessUnit
    && order.date === day
    && (sessionUser.role === "manager" || Number(order.createdByUserId) === Number(sessionUser.id))
  ));
  return orders.map((order) => ({
    id: order.id,
    customerName: order.customerName,
    truck: order.truck,
    advance: order.advance,
    source: order.source || "",
    createdByEmail: order.createdByEmail || "",
    ...Object.fromEntries(QTY_FIELDS.map((field) => [field, order[field]])),
  }));
}

exports.handler = async (event) => {
  try {
    const sessionUser = await requireAuth(event);
    if (!ALLOWED_ROLES.includes(sessionUser.role)) throw httpError("Tài khoản không có quyền nhập bằng giọng nói.", 403);
    const query = event.queryStringParameters || {};
    if (event.httpMethod === "GET" && query.action === "settings") {
      if (sessionUser.role !== "manager") throw httpError("Chỉ quản lý được xem cài đặt.", 403);
      return jsonResponse(200, settingsStatus());
    }
    if (event.httpMethod === "GET") {
      const businessUnit = requireBusinessUnit(sessionUser, query.businessUnit);
      return jsonResponse(200, { orders: await todayOrders(businessUnit, sessionUser, query.date) });
    }
    if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
    const payload = parseJsonBody(event);
    if (payload.action === "voice-model") {
      if (sessionUser.role !== "manager") throw httpError("Chỉ quản lý được đổi model.", 403);
      return jsonResponse(200, { ok: true, ...saveSettings({ voiceModel: payload.model, listenModel: payload.listenModel }) });
    }
    const businessUnit = requireBusinessUnit(sessionUser, payload.businessUnit || query.businessUnit);
    if (businessUnit !== "mi") throw httpError("Nhập bằng giọng nói hiện dành cho Xưởng Mì.");
    if (payload.action === "transcribe") return jsonResponse(200, { ok: true, ...(await transcribeSpeech(payload, businessUnit, sessionUser)) });
    if (payload.action === "parse") return jsonResponse(200, { ok: true, ...(await parseSpeech(payload, businessUnit, sessionUser)) });
    if (payload.action === "save") return jsonResponse(201, { ok: true, ...(await saveOrders(payload, businessUnit, sessionUser)) });
    return jsonResponse(400, { error: "Thao tác không hợp lệ." });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(400, { error: error.message });
  }
};
