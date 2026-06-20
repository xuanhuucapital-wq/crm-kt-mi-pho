const { authErrorResponse, requireBusinessUnit, requireRole } = require("./_auth");
const { normalizeBusinessUnit, normalizeText, readDatabase, recalculate } = require("./_database");
const { jsonResponse } = require("./_sheets");

const productColumns = {
  mi: [
    { name: "Mì", quantity: "miKg", price: "priceMi" },
    { name: "Da cảo", quantity: "caoKg", price: "priceCao" },
    { name: "Da hoành", quantity: "hoanhKg", price: "priceHoanh" },
  ],
  pho: [
    { name: "Phở sợi", quantity: "phoSoiKg", price: "pricePhoSoi" },
    { name: "Phở cuốn", quantity: "phoCuonKg", price: "pricePhoCuon" },
  ],
};

function loadExcelJs() {
  if (process.env.CRM_DISABLE_EXCELJS_EXPORT === "true") return null;
  try {
    return require("exceljs");
  } catch {
    return null;
  }
}

function exportDate() {
  const dateParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function safeFilename(value) {
  return normalizeText(value)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "khach-hang";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function asDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00+07:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function displayDate(value) {
  const date = asDate(value);
  return date ? date.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "";
}

function customerOrders(database, businessUnit, customer) {
  return (database.crm.orders || [])
    .filter((order) => (
      normalizeBusinessUnit(order.businessUnit) === businessUnit
      && normalizeText(order.customerName) === normalizeText(customer.TenKH)
    ))
    .sort((first, second) => (
      String(second.date || "").localeCompare(String(first.date || ""))
      || Number(second.id || 0) - Number(first.id || 0)
    ));
}

function totalsForOrders(orders) {
  return orders.reduce((result, order) => ({
    subtotal: result.subtotal + Number(order.subtotal || 0),
    tax: result.tax + Number(order.taxAmount || 0),
    advance: result.advance + Number(order.advance || 0),
    paid: result.paid + Number(order.paid || 0),
    debt: result.debt + Number(order.debt || 0),
  }), { subtotal: 0, tax: 0, advance: 0, paid: 0, debt: 0 });
}

function usedProducts(businessUnit, orders) {
  return (productColumns[businessUnit] || productColumns.mi).filter((product) => (
    orders.some((order) => Number(order[product.quantity] || 0) > 0)
  ));
}

function detailExtraColumns(orders, totals) {
  return [
    { header: "Tiền hàng", width: 18, money: true, value: (order) => Number(order.subtotal || 0) },
    ...(totals.tax > 0 ? [{ header: "Thuế", width: 16, money: true, value: (order) => Number(order.taxAmount || 0) }] : []),
    ...(totals.advance > 0 ? [{ header: "Ứng xe", width: 16, money: true, value: (order) => Number(order.advance || 0) }] : []),
    { header: "Đã trả", width: 16, money: true, value: (order) => Number(order.paid || 0) },
    { header: "Còn lại", width: 16, money: true, value: (order) => Number(order.debt || 0) },
    ...(orders.some((order) => order.truck) ? [{ header: "Nhà xe", width: 18, value: (order) => order.truck || "" }] : []),
    ...(orders.some((order) => order.extraShipCustomer) ? [{ header: "Khách phụ ship", width: 20, value: (order) => order.extraShipCustomer || "" }] : []),
    ...(orders.some((order) => order.customerResting) ? [{ header: "Khách nghỉ", width: 12, value: (order) => (order.customerResting ? "Có" : "") }] : []),
    ...(orders.some((order) => order.note) ? [{ header: "Ghi chú", width: 34, value: (order) => order.note || "" }] : []),
  ];
}

function orderRow(order, products, extras) {
  const productValues = products.flatMap((product) => {
    const quantity = Number(order[product.quantity] || 0);
    const price = Number(order[product.price] || 0);
    return [quantity, price, quantity * price];
  });
  return [
    asDate(order.date),
    Number(order.id || 0),
    ...productValues,
    ...extras.map((column) => column.value(order)),
  ];
}

function fallbackWorkbook({ businessUnit, customer, orders, payments }) {
  const products = usedProducts(businessUnit, orders);
  const totals = totalsForOrders(orders);
  const extras = detailExtraColumns(orders, totals);
  const headers = [
    "Ngày",
    "Mã đơn",
    ...products.flatMap((product) => [`${product.name} - SL kg`, `${product.name} - Đơn giá`, `${product.name} - Thành tiền`]),
    ...extras.map((column) => column.header),
  ];
  const rows = orders.map((order) => {
    const values = orderRow(order, products, extras);
    return [displayDate(order.date), ...values.slice(1)];
  });
  const htmlRows = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
  const paymentRows = payments.map((payment) => `
    <tr>
      <td>${escapeHtml(displayDate(payment.date))}</td>
      <td>${escapeHtml(payment.amount || 0)}</td>
      <td>${escapeHtml(payment.note || "")}</td>
      <td>${escapeHtml((payment.allocations || []).map((item) => `#${item.orderId}: ${Number(item.amount || 0).toLocaleString("vi-VN")} đ`).join("; "))}</td>
    </tr>`).join("");
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/vnd.ms-excel; charset=utf-8",
      "content-disposition": `attachment; filename="ho-so-${safeFilename(customer.TenKH)}-${exportDate()}.xls"`,
      "cache-control": "no-store",
    },
    body: `<!doctype html>
<html><head><meta charset="utf-8" /><style>
body{font-family:Arial,sans-serif} h1{font-size:18pt;color:#17352f} h2{font-size:13pt;color:#246b59;margin-top:22px}
table{border-collapse:collapse;margin-bottom:18px} th{background:#246b59;color:#fff;font-weight:bold}
th,td{border:1px solid #dfe5e2;padding:6px 8px;vertical-align:top}
</style></head><body>
<h1>Hồ sơ khách hàng - ${escapeHtml(customer.TenKH)}</h1>
<p>Mã khách: ${escapeHtml(customer.MaKH)} - Nhà xe: ${escapeHtml(customer.NhaXeMacDinh || "")}</p>
<table><tbody>
<tr><th>Số giao dịch</th><td>${orders.length}</td><th>Tiền hàng</th><td>${totals.subtotal}</td></tr>
${totals.tax || totals.advance ? `<tr><th>Thuế</th><td>${totals.tax}</td><th>Ứng xe</th><td>${totals.advance}</td></tr>` : ""}
<tr><th>Đã trả</th><td>${totals.paid}</td><th>Còn lại</th><td>${totals.debt}</td></tr>
</tbody></table>
<h2>Lịch sử giao dịch</h2>
<table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${htmlRows}</tbody></table>
<h2>Lịch sử thanh toán</h2>
<table><thead><tr><th>Ngày</th><th>Số tiền</th><th>Ghi chú</th><th>Giao dịch được phân bổ</th></tr></thead><tbody>${paymentRows}</tbody></table>
</body></html>`,
  };
}

async function excelWorkbook({ businessUnit, unitName, customer, orders, payments }) {
  const ExcelJS = loadExcelJs();
  if (!ExcelJS) return fallbackWorkbook({ businessUnit, customer, orders, payments });
  const products = usedProducts(businessUnit, orders);
  const totals = totalsForOrders(orders);
  const extras = detailExtraColumns(orders, totals);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = `CRM ${unitName}`;
  workbook.created = new Date();
  workbook.modified = new Date();

  const summary = workbook.addWorksheet("Tổng quan");
  summary.columns = [
    { header: "Chỉ số", key: "label", width: 24 },
    { header: "Giá trị", key: "value", width: 24 },
  ];
  [
    ["Khách hàng", customer.TenKH],
    ["Mã khách", customer.MaKH],
    ["Nhà xe mặc định", customer.NhaXeMacDinh || ""],
    ["Phân hệ", unitName],
    ["Số giao dịch", orders.length],
    ["Tiền hàng", totals.subtotal],
    ...(totals.tax > 0 ? [["Thuế", totals.tax]] : []),
    ...(totals.advance > 0 ? [["Ứng xe", totals.advance]] : []),
    ["Đã trả", totals.paid],
    ["Còn lại", totals.debt],
  ].forEach(([label, value]) => summary.addRow({ label, value }));
  summary.getRow(1).font = { bold: true };
  summary.eachRow((row, rowNumber) => {
    if (rowNumber < 6) return;
    row.getCell(2).numFmt = '#,##0" đ"';
  });

  const detail = workbook.addWorksheet("Giao dịch", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  detail.columns = [
    { header: "Ngày", key: "date", width: 14 },
    { header: "Mã đơn", key: "id", width: 10 },
    ...products.flatMap((product) => [
      { header: `${product.name} - SL kg`, width: 14 },
      { header: `${product.name} - Đơn giá`, width: 16 },
      { header: `${product.name} - Thành tiền`, width: 18 },
    ]),
    ...extras.map((column) => ({ header: column.header, width: column.width })),
  ];
  detail.getRow(1).font = { bold: true, color: { argb: "FFFFFF" } };
  detail.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "246B59" } };
  orders.forEach((order) => {
    const row = detail.addRow(orderRow(order, products, extras));
    row.getCell(1).numFmt = "dd/mm/yyyy";
    for (let index = 0; index < products.length; index += 1) {
      row.getCell(3 + index * 3).numFmt = "0.##";
      row.getCell(4 + index * 3).numFmt = '#,##0" đ"';
      row.getCell(5 + index * 3).numFmt = '#,##0" đ"';
    }
    const moneyStart = 3 + products.length * 3;
    extras.forEach((column, index) => {
      if (column.money) row.getCell(moneyStart + index).numFmt = '#,##0" đ"';
    });
  });
  detail.autoFilter = { from: "A1", to: `${detail.getColumn(detail.columnCount).letter}${Math.max(1, detail.rowCount)}` };

  const paymentSheet = workbook.addWorksheet("Thanh toán", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  paymentSheet.columns = [
    { header: "Ngày", key: "date", width: 14 },
    { header: "Số tiền", key: "amount", width: 18 },
    { header: "Ghi chú", key: "note", width: 34 },
    { header: "Giao dịch được phân bổ", key: "allocations", width: 46 },
  ];
  paymentSheet.getRow(1).font = { bold: true, color: { argb: "FFFFFF" } };
  paymentSheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "246B59" } };
  payments.forEach((payment) => {
    const row = paymentSheet.addRow({
      date: asDate(payment.date),
      amount: Number(payment.amount || 0),
      note: payment.note || "",
      allocations: (payment.allocations || []).map((item) => `#${item.orderId}: ${Number(item.amount || 0).toLocaleString("vi-VN")} đ`).join("; "),
    });
    row.getCell(1).numFmt = "dd/mm/yyyy";
    row.getCell(2).numFmt = '#,##0" đ"';
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="ho-so-${safeFilename(customer.TenKH)}-${exportDate()}.xlsx"`,
      "cache-control": "no-store",
    },
    body: Buffer.from(buffer).toString("base64"),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method not allowed" });
  try {
    const manager = await requireRole(event, "manager");
    const businessUnit = requireBusinessUnit(manager, event.queryStringParameters?.businessUnit);
    const code = String(event.queryStringParameters?.customerCode || "").trim();
    if (!code) return jsonResponse(400, { error: "Thiếu mã khách hàng." });
    const database = await readDatabase();
    recalculate(database);
    const customer = (database.crm.customers || []).find((item) => (
      normalizeBusinessUnit(item.businessUnit) === businessUnit
      && normalizeText(item.MaKH) === normalizeText(code)
    ));
    if (!customer) return jsonResponse(404, { error: "Không tìm thấy khách hàng." });
    const orders = customerOrders(database, businessUnit, customer);
    const payments = (database.payments || []).filter((payment) => (
      normalizeBusinessUnit(payment.businessUnit) === businessUnit
      && normalizeText(payment.customerCode) === normalizeText(customer.MaKH)
    ));
    const unitName = businessUnit === "pho" ? "Xưởng Phở" : "Xưởng Mì";
    return await excelWorkbook({ businessUnit, unitName, customer, orders, payments });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(500, { error: error.message });
  }
};
