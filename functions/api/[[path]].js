const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";
const PASSWORD_SALT = "nhap-lieu-mi-v1";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const USERS = [
  {
    username: "admin",
    displayName: "Admin",
    role: "admin",
    email: "admin@noi-bo.local",
    passwordHash: "f7c06128217e70cb4a0c42dbd9d860dc5b6ffb763309216bd6b83431a40d6c77",
  },
  {
    username: "nhanvien",
    displayName: "Nhân viên",
    role: "staff",
    email: "nhanvien@noi-bo.local",
    passwordHash: "4db228f47130c8c6a6e90ae746f486e18047dd66933f08ae381ad13fa18e4a5b",
  },
];

const MAIN_REQUIRED_HEADERS = ["Ngày Đặt", "Tên KH"];
const CUSTOMER_REQUIRED_HEADERS = ["MaKH", "TenKH"];
const CUSTOMER_COLUMNS = ["MaKH", "TenKH", "GiaMi", "GiaCao", "GiaHoanh", "NhaXeMacDinh", "TrangThai"];
const quantityFields = ["miKg", "caoKg", "hoanhKg", "huTieu", "voBanhGoi"];

const fieldToHeader = {
  orderDate: ["Ngày Đặt"],
  weekday: ["Stt", "Thứ"],
  priceMi: ["Giá Mì", "Gia Mi", "Mì", "Mi"],
  priceCao: ["Giá Da Cảo", "Gia Da Cao", "Da Cảo", "Da Cao"],
  priceHoanh: ["Giá Da Hoành", "Gia Da Hoanh", "Da Hoành", "Da Hoanh"],
  customerName: ["Tên KH"],
  miKg: ["Mì (kg)", "Mi (kg)"],
  caoKg: ["Da Cảo (kg)", "Da Cao (kg)", "Da Cảo", "Da Cao"],
  hoanhKg: ["Da Hoành Thành (kg)", "Da Hoanh Thanh (kg)", "Da Hoành Thánh (kg)", "Da Hoanh Thánh (kg)", "Da Hoành Thánh", "Da Hoanh Thanh"],
  huTieu: ["Hủ Tiếu", "Hu Tieu"],
  voBanhGoi: ["Vỏ bánh gối", "Vo banh goi"],
  tienUng: ["Tiền ứng", "Tien ung", "Tiền Ứng KH", "Tien Ung KH"],
  thungXop: ["Thùng Xốp", "Thung Xop"],
  nhaXe: ["Nhà xe", "Nha xe"],
  ghiChu: ["Ghi chú", "Ghi chu"],
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function encodeBase64Url(input) {
  const text = typeof input === "string" ? input : String.fromCharCode(...new Uint8Array(input));
  return btoa(text).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(input) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  return atob(base64);
}

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hashPassword(password) {
  return sha256Hex(`${PASSWORD_SALT}|${password}`);
}

async function hmacSign(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encodeBase64Url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

async function createSessionToken(env, user) {
  const payload = {
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    email: user.email,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = await hmacSign(env.APP_AUTH_SECRET || "doi-secret-nay-khi-deploy", encodedPayload);
  return `${encodedPayload}.${signature}`;
}

async function verifySessionToken(env, token) {
  if (!token || !token.includes(".")) {
    throw new Error("Vui lòng đăng nhập trước khi ghi nhận số lượng.");
  }

  const [encodedPayload, signature] = token.split(".");
  const expectedSignature = await hmacSign(env.APP_AUTH_SECRET || "doi-secret-nay-khi-deploy", encodedPayload);
  if (signature !== expectedSignature) {
    throw new Error("Phiên đăng nhập không hợp lệ.");
  }

  const payload = JSON.parse(decodeBase64Url(encodedPayload));
  if (!payload.exp || payload.exp < Date.now()) {
    throw new Error("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.");
  }
  return payload;
}

async function requireAuth(env, request) {
  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return verifySessionToken(env, token);
}

function requiredEnv(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

function normalizePrivateKey(key) {
  return String(key).replace(/^"|"$/g, "").replace(/\\n/g, "\n");
}

function pemToArrayBuffer(pem) {
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function getAccessToken(env) {
  const email = requiredEnv(env, "GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKey = normalizePrivateKey(requiredEnv(env, "GOOGLE_PRIVATE_KEY"));
  const now = Math.floor(Date.now() / 1000);
  const unsignedToken = `${encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${encodeBase64Url(JSON.stringify({
    iss: email,
    scope: SCOPES.join(" "),
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now,
  }))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsignedToken));
  const jwt = `${unsignedToken}.${encodeBase64Url(signature)}`;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Google auth failed");
  }
  return data.access_token;
}

async function googleRequest(env, path, options = {}) {
  const token = await getAccessToken(env);
  const response = await fetch(`${SHEETS_URL}/${requiredEnv(env, "GOOGLE_SHEET_ID")}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.error?.message || `Google Sheets request failed: ${response.status}`);
  }
  return data;
}

function sheetRange(sheetName, range) {
  return `'${String(sheetName).replace(/'/g, "''")}'!${range}`;
}

async function getValues(env, sheetName, range = "A1:Z5000") {
  const path = `/values/${encodeURIComponent(sheetRange(sheetName, range))}?majorDimension=ROWS`;
  const data = await googleRequest(env, path);
  return data.values || [];
}

async function batchUpdateValues(env, data) {
  return googleRequest(env, "/values:batchUpdate", {
    method: "POST",
    body: JSON.stringify({ valueInputOption: "USER_ENTERED", data }),
  });
}

async function batchUpdate(env, requests) {
  return googleRequest(env, ":batchUpdate", {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

async function getSheetIdByTitle(env, title) {
  const data = await googleRequest(env, "?fields=sheets(properties(sheetId,title))");
  const sheet = data.sheets.find((item) => item.properties.title === title);
  if (!sheet) {
    throw new Error(`Không tìm thấy tab "${title}" trong Google Sheet.`);
  }
  return sheet.properties.sheetId;
}

function findHeader(values, requiredLabels) {
  const normalized = requiredLabels.map(normalizeText);
  const index = values.findIndex((row) => {
    const rowText = row.map(normalizeText);
    return normalized.every((label) => rowText.includes(label));
  });
  if (index === -1) {
    throw new Error(`Không tìm thấy dòng tiêu đề có: ${requiredLabels.join(", ")}`);
  }

  const header = {};
  values[index].forEach((label, columnIndex) => {
    const key = normalizeText(label);
    if (key && header[key] === undefined) {
      header[key] = columnIndex;
    }
  });
  return { headerRowIndex: index, header };
}

function colToA1(index) {
  let column = "";
  let n = index + 1;
  while (n > 0) {
    const mod = (n - 1) % 26;
    column = String.fromCharCode(65 + mod) + column;
    n = Math.floor((n - mod) / 26);
  }
  return column;
}

function parseNumber(value) {
  const raw = String(value || "").trim().replace(",", ".");
  if (!raw) {
    return "";
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Số lượng không hợp lệ: ${value}`);
  }
  return parsed;
}

function isBlank(value) {
  return String(value || "").trim() === "";
}

function toSheetDate(input) {
  if (!input) {
    throw new Error("Thiếu ngày đặt.");
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const [year, month, day] = input.split("-").map(Number);
    return `${day}/${month}/${String(year).slice(-2)}`;
  }
  return String(input).trim();
}

function normalizeDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) {
    return text;
  }
  return `${Number(match[1])}/${Number(match[2])}/${Number(match[3]) % 100}`;
}

function dateKey(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-").map(Number);
    return year * 10000 + month * 100 + day;
  }
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!match) {
    return null;
  }
  let year = Number(match[3]);
  if (year < 100) {
    year += 2000;
  }
  return year * 10000 + Number(match[2]) * 100 + Number(match[1]);
}

function weekdayForSheet(input) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input) ? new Date(`${input}T00:00:00+07:00`) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return "";
  }
  const day = date.getDay();
  return day === 0 ? "CN" : `T${day + 1}`;
}

function assertAllowedUser(env, email) {
  const allowed = String(env.ALLOWED_USERS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(String(email || "").trim().toLowerCase())) {
    throw new Error("Email này chưa được cấp quyền nhập liệu.");
  }
}

function findColumnInHeaderRow(headerRow, aliases, preferAfter = -1) {
  const normalizedAliases = aliases.map(normalizeText);
  const matches = [];
  headerRow.forEach((label, index) => {
    if (normalizedAliases.includes(normalizeText(label))) {
      matches.push(index);
    }
  });
  return matches.find((index) => index > preferAfter) ?? matches[0];
}

function findColumnAfter(headerRow, aliases, afterIndex) {
  const normalizedAliases = aliases.map(normalizeText);
  return headerRow.findIndex((label, index) => index > afterIndex && normalizedAliases.includes(normalizeText(label)));
}

function findColumnBetween(headerRow, aliases, afterIndex, beforeIndex) {
  const normalizedAliases = aliases.map(normalizeText);
  const index = headerRow.findIndex((label, columnIndex) => {
    return columnIndex > afterIndex && columnIndex < beforeIndex && normalizedAliases.includes(normalizeText(label));
  });
  return index === -1 ? undefined : index;
}

function optionalColumn(index) {
  return index === -1 ? undefined : index;
}

function getCell(row, columnIndex) {
  return columnIndex === undefined ? "" : row[columnIndex] || "";
}

function findCustomer(customersValues, code) {
  const { headerRowIndex, header } = findHeader(customersValues, CUSTOMER_REQUIRED_HEADERS);
  const codeColumn = header[normalizeText("MaKH")];
  const nameColumn = header[normalizeText("TenKH")];
  const priceMiColumn = header[normalizeText("GiaMi")];
  const priceCaoColumn = header[normalizeText("GiaCao")];
  const priceHoanhColumn = header[normalizeText("GiaHoanh")];
  const defaultTruckColumn = header[normalizeText("NhaXeMacDinh")];
  const statusColumn = header[normalizeText("TrangThai")];
  const customer = customersValues.slice(headerRowIndex + 1).find((row) => {
    const active = normalizeText(getCell(row, statusColumn) || "active") !== "inactive";
    return active && normalizeText(getCell(row, codeColumn)) === normalizeText(code);
  });
  if (!customer) {
    throw new Error("Không tìm thấy mã khách trong tab DanhSachKhach.");
  }
  return {
    code: getCell(customer, codeColumn),
    name: getCell(customer, nameColumn),
    priceMi: getCell(customer, priceMiColumn),
    priceCao: getCell(customer, priceCaoColumn),
    priceHoanh: getCell(customer, priceHoanhColumn),
    defaultTruck: getCell(customer, defaultTruckColumn),
  };
}

function findCustomerBlock(values, headerRowIndex, nameColumn, customerName) {
  let start = -1;
  for (let i = headerRowIndex + 1; i < values.length; i += 1) {
    if (normalizeText(getCell(values[i], nameColumn)) === normalizeText(customerName)) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    throw new Error(`Không tìm thấy block khách "${customerName}" trong tab chính.`);
  }

  let end = values.length - 1;
  for (let i = start + 1; i < values.length; i += 1) {
    const rowCustomerName = normalizeText(getCell(values[i], nameColumn));
    if (!rowCustomerName) {
      continue;
    }
    if (rowCustomerName !== normalizeText(customerName)) {
      end = i - 1;
      break;
    }
  }
  return { start, end };
}

function rowHasQuantity(row, columns) {
  return quantityFields.some((field) => !isBlank(getCell(row, columns[field])));
}

function findTargetRow(values, block, columns, sheetDate) {
  const dateColumn = columns.orderDate;
  const targetDateKey = dateKey(sheetDate);
  for (let i = block.start; i <= block.end; i += 1) {
    const row = values[i] || [];
    if (normalizeDate(getCell(row, dateColumn)) === normalizeDate(sheetDate)) {
      if (rowHasQuantity(row, columns)) {
        throw new Error("Ngày này đã có dữ liệu rồi. Tool không ghi đè, anh kiểm tra Google Sheet nhé.");
      }
      return { rowIndex: i, shouldInsert: false };
    }
  }

  if (targetDateKey !== null) {
    for (let i = block.start; i <= block.end; i += 1) {
      const currentDateKey = dateKey(getCell(values[i] || [], dateColumn));
      if (currentDateKey !== null && currentDateKey > targetDateKey) {
        return { rowIndex: i, shouldInsert: true, copyFromRowIndex: i > block.start ? i - 1 : i, copyFromAfterInsert: i === block.start };
      }
    }
  }

  for (let i = block.start; i <= block.end; i += 1) {
    const row = values[i] || [];
    if (isBlank(getCell(row, dateColumn)) && !rowHasQuantity(row, columns)) {
      return { rowIndex: i, shouldInsert: false };
    }
  }

  return { rowIndex: block.end + 1, shouldInsert: true, copyFromRowIndex: block.end };
}

function buildUpdates({ payload, customer, columns, sheetName, rowIndex, sheetDate }) {
  const rowNumber = rowIndex + 1;
  const updates = [];
  function add(field, value) {
    const columnIndex = columns[field];
    if (columnIndex === undefined || value === undefined) {
      return;
    }
    updates.push({ range: sheetRange(sheetName, `${colToA1(columnIndex)}${rowNumber}`), values: [[value]] });
  }

  add("orderDate", sheetDate);
  add("weekday", weekdayForSheet(payload.orderDate));
  add("priceMi", customer.priceMi);
  add("priceCao", customer.priceCao);
  add("priceHoanh", customer.priceHoanh);
  add("customerName", customer.name);
  add("miKg", parseNumber(payload.miKg));
  add("caoKg", parseNumber(payload.caoKg));
  add("hoanhKg", parseNumber(payload.hoanhKg));
  add("huTieu", parseNumber(payload.huTieu));
  add("voBanhGoi", parseNumber(payload.voBanhGoi));
  add("tienUng", parseNumber(payload.tienUng));
  add("thungXop", parseNumber(payload.thungXop));
  add("nhaXe", payload.nhaXe || customer.defaultTruck || "");
  add("ghiChu", payload.ghiChu || "");
  return updates;
}

async function appendLog(env, payload, customer, status) {
  const sheetName = env.LOG_SHEET_NAME || "LichSuNhap";
  const values = await getValues(env, sheetName, "A1:O5000");
  const { header } = findHeader(values, ["ThoiGian", "MaKH", "TenKH"]);
  const row = [];
  function set(label, value) {
    const index = header[normalizeText(label)];
    if (index !== undefined) {
      row[index] = value;
    }
  }
  set("ThoiGian", new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }));
  set("EmailNguoiNhap", payload.userEmail || "");
  set("MaKH", customer.code);
  set("TenKH", customer.name);
  set("Ngay", toSheetDate(payload.orderDate));
  set("MiKg", parseNumber(payload.miKg));
  set("CaoKg", parseNumber(payload.caoKg));
  set("HoanhKg", parseNumber(payload.hoanhKg));
  set("HuTieu", parseNumber(payload.huTieu));
  set("VoBanhGoi", parseNumber(payload.voBanhGoi));
  set("TienUng", parseNumber(payload.tienUng));
  set("ThungXop", parseNumber(payload.thungXop));
  set("NhaXe", payload.nhaXe || customer.defaultTruck || "");
  set("GhiChu", payload.ghiChu || "");
  set("TrangThai", status);
  await batchUpdateValues(env, [{ range: sheetRange(sheetName, `A${values.length + 1}:O${values.length + 1}`), values: [row] }]);
}

async function handleLogin(env, request) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  const payload = await request.json();
  const username = normalizeText(payload.username);
  const password = String(payload.password || "");
  const user = USERS.find((item) => normalizeText(item.username) === username);
  if (!user || user.passwordHash !== await hashPassword(password)) {
    return json({ error: "Sai tài khoản hoặc mật khẩu." }, 401);
  }
  const token = await createSessionToken(env, user);
  return json({
    token,
    user: {
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      email: user.email,
    },
  });
}

async function handleCustomers(env, request) {
  await requireAuth(env, request);
  const sheetName = env.CUSTOMERS_SHEET_NAME || "DanhSachKhach";
  const values = await getValues(env, sheetName, "A1:G2000");
  const { headerRowIndex, header } = findHeader(values, ["MaKH", "TenKH"]);
  const customers = values
    .slice(headerRowIndex + 1)
    .map((row) => {
      const customer = {};
      CUSTOMER_COLUMNS.forEach((column) => {
        const index = header[normalizeText(column)];
        customer[column] = index === undefined ? "" : row[index] || "";
      });
      return customer;
    })
    .filter((customer) => customer.MaKH && customer.TenKH)
    .filter((customer) => normalizeText(customer.TrangThai || "active") !== "inactive");
  return json({ customers });
}

async function handleOrders(env, request) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const payload = await request.json();
  const sessionUser = await requireAuth(env, request);
  payload.userEmail = sessionUser.email || sessionUser.username;
  assertAllowedUser(env, payload.userEmail);

  const mainSheetName = env.MAIN_SHEET_NAME || "Tiền Khách Nợ";
  const customersSheetName = env.CUSTOMERS_SHEET_NAME || "DanhSachKhach";
  const [mainValues, customersValues] = await Promise.all([
    getValues(env, mainSheetName, "A1:Z5000"),
    getValues(env, customersSheetName, "A1:G2000"),
  ]);

  const customer = findCustomer(customersValues, payload.customerCode);
  const { headerRowIndex } = findHeader(mainValues, MAIN_REQUIRED_HEADERS);
  const headerRow = mainValues[headerRowIndex] || [];
  const columns = {};
  Object.entries(fieldToHeader).forEach(([field, aliases]) => {
    columns[field] = findColumnInHeaderRow(headerRow, aliases);
  });

  if (columns.orderDate === undefined || columns.customerName === undefined) {
    throw new Error("Tab chính thiếu cột Ngày Đặt hoặc Tên KH.");
  }

  columns.priceMi = findColumnBetween(headerRow, fieldToHeader.priceMi, columns.weekday ?? -1, columns.customerName);
  columns.priceCao = findColumnBetween(headerRow, fieldToHeader.priceCao, columns.priceMi ?? -1, columns.customerName);
  columns.priceHoanh = findColumnBetween(headerRow, fieldToHeader.priceHoanh, columns.priceCao ?? -1, columns.customerName);
  columns.miKg = optionalColumn(findColumnAfter(headerRow, fieldToHeader.miKg, columns.customerName));
  columns.caoKg = optionalColumn(findColumnAfter(headerRow, fieldToHeader.caoKg, columns.miKg));
  columns.hoanhKg = optionalColumn(findColumnAfter(headerRow, fieldToHeader.hoanhKg, columns.caoKg));
  columns.huTieu = optionalColumn(findColumnAfter(headerRow, fieldToHeader.huTieu, columns.hoanhKg));
  columns.voBanhGoi = optionalColumn(findColumnAfter(headerRow, fieldToHeader.voBanhGoi, columns.huTieu));

  if (columns.miKg === undefined || columns.caoKg === undefined) {
    throw new Error("Không tìm thấy đúng cột Mì kg / Da Cảo kg sau cột Tên KH.");
  }

  const sheetDate = toSheetDate(payload.orderDate);
  const block = findCustomerBlock(mainValues, headerRowIndex, columns.customerName, customer.name);
  const target = findTargetRow(mainValues, block, columns, sheetDate);

  if (target.shouldInsert) {
    const sheetId = await getSheetIdByTitle(env, mainSheetName);
    const copySourceRowIndex = target.copyFromAfterInsert ? target.rowIndex + 1 : target.copyFromRowIndex;
    await batchUpdate(env, [
      {
        insertDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: target.rowIndex, endIndex: target.rowIndex + 1 },
          inheritFromBefore: true,
        },
      },
      {
        copyPaste: {
          source: { sheetId, startRowIndex: copySourceRowIndex, endRowIndex: copySourceRowIndex + 1, startColumnIndex: 0, endColumnIndex: 26 },
          destination: { sheetId, startRowIndex: target.rowIndex, endRowIndex: target.rowIndex + 1, startColumnIndex: 0, endColumnIndex: 26 },
          pasteType: "PASTE_FORMAT",
        },
      },
      {
        copyPaste: {
          source: { sheetId, startRowIndex: copySourceRowIndex, endRowIndex: copySourceRowIndex + 1, startColumnIndex: 0, endColumnIndex: 26 },
          destination: { sheetId, startRowIndex: target.rowIndex, endRowIndex: target.rowIndex + 1, startColumnIndex: 0, endColumnIndex: 26 },
          pasteType: "PASTE_FORMULA",
        },
      },
      {
        copyPaste: {
          source: { sheetId, startRowIndex: copySourceRowIndex, endRowIndex: copySourceRowIndex + 1, startColumnIndex: 0, endColumnIndex: 26 },
          destination: { sheetId, startRowIndex: target.rowIndex, endRowIndex: target.rowIndex + 1, startColumnIndex: 0, endColumnIndex: 26 },
          pasteType: "PASTE_DATA_VALIDATION",
        },
      },
    ]);
  }

  await batchUpdateValues(env, buildUpdates({ payload, customer, columns, sheetName: mainSheetName, rowIndex: target.rowIndex, sheetDate }));
  await appendLog(env, payload, customer, target.shouldInsert ? "inserted" : "updated_blank_row");
  return json({ ok: true, customerName: customer.name, rowNumber: target.rowIndex + 1, inserted: target.shouldInsert });
}

export async function onRequest(context) {
  const { request, env } = context;
  const pathname = new URL(request.url).pathname.replace(/\/+$/, "");

  try {
    if (pathname === "/api/login") {
      return await handleLogin(env, request);
    }
    if (pathname === "/api/customers") {
      return await handleCustomers(env, request);
    }
    if (pathname === "/api/orders") {
      return await handleOrders(env, request);
    }
    return json({ error: "API route not found" }, 404);
  } catch (error) {
    const message = error?.message || "Có lỗi xảy ra.";
    const status = message.includes("đăng nhập") || message.includes("Phiên đăng nhập") ? 401 : 400;
    return json({ error: message }, status);
  }
}
