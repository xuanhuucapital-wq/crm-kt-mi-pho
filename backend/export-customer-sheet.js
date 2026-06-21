const { authErrorResponse, requireBusinessUnit, requireRole } = require("./_auth");
const { normalizeBusinessUnit, normalizeText, readDatabase, recalculate } = require("./_database");
const {
  batchUpdate,
  batchUpdateValues,
  colToA1,
  createDriveSpreadsheet,
  createSpreadsheet,
  getSpreadsheetSheets,
  hasOAuthCredentials,
  jsonResponse,
  shareDriveFile,
  spreadsheetUrl,
} = require("./_sheets");

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

function safeSheetTitle(customer) {
  const title = `HS ${customer.MaKH} ${customer.TenKH}`
    .replace(/[\[\]*?/\\:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title.slice(0, 90) || "HS khach hang";
}

function exportTimestamp() {
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const values = Object.fromEntries(dateParts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}-${values.minute}`;
}

function spreadsheetTitle(customer) {
  return `Hồ sơ ${customer.MaKH} - ${customer.TenKH} - ${exportTimestamp()}`;
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
    { key: "subtotal", header: "Tiền hàng", value: (order) => Number(order.subtotal || 0), money: true },
    ...(totals.tax > 0 ? [{ key: "tax", header: "Thuế", value: (order) => Number(order.taxAmount || 0), money: true }] : []),
    ...(totals.advance > 0 ? [{ key: "advance", header: "Ứng xe", value: (order) => Number(order.advance || 0), money: true }] : []),
    { key: "paid", header: "Đã trả", value: (order) => Number(order.paid || 0), money: true },
    { key: "debt", header: "Còn lại", value: (order) => Number(order.debt || 0), money: true },
    ...(orders.some((order) => order.truck) ? [{ header: "Nhà xe", value: (order) => order.truck || "" }] : []),
    ...(orders.some((order) => order.extraShipCustomer) ? [{ header: "Khách phụ ship", value: (order) => order.extraShipCustomer || "" }] : []),
    ...(orders.some((order) => order.customerResting) ? [{ header: "Khách nghỉ", value: (order) => (order.customerResting ? "Có" : "") }] : []),
    ...(orders.some((order) => order.note) ? [{ header: "Ghi chú", value: (order) => order.note || "" }] : []),
  ];
}

function detailHeaders(products, extras) {
  return [
    "Ngày",
    "Mã đơn",
    ...products.flatMap((product) => [`${product.name} - SL kg`, `${product.name} - Đơn giá`, `${product.name} - Thành tiền`]),
    ...extras.map((column) => column.header),
  ];
}

function detailRow(order, products, extras, rowNumber) {
  const productCells = products.flatMap((product, index) => {
    const quantityColumn = 3 + index * 3;
    const priceColumn = quantityColumn + 1;
    return [
      Number(order[product.quantity] || 0),
      Number(order[product.price] || 0),
      `=${colToA1(quantityColumn - 1)}${rowNumber}*${colToA1(priceColumn - 1)}${rowNumber}`,
    ];
  });
  const productAmountColumns = products.map((_, index) => 5 + index * 3);
  const moneyStartColumn = 3 + products.length * 3;
  const extraCells = extras.map((column, index) => {
    if (column.key === "subtotal" && productAmountColumns.length) {
      return `=${productAmountColumns.map((amountColumn) => `${colToA1(amountColumn - 1)}${rowNumber}`).join("+")}`;
    }
    if (column.key === "debt") {
      const columnFor = (key) => {
        const offset = extras.findIndex((item) => item.key === key);
        return offset === -1 ? null : moneyStartColumn + offset;
      };
      const addends = [columnFor("subtotal"), columnFor("tax"), columnFor("advance")]
        .filter(Boolean)
        .map((item) => `${colToA1(item - 1)}${rowNumber}`);
      const paidColumn = columnFor("paid");
      const paidTerm = paidColumn ? `${colToA1(paidColumn - 1)}${rowNumber}` : "0";
      return `=${addends.join("+") || "0"}-${paidTerm}`;
    }
    return column.value(order);
  });
  return [
    displayDate(order.date),
    Number(order.id || 0),
    ...productCells,
    ...extraCells,
  ];
}

function buildSheetValues({ unitName, customer, orders, payments }) {
  const products = usedProducts(normalizeBusinessUnit(customer.businessUnit), orders);
  const totals = totalsForOrders(orders);
  const extras = detailExtraColumns(orders, totals);
  const headers = detailHeaders(products, extras);
  const summaryHeaders = [
    "Số giao dịch",
    "Tiền hàng",
    ...(totals.tax > 0 ? ["Thuế"] : []),
    ...(totals.advance > 0 ? ["Ứng xe"] : []),
    "Đã trả",
    "Còn lại",
  ];
  const summaryValues = [
    orders.length,
    totals.subtotal,
    ...(totals.tax > 0 ? [totals.tax] : []),
    ...(totals.advance > 0 ? [totals.advance] : []),
    totals.paid,
    totals.debt,
  ];
  const detailTitleRow = 7;
  const detailHeaderRow = 9;
  const detailDataStartRow = 10;
  const rows = [
    [`Hồ sơ khách hàng - ${customer.TenKH}`],
    [`Mã khách: ${customer.MaKH}`, `Nhà xe: ${customer.NhaXeMacDinh || ""}`, `Phân hệ: ${unitName}`],
    [],
    summaryHeaders,
    summaryValues,
    [],
    ["Lịch sử giao dịch"],
    [`${orders.length} giao dịch`],
    headers,
    ...orders.map((order, index) => detailRow(order, products, extras, detailDataStartRow + index)),
  ];
  const paymentTitleRow = rows.length + 2;
  const paymentHeaderRow = rows.length + 3;
  const paymentDataStartRow = rows.length + 4;
  rows.push(
    [],
    ["Lịch sử thanh toán"],
    ["Ngày", "Số tiền", "Ghi chú", "Giao dịch được phân bổ"],
    ...payments.map((payment) => [
      displayDate(payment.date),
      Number(payment.amount || 0),
      payment.note || "",
      (payment.allocations || []).map((item) => `#${item.orderId}: ${Number(item.amount || 0).toLocaleString("vi-VN")} đ`).join("; "),
    ]),
  );
  return {
    rows,
    detailTitleRow,
    detailHeaderRow,
    detailDataStartRow,
    paymentTitleRow,
    paymentHeaderRow,
    paymentDataStartRow,
    headers,
    products,
    extras,
    totals,
  };
}

