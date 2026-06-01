// Import các hàm dùng chung từ _sheets.js.
const {
  // Kiểm tra email người nhập có được cấp quyền không.
  assertAllowedUser,
  // Gọi Google Sheets batchUpdate để chèn dòng/copy format/công thức.
  batchUpdate,
  // Ghi giá trị vào nhiều ô/range cùng lúc.
  batchUpdateValues,
  // Đổi số thứ tự cột sang chữ A1, ví dụ 0 -> A.
  colToA1,
  // Đổi ngày thành số yyyymmdd để so thứ tự.
  dateKey,
  // Tìm dòng tiêu đề trong Sheet.
  findHeader,
  // Lấy sheetId nội bộ của tab để chèn dòng.
  getSheetIdByTitle,
  // Đọc dữ liệu từ Google Sheet.
  getValues,
  // Kiểm tra ô trống.
  isBlank,
  // Tạo response JSON cho frontend.
  jsonResponse,
  // Chuẩn hóa ngày để so sánh cùng một ngày.
  normalizeDate,
  // Chuẩn hóa text để so tên cột/mã khách.
  normalizeText,
  // Chuyển input số lượng thành number hợp lệ.
  parseNumber,
  // Tạo range dạng 'Tên Tab'!A1.
  sheetRange,
  // Đổi yyyy-mm-dd thành d/m/yy cho Sheet.
  toSheetDate,
  // Tính thứ T2/T3/CN từ ngày.
  weekdayForSheet,
} = require("./_sheets");
// Import auth để chỉ tài khoản đã đăng nhập mới được ghi Sheet.
const { authErrorResponse, requireAuth } = require("./_auth");

// Tab chính bắt buộc phải có 2 cột này để tìm block khách.
const MAIN_REQUIRED_HEADERS = ["Ngày Đặt", "Tên KH"];
// Tab DanhSachKhach bắt buộc phải có 2 cột này.
const CUSTOMER_REQUIRED_HEADERS = ["MaKH", "TenKH"];

// Map tên field trong code sang các tên cột có thể xuất hiện trong Google Sheet.
const fieldToHeader = {
  // Cột ngày đặt.
  orderDate: ["Ngày Đặt"],
  // Cột thứ, hiện sheet của anh dùng Stt nhưng cũng hỗ trợ Thứ.
  weekday: ["Stt", "Thứ"],
  // Cột giá mì.
  priceMi: ["Giá Mì", "Gia Mi", "Mì", "Mi"],
  // Cột giá da cảo.
  priceCao: ["Giá Da Cảo", "Gia Da Cao", "Da Cảo", "Da Cao"],
  // Cột giá da hoành.
  priceHoanh: ["Giá Da Hoành", "Gia Da Hoanh", "Da Hoành", "Da Hoanh"],
  // Cột tên khách hàng.
  customerName: ["Tên KH"],
  // Cột số lượng mì kg.
  miKg: ["Mì (kg)", "Mi (kg)"],
  // Cột số lượng da cảo kg.
  caoKg: ["Da Cảo (kg)", "Da Cao (kg)", "Da Cảo", "Da Cao"],
  // Cột số lượng da hoành kg.
  hoanhKg: ["Da Hoành Thành (kg)", "Da Hoanh Thanh (kg)", "Da Hoành Thánh (kg)", "Da Hoanh Thánh (kg)", "Da Hoành Thánh", "Da Hoanh Thanh"],
  // Cột hủ tiếu.
  huTieu: ["Hủ Tiếu", "Hu Tieu"],
  // Cột vỏ bánh gối.
  voBanhGoi: ["Vỏ bánh gối", "Vo banh goi"],
  // Cột tiền ứng.
  tienUng: ["Tiền ứng", "Tien ung", "Tiền Ứng KH", "Tien Ung KH"],
  // Cột thùng xốp.
  thungXop: ["Thùng Xốp", "Thung Xop"],
  // Cột nhà xe.
  nhaXe: ["Nhà xe", "Nha xe"],
  // Cột ghi chú.
  ghiChu: ["Ghi chú", "Ghi chu"],
};

// Những field này được xem là số lượng; dùng để biết dòng đã có dữ liệu chưa.
const quantityFields = ["miKg", "caoKg", "hoanhKg", "huTieu", "voBanhGoi"];

