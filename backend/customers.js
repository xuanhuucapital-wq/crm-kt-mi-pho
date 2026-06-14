const { authErrorResponse, requireAuth, requireBusinessUnit } = require("./_auth");
const { appendAudit, normalizeBusinessUnit, normalizeText, readDatabase, updateDatabase } = require("./_database");
const { jsonResponse } = require("./_sheets");
const { boundedString, finiteNumber, parseJsonBody } = require("./_validation");

const editableFields = [
  "TenKH",
  "GiaMi",
  "GiaCao",
  "GiaHoanh",
  "GiaPhoSoi",
  "GiaPhoCuon",
  "NhaXeMacDinh",
  "ChinhSachThue",
  "ThueSuat",
];

function deliveryCustomer(customer) {
  return {
    MaKH: customer.MaKH,
    TenKH: customer.TenKH,
    GiaMi: Number(customer.GiaMi || 0),
    GiaCao: Number(customer.GiaCao || 0),
    GiaHoanh: Number(customer.GiaHoanh || 0),
    GiaPhoSoi: Number(customer.GiaPhoSoi || 0),
    GiaPhoCuon: Number(customer.GiaPhoCuon || 0),
    NhaXeMacDinh: String(customer.NhaXeMacDinh || ""),
    ThueSuat: Number(customer.ThueSuat || 0),
    businessUnit: customer.businessUnit,
  };
}

function sortCustomers(first, second) {
  const firstName = String(first.TenKH || "").trim();
  const secondName = String(second.TenKH || "").trim();
  const startsWithLetter = (value) => /^[a-z]/.test(
    value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").toLowerCase(),
  );
  if (startsWithLetter(firstName) !== startsWithLetter(secondName)) {
    return startsWithLetter(firstName) ? -1 : 1;
  }
  return firstName.localeCompare(secondName, "vi", {
    sensitivity: "base",
    numeric: true,
    ignorePunctuation: true,
  });
}

