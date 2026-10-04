// Kế hoạch sản xuất theo ngày: mẻ bột → sản phẩm (cân thành phẩm) → khách nhận.
// Mỗi phân hệ, mỗi ngày có đúng một kế hoạch. Sản lượng tính theo thành phẩm, số trộn để đối chiếu.
const { authErrorResponse, requireAuth, requireBusinessUnit } = require("./_auth");
const { appendAudit, nextId, normalizeBusinessUnit, readDatabase, updateDatabase } = require("./_database");
const { jsonResponse } = require("./_sheets");
const { boundedString, finiteNumber, parseJsonBody } = require("./_validation");
const { openRouterApiKey, openRouterVoiceModel } = require("./_openrouter-env");
const { callOpenRouter, httpError, learnedAliases } = require("./ban-giao").shared;

const GROUPS = ["DA", "MI"];
const UNITS = ["kg", "gói"];
const MAX_BATCHES = 30;
const MAX_PRODUCTS = 12;
const MAX_OUTPUTS = 30;

function validDate(value) {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new Error("Ngày kế hoạch không hợp lệ.");
  }
  return date;
}

function optionalNumber(value, field) {
  if (value === null || value === undefined || value === "") return null;
  return finiteNumber(value, field, { minimum: 0, maximum: 100000 });
}