// Tìm cột theo tên header, có thể ưu tiên cột nằm sau một vị trí nào đó.
function findColumnInHeaderRow(headerRow, aliases, preferAfter = -1) {
  // Chuẩn hóa các tên cột có thể chấp nhận.
  const normalizedAliases = aliases.map(normalizeText);
  // Danh sách index cột match tên.
  const matches = [];
  // Duyệt toàn bộ dòng header.
  headerRow.forEach((label, index) => {
    // Nếu tên cột nằm trong alias thì lưu index.
    if (normalizedAliases.includes(normalizeText(label))) {
      matches.push(index);
    }
  });

  // Ưu tiên cột nằm sau preferAfter, nếu không có thì lấy match đầu tiên.
  return matches.find((index) => index > preferAfter) ?? matches[0];
}

// Tìm cột nằm sau một cột khác, dùng cho cột số lượng sau Tên KH.
function findColumnAfter(headerRow, aliases, afterIndex) {
  // Chuẩn hóa tên cột.
  const normalizedAliases = aliases.map(normalizeText);
  // Tìm cột đầu tiên nằm sau afterIndex và có tên hợp lệ.
  return headerRow.findIndex((label, index) => {
    return index > afterIndex && normalizedAliases.includes(normalizeText(label));
  });
}

// Tìm cột nằm giữa 2 cột khác, dùng cho các cột giá trước Tên KH.
function findColumnBetween(headerRow, aliases, afterIndex, beforeIndex) {
  // Chuẩn hóa tên cột.
  const normalizedAliases = aliases.map(normalizeText);
  // Tìm cột trong khoảng afterIndex < cột < beforeIndex.
  const index = headerRow.findIndex((label, columnIndex) => {
    return columnIndex > afterIndex && columnIndex < beforeIndex && normalizedAliases.includes(normalizeText(label));
  });
  // Nếu không thấy thì trả undefined thay vì -1.
  return index === -1 ? undefined : index;
}

// Chuyển -1 thành undefined cho cột không bắt buộc.
function optionalColumn(index) {
  return index === -1 ? undefined : index;
}

// Lấy ô trong một dòng, nếu cột không tồn tại thì trả rỗng.
function getCell(row, columnIndex) {
  return columnIndex === undefined ? "" : row[columnIndex] || "";
}

// Tìm thông tin khách trong tab DanhSachKhach dựa trên mã khách.
function findCustomer(customersValues, code) {
  // Tìm dòng header của tab DanhSachKhach.
  const { headerRowIndex, header } = findHeader(customersValues, CUSTOMER_REQUIRED_HEADERS);
  // Index cột MaKH.
  const codeColumn = header[normalizeText("MaKH")];
  // Index cột TenKH.
  const nameColumn = header[normalizeText("TenKH")];
  // Index cột GiaMi.
  const priceMiColumn = header[normalizeText("GiaMi")];
  // Index cột GiaCao.
  const priceCaoColumn = header[normalizeText("GiaCao")];
  // Index cột GiaHoanh.
  const priceHoanhColumn = header[normalizeText("GiaHoanh")];
  // Index cột NhaXeMacDinh.
  const defaultTruckColumn = header[normalizeText("NhaXeMacDinh")];
  // Index cột TrangThai.
  const statusColumn = header[normalizeText("TrangThai")];

  // Tìm dòng khách có mã trùng và không inactive.
  const customer = customersValues.slice(headerRowIndex + 1).find((row) => {
    // Nếu TrangThai trống thì hiểu là active.
    const active = normalizeText(getCell(row, statusColumn) || "active") !== "inactive";
    // So mã khách đã chuẩn hóa.
    return active && normalizeText(getCell(row, codeColumn)) === normalizeText(code);
  });

  // Không tìm thấy mã khách thì báo lỗi.
  if (!customer) {
    throw new Error("Không tìm thấy mã khách trong tab DanhSachKhach.");
  }

  // Trả object khách với thông tin cần dùng để ghi vào tab chính.
  return {
    code: getCell(customer, codeColumn),
    name: getCell(customer, nameColumn),
    priceMi: getCell(customer, priceMiColumn),
    priceCao: getCell(customer, priceCaoColumn),
    priceHoanh: getCell(customer, priceHoanhColumn),
    defaultTruck: getCell(customer, defaultTruckColumn),
  };
}