exports.handler = async (event) => {
  try {
    const sessionUser = await requireAuth(event);
    const payload = ["POST", "PUT"].includes(event.httpMethod) ? parseJsonBody(event) : {};
    const requestedUnit = payload.businessUnit || event.queryStringParameters?.businessUnit;
    const businessUnit = requireBusinessUnit(sessionUser, requestedUnit);
    if (event.httpMethod === "GET") {
      const database = await readDatabase();
      const customers = (database.crm.customers || []).filter((item) => (
        normalizeBusinessUnit(item.businessUnit) === businessUnit
      )).sort(sortCustomers);
      return jsonResponse(200, {
        customers: sessionUser.role === "delivery"
          ? customers.map(deliveryCustomer)
          : customers,
      });
    }
    if (sessionUser.role !== "manager") {
      return jsonResponse(403, { error: "Chỉ tài khoản quản lý được thay đổi khách hàng." });
    }
    if (event.httpMethod === "POST") {
      const code = boundedString(payload.MaKH, "mã khách", 50, { required: true });
      const name = boundedString(payload.TenKH, "tên khách hàng", 200, { required: true });
      const customer = await updateDatabase((database) => {
        const customers = database.crm.customers;
        if (customers.some((item) => (
          normalizeBusinessUnit(item.businessUnit) === businessUnit
          && normalizeText(item.MaKH) === normalizeText(code)
        ))) {
          throw new Error(`Mã khách ${code} đã tồn tại.`);
        }
        const created = {
          MaKH: code,
          TenKH: name,
          GiaMi: finiteNumber(payload.GiaMi, "Giá mì", { minimum: 0, maximum: 10000000 }),
          GiaCao: finiteNumber(payload.GiaCao, "Giá cảo", { minimum: 0, maximum: 10000000 }),
          GiaHoanh: finiteNumber(payload.GiaHoanh, "Giá hoành", { minimum: 0, maximum: 10000000 }),
          GiaPhoSoi: finiteNumber(payload.GiaPhoSoi, "Giá phở sợi", { minimum: 0, maximum: 10000000 }),
          GiaPhoCuon: finiteNumber(payload.GiaPhoCuon, "Giá phở cuốn", { minimum: 0, maximum: 10000000 }),
          businessUnit,
          NhaXeMacDinh: boundedString(payload.NhaXeMacDinh, "nhà xe mặc định", 150),
          ChinhSachThue: payload.ChinhSachThue || "linh-hoat",
          ThueSuat: finiteNumber(payload.ThueSuat, "Thuế suất", { minimum: 0, maximum: 100 }),
          TrangThai: "active",
        };
        customers.push(created);
        let linkedProduction = null;
        const productionInfoId = Number(payload.productionInfoId);
        if (Number.isInteger(productionInfoId) && productionInfoId > 0) {
          const entry = (database.productionInfo?.entries || []).find(
            (item) => (
              Number(item.id) === productionInfoId
              && normalizeBusinessUnit(item.businessUnit) === businessUnit
            ),
          );
          if (!entry) throw new Error("Không tìm thấy hồ sơ sản xuất được đề xuất.");
          if (entry.customerCode && normalizeText(entry.customerCode) !== normalizeText(code)) {
            throw new Error("Hồ sơ sản xuất này đã liên kết với khách hàng khác.");
          }
          entry.customerCode = code;
          entry.linkedExplicitly = true;
          linkedProduction = { id: entry.id, customer: entry.customer };
        }
        appendAudit(database, {
          action: "customer-created",
          actorUserId: sessionUser.id,
          actorEmail: sessionUser.email,
          actorName: sessionUser.displayName,
          targetCustomerCode: created.MaKH,
          summary: `${sessionUser.displayName} thêm khách hàng ${created.TenKH}.`,
          businessUnit,
          details: { customer: { ...created }, linkedProduction },
        });
        return { customer: created, linkedProduction };
      });
      return jsonResponse(201, { ok: true, ...customer });
    }

    if (event.httpMethod === "PUT") {
      const result = await updateDatabase((database) => {
        const customer = database.crm.customers.find(
          (item) => normalizeBusinessUnit(item.businessUnit) === businessUnit
            && normalizeText(item.MaKH) === normalizeText(payload.MaKH),
        );
        if (!customer) throw new Error("Không tìm thấy khách hàng cần cập nhật.");
        const oldName = customer.TenKH;
        const before = { ...customer };
        editableFields.forEach((field) => {
          if (payload[field] === undefined) return;
          if (["GiaMi", "GiaCao", "GiaHoanh", "GiaPhoSoi", "GiaPhoCuon"].includes(field)) {
            customer[field] = finiteNumber(payload[field], field, { minimum: 0, maximum: 10000000 });
          } else if (field === "ThueSuat") {
            customer[field] = finiteNumber(payload[field], "Thuế suất", { minimum: 0, maximum: 100 });
          } else {
            const maximum = field === "TenKH" ? 200 : 150;
            customer[field] = boundedString(payload[field], field, maximum, { required: field === "TenKH" });
          }
        });
        let syncedOrders = 0;
        let syncedProduction = 0;
        if (normalizeText(oldName) !== normalizeText(customer.TenKH)) {
          database.crm.orders.forEach((order) => {
            if (normalizeBusinessUnit(order.businessUnit) !== businessUnit) return;
            if (normalizeText(order.customerName) !== normalizeText(oldName)) return;
            order.customerName = customer.TenKH;
            syncedOrders += 1;
          });
          (database.productionInfo?.entries || []).forEach((entry) => {
            if (normalizeBusinessUnit(entry.businessUnit) !== businessUnit) return;
            if (normalizeText(entry.customerCode) !== normalizeText(customer.MaKH)) return;
            entry.customer = customer.TenKH;
            syncedProduction += 1;
          });
        }
        appendAudit(database, {
          action: "customer-updated",
          actorUserId: sessionUser.id,
          actorEmail: sessionUser.email,
          actorName: sessionUser.displayName,
          targetCustomerCode: customer.MaKH,
          summary: `${sessionUser.displayName} cập nhật khách hàng ${customer.TenKH}.`,
          businessUnit,
          details: { before, after: { ...customer }, syncedOrders, syncedProduction },
        });
        return { customer, syncedOrders, syncedProduction };
      });
      return jsonResponse(200, { ok: true, ...result });
    }

    return jsonResponse(405, { error: "Method not allowed" });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(error.message.includes("đã tồn tại") ? 409 : 400, { error: error.message });
  }
};