function list(value, field, max) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} phải là danh sách.`);
  if (value.length > max) throw new Error(`${field} tối đa ${max} dòng.`);
  return value;
}

function cleanOutput(output) {
  const unit = UNITS.includes(output?.unit) ? output.unit : "kg";
  return {
    customer: boundedString(output?.customer, "khách nhận", 120),
    qty: optionalNumber(output?.qty, "số lượng giao"),
    qtyMax: optionalNumber(output?.qtyMax, "số lượng giao tối đa"),
    unit,
    pack: boundedString(output?.pack, "cách gói", 60),
    optional: Boolean(output?.optional),
    note: boundedString(output?.note, "ghi chú giao", 200),
  };
}

function cleanProduct(product) {
  const name = boundedString(product?.name, "tên sản phẩm", 120, { required: true });
  return {
    name,
    kgTron: optionalNumber(product?.kgTron, "kg bột soạn cho sản phẩm"),
    finishedKg: optionalNumber(product?.finishedKg, "kg thành phẩm"),
    note: boundedString(product?.note, "ghi chú sản phẩm", 200),
    outputs: list(product?.outputs, "Khách nhận", MAX_OUTPUTS).map(cleanOutput),
  };
}

function cleanBatch(batch, index) {
  const group = String(batch?.group || "").toUpperCase();
  if (!GROUPS.includes(group)) throw new Error(`Mẻ ${index + 1}: nhóm phải là DA hoặc MÌ.`);
  return {
    label: boundedString(batch?.label, "số mẻ", 20) || String(index + 1),
    group,
    name: boundedString(batch?.name, "loại bột", 120, { required: true }),
    kgTron: finiteNumber(batch?.kgTron, "kg trộn", { minimum: 0, maximum: 100000 }),
    note: boundedString(batch?.note, "ghi chú mẻ", 200),
    products: list(batch?.products, "Sản phẩm", MAX_PRODUCTS).map(cleanProduct),
  };
}

// Sản lượng một ngày: trộn theo mẻ; thành phẩm theo sản phẩm đã cân, đếm sản phẩm chưa cân.
function summarize(plan) {
  const total = { DA: { tron: 0, thanhPham: 0, chuaCan: 0 }, MI: { tron: 0, thanhPham: 0, chuaCan: 0 } };
  (plan.batches || []).forEach((batch) => {
    const bucket = total[batch.group];
    if (!bucket) return;
    bucket.tron += Number(batch.kgTron) || 0;
    (batch.products || []).forEach((product) => {
      if (product.finishedKg === null || product.finishedKg === undefined) bucket.chuaCan += 1;
      else bucket.thanhPham += Number(product.finishedKg) || 0;
    });
  });
  return { date: plan.date, batchCount: (plan.batches || []).length, ...total };
}

// Doanh thu một ngày lấy từ đơn đã nhập trong sổ (không tính đơn khách nghỉ).
function revenueFor(database, businessUnit, date) {
  const orders = (database.crm?.orders || []).filter((order) => (
    normalizeBusinessUnit(order.businessUnit) === businessUnit && order.date === date && !order.customerResting
  ));
  const sum = (field) => orders.reduce((total, order) => total + (Number(order[field]) || 0), 0);
  return {
    date,
    orderCount: orders.length,
    total: sum("total"),
    miKg: sum("miKg"),
    caoKg: sum("caoKg"),
    hoanhKg: sum("hoanhKg"),
  };
}

function plansFor(database, businessUnit) {
  return (database.productionPlans || []).filter((plan) => normalizeBusinessUnit(plan.businessUnit) === businessUnit);
}

// ---------- Nhập bằng lời nói ----------
// Nói → AI xếp vào kế hoạch đang soạn → đọc lại → nói "ok / lưu" thì máy lưu.
const PRODUCT_HINT = "Cảo dày, Cảo mỏng, Cảo thường, Hoành thánh size 8, Hoành thánh size 9, Mì sợi nhỏ, Mì dẹp, Mì lớn";

function planForPrompt(plan) {
  return (plan.batches || []).map((batch) => ({
    so: batch.label, nhom: batch.group, loai: batch.name, kgTron: batch.kgTron, ghiChu: batch.note || "",
    sanPham: (batch.products || []).map((product) => ({
      ten: product.name, kgBot: product.kgTron, thanhPham: product.finishedKg, ghiChu: product.note || "",
      khach: (product.outputs || []).map((output) => ({
        khach: output.customer, sl: output.qty, den: output.qtyMax, donVi: output.unit, goi: output.pack,
        neuCo: output.optional, ghiChu: output.note || "",
      })),
    })),
  }));
}

function planFromAi(list) {
  if (!Array.isArray(list)) throw httpError("AI trả về kế hoạch không đúng dạng. Nói lại giúp tôi.", 502);
  const num = (value) => (value === null || value === undefined || value === "" || Number.isNaN(Number(value)) ? null : Number(value));
  return list.slice(0, MAX_BATCHES).map((batch, index) => cleanBatch({
    label: String(batch.so ?? index + 1),
    group: String(batch.nhom || "").toUpperCase().replace("Ì", "I"),
    name: batch.loai || "bột",
    kgTron: num(batch.kgTron) || 0,
    note: batch.ghiChu,
    products: (Array.isArray(batch.sanPham) ? batch.sanPham : []).map((product) => ({
      name: product.ten || "Sản phẩm",
      kgTron: num(product.kgBot),
      finishedKg: num(product.thanhPham),
      note: product.ghiChu,
      outputs: (Array.isArray(product.khach) ? product.khach : []).map((output) => ({
        customer: output.khach, qty: num(output.sl), qtyMax: num(output.den),
        unit: output.donVi === "gói" || output.donVi === "goi" ? "gói" : "kg",
        pack: output.goi, optional: Boolean(output.neuCo), note: output.ghiChu,
      })),
    })),
  }, index));
}

function voicePrompt({ customers, aliases }, payload, plan) {
  const history = (Array.isArray(payload.history) ? payload.history : []).slice(-8)
    .map((item) => `${item.role === "me" ? "Người nói" : "Trợ lý"}: ${String(item.text || "").slice(0, 400)}`).join("\n");
  return `Bạn là trợ lý ghi KẾ HOẠCH SẢN XUẤT NGÀY ${payload.date} của một xưởng mì Việt Nam. Chủ xưởng và vợ NÓI bằng miệng, không gõ tay. Câu trả lời của bạn sẽ được ĐỌC TO.