// Tìm block dòng của một khách trong tab Tiền Khách Nợ.
function findCustomerBlock(values, headerRowIndex, nameColumn, customerName) {
  // Tìm dòng đầu tiên có tên khách trùng.
  let start = -1;
  // Duyệt từ dưới header đến hết dữ liệu.
  for (let i = headerRowIndex + 1; i < values.length; i += 1) {
    // Nếu cột tên khách trùng customerName thì đây là đầu block.
    if (normalizeText(getCell(values[i], nameColumn)) === normalizeText(customerName)) {
      start = i;
      break;
    }
  }

  // Nếu không có dòng nào thì nghĩa là khách chưa có block trong tab chính.
  if (start === -1) {
    throw new Error(`Không tìm thấy block khách "${customerName}" trong tab chính.`);
  }

  // Block kéo dài tới ngay trước khách kế tiếp.
  // Các dòng trống bên dưới khách hiện tại vẫn được xem là thuộc block của khách đó.
  let end = values.length - 1;
  for (let i = start + 1; i < values.length; i += 1) {
    // Lấy tên khách ở dòng đang xét.
    const rowCustomerName = normalizeText(getCell(values[i], nameColumn));
    // Dòng trống tên khách thì vẫn thuộc block hiện tại.
    if (!rowCustomerName) {
      continue;
    }
    // Nếu gặp tên khách khác thì block hiện tại kết thúc ở dòng phía trên.
    if (rowCustomerName !== normalizeText(customerName)) {
      end = i - 1;
      break;
    }
  }

  // Block bắt đầu ở dòng đầu tiên của khách và kết thúc trước khách kế tiếp.
  return {
    start,
    end,
  };
}

// Kiểm tra dòng đã có số lượng chưa.
function rowHasQuantity(row, columns) {
  // Nếu bất kỳ field số lượng nào không trống thì xem như đã có dữ liệu.
  return quantityFields.some((field) => !isBlank(getCell(row, columns[field])));
}

// Tìm dòng đích để ghi đơn hàng.
function findTargetRow(values, block, columns, sheetDate) {
  // Lấy index cột ngày đặt.
  const dateColumn = columns.orderDate;
  // Đổi ngày cần ghi thành số để so thứ tự.
  const targetDateKey = dateKey(sheetDate);

  // Bước 1: nếu đã có đúng ngày trong block thì xử lý dòng đó.
  for (let i = block.start; i <= block.end; i += 1) {
    // Lấy dòng hiện tại.
    const row = values[i] || [];
    // So ngày hiện tại với ngày cần ghi.
    if (normalizeDate(getCell(row, dateColumn)) === normalizeDate(sheetDate)) {
      // Nếu dòng đã có số lượng thì không ghi đè.
      if (rowHasQuantity(row, columns)) {
        throw new Error("Ngày này đã có dữ liệu rồi. Tool không ghi đè, anh kiểm tra Google Sheet nhé.");
      }
      // Nếu có ngày nhưng chưa có số lượng thì ghi vào dòng đó.
      return { rowIndex: i, shouldInsert: false };
    }
  }

  // Bước 2: nếu nhập bù ngày cũ thì chèn lên trước ngày mới hơn.
  if (targetDateKey !== null) {
    // Duyệt từng dòng trong block.
    for (let i = block.start; i <= block.end; i += 1) {
      // Lấy dòng hiện tại.
      const row = values[i] || [];
      // Đổi ngày của dòng hiện tại thành số.
      const currentDateKey = dateKey(getCell(row, dateColumn));
      // Nếu dòng hiện tại là ngày mới hơn ngày cần ghi.
      if (currentDateKey !== null && currentDateKey > targetDateKey) {
        // Chèn dòng mới tại vị trí này để giữ thứ tự thời gian.
        return {
          rowIndex: i,
          shouldInsert: true,
          copyFromRowIndex: i > block.start ? i - 1 : i,
          copyFromAfterInsert: i === block.start,
        };
      }
    }
  }

  // Bước 3: nếu không cần chèn giữa, tìm dòng trống trong block.
  for (let i = block.start; i <= block.end; i += 1) {
    // Lấy dòng hiện tại.
    const row = values[i] || [];
    // Dòng trống là chưa có ngày và chưa có số lượng.
    const isEmptyOrderRow = isBlank(getCell(row, dateColumn)) && !rowHasQuantity(row, columns);
    // Nếu tìm thấy dòng trống thì ghi vào đó.
    if (isEmptyOrderRow) {
      return { rowIndex: i, shouldInsert: false };
    }
  }

  // Bước 4: hết dòng trống thì chèn thêm ở cuối block.
  return { rowIndex: block.end + 1, shouldInsert: true, copyFromRowIndex: block.end };
}