function moneyColumnRequests(sheetId, rowStartIndex, rowCount, columnIndexes) {
  return columnIndexes.map((columnIndex) => ({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowStartIndex,
        endRowIndex: rowStartIndex + rowCount,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      cell: {
        userEnteredFormat: {
          numberFormat: { type: "NUMBER", pattern: '#,##0" đ"' },
          horizontalAlignment: "RIGHT",
        },
      },
      fields: "userEnteredFormat(numberFormat,horizontalAlignment)",
    },
  }));
}

function quantityColumnRequests(sheetId, rowStartIndex, rowCount, columnIndexes) {
  return columnIndexes.map((columnIndex) => ({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: rowStartIndex,
        endRowIndex: rowStartIndex + rowCount,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      cell: {
        userEnteredFormat: {
          numberFormat: { type: "NUMBER", pattern: "#,##0.###" },
          horizontalAlignment: "RIGHT",
        },
      },
      fields: "userEnteredFormat(numberFormat,horizontalAlignment)",
    },
  }));
}

async function styleSheet({
  spreadsheetId,
  sheetId,
  detailTitleRow,
  detailHeaderRow,
  detailDataStartRow,
  paymentTitleRow,
  paymentHeaderRow,
  paymentDataStartRow,
  rowCount,
  columnCount,
  products,
  extras,
  summaryColumnCount,
}) {
  const moneyDetailColumns = [
    ...products.flatMap((_, index) => [3 + index * 3, 4 + index * 3]),
    ...extras.map((column, index) => (column.money ? 2 + products.length * 3 + index : null)).filter((index) => index !== null),
  ];
  const quantityDetailColumns = products.map((_, index) => 2 + index * 3);
  await batchUpdate([
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: Math.max(1, columnCount) },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.14, green: 0.42, blue: 0.35 },
            textFormat: { bold: true, fontSize: 14, foregroundColor: { red: 1, green: 1, blue: 1 } },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: summaryColumnCount },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.92, green: 0.96, blue: 0.94 },
            textFormat: { bold: true },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: detailTitleRow - 1, endRowIndex: detailTitleRow, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true, foregroundColor: { red: 0.14, green: 0.42, blue: 0.35 } } } },
        fields: "userEnteredFormat(textFormat)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: detailHeaderRow - 1, endRowIndex: detailHeaderRow, startColumnIndex: 0, endColumnIndex: Math.max(1, columnCount) },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.14, green: 0.42, blue: 0.35 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
            wrapStrategy: "WRAP",
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat,wrapStrategy)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: paymentTitleRow - 1, endRowIndex: paymentTitleRow, startColumnIndex: 0, endColumnIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true, foregroundColor: { red: 0.14, green: 0.42, blue: 0.35 } } } },
        fields: "userEnteredFormat(textFormat)",
      },
    },
    {
      repeatCell: {
        range: { sheetId, startRowIndex: paymentHeaderRow - 1, endRowIndex: paymentHeaderRow, startColumnIndex: 0, endColumnIndex: 4 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.14, green: 0.42, blue: 0.35 },
            textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          },
        },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      },
    },
    {
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: {
            frozenRowCount: detailHeaderRow,
            rowCount: Math.max(1000, rowCount + 20),
            columnCount: Math.max(40, columnCount + 2),
          },
        },
        fields: "gridProperties(frozenRowCount,rowCount,columnCount)",
      },
    },
    {
      autoResizeDimensions: {
        dimensions: {
          sheetId,
          dimension: "COLUMNS",
          startIndex: 0,
          endIndex: Math.max(1, columnCount),
        },
      },
    },
    ...moneyColumnRequests(sheetId, 4, 1, [...Array(summaryColumnCount).keys()].slice(1)),
    ...quantityColumnRequests(sheetId, detailDataStartRow - 1, Math.max(1, rowCount - detailDataStartRow + 1), quantityDetailColumns),
    ...moneyColumnRequests(sheetId, detailDataStartRow - 1, Math.max(1, rowCount - detailDataStartRow + 1), moneyDetailColumns),
    ...moneyColumnRequests(sheetId, paymentDataStartRow - 1, Math.max(1, rowCount - paymentDataStartRow + 1), [1]),
  ], spreadsheetId);
}

