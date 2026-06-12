const { authErrorResponse, requireAuth, requireBusinessUnit } = require("./_auth");
const { appendAudit, nextId, normalizeBusinessUnit, normalizeText, readDatabase, updateDatabase } = require("./_database");
const { jsonResponse } = require("./_sheets");

function fields(payload) {
  return {
    customer: String(payload.customer || "").trim(),
    usualOrder: String(payload.usualOrder || "").trim(),
    production: String(payload.production || "").trim(),
    delivery: String(payload.delivery || "").trim(),
    additional: String(payload.additional || "").trim(),
    invoice: String(payload.invoice || "").trim(),
    customerCode: String(payload.customerCode || "").trim(),
  };
}

function matchCustomer(entry, customers) {
  const text = normalizeText(entry.customer);
  const matches = customers.filter((customer) => (
    text.includes(normalizeText(customer.MaKH))
    || text.includes(normalizeText(customer.TenKH))
    || normalizeText(customer.TenKH).includes(text)
  ));
  return matches.length === 1 ? matches[0].MaKH : "";
}

exports.handler = async (event) => {
  try {
    const sessionUser = requireAuth(event);
    const payload = ["POST", "PUT"].includes(event.httpMethod) ? JSON.parse(event.body || "{}") : {};
    const businessUnit = requireBusinessUnit(
      sessionUser,
      payload.businessUnit || event.queryStringParameters?.businessUnit,
    );
    if (event.httpMethod === "GET" && sessionUser.role === "manager") {
      const productionInfo = readDatabase().productionInfo || { title: "Thông tin khách hàng", entries: [] };
      return jsonResponse(200, {
        title: productionInfo.title,
        entries: (productionInfo.entries || []).filter((entry) => (
          normalizeBusinessUnit(entry.businessUnit) === businessUnit
        )),
      });
    }
    if (sessionUser.role !== "manager") {
      return jsonResponse(403, { error: "Chỉ tài khoản quản lý được xem hoặc thay đổi thông tin sản xuất." });
    }
    if (event.httpMethod === "PUT") {
      const entry = await updateDatabase((database) => {
        const entries = database.productionInfo.entries;
        const current = entries.find((item) => (
          Number(item.id) === Number(payload.id)
          && normalizeBusinessUnit(item.businessUnit) === businessUnit
        ));
        if (!current) throw new Error("Không tìm thấy thông tin sản xuất cần sửa.");
        const nextFields = fields(payload);
        if (nextFields.customerCode) {
          const customerExists = database.crm.customers.some((customer) => (
            normalizeBusinessUnit(customer.businessUnit) === businessUnit
            && normalizeText(customer.MaKH) === normalizeText(nextFields.customerCode)
          ));
          if (!customerExists) throw new Error("Khách hàng liên kết không thuộc phân hệ đang chọn.");
        }
        const before = { ...current };
        Object.assign(current, nextFields, { linkedExplicitly: Boolean(nextFields.customerCode) });
        current.businessUnit = businessUnit;
        appendAudit(database, {
          action: "production-info-updated",
          actorUserId: sessionUser.id,
          actorEmail: sessionUser.email,
          actorName: sessionUser.displayName,
          targetProductionInfoId: current.id,
          summary: `${sessionUser.displayName} sửa thông tin sản xuất của ${current.customer}.`,
          businessUnit,
          details: { before, after: { ...current } },
        });
        return current;
      });
      return jsonResponse(200, { ok: true, entry });
    }

    if (event.httpMethod === "POST" && payload.action === "create") {
      const entry = await updateDatabase((database) => {
        const entries = database.productionInfo.entries;
        const created = {
          id: nextId(entries),
          ...fields(payload),
          businessUnit,
          linkedExplicitly: Boolean(payload.customerCode),
        };
        if (!created.customer) throw new Error("Vui lòng nhập tên khách hàng.");
        if (created.customerCode) {
          const customerExists = database.crm.customers.some((customer) => (
            normalizeBusinessUnit(customer.businessUnit) === businessUnit
            && normalizeText(customer.MaKH) === normalizeText(created.customerCode)
          ));
          if (!customerExists) throw new Error("Khách hàng liên kết không thuộc phân hệ đang chọn.");
        }
        entries.push(created);
        appendAudit(database, {
          action: "production-info-created",
          actorUserId: sessionUser.id,
          actorEmail: sessionUser.email,
          actorName: sessionUser.displayName,
          targetProductionInfoId: created.id,
          summary: `${sessionUser.displayName} thêm thông tin sản xuất của ${created.customer}.`,
          businessUnit,
          details: { entry: { ...created } },
        });
        return created;
      });
      return jsonResponse(201, { ok: true, entry });
    }

    if (event.httpMethod === "POST") {
      const matched = await updateDatabase((database) => {
        let count = 0;
        database.productionInfo.entries.forEach((entry) => {
          if (normalizeBusinessUnit(entry.businessUnit) !== businessUnit) return;
          if (entry.customerCode) return;
          const code = matchCustomer(entry, database.crm.customers.filter((customer) => (
            normalizeBusinessUnit(customer.businessUnit) === businessUnit
          )));
          if (!code) return;
          entry.customerCode = code;
          entry.linkedExplicitly = false;
          count += 1;
        });
        appendAudit(database, {
          action: "production-customers-matched",
          actorUserId: sessionUser.id,
          actorEmail: sessionUser.email,
          actorName: sessionUser.displayName,
          summary: `${sessionUser.displayName} khớp tự động ${count} hồ sơ sản xuất với khách CRM.`,
          businessUnit,
          details: { matched: count },
        });
        return count;
      });
      return jsonResponse(200, { ok: true, matched });
    }

    return jsonResponse(405, { error: "Method not allowed" });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(400, { error: error.message });
  }
};