// Tạo danh sách ô cần ghi vào tab chính.
function buildUpdates({ payload, customer, columns, sheetName, rowIndex, sheetDate }) {
  // Google Sheet dùng dòng 1-based, còn array dùng 0-based.
  const rowNumber = rowIndex + 1;
  // Danh sách update sẽ gửi cho Google.
  const updates = [];

  // Hàm nhỏ để thêm một ô cần ghi.
  function add(field, value) {
    // Lấy index cột theo field.
    const columnIndex = columns[field];
    // Nếu cột không tồn tại hoặc value undefined thì bỏ qua.
    if (columnIndex === undefined || value === undefined) {
      return;
    }
    // Thêm range và value vào danh sách update.
    updates.push({
      range: sheetRange(sheetName, `${colToA1(columnIndex)}${rowNumber}`),
      values: [[value]],
    });
  }

  // Ghi ngày đặt.
  add("orderDate", sheetDate);
  // Ghi thứ T2/T3/CN.
  add("weekday", weekdayForSheet(payload.orderDate));
  // Ghi giá mì từ DanhSachKhach.
  add("priceMi", customer.priceMi);
  // Ghi giá da cảo từ DanhSachKhach.
  add("priceCao", customer.priceCao);
  // Ghi giá da hoành từ DanhSachKhach.
  add("priceHoanh", customer.priceHoanh);
  // Ghi tên khách.
  add("customerName", customer.name);
  // Ghi số kg mì.
  add("miKg", parseNumber(payload.miKg));
  // Ghi số kg da cảo.
  add("caoKg", parseNumber(payload.caoKg));
  // Ghi số kg da hoành.
  add("hoanhKg", parseNumber(payload.hoanhKg));
  // Ghi hủ tiếu nếu có.
  add("huTieu", parseNumber(payload.huTieu));
  // Ghi vỏ bánh gối nếu có.
  add("voBanhGoi", parseNumber(payload.voBanhGoi));
  // Ghi tiền ứng nếu có.
  add("tienUng", parseNumber(payload.tienUng));
  // Ghi thùng xốp nếu có.
  add("thungXop", parseNumber(payload.thungXop));
  // Ghi nhà xe, ưu tiên người dùng nhập, nếu trống thì dùng mặc định.
  add("nhaXe", payload.nhaXe || customer.defaultTruck || "");
  // Ghi ghi chú nếu có.
  add("ghiChu", payload.ghiChu || "");

  // Trả danh sách update cho hàm gọi Google.
  return updates;
}

// Ghi nhật ký vào tab LichSuNhap.
async function appendLog(payload, customer, status) {
  // Lấy tên tab log từ env hoặc dùng mặc định.
  const sheetName = process.env.LOG_SHEET_NAME || "LichSuNhap";
  // Đọc một phần tab log để tìm header và biết dòng cuối.
  const values = await getValues(sheetName, "A1:O5000");
  // Tìm header bắt buộc.
  const { header } = findHeader(values, ["ThoiGian", "MaKH", "TenKH"]);
  // Tạo row log dạng array.
  const row = [];

  // Hàm nhỏ để set giá trị theo tên cột log.
  function set(label, value) {
    // Tìm index cột log.
    const index = header[normalizeText(label)];
    // Nếu có cột thì ghi value vào đúng vị trí.
    if (index !== undefined) {
      row[index] = value;
    }
  }

  // Ghi thời gian nhập theo giờ Việt Nam.
  set("ThoiGian", new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }));
  // Ghi email người nhập.
  set("EmailNguoiNhap", payload.userEmail || "");
  // Ghi mã khách.
  set("MaKH", customer.code);
  // Ghi tên khách.
  set("TenKH", customer.name);
  // Ghi ngày đặt.
  set("Ngay", toSheetDate(payload.orderDate));
  // Ghi mì kg.
  set("MiKg", parseNumber(payload.miKg));
  // Ghi da cảo kg.
  set("CaoKg", parseNumber(payload.caoKg));
  // Ghi da hoành kg.
  set("HoanhKg", parseNumber(payload.hoanhKg));
  // Ghi hủ tiếu.
  set("HuTieu", parseNumber(payload.huTieu));
  // Ghi vỏ bánh gối.
  set("VoBanhGoi", parseNumber(payload.voBanhGoi));
  // Ghi tiền ứng.
  set("TienUng", parseNumber(payload.tienUng));
  // Ghi thùng xốp.
  set("ThungXop", parseNumber(payload.thungXop));
  // Ghi nhà xe.
  set("NhaXe", payload.nhaXe || customer.defaultTruck || "");
  // Ghi ghi chú.
  set("GhiChu", payload.ghiChu || "");
  // Ghi trạng thái: inserted hoặc updated_blank_row.
  set("TrangThai", status);

  // Ghi dòng log vào dòng tiếp theo của tab LichSuNhap.
  await batchUpdateValues([
    {
      range: sheetRange(sheetName, `A${values.length + 1}:O${values.length + 1}`),
      values: [row],
    },
  ]);
}

