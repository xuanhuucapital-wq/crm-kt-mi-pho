const ExcelJS = require("exceljs");
const { authErrorResponse, requireBusinessUnit, requireRole } = require("./_auth");
const { normalizeBusinessUnit, readDatabase, recalculate } = require("./_database");
const { jsonResponse } = require("./_sheets");

const colors = {
  dark: "17352F",
  green: "246B59",
  paleGreen: "E8F4EE",
  red: "C23B34",
  paleRed: "FBE9E7",
  gold: "A86F18",
  paleGold: "FBF1DC",
  brightYellow: "FFF200",
  brightGreen: "42F000",
  headerGreen: "C6E0B4",
  headerGray: "D9E1F2",
  line: "DFE5E2",
  muted: "697570",
  white: "FFFFFF",
};

function moneyFormat(cell) {
  cell.numFmt = '#,##0" ₫"';
  cell.alignment = { horizontal: "right" };
}

function styleTitle(sheet, title, subtitle, lastColumn) {
  sheet.mergeCells(`A1:${lastColumn}1`);
  sheet.getCell("A1").value = title;
  sheet.getCell("A1").font = { bold: true, size: 18, color: { argb: colors.white } };
  sheet.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.dark } };
  sheet.getCell("A1").alignment = { vertical: "middle" };
  sheet.getRow(1).height = 32;
  sheet.mergeCells(`A2:${lastColumn}2`);
  sheet.getCell("A2").value = subtitle;
  sheet.getCell("A2").font = { italic: true, color: { argb: colors.muted } };
  sheet.getRow(2).height = 24;
}

function styleHeader(row) {
  row.font = { bold: true, color: { argb: colors.white } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.green } };
  row.alignment = { vertical: "middle", horizontal: "center" };
  row.height = 25;
}

function addBorders(row) {
  row.eachCell((cell) => {
    cell.border = {
      bottom: { style: "thin", color: { argb: colors.line } },
    };
  });
}

function debtLevel(value) {
  if (value >= 10000000) return "Ưu tiên cao";
  if (value >= 3000000) return "Theo dõi";
  return "Bình thường";
}

function asDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00+07:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function weekday(value) {
  const date = asDate(value);
  if (!date) return "";
  const day = date.getDay();
  return day === 0 ? "CN" : `T${day + 1}`;
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

async function phoDebtWorkbook(workbook, outstandingOrders) {
  const sheet = workbook.addWorksheet("Công nợ phở", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const header = sheet.addRow([
    "Thứ",
    "Ngày tháng năm",
    "Tên quán",
    "Số lượng (kg)",
    "Tiền hàng",
    "Đã thu",
    "Còn nợ",
  ]);
  styleHeader(header);
  outstandingOrders.forEach((order) => {
    const date = asDate(order.date);
    const row = sheet.addRow([
      weekday(order.date),
      date,
      order.customerName,
      Number(order.phoSoiKg || 0) + Number(order.phoCuonKg || 0),
      Number(order.subtotal || 0),
      Number(order.paid || 0),
      Number(order.debt || 0),
    ]);
    row.getCell(2).numFmt = "dd/mm/yyyy";
    row.getCell(4).numFmt = "0";
    [5, 6, 7].forEach((column) => moneyFormat(row.getCell(column)));
    row.getCell(7).font = { bold: true, color: { argb: colors.red } };
    addBorders(row);
  });
  sheet.autoFilter = { from: "A1", to: `G${Math.max(1, sheet.rowCount)}` };
  [8, 16, 32, 16, 18, 18, 18].forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  sheet.pageSetup = {
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    paperSize: 9,
    margins: { left: 0.3, right: 0.3, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
  };
  const buffer = await workbook.xlsx.writeBuffer();
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="cong-no-pho-${exportDate()}.xlsx"`,
      "cache-control": "no-store",
    },
    body: Buffer.from(buffer).toString("base64"),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method not allowed" });
  try {
    const manager = requireRole(event, "manager");
    const businessUnit = requireBusinessUnit(manager, event.queryStringParameters?.businessUnit);
    const unitName = businessUnit === "pho" ? "Xưởng Phở" : "Xưởng Mì";
    const database = readDatabase();
    recalculate(database);
    const customers = [...database.crm.customers]
      .filter((customer) => normalizeBusinessUnit(customer.businessUnit) === businessUnit)
      .filter((customer) => Number(customer.debt || 0) > 0)
      .sort((first, second) => second.debt - first.debt);
    const outstandingOrders = database.crm.orders
      .filter((order) => normalizeBusinessUnit(order.businessUnit) === businessUnit)
      .filter((order) => Number(order.debt || 0) > 0)
      .sort((first, second) => (
        first.customerName.localeCompare(second.customerName, "vi")
        || String(first.date || "9999").localeCompare(String(second.date || "9999"))
      ));
    const payments = (database.payments || []).filter((payment) => (
      normalizeBusinessUnit(payment.businessUnit) === businessUnit
    ));
    const workbook = new ExcelJS.Workbook();
    workbook.creator = `CRM ${unitName}`;
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.properties.date1904 = false;

    if (businessUnit === "pho") {
      return await phoDebtWorkbook(workbook, outstandingOrders);
    }

    const summary = workbook.addWorksheet("Tổng hợp công nợ", {
      views: [{ state: "frozen", ySplit: 6 }],
    });
    styleTitle(
      summary,
      `BÁO CÁO THU HỒI CÔNG NỢ ${unitName.toUpperCase()}`,
      `Xuất từ database CRM lúc ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}`,
      "I",
    );
    summary.mergeCells("A4:B4");
    summary.getCell("A4").value = "Tổng phải thu";
    summary.mergeCells("C4:D4");
    summary.getCell("C4").value = customers.reduce((sum, customer) => sum + customer.debt, 0);
    summary.mergeCells("E4:F4");
    summary.getCell("E4").value = "Khách còn nợ";
    summary.mergeCells("G4:I4");
    summary.getCell("G4").value = customers.length;
    ["A4", "C4", "E4", "G4"].forEach((address) => {
      summary.getCell(address).font = { bold: true, size: 13 };
      summary.getCell(address).fill = { type: "pattern", pattern: "solid", fgColor: { argb: colors.paleGreen } };
      summary.getCell(address).alignment = { vertical: "middle" };
    });
    moneyFormat(summary.getCell("C4"));
    const summaryHeaders = ["STT", "Mã khách", "Khách hàng", "Số giao dịch", "Tiền hàng", "Đã thu", "Còn nợ", "Giao dịch cuối", "Mức độ"];
    summary.addRow([]);
    const summaryHeader = summary.addRow(summaryHeaders);
    styleHeader(summaryHeader);
    customers.forEach((customer, index) => {
      const row = summary.addRow([
        index + 1,
        customer.MaKH,
        customer.TenKH,
        customer.orderCount,
        customer.revenue,
        customer.paid,
        customer.debt,
        asDate(customer.lastOrderDate),
        debtLevel(customer.debt),
      ]);
      [5, 6, 7].forEach((column) => moneyFormat(row.getCell(column)));
      row.getCell(8).numFmt = "dd/mm/yyyy";
      const debtCell = row.getCell(7);
      debtCell.font = { bold: true, color: { argb: customer.debt >= 10000000 ? colors.red : colors.gold } };
      const statusCell = row.getCell(9);
      statusCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: customer.debt >= 10000000 ? colors.paleRed : customer.debt >= 3000000 ? colors.paleGold : colors.paleGreen },
      };
      addBorders(row);
    });
    summary.autoFilter = { from: "A6", to: `I${Math.max(6, summary.rowCount)}` };
    [6, 16, 30, 14, 18, 18, 18, 16, 16].forEach((width, index) => { summary.getColumn(index + 1).width = width; });

    const details = workbook.addWorksheet(businessUnit === "pho" ? "Đơn hàng phở" : "Bảng công nợ chi tiết", {
      views: [{ state: "frozen", xSplit: 4, ySplit: 4 }],
    });
    const productColumns = businessUnit === "pho"
      ? [
        { name: "Phở sợi (kg)", priceName: "Giá phở sợi", quantity: "phoSoiKg", price: "pricePhoSoi" },
        { name: "Phở cuốn (kg)", priceName: "Giá phở cuốn", quantity: "phoCuonKg", price: "pricePhoCuon" },
      ]
      : [
        { name: "Mì (kg)", priceName: "Giá mì", quantity: "miKg", price: "priceMi" },
        { name: "Da cảo (kg)", priceName: "Giá da cảo", quantity: "caoKg", price: "priceCao" },
        { name: "Da hoành (kg)", priceName: "Giá da hoành", quantity: "hoanhKg", price: "priceHoanh" },
      ];
    const extraHeaders = businessUnit === "mi" ? ["Hủ tiếu", "Vỏ bánh gối"] : [];
    const detailHeaders = [
      "Mã GD", "Thứ", "Ngày đặt", "Tên KH",
      ...productColumns.flatMap((product) => [product.name, product.priceName]),
      ...extraHeaders,
      "Tiền ứng", ...(businessUnit === "mi" ? ["Thùng xốp"] : []),
      "Chưa thanh toán", "Đã thanh toán", "Thuế", "Còn lại",
      "Nhà xe", "Khách phụ ship", "Ghi chú", "Mức độ",
    ];
    const lastColumn = details.getColumn(detailHeaders.length).letter;
    styleTitle(
      details,
      businessUnit === "pho" ? "BẢNG ĐƠN HÀNG VÀ CÔNG NỢ PHỞ" : "BẢNG CÔNG NỢ CHI TIẾT",
      `Dữ liệu vận hành riêng của ${unitName}`,
      lastColumn,
    );
    details.addRow([]);
    const detailHeader = details.addRow(detailHeaders);
    detailHeader.font = { bold: true, color: { argb: "000000" } };
    detailHeader.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    detailHeader.height = 38;
    detailHeader.eachCell((cell, column) => {
      let color = colors.headerGray;
      if (column >= 5 && column < 5 + productColumns.length * 2) {
        color = column % 4 < 2 ? colors.brightYellow : colors.brightGreen;
      }
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
      cell.border = {
        top: { style: "thin", color: { argb: "A6A6A6" } },
        bottom: { style: "thin", color: { argb: "A6A6A6" } },
        left: { style: "thin", color: { argb: "A6A6A6" } },
        right: { style: "thin", color: { argb: "A6A6A6" } },
      };
    });
    outstandingOrders.forEach((order) => {
      const beforeTax = Number(order.subtotal || 0) + Number(order.advance || 0);
      const values = [
        `#${order.id}`,
        weekday(order.date),
        asDate(order.date),
        order.customerName,
        ...productColumns.flatMap((product) => [order[product.quantity] || "", order[product.price] || 0]),
        ...(businessUnit === "mi" ? [order.huTieu || "", order.voBanhGoi || ""] : []),
        order.advance,
        ...(businessUnit === "mi" ? [order.thungXop || ""] : []),
        beforeTax,
        order.paid,
        order.taxAmount,
        order.debt,
        order.truck || "",
        order.extraShipCustomer || "",
        order.note || "",
        debtLevel(order.debt),
      ];
      const row = details.addRow(values);
      row.getCell(3).numFmt = "dd/mm/yyyy";
      productColumns.forEach((product, index) => moneyFormat(row.getCell(6 + index * 2)));
      const financialStart = 5 + productColumns.length * 2 + extraHeaders.length;
      const advanceColumn = financialStart;
      const unpaidColumn = financialStart + (businessUnit === "mi" ? 2 : 1);
      const paidColumn = unpaidColumn + 1;
      const taxColumn = paidColumn + 1;
      const debtColumn = taxColumn + 1;
      [advanceColumn, unpaidColumn, paidColumn, taxColumn, debtColumn].forEach((column) => moneyFormat(row.getCell(column)));
      row.getCell(debtColumn).font = { bold: true, color: { argb: colors.red } };
      row.getCell(detailHeaders.length).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: order.debt >= 10000000 ? colors.paleRed : order.debt >= 3000000 ? colors.paleGold : colors.paleGreen },
      };
      row.alignment = { vertical: "middle" };
      row.eachCell((cell) => {
        cell.border = {
          bottom: { style: "thin", color: { argb: "D0D0D0" } },
          right: { style: "thin", color: { argb: "E5E5E5" } },
        };
      });
    });
    details.autoFilter = { from: "A4", to: `${lastColumn}${Math.max(4, details.rowCount)}` };
    detailHeaders.forEach((header, index) => {
      details.getColumn(index + 1).width = header === "Tên KH" ? 28
        : header === "Ghi chú" ? 34
          : header.includes("Nhà xe") || header.includes("Khách phụ") ? 20
            : header.includes("Giá") || header.includes("thanh toán") || header === "Còn lại" ? 17
              : 13;
    });
    details.pageSetup = {
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
      margins: { left: 0.2, right: 0.2, top: 0.4, bottom: 0.4, header: 0.2, footer: 0.2 },
    };

    const paymentSheet = workbook.addWorksheet("Lịch sử thanh toán", {
      views: [{ state: "frozen", ySplit: 4 }],
    });
    styleTitle(paymentSheet, "LỊCH SỬ THANH TOÁN", "Các khoản thu đã ghi nhận trong database CRM", "F");
    paymentSheet.addRow([]);
    const paymentHeader = paymentSheet.addRow(["Ngày", "Mã khách", "Khách hàng", "Số tiền", "Ghi chú", "Giao dịch được phân bổ"]);
    styleHeader(paymentHeader);
    payments.forEach((payment) => {
      const row = paymentSheet.addRow([
        asDate(payment.date),
        payment.customerCode,
        payment.customerName,
        payment.amount,
        payment.note || "",
        (payment.allocations || []).map((item) => `#${item.orderId}: ${item.amount.toLocaleString("vi-VN")} ₫`).join("; "),
      ]);
      row.getCell(1).numFmt = "dd/mm/yyyy";
      moneyFormat(row.getCell(4));
      addBorders(row);
    });
    paymentSheet.autoFilter = { from: "A4", to: `F${Math.max(4, paymentSheet.rowCount)}` };
    [14, 16, 30, 18, 32, 46].forEach((width, index) => { paymentSheet.getColumn(index + 1).width = width; });
    [5, 6].forEach((column) => { paymentSheet.getColumn(column).alignment = { wrapText: true, vertical: "top" }; });

    const buffer = await workbook.xlsx.writeBuffer();
    const date = exportDate();
    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="cong-no-${businessUnit}-${date}.xlsx"`,
        "cache-control": "no-store",
      },
      body: Buffer.from(buffer).toString("base64"),
    };
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(500, { error: error.message });
  }
};