Kế hoạch gồm các MẺ bột. Mỗi mẻ: số mẻ, nhóm DA hoặc MI, loại bột, kg trộn. Trong mẻ có SẢN PHẨM (kg bột soạn riêng nếu tách, kg thành phẩm khi đã cân). Dưới sản phẩm là KHÁCH nhận: số lượng (có thể là khoảng "12 tới 13"), đơn vị kg hoặc gói, cách gói (thùng, bịch, gói giấy), "nếu có / nếu dư".
- Nhóm DA = cảo dày, cảo mỏng, cảo thường, hoành thánh. Nhóm MI = mì dẹp, mì sợi nhỏ, mì lớn.
- Tên sản phẩm chuẩn: ${PRODUCT_HINT}.
- Máy nghe hay sai: "cạo/cáo/cao/kháo" = cảo; "cạo giày" = cảo dày; "vành/hoàn/doanh" sau số = hoành; "mỳ/mi" = mì; "sai tám/sa tám" = size 8; "em mười/mờ mười" = M10; "chỗ đốc" = Châu Đốc.
- "Trong đó soạn ra 9 ký cán cảo thường" = một SẢN PHẨM trong mẻ đó với kgBot 9. "Còn lại cán hoành thánh" = sản phẩm khác, kgBot = kg trộn trừ phần đã soạn.
- "cắt ra 14 ký hoành thánh thành phẩm", "cân được 31 ký", "thành phẩm 31" = thanhPham của sản phẩm đó.
- "nếu có", "nếu dư thì giao M23" = khách đó neuCo true.
- "mỗi mẻ 33 ký mì" cho mẻ 4 và 5 = hai mẻ, mỗi mẻ kgTron 33.
- Khách: ghi đúng chữ người nói dùng để gọi khách (vd "Châu Đốc", "M10"). Nếu chắc chắn là khách trong sổ thì ghi MÃ KHÁCH trong sổ.
- Người nói có thể nói nhiều mẻ một lần, hoặc sửa: "mẻ 2 đổi thành 25 ký", "bỏ khách M23", "thêm M28 12 ký hoành thánh vào mẻ 3".
- Giữ NGUYÊN phần kế hoạch không bị nhắc tới. Không bịa số; không nghe rõ thì hỏi lại.

LỆNH (trường "lenh"):
- "luu": người nói xác nhận đúng ("ok", "đúng rồi", "lưu đi", "chốt") và KHÔNG nói thêm thay đổi.
- "huy": muốn bỏ hết phần vừa soạn chưa lưu ("bỏ hết", "làm lại").
- "": các trường hợp còn lại.

Khách trong sổ (mã | tên | nhà xe):
${customers.map((customer) => `${customer.MaKH} | ${customer.TenKH} | ${customer.NhaXeMacDinh || "-"}`).join("\n")}

Viết tắt đã học (lời nói → mã khách):
${aliases.map((item) => `"${item.text}" → ${item.customerCode}`).join("\n") || "(chưa có)"}

KẾ HOẠCH ĐANG SOẠN (chưa lưu):
${JSON.stringify(planForPrompt(plan))}

Hội thoại:
${history || "(mới)"}

Người nói vừa nói: "${String(payload.text || "").replace(/"/g, "'")}"

