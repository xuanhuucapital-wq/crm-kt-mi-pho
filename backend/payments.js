const { authErrorResponse, requireBusinessUnit, requireRole } = require("./_auth");
const { appendAudit, nextId, normalizeBusinessUnit, normalizeText, readDatabase, updateDatabase } = require("./_database");
const { jsonResponse } = require("./_sheets");
const { boundedString, parseJsonBody } = require("./_validation");

exports.handler = async (event) => {
  try {
    const manager = await requireRole(event, "manager");
    const payload = event.httpMethod === "POST" ? parseJsonBody(event) : {};
    const businessUnit = requireBusinessUnit(
      manager,
      payload.businessUnit || event.queryStringParameters?.businessUnit,
    );
    if (event.httpMethod === "GET") {
      return jsonResponse(200, {
        payments: ((await readDatabase()).payments || []).filter((item) => (
          normalizeBusinessUnit(item.businessUnit) === businessUnit
        )),
      });
    }
    if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
    const amount = Number(String(payload.amount || "").replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      return jsonResponse(400, { error: "Số tiền thanh toán phải lớn hơn 0." });
    }
    if (amount > 10000000000) {
      return jsonResponse(400, { error: "Số tiền thanh toán vượt quá giới hạn cho phép." });
    }
    const customerCode = boundedString(payload.customerCode, "mã khách", 50, { required: true });
    const payment = await updateDatabase((database) => {
      const customer = database.crm.customers.find(
        (item) => normalizeBusinessUnit(item.businessUnit) === businessUnit
          && normalizeText(item.MaKH) === normalizeText(customerCode),
      );
      if (!customer) throw new Error("Không tìm thấy khách hàng.");
      const orders = database.crm.orders
        .filter((order) => (
          normalizeBusinessUnit(order.businessUnit) === businessUnit
          && normalizeText(order.customerName) === normalizeText(customer.TenKH)
          && order.debt > 0
        ))
        .sort((first, second) => (
          (first.date || "9999").localeCompare(second.date || "9999")
          || Number(first.id) - Number(second.id)
        ));
      const debt = orders.reduce((sum, order) => sum + order.debt, 0);
      if (amount > debt) throw new Error(`Số tiền vượt quá công nợ ${debt.toLocaleString("vi-VN")} ₫.`);
      let remaining = amount;
      const allocations = [];
      orders.forEach((order) => {
        if (remaining <= 0) return;
        const applied = Math.min(remaining, order.debt);
        order.paid += applied;
        order.debt -= applied;
        remaining -= applied;
        allocations.push({ orderId: order.id, amount: applied });
      });
      const payments = database.payments || (database.payments = []);
      const created = {
        id: nextId(payments),
        customerCode: customer.MaKH,
        customerName: customer.TenKH,
        amount,
        date: boundedString(payload.date, "ngày thanh toán", 10, { required: true }),
        note: boundedString(payload.note, "ghi chú", 1000),
        allocations,
        businessUnit,
        createdAt: new Date().toISOString(),
      };
      payments.unshift(created);
      appendAudit(database, {
        action: "payment-recorded",
        actorUserId: manager.id,
        actorEmail: manager.email,
        actorName: manager.displayName,
        targetPaymentId: created.id,
        summary: `${manager.displayName} ghi nhận ${amount.toLocaleString("vi-VN")} ₫ từ ${customer.TenKH}.`,
        businessUnit,
        details: {
          customerCode: customer.MaKH,
          customerName: customer.TenKH,
          amount,
          date: created.date,
          note: created.note,
          allocations,
        },
      });
      return created;
    });
    return jsonResponse(201, { ok: true, payment });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(400, { error: error.message });
  }
};