async function syncCustomerSheet({ businessUnit, unitName, customer, orders, payments }) {
  const title = spreadsheetTitle(customer);
  const tabTitle = "Hồ sơ";
  const folderId = String(process.env.GOOGLE_EXPORT_FOLDER_ID || "").trim();
  let spreadsheet;
  try {
    spreadsheet = folderId
      ? await createDriveSpreadsheet(title, folderId)
      : await createSpreadsheet(title, tabTitle);
  } catch (error) {
    const usingOAuth = hasOAuthCredentials();
    throw new Error(
      folderId
        ? `Google không cho tạo file Sheet mới trong GOOGLE_EXPORT_FOLDER_ID. ${usingOAuth ? "Hãy kiểm tra Gmail OAuth có quyền tạo file trong folder này và Drive còn dung lượng." : "Hãy share folder quyền Editor cho service account hoặc bỏ trống folder."} Chi tiết: ${error.message}`
        : `Google không cho tạo file Sheet mới. ${usingOAuth ? "Hãy kiểm tra Gmail OAuth còn dung lượng Drive và đã cấp quyền." : "GOOGLE_EXPORT_FOLDER_ID đang trống hoặc Drive của service account bị chặn. Hãy tạo một folder Google Drive, share Editor cho service account, rồi cấu hình GOOGLE_EXPORT_FOLDER_ID."} Chi tiết: ${error.message}`,
    );
  }
  const spreadsheetId = spreadsheet.spreadsheetId || spreadsheet.id;
  let sheetId = spreadsheet.sheets?.[0]?.properties?.sheetId;
  if (sheetId === undefined) {
    try {
      const sheets = await getSpreadsheetSheets(spreadsheetId);
      sheetId = sheets[0]?.properties?.sheetId || 0;
      const currentTitle = sheets[0]?.properties?.title || "";
      if (currentTitle && currentTitle !== tabTitle) {
        await batchUpdate([{
          updateSheetProperties: {
            properties: { sheetId, title: tabTitle },
            fields: "title",
          },
        }], spreadsheetId);
      }
    } catch (error) {
      throw new Error(`Google đã tạo file nhưng không đọc/đổi được tab mặc định: ${error.message}`);
    }
  }
  sheetId = sheetId || 0;
  const sheet = buildSheetValues({ businessUnit, unitName, customer, orders, payments });
  try {
    await batchUpdateValues([{
      range: `'${tabTitle}'!A1`,
      values: sheet.rows,
    }], spreadsheetId);
  } catch (error) {
    throw new Error(`Google đã tạo file nhưng không cho ghi dữ liệu: ${error.message}`);
  }
  const columnCount = Math.max(...sheet.rows.map((row) => row.length), 1);
  try {
    await styleSheet({
      spreadsheetId,
      sheetId,
      detailTitleRow: sheet.detailTitleRow,
      detailHeaderRow: sheet.detailHeaderRow,
      detailDataStartRow: sheet.detailDataStartRow,
      paymentTitleRow: sheet.paymentTitleRow,
      paymentHeaderRow: sheet.paymentHeaderRow,
      paymentDataStartRow: sheet.paymentDataStartRow,
      rowCount: sheet.rows.length,
      columnCount,
      products: sheet.products,
      extras: sheet.extras,
      summaryColumnCount: sheet.rows[3].length,
    });
  } catch (error) {
    throw new Error(`Google đã ghi dữ liệu nhưng không cho định dạng Sheet: ${error.message}`);
  }
  const warnings = [];
  const shareEmails = String(process.env.GOOGLE_EXPORT_SHARE_EMAILS || process.env.GOOGLE_EXPORT_SHARE_EMAIL || "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  if (shareEmails.length) {
    try {
      await shareDriveFile(spreadsheetId, shareEmails);
    } catch (error) {
      warnings.push(`Không share được file cho ${shareEmails.join(", ")}: ${error.message}`);
    }
  } else {
    warnings.push("File mới đã được tạo bởi service account. Hãy cấu hình GOOGLE_EXPORT_SHARE_EMAILS để tài khoản của bạn mở được link.");
  }
  return {
    title,
    spreadsheetId,
    sheetId,
    sharedWith: shareEmails,
    url: spreadsheetUrl(sheetId, spreadsheetId),
    warning: warnings.join("\n"),
  };
}

exports.handler = async (event) => {
  if (!["GET", "POST"].includes(event.httpMethod)) return jsonResponse(405, { error: "Method not allowed" });
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
    const result = await syncCustomerSheet({ businessUnit, unitName, customer, orders, payments });
    return jsonResponse(200, {
      ok: true,
      sheetTitle: result.title,
      spreadsheetId: result.spreadsheetId,
      sheetId: result.sheetId,
      sharedWith: result.sharedWith,
      url: result.url,
      warning: result.warning,
    });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(500, { error: error.message });
  }
};