Trả về DUY NHẤT JSON:
{"me":[{"so":"1","nhom":"DA","loai":"cảo dày","kgTron":32,"ghiChu":"","sanPham":[{"ten":"Cảo dày","kgBot":null,"thanhPham":null,"ghiChu":"","khach":[{"khach":"Châu Đốc","sl":30,"den":null,"donVi":"kg","goi":"","neuCo":false,"ghiChu":""}]}]}],
"loiNoi":"câu ĐỌC TO: đọc lại gọn phần VỪA thêm hoặc sửa (mẻ mấy, bao nhiêu ký, sản phẩm, khách nào bao nhiêu), rồi hỏi 'Đúng chưa? Đúng thì nói ok.' Nếu lenh là luu thì nói 'Tôi lưu kế hoạch nhé.'",
"cauHoi":"câu hỏi ngắn nếu còn chỗ không rõ, không thì rỗng",
"lenh":""}
"me" là TOÀN BỘ kế hoạch sau khi xử lý câu vừa nói. Câu đọc to dùng chữ số, từ ngữ đơn giản, xưng "tôi", gọi "bạn".`;
}

async function voiceParse(payload, businessUnit) {
  const text = String(payload.text || "").trim().slice(0, 4000);
  if (!text) throw httpError("Chưa nghe được gì.");
  if (!openRouterApiKey()) throw httpError("Chưa có khóa AI. Vào Ảnh bàn giao → Cài đặt AI để nhập khóa.", 409);
  const date = validDate(payload.date);
  const current = { batches: list(payload.plan?.batches, "Mẻ", MAX_BATCHES).map(cleanBatch) };
  const database = await readDatabase();
  const customers = (database.crm?.customers || []).filter((customer) => normalizeBusinessUnit(customer.businessUnit) === businessUnit);
  const aliases = learnedAliases(database, businessUnit);
  const model = openRouterVoiceModel();
  const { json, cost } = await callOpenRouter(model, [{ type: "text", text: voicePrompt({ customers, aliases }, { ...payload, date, text }, current) }]);
  const command = ["luu", "huy"].includes(json?.lenh) ? json.lenh : "";
  const batches = command === "huy" ? current.batches : planFromAi(json?.me ?? planForPrompt(current));
  return {
    model,
    cost,
    heard: text,
    command,
    speech: String(json?.loiNoi || "").slice(0, 1500),
    question: String(json?.cauHoi || "").slice(0, 300),
    plan: { batches },
  };
}

exports.summarize = summarize;

exports.handler = async (event) => {
  try {
    const sessionUser = await requireAuth(event);
    const payload = ["POST", "PUT"].includes(event.httpMethod) ? parseJsonBody(event) : {};
    const query = event.queryStringParameters || {};
    const businessUnit = requireBusinessUnit(sessionUser, payload.businessUnit || query.businessUnit);

    if (event.httpMethod === "GET") {
      const database = await readDatabase();
      const plans = plansFor(database, businessUnit);
      const isManager = sessionUser.role === "manager";
      if (query.action === "summary") {
        return jsonResponse(200, {
          days: plans.map(summarize).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 120)
            .map((day) => (isManager ? { ...day, revenue: revenueFor(database, businessUnit, day.date) } : day)),
        });
      }
      const date = validDate(query.date);
      return jsonResponse(200, {
        plan: plans.find((plan) => plan.date === date) || null,
        revenue: isManager ? revenueFor(database, businessUnit, date) : null,
      });
    }

    if (sessionUser.role !== "manager") {
      return jsonResponse(403, { error: "Chỉ tài khoản quản lý được sửa kế hoạch sản xuất." });
    }

    if (event.httpMethod === "POST" && payload.action === "voice") {
      return jsonResponse(200, { ok: true, ...(await voiceParse(payload, businessUnit)) });
    }

    if (event.httpMethod === "PUT") {
      const date = validDate(payload.date);
      const batches = list(payload.batches, "Mẻ", MAX_BATCHES).map(cleanBatch);
      const note = boundedString(payload.note, "ghi chú ngày", 500);
      const plan = await updateDatabase((database) => {
        const plans = database.productionPlans;
        let current = plans.find((item) => item.date === date && normalizeBusinessUnit(item.businessUnit) === businessUnit);
        const before = current ? JSON.parse(JSON.stringify(current)) : null;
        if (!current) {
          current = { id: nextId(plans), businessUnit, date, createdAt: new Date().toISOString() };
          plans.push(current);
        }
        Object.assign(current, {
          batches,
          note,
          updatedAt: new Date().toISOString(),
          updatedByUserId: sessionUser.id,
        });
        const sum = summarize(current);
        appendAudit(database, {
          action: before ? "production-plan-updated" : "production-plan-created",
          actorUserId: sessionUser.id,
          actorEmail: sessionUser.email,
          actorName: sessionUser.displayName,
          targetProductionPlanId: current.id,
          summary: `${sessionUser.displayName} ${before ? "sửa" : "tạo"} kế hoạch sản xuất ngày ${date}: ${sum.batchCount} mẻ, DA trộn ${sum.DA.tron} kg, MÌ trộn ${sum.MI.tron} kg.`,
          businessUnit,
          details: { before, after: JSON.parse(JSON.stringify(current)) },
        });
        return current;
      });
      return jsonResponse(200, { ok: true, plan, summary: summarize(plan) });
    }

    return jsonResponse(405, { error: "Method not allowed" });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(400, { error: error.message });
  }
};