// Handler chính của Netlify Function /api/orders.
exports.handler = async (event) => {
  // Chỉ cho phép POST, không cho GET.
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    // Parse body JSON từ frontend.
    const payload = JSON.parse(event.body || "{}");
    // Kiểm tra token đăng nhập trước khi xử lý dữ liệu.
    const sessionUser = requireAuth(event);
    // Email log lấy từ tài khoản đăng nhập, không lấy từ input người dùng tự gõ.
    payload.userEmail = sessionUser.email || sessionUser.username;
    // Kiểm tra email người nhập có quyền không.
    assertAllowedUser(payload.userEmail);

    // Tên tab chính chứa bảng tiền khách nợ.
    const mainSheetName = process.env.MAIN_SHEET_NAME || "Tiền Khách Nợ";
    // Tên tab danh sách khách.
    const customersSheetName = process.env.CUSTOMERS_SHEET_NAME || "DanhSachKhach";
    // Đọc song song tab chính và tab danh sách khách.
    const [mainValues, customersValues] = await Promise.all([
      getValues(mainSheetName, "A1:Z5000"),
      getValues(customersSheetName, "A1:G2000"),
    ]);

    // Tìm khách dựa trên mã khách người dùng nhập.
    const customer = findCustomer(customersValues, payload.customerCode);
    // Tìm dòng header trong tab chính.
    const { headerRowIndex } = findHeader(mainValues, MAIN_REQUIRED_HEADERS);
    // Lấy toàn bộ dòng header.
    const headerRow = mainValues[headerRowIndex] || [];
    // Object lưu vị trí cột của từng field.
    const columns = {};
    // Tìm sơ bộ các cột theo tên header.
    Object.entries(fieldToHeader).forEach(([field, aliases]) => {
      columns[field] = findColumnInHeaderRow(headerRow, aliases);
    });

    // Nếu thiếu Ngày Đặt hoặc Tên KH thì không thể tìm block khách.
    if (columns.orderDate === undefined || columns.customerName === undefined) {
      throw new Error("Tab chính thiếu cột Ngày Đặt hoặc Tên KH.");
    }

    // Tìm cột giá mì nằm trước Tên KH.
    columns.priceMi = findColumnBetween(headerRow, fieldToHeader.priceMi, columns.weekday ?? -1, columns.customerName);
    // Tìm cột giá da cảo nằm sau giá mì và trước Tên KH.
    columns.priceCao = findColumnBetween(headerRow, fieldToHeader.priceCao, columns.priceMi ?? -1, columns.customerName);
    // Tìm cột giá da hoành nằm sau giá da cảo và trước Tên KH.
    columns.priceHoanh = findColumnBetween(headerRow, fieldToHeader.priceHoanh, columns.priceCao ?? -1, columns.customerName);
    // Tìm cột mì kg nằm sau Tên KH.
    columns.miKg = optionalColumn(findColumnAfter(headerRow, fieldToHeader.miKg, columns.customerName));
    // Tìm cột da cảo kg nằm sau mì kg.
    columns.caoKg = optionalColumn(findColumnAfter(headerRow, fieldToHeader.caoKg, columns.miKg));
    // Tìm cột da hoành kg nằm sau da cảo kg.
    columns.hoanhKg = optionalColumn(findColumnAfter(headerRow, fieldToHeader.hoanhKg, columns.caoKg));
    // Tìm cột hủ tiếu nằm sau da hoành kg.
    columns.huTieu = optionalColumn(findColumnAfter(headerRow, fieldToHeader.huTieu, columns.hoanhKg));
    // Tìm cột vỏ bánh gối nằm sau hủ tiếu.
    columns.voBanhGoi = optionalColumn(findColumnAfter(headerRow, fieldToHeader.voBanhGoi, columns.huTieu));

    // Mì kg và da cảo kg là 2 cột quan trọng, thiếu thì báo lỗi.
    if (columns.miKg === undefined || columns.caoKg === undefined) {
      throw new Error("Không tìm thấy đúng cột Mì kg / Da Cảo kg sau cột Tên KH.");
    }

    // Đổi ngày từ website sang dạng Sheet.
    const sheetDate = toSheetDate(payload.orderDate);
    // Tìm block khách trong tab chính.
    const block = findCustomerBlock(mainValues, headerRowIndex, columns.customerName, customer.name);
    // Tìm dòng cần ghi hoặc vị trí cần chèn.
    const target = findTargetRow(mainValues, block, columns, sheetDate);

    // Nếu cần chèn dòng mới.
    if (target.shouldInsert) {
      // Lấy sheetId nội bộ của tab chính.
      const sheetId = await getSheetIdByTitle(mainSheetName);
      // Nếu chèn ngay đầu block thì sau khi chèn, dòng mẫu bị đẩy xuống rowIndex + 1.
      const copySourceRowIndex = target.copyFromAfterInsert ? target.rowIndex + 1 : target.copyFromRowIndex;
      // Gửi batchUpdate gồm chèn dòng + copy format/công thức/dropdown.
      await batchUpdate([
        {
          // Chèn một dòng mới.
          insertDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: target.rowIndex,
              endIndex: target.rowIndex + 1,
            },
            // Kế thừa format từ dòng phía trước.
            inheritFromBefore: true,
          },
        },
        {
          // Copy format từ dòng mẫu.
          copyPaste: {
            source: {
              sheetId,
              startRowIndex: copySourceRowIndex,
              endRowIndex: copySourceRowIndex + 1,
              startColumnIndex: 0,
              endColumnIndex: 26,
            },
            destination: {
              sheetId,
              startRowIndex: target.rowIndex,
              endRowIndex: target.rowIndex + 1,
              startColumnIndex: 0,
              endColumnIndex: 26,
            },
            pasteType: "PASTE_FORMAT",
          },
        },
        {
          // Copy công thức để cột Chưa Thanh Toán/Còn lại tự tính.
          copyPaste: {
            source: {
              sheetId,
              startRowIndex: copySourceRowIndex,
              endRowIndex: copySourceRowIndex + 1,
              startColumnIndex: 0,
              endColumnIndex: 26,
            },
            destination: {
              sheetId,
              startRowIndex: target.rowIndex,
              endRowIndex: target.rowIndex + 1,
              startColumnIndex: 0,
              endColumnIndex: 26,
            },
            pasteType: "PASTE_FORMULA",
          },
        },
        {
          // Copy dropdown/data validation, ví dụ nhà xe nếu có dropdown.
          copyPaste: {
            source: {
              sheetId,
              startRowIndex: copySourceRowIndex,
              endRowIndex: copySourceRowIndex + 1,
              startColumnIndex: 0,
              endColumnIndex: 26,
            },
            destination: {
              sheetId,
              startRowIndex: target.rowIndex,
              endRowIndex: target.rowIndex + 1,
              startColumnIndex: 0,
              endColumnIndex: 26,
            },
            pasteType: "PASTE_DATA_VALIDATION",
          },
        },
      ]);
    }

    // Tạo danh sách ô cần ghi vào tab chính.
    const updates = buildUpdates({
      payload,
      customer,
      columns,
      sheetName: mainSheetName,
      rowIndex: target.rowIndex,
      sheetDate,
    });

    // Ghi dữ liệu vào tab chính.
    await batchUpdateValues(updates);
    // Ghi lịch sử vào tab LichSuNhap.
    await appendLog(payload, customer, target.shouldInsert ? "inserted" : "updated_blank_row");

    // Trả kết quả thành công về frontend.
    return jsonResponse(200, {
      ok: true,
      customerName: customer.name,
      rowNumber: target.rowIndex + 1,
      inserted: target.shouldInsert,
    });
  } catch (error) {
    // Lỗi auth trả 401 để frontend có thể đưa người dùng về màn hình login.
    if (error.message.includes("đăng nhập") || error.message.includes("Phiên đăng nhập")) {
      return authErrorResponse(error);
    }
    // Trả lỗi về frontend để hiện dưới nút Lưu.
    return jsonResponse(400, { error: error.message });
  }
};
