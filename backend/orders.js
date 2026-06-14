const { authErrorResponse, requireAuth, requireBusinessUnit } = require("./_auth");
const { appendAudit, nextId, normalizeBusinessUnit, normalizeOrder, normalizeText, updateDatabase } = require("./_database");
const { jsonResponse } = require("./_sheets");

function numberValue(value) {
  const raw = String(value ?? "").trim().replace(/\./g, "").replace(",", ".");
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function booleanValue(value) {
  return value === true || String(value) === "true";
}

function todayInVietnam() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function copiedNote(note) {
  return String(note || "")
    .replace(/\s*\|\s*(Tiền mặt|Chuyển khoản)\s*$/i, "")
    .trim();
}

function applyPayload(order, payload, businessUnit, options = {}) {
  const resting = booleanValue(payload.customerResting);
  order.businessUnit = businessUnit;
  const paymentMethod = ["debt", "cash", "transfer"].includes(payload.paymentMethod)
    ? payload.paymentMethod
    : order.paymentMethod || "debt";
  order.date = String(payload.orderDate || order.date || "").trim();
  order.miKg = resting ? 0 : numberValue(payload.miKg);
  order.caoKg = resting ? 0 : numberValue(payload.caoKg);
  order.hoanhKg = resting ? 0 : numberValue(payload.hoanhKg);
  order.huTieu = resting ? 0 : numberValue(payload.huTieu);
  order.voBanhGoi = resting ? 0 : numberValue(payload.voBanhGoi);
  order.thungXop = resting ? 0 : numberValue(payload.thungXop);
  const phoSoiUnit = payload.phoSoiUnit === "cay" ? "cay" : "kg";
  const phoSoiInputQuantity = resting ? 0 : numberValue(payload.phoSoiKg);
  order.phoSoiUnit = phoSoiUnit;
  order.phoSoiInputQuantity = phoSoiInputQuantity;
  order.phoSoiKg = phoSoiInputQuantity * (phoSoiUnit === "cay" ? 5 : 1);
  order.phoCuonKg = resting ? 0 : numberValue(payload.phoCuonKg);
  order.advance = numberValue(payload.tienUng);
  order.taxRate = numberValue(payload.taxRate);
  order.taxPayer = payload.taxPayer || order.taxPayer || "customer";
  const calculatedTax = (
    businessUnit === "pho"
      ? Number(order.phoSoiKg || 0) * Number(order.pricePhoSoi || 0)
        + Number(order.phoCuonKg || 0) * Number(order.pricePhoCuon || 0)
      : Number(order.miKg || 0) * Number(order.priceMi || 0)
        + Number(order.caoKg || 0) * Number(order.priceCao || 0)
        + Number(order.hoanhKg || 0) * Number(order.priceHoanh || 0)
  ) * order.taxRate / 100;
  order.taxAmount = order.taxPayer === "owner" ? 0 : calculatedTax;
  order.paymentMethod = paymentMethod;
  if (options.allowPaid) {
    order.paid = numberValue(payload.paid ?? order.paid);
  }
  order.customerResting = resting;
  order.truck = resting ? "" : String(payload.nhaXe || "").trim();
  order.extraShipCustomer = String(payload.extraShipCustomer || "").trim();
  const paymentNote = paymentMethod === "cash"
    ? "Tiền mặt"
    : paymentMethod === "transfer"
      ? "Chuyển khoản"
      : "";
  order.note = [String(payload.ghiChu || "").trim(), paymentNote].filter(Boolean).join(" | ");
  normalizeOrder(order);
  if (paymentMethod === "cash" || paymentMethod === "transfer") {
    order.paid = order.total;
    order.debt = 0;
  }
  return order;
}

exports.handler = async (event) => {
  if (!["POST", "PUT", "DELETE"].includes(event.httpMethod)) {
    return jsonResponse(405, { error: "Method not allowed" });
  }
  try {
    const sessionUser = await requireAuth(event);
    const payload = JSON.parse(event.body || "{}");
    const businessUnit = requireBusinessUnit(
      sessionUser,
      payload.businessUnit || event.queryStringParameters?.businessUnit,
    );

    if (event.httpMethod === "DELETE") {
      if (sessionUser.role !== "manager") {
        return jsonResponse(403, { error: "Chỉ tài khoản quản lý được xóa giao dịch." });
      }
      const result = await updateDatabase((database) => {
        const orderIndex = database.crm.orders.findIndex((item) => (
          Number(item.id) === Number(payload.rowId)
          && normalizeBusinessUnit(item.businessUnit) === businessUnit
        ));
        if (orderIndex < 0) throw new Error("Không tìm thấy đơn hàng cần xóa.");
        const [deletedOrder] = database.crm.orders.splice(orderIndex, 1);
        let reversedPayment = 0;
        let removedPayments = 0;
        const payments = database.payments || (database.payments = []);
        for (let index = payments.length - 1; index >= 0; index -= 1) {
          const payment = payments[index];
          if (normalizeBusinessUnit(payment.businessUnit) !== businessUnit) continue;
          const removedAmount = (payment.allocations || [])
            .filter((allocation) => Number(allocation.orderId) === Number(deletedOrder.id))
            .reduce((sum, allocation) => sum + Number(allocation.amount || 0), 0);
          if (!removedAmount) continue;
          payment.allocations = (payment.allocations || []).filter(
            (allocation) => Number(allocation.orderId) !== Number(deletedOrder.id),
          );
          payment.amount = Math.max(0, Number(payment.amount || 0) - removedAmount);
          reversedPayment += removedAmount;
          if (payment.amount <= 0 || payment.allocations.length === 0) {
            payments.splice(index, 1);
            removedPayments += 1;
          }
        }
        appendAudit(database, {
          action: "order-deleted",
          actorUserId: sessionUser.id,
          actorEmail: sessionUser.email,
          actorName: sessionUser.displayName,
          targetOrderId: deletedOrder.id,
          summary: `${sessionUser.displayName} xóa đơn #${deletedOrder.id} của ${deletedOrder.customerName}.`,
          businessUnit,
          details: {
            deletedOrder,
            reversedPayment,
            removedPayments,
          },
        });
        return { deletedOrder, reversedPayment, removedPayments };
      });
      return jsonResponse(200, {
        ok: true,
        rowNumber: result.deletedOrder.id,
        customerName: result.deletedOrder.customerName,
        reversedPayment: result.reversedPayment,
        removedPayments: result.removedPayments,
      });
    }

    if (event.httpMethod === "POST") {
      if (sessionUser.role === "delivery" && payload.action === "copy") {
        return jsonResponse(403, { error: "Tài khoản giao hàng không được copy giao dịch cũ." });
      }
      const order = await updateDatabase((database) => {
        if (payload.action === "copy") {
          const source = database.crm.orders.find(
            (item) => Number(item.id) === Number(payload.sourceOrderId)
              && normalizeBusinessUnit(item.businessUnit) === businessUnit,
          );
          if (!source) throw new Error("Không tìm thấy đơn hàng cần copy.");
          const created = {
            ...source,
            id: nextId(database.crm.orders),
            paymentMethod: "debt",
            paid: 0,
            debt: 0,
            copiedFromOrderId: source.id,
            createdAt: new Date().toISOString(),
            createdByUserId: sessionUser.id,
            createdByEmail: sessionUser.email,
          };
          applyPayload(created, {
            ...payload,
            orderDate: payload.orderDate || todayInVietnam(),
            paid: 0,
            paymentMethod: "debt",
            ghiChu: payload.ghiChu === undefined ? copiedNote(source.note) : payload.ghiChu,
          }, businessUnit);
          created.paymentMethod = "debt";
          created.paid = 0;
          normalizeOrder(created);
          database.crm.orders.push(created);
          appendAudit(database, {
            action: "order-copied",
            actorUserId: sessionUser.id,
            actorEmail: sessionUser.email,
            actorName: sessionUser.displayName,
            targetOrderId: created.id,
            summary: `${sessionUser.displayName} copy đơn #${source.id} thành #${created.id}.`,
            businessUnit,
            details: {
              copiedFromOrderId: source.id,
              customerName: created.customerName,
              date: created.date,
              total: created.total,
            },
          });
          return created;
        }
        const customer = database.crm.customers.find(
          (item) => normalizeBusinessUnit(item.businessUnit) === businessUnit
            && normalizeText(item.MaKH) === normalizeText(payload.customerCode),
        );
        if (!customer) throw new Error("Không tìm thấy khách hàng.");
        const orders = database.crm.orders;
        const created = {
          id: nextId(orders),
          customerName: customer.TenKH,
          priceMi: Number(customer.GiaMi || 0),
          priceCao: Number(customer.GiaCao || 0),
          priceHoanh: Number(customer.GiaHoanh || 0),
          pricePhoSoi: Number(customer.GiaPhoSoi || 0),
          pricePhoCuon: Number(customer.GiaPhoCuon || 0),
          businessUnit,
          paid: 0,
          createdAt: new Date().toISOString(),
          createdByUserId: sessionUser.id,
          createdByEmail: sessionUser.email,
        };
        applyPayload(created, {
          ...payload,
          nhaXe: payload.nhaXe || customer.NhaXeMacDinh || "",
          taxRate: payload.taxRate ?? customer.ThueSuat ?? 0,
        }, businessUnit);
        orders.push(created);
        appendAudit(database, {
          action: "order-created",
          actorUserId: sessionUser.id,
          actorEmail: sessionUser.email,
          actorName: sessionUser.displayName,
          targetOrderId: created.id,
          summary: `${sessionUser.displayName} tạo đơn #${created.id} cho ${created.customerName}.`,
          businessUnit,
          details: {
            customerName: created.customerName,
            date: created.date,
            miKg: created.miKg,
            caoKg: created.caoKg,
            hoanhKg: created.hoanhKg,
            phoSoiKg: created.phoSoiKg,
            phoCuonKg: created.phoCuonKg,
            total: created.total,
            paymentMethod: created.paymentMethod,
          },
        });
        if (created.total > 0 && created.paymentMethod !== "debt") {
          const payments = database.payments || (database.payments = []);
          payments.unshift({
            id: nextId(payments),
            customerCode: customer.MaKH,
            customerName: customer.TenKH,
            amount: created.total,
            date: created.date,
            method: created.paymentMethod,
            note: created.paymentMethod === "cash"
              ? "Thanh toán tiền mặt khi tạo đơn."
              : "Chuyển khoản khi tạo đơn.",
            allocations: [{ orderId: created.id, amount: created.total }],
            businessUnit,
            createdAt: new Date().toISOString(),
          });
        }
        return created;
      });
      return jsonResponse(201, {
        ok: true,
        customerName: order.customerName,
        rowNumber: order.id,
        order,
      });
    }

    if (sessionUser.role !== "manager") {
      return jsonResponse(403, { error: "Chỉ tài khoản quản lý được sửa giao dịch." });
    }
    const order = await updateDatabase((database) => {
      const current = database.crm.orders.find((item) => Number(item.id) === Number(payload.rowId));
      if (!current) throw new Error("Không tìm thấy đơn hàng cần sửa.");
      if (normalizeBusinessUnit(current.businessUnit) !== businessUnit) {
        throw new Error("Giao dịch không thuộc phân hệ đang chọn.");
      }
      const before = { ...current };
      applyPayload(current, payload, businessUnit, { allowPaid: true });
      appendAudit(database, {
        action: "order-updated",
        actorUserId: sessionUser.id,
        actorEmail: sessionUser.email,
        actorName: sessionUser.displayName,
        targetOrderId: current.id,
        summary: `${sessionUser.displayName} điều chỉnh đơn #${current.id} của ${current.customerName}.`,
        businessUnit,
        details: { before, after: { ...current } },
      });
      return current;
    });
    return jsonResponse(200, { ok: true, rowNumber: order.id, order });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(400, { error: error.message });
  }
};
