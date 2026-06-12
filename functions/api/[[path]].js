const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";
// Tạm ngắt toàn bộ kết nối Google Sheets. Đổi thành true khi cần kết nối lại.
const GOOGLE_SHEETS_CONNECTED = false;
const PASSWORD_SALT = "nhap-lieu-mi-v1";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MAIN_REQUIRED_HEADERS = ["Ngày Đặt", "Tên KH"];
const CUSTOMER_REQUIRED_HEADERS = ["MaKH", "TenKH"];
const CUSTOMER_COLUMNS = ["MaKH", "TenKH", "GiaMi", "GiaCao", "GiaHoanh", "NhaXeMacDinh", "ChinhSachThue", "ThueSuat", "TrangThai"];
const quantityFields = ["miKg", "caoKg", "hoanhKg", "huTieu", "voBanhGoi"];
const TRUCK_NAMES = [
  { pattern: /thành\s*bưởi|thanh\s*buoi/i, name: "Thành Bưởi" },
  { pattern: /\bbany\b/i, name: "Bany" },
  { pattern: /huệ\s*nghĩa|hue\s*nghia/i, name: "Huệ Nghĩa" },
  { pattern: /tư\s*nhiều|tu\s*nhieu/i, name: "Tư Nhiều" },
];

function truckFromText(value) {
  return TRUCK_NAMES.find((item) => item.pattern.test(String(value || "")))?.name || "";
}

function noteWithoutTruck(value) {
  let text = String(value || "");
  TRUCK_NAMES.forEach((item) => { text = text.replace(item.pattern, ""); });
  return text.replace(/\s*[-|,]\s*$/g, "").replace(/^\s*[-|,]\s*/g, "").replace(/\s{2,}/g, " ").trim();
}

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
  extraShipCustomer: ["Khách Phụ Ship", "Khach Phu Ship", "Khách phụ ship", "KhachPhuShip"],
  ghiChu: ["Ghi chú", "Ghi chu"],
  taxRate: ["Thuế suất", "Thue suat", "TaxRate"],
  taxPayer: ["Người chịu thuế", "Nguoi chiu thue", "TaxPayer"],
  taxAmount: ["Tiền thuế", "Tien thue", "Thuế 5%", "Thue 5%", "TaxAmount"],
  subtotal: ["Tiền hàng", "Tien hang", "Tạm tính", "Tam tinh", "Subtotal"],
  orderTotal: ["Tổng tiền", "Tong tien", "Thành tiền", "Thanh tien", "Chưa Thanh Toán", "Chua Thanh Toan", "OrderTotal"],
  paid: ["Đã thanh toán", "Da thanh toan", "Khách trả", "Khach tra"],
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
  const signature = await hmacSign(requiredEnv(env, "APP_AUTH_SECRET"), encodedPayload);
  return `${encodedPayload}.${signature}`;
}

async function verifySessionToken(env, token) {
  if (!token || !token.includes(".")) {
    throw new Error("Vui lòng đăng nhập trước khi ghi nhận số lượng.");
  }

  const [encodedPayload, signature] = token.split(".");
  const expectedSignature = await hmacSign(requiredEnv(env, "APP_AUTH_SECRET"), encodedPayload);
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
  if (!GOOGLE_SHEETS_CONNECTED) {
    throw new Error("Google Sheets đang tạm ngắt kết nối.");
  }

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
  const raw = String(value ?? "").trim().replace(",", ".");
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
  if (start === -1) return null;

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

function findLastCustomerRow(values, headerRowIndex, nameColumn) {
  for (let i = values.length - 1; i > headerRowIndex; i -= 1) {
    if (normalizeText(getCell(values[i], nameColumn))) return i;
  }
  return headerRowIndex;
}

function rowHasQuantity(row, columns) {
  return quantityFields.some((field) => !isBlank(getCell(row, columns[field])))
    || normalizeText(getCell(row, columns.ghiChu)).includes("khách nghỉ");
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

  let blankRowIndex = -1;
  for (let i = block.start; i <= block.end; i += 1) {
    const row = values[i] || [];
    if (isBlank(getCell(row, dateColumn)) && !rowHasQuantity(row, columns)) {
      blankRowIndex = i;
      break;
    }
  }
  if (blankRowIndex !== -1) {
    return { rowIndex: blankRowIndex, shouldInsert: false };
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
  const customerResting = payload.customerResting === true || String(payload.customerResting) === "true";
  add("miKg", customerResting ? 0 : parseNumber(payload.miKg));
  add("caoKg", customerResting ? 0 : parseNumber(payload.caoKg));
  add("hoanhKg", customerResting ? 0 : parseNumber(payload.hoanhKg));
  add("huTieu", customerResting ? 0 : parseNumber(payload.huTieu));
  add("voBanhGoi", customerResting ? 0 : parseNumber(payload.voBanhGoi));
  add("tienUng", parseNumber(payload.tienUng));
  add("thungXop", customerResting ? 0 : parseNumber(payload.thungXop));
  const resolvedTruck = truckFromText(payload.nhaXe) || truckFromText(payload.ghiChu) || payload.nhaXe || customer.defaultTruck || "";
  add("nhaXe", resolvedTruck);
  add("extraShipCustomer", String(payload.extraShipCustomer || "").trim());
  const paymentMethod = ["debt", "cash", "transfer"].includes(payload.paymentMethod) ? payload.paymentMethod : "debt";
  const taxRate = parseNumber(payload.taxRate);
  const taxNote = taxRate ? `Thuế ${taxRate}%: ${payload.taxPayer === "owner" ? "xưởng chịu (ưu đãi)" : "khách trả"}` : "";
  const paymentNote = paymentMethod === "cash"
    ? "Tiền mặt"
    : paymentMethod === "transfer"
      ? "Chuyển khoản"
      : "";
  add("ghiChu", [customerResting ? "Khách nghỉ" : "", noteWithoutTruck(payload.ghiChu), taxNote, paymentNote].filter(Boolean).join(" | "));
  add("taxRate", parseNumber(payload.taxRate));
  add("taxPayer", payload.taxPayer || "customer");
  add("taxAmount", parseNumber(payload.taxAmount));
  add("subtotal", parseNumber(payload.subtotal));
  add("orderTotal", parseNumber(payload.orderTotal));
  add("paid", paymentMethod === "debt" ? parseNumber(payload.paid) : parseNumber(payload.orderTotal));
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
  const customerResting = payload.customerResting === true || String(payload.customerResting) === "true";
  set("MiKg", customerResting ? 0 : parseNumber(payload.miKg));
  set("CaoKg", customerResting ? 0 : parseNumber(payload.caoKg));
  set("HoanhKg", customerResting ? 0 : parseNumber(payload.hoanhKg));
  set("HuTieu", customerResting ? 0 : parseNumber(payload.huTieu));
  set("VoBanhGoi", customerResting ? 0 : parseNumber(payload.voBanhGoi));
  set("TienUng", parseNumber(payload.tienUng));
  set("ThungXop", customerResting ? 0 : parseNumber(payload.thungXop));
  set("NhaXe", truckFromText(payload.nhaXe) || truckFromText(payload.ghiChu) || payload.nhaXe || customer.defaultTruck || "");
  set("Khách Phụ Ship", String(payload.extraShipCustomer || "").trim());
  set("GhiChu", [customerResting ? "Khách nghỉ" : "", noteWithoutTruck(payload.ghiChu)].filter(Boolean).join(" | "));
  set("TrangThai", status);
  await batchUpdateValues(env, [{ range: sheetRange(sheetName, `A${values.length + 1}:AZ${values.length + 1}`), values: [row] }]);
}

async function handleLogin(env, request) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }
  const payload = await request.json();
  const email = normalizeText(payload.email);
  const password = String(payload.password || "");
  const users = JSON.parse(requiredEnv(env, "AUTH_USERS_JSON"));
  const user = users.find((item) => normalizeText(item.email) === email);
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
  const sessionUser = await requireAuth(env, request);
  const sheetName = env.CUSTOMERS_SHEET_NAME || "DanhSachKhach";
  const values = await getValues(env, sheetName, "A1:Z2000");
  const { headerRowIndex, header } = findHeader(values, ["MaKH", "TenKH"]);
  if (request.method === "POST") {
    if (sessionUser.role !== "manager") return json({ error: "Chỉ tài khoản quản lý được thêm khách hàng." }, 403);
    const payload = await request.json();
    const code = String(payload.MaKH || "").trim();
    const name = String(payload.TenKH || "").trim();
    if (!code || !name) return json({ error: "Vui lòng nhập mã khách và tên khách hàng." }, 400);
    const codeColumn = header[normalizeText("MaKH")];
    const duplicate = values.slice(headerRowIndex + 1).some((row) => normalizeText(row[codeColumn]) === normalizeText(code));
    if (duplicate) return json({ error: `Mã khách ${code} đã tồn tại.` }, 409);
    const blankOffset = values.slice(headerRowIndex + 1).findIndex((row) => !String(row[codeColumn] || "").trim());
    const rowNumber = blankOffset === -1 ? values.length + 1 : headerRowIndex + blankOffset + 2;
    const fields = { MaKH: code, TenKH: name, GiaMi: payload.GiaMi || 0, GiaCao: payload.GiaCao || 0, GiaHoanh: payload.GiaHoanh || 0, NhaXeMacDinh: payload.NhaXeMacDinh || "", ChinhSachThue: payload.ChinhSachThue || "", ThueSuat: payload.ThueSuat || 0, TrangThai: "active" };
    const updates = Object.entries(fields).flatMap(([column, value]) => {
      const index = header[normalizeText(column)];
      return index === undefined ? [] : [{ range: sheetRange(sheetName, `${colToA1(index)}${rowNumber}`), values: [[value]] }];
    });
    await batchUpdateValues(env, updates);
    return json({ ok: true, rowNumber, customer: fields }, 201);
  }
  if (request.method === "PUT") {
    if (sessionUser.role !== "manager") return json({ error: "Chỉ tài khoản quản lý được sửa bảng giá khách hàng." }, 403);
    const payload = await request.json();
    const codeColumn = header[normalizeText("MaKH")];
    const offset = values.slice(headerRowIndex + 1).findIndex((row) => normalizeText(row[codeColumn]) === normalizeText(payload.MaKH));
    if (offset === -1) return json({ error: "Không tìm thấy khách hàng cần cập nhật." }, 404);
    const rowNumber = headerRowIndex + offset + 2;
    const nameColumn = header[normalizeText("TenKH")];
    const oldName = String(values[rowNumber - 1]?.[nameColumn] || "").trim();
    const newName = String(payload.TenKH || oldName).trim();
    const editable = ["TenKH", "GiaMi", "GiaCao", "GiaHoanh", "NhaXeMacDinh", "ChinhSachThue", "ThueSuat"];
    const updates = editable.flatMap((column) => {
      const index = header[normalizeText(column)];
      return index === undefined || payload[column] === undefined
        ? []
        : [{ range: sheetRange(sheetName, `${colToA1(index)}${rowNumber}`), values: [[payload[column]]] }];
    });
    if (!updates.length) return json({ error: "Sheet chưa có cột phù hợp để cập nhật." }, 400);
    let syncedOrders = 0;
    let syncedProduction = 0;
    if (newName && normalizeText(newName) !== normalizeText(oldName)) {
      const mainSheet = env.MAIN_SHEET_NAME || "Tiền Khách Nợ";
      const productionSheet = env.PRODUCTION_INFO_SHEET_NAME || "thongtinkhachhang";
      const [mainValues, productionValues] = await Promise.all([
        getValues(env, mainSheet, "A1:AZ5000"),
        getValues(env, productionSheet, "A1:AZ1000"),
      ]);
      const mainHeader = findHeader(mainValues, ["Ngày Đặt", "Tên KH"]);
      const mainNameColumn = mainHeader.header[normalizeText("Tên KH")];
      mainValues.slice(mainHeader.headerRowIndex + 1).forEach((row, index) => {
        if (normalizeText(row[mainNameColumn]) !== normalizeText(oldName)) return;
        updates.push({ range: sheetRange(mainSheet, `${colToA1(mainNameColumn)}${mainHeader.headerRowIndex + index + 2}`), values: [[newName]] });
        syncedOrders += 1;
      });
      productionValues.slice(1).forEach((row, index) => {
        if (normalizeText(row[6]) !== normalizeText(payload.MaKH)) return;
        updates.push({ range: sheetRange(productionSheet, `A${index + 2}`), values: [[newName]] });
        syncedProduction += 1;
      });
    }
    await batchUpdateValues(env, updates);
    return json({ ok: true, rowNumber, syncedOrders, syncedProduction });
  }
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
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

async function handleProductionInfo(env, request) {
  const sessionUser = await requireAuth(env, request);
  const sheetName = env.PRODUCTION_INFO_SHEET_NAME || "thongtinkhachhang";
  const values = await getValues(env, sheetName, "A1:AZ1000");
  const header = values[0] || [];
  const cell = (row, index) => String(row?.[index] || "").trim();
  const normalize = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const customerValues = await getValues(env, env.CUSTOMERS_SHEET_NAME || "DanhSachKhach", "A1:Z2000");
  const customers = customerValues.slice(1).map((row) => ({ code: cell(row, 0), name: cell(row, 1) })).filter((customer) => customer.code && customer.name);
  const matchCustomer = (entryName) => {
    const text = normalize(entryName);
    if (!text) return "";
    const codeMatches = customers.filter((customer) => {
      const code = normalize(customer.code);
      return code && new RegExp(`(^|\\s)${code}(?=\\s|$)`).test(text);
    });
    if (codeMatches.length === 1) return codeMatches[0].code;
    const nameMatches = customers.filter((customer) => {
      const name = normalize(customer.name);
      return name.length >= 4 && (text.includes(name) || name.includes(text));
    });
    return nameMatches.length === 1 ? nameMatches[0].code : "";
  };
  if (request.method === "PUT") {
    if (sessionUser.role !== "manager") return json({ error: "Chỉ quản lý được sửa thông tin sản xuất." }, 403);
    const payload = await request.json();
    const rowNumber = Number(payload.id);
    if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > values.length + 50) return json({ error: "Dòng thông tin cần sửa không hợp lệ." }, 400);
    const fields = [payload.customer, payload.usualOrder, payload.production, payload.delivery, payload.additional, payload.invoice, payload.customerCode].map((value) => String(value || "").trim());
    const updates = [{ range: sheetRange(sheetName, `A${rowNumber}:G${rowNumber}`), values: [fields] }];
    if (!cell(header, 6)) updates.push({ range: sheetRange(sheetName, "G1"), values: [["Mã KH CRM"]] });
    await batchUpdateValues(env, updates);
    return json({ ok: true, rowNumber });
  }
  if (request.method === "POST") {
    if (sessionUser.role !== "manager") return json({ error: "Chỉ quản lý được đồng bộ thông tin sản xuất." }, 403);
    const payload = await request.json().catch(() => ({}));
    if (payload.action === "create") {
      const fields = [payload.customer, payload.usualOrder, payload.production, payload.delivery, payload.additional, payload.invoice, payload.customerCode]
        .map((value) => String(value || "").trim());
      if (!fields[0]) return json({ error: "Vui lòng nhập tên khách hàng." }, 400);
      if (!fields.slice(1, 6).some(Boolean)) return json({ error: "Vui lòng nhập ít nhất một thông tin về sản xuất hoặc giao hàng." }, 400);
      const rowNumber = Math.max(values.length + 1, 2);
      const updates = [{ range: sheetRange(sheetName, `A${rowNumber}:G${rowNumber}`), values: [fields] }];
      if (!cell(header, 6)) updates.push({ range: sheetRange(sheetName, "G1"), values: [["Mã KH CRM"]] });
      await batchUpdateValues(env, updates);
      return json({ ok: true, rowNumber }, 201);
    }
    const updates = [];
    if (!cell(header, 6)) updates.push({ range: sheetRange(sheetName, "G1"), values: [["Mã KH CRM"]] });
    let matched = 0;
    values.slice(1).forEach((row, index) => {
      if (cell(row, 6) || !cell(row, 0)) return;
      const code = matchCustomer(cell(row, 0));
      if (!code) return;
      updates.push({ range: sheetRange(sheetName, `G${index + 2}`), values: [[code]] });
      matched += 1;
    });
    if (updates.length) await batchUpdateValues(env, updates);
    return json({ ok: true, matched });
  }
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  const entries = values.slice(1).map((row, index) => ({
    id: index + 2,
    customer: cell(row, 0),
    usualOrder: cell(row, 1),
    production: cell(row, 2),
    delivery: cell(row, 3),
    additional: cell(row, 4),
    invoice: cell(row, 5),
    customerCode: cell(row, 6) || matchCustomer(cell(row, 0)),
    linkedExplicitly: Boolean(cell(row, 6)),
  })).filter((entry) => Object.values(entry).some((value) => typeof value === "string" && value));
  return json({
    title: cell(header, 0) || "Thông tin khách hàng",
    columns: {
      customer: cell(header, 0),
      usualOrder: cell(header, 1),
      production: cell(header, 2),
      delivery: cell(header, 3),
      additional: cell(header, 4),
      invoice: cell(header, 5),
    },
    entries,
  });
}

function crmMoney(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value || "").trim();
  if (!text || !/\d/.test(text)) return 0;
  const parsed = Number(text.replace(/[^\d]/g, ""));
  return Number.isFinite(parsed) ? parsed * (text.includes("(") ? -1 : 1) : 0;
}

function crmNumber(value) {
  const parsed = Number(String(value || "").trim().replace(",", ".").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function crmDate(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    return `${year}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  }
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : "";
}

function crmColumn(headerRow, names) {
  const wanted = names.map(normalizeText);
  const index = headerRow.findIndex((label) => wanted.includes(normalizeText(label)));
  return index === -1 ? undefined : index;
}

function crmTruck(truck, note) {
  const text = `${truck || ""} ${note || ""}`;
  if (/thành\s*bưởi|thanh\s*buoi/i.test(text)) return "Thành Bưởi";
  if (/\bbany\b/i.test(text)) return "Bany";
  if (/huệ\s*nghĩa|hue\s*nghia/i.test(text)) return "Huệ Nghĩa";
  if (/tư\s*nhiều|tu\s*nhieu/i.test(text)) return "Tư Nhiều";
  return String(truck || "");
}

function crmCleanNote(note) {
  return String(note || "").replace(/thành\s*bưởi|thanh\s*buoi|\bbany\b|huệ\s*nghĩa|hue\s*nghia|tư\s*nhiều|tu\s*nhieu/ig, "").replace(/\s*[-|,]\s*$/g, "").replace(/^\s*[-|,]\s*/g, "").replace(/\s{2,}/g, " ").trim();
}

function crmIsResting(note, truck) {
  const normalizedNote = normalizeText(note), normalizedTruck = normalizeText(truck);
  return normalizedNote === "nghỉ" || normalizedNote === "nghi" || normalizedNote.includes("khách nghỉ") || normalizedTruck === "nghỉ" || normalizedTruck === "nghi";
}

function crmSuggestion(customer, allOrders) {
  const history = allOrders.filter((order) => normalizeText(order.customerName) === normalizeText(customer.TenKH)).sort((a, b) => a.date.localeCompare(b.date)).slice(-8);
  if (!history.length) return { confidence: "new", message: "Chưa có lịch sử mua. Nên xác nhận nhu cầu trước khi lên đơn.", products: [] };
  const productMap = [["Mì", "miKg"], ["Da cảo", "caoKg"], ["Da hoành", "hoanhKg"]];
  const products = productMap.map(([name, key]) => {
    const bought = history.map((order) => order[key]).filter((value) => value > 0);
    return { name, quantity: bought.length ? Math.round(bought.reduce((sum, value) => sum + value, 0) / bought.length * 10) / 10 : 0, frequency: Math.round(bought.length / history.length * 100) };
  }).filter((product) => product.frequency >= 25);
  const dates = history.map((order) => order.date).filter(Boolean);
  const intervals = dates.slice(1).map((date, index) => Math.max(1, Math.round((new Date(date) - new Date(dates[index])) / 86400000)));
  const averageInterval = intervals.length ? Math.round(intervals.reduce((sum, value) => sum + value, 0) / intervals.length) : 7;
  const nextDate = dates.length ? new Date(new Date(`${dates.at(-1)}T00:00:00+07:00`).getTime() + averageInterval * 86400000).toISOString().slice(0, 10) : "";
  const strongest = [...products].sort((a, b) => b.frequency - a.frequency)[0];
  return { confidence: history.length >= 5 ? "high" : "medium", nextDate, averageInterval, products, message: strongest ? `Khách thường lấy ${strongest.name.toLowerCase()} khoảng ${strongest.quantity} kg, chu kỳ gần ${averageInterval} ngày.` : `Khách mua không theo mẫu cố định, nên xem lại ${history.length} đơn gần nhất.` };
}

async function handleCrm(env, request) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  await requireAuth(env, request);
  const [mainValues, customerValues] = await Promise.all([
    getValues(env, env.MAIN_SHEET_NAME || "Tiền Khách Nợ", "A1:AZ5000"),
    getValues(env, env.CUSTOMERS_SHEET_NAME || "DanhSachKhach", "A1:Z2000"),
  ]);
  const customerHeader = findHeader(customerValues, ["MaKH", "TenKH"]);
  const readCustomer = (row, label) => row[customerHeader.header[normalizeText(label)]] || "";
  const customers = customerValues.slice(customerHeader.headerRowIndex + 1).map((row) => ({
    MaKH: readCustomer(row, "MaKH"), TenKH: readCustomer(row, "TenKH"),
    GiaMi: crmMoney(readCustomer(row, "GiaMi")), GiaCao: crmMoney(readCustomer(row, "GiaCao")), GiaHoanh: crmMoney(readCustomer(row, "GiaHoanh")),
    NhaXeMacDinh: readCustomer(row, "NhaXeMacDinh"), ThueSuat: crmNumber(readCustomer(row, "ThueSuat")),
    TrangThai: readCustomer(row, "TrangThai") || "active",
  })).filter((item) => item.MaKH && item.TenKH && normalizeText(item.TrangThai) !== "inactive");
  const mainHeader = findHeader(mainValues, ["Ngày Đặt", "Tên KH"]);
  const headerRow = mainValues[mainHeader.headerRowIndex] || [];
  const names = {
    date: ["Ngày Đặt"], customer: ["Tên KH"], miKg: ["Mì (kg)", "Mi (kg)"], caoKg: ["Da Cảo (kg)", "Da Cao (kg)"], hoanhKg: ["Da Hoành Thánh (kg)", "Da Hoành Thành (kg)"], huTieu: ["Hủ Tiếu", "Hu Tieu"], voBanhGoi: ["Vỏ bánh gối", "Vo banh goi"], thungXop: ["Thùng Xốp", "Thung Xop"],
    priceMi: ["Giá Mì"], priceCao: ["Giá Da Cảo"], priceHoanh: ["Giá Da Hoành"], advance: ["Tiền ứng"], taxAmount: ["Thuế 5%", "Tiền thuế"],
    total: ["Chưa Thanh Toán", "Tổng tiền"], paid: ["Đã thanh toán"], debt: ["Còn lại"], truck: ["Nhà xe"], extraShipCustomer: ["Khách Phụ Ship", "Khach Phu Ship", "KhachPhuShip"], note: ["Ghi chú"],
  };
  const columns = Object.fromEntries(Object.entries(names).map(([key, value]) => [key, crmColumn(headerRow, value)]));
  let currentCustomer = "";
  const orders = mainValues.slice(mainHeader.headerRowIndex + 1).map((row, offset) => {
    if (row[columns.customer]) currentCustomer = row[columns.customer];
    const miKg = crmNumber(row[columns.miKg]), caoKg = crmNumber(row[columns.caoKg]), hoanhKg = crmNumber(row[columns.hoanhKg]), huTieu = crmNumber(row[columns.huTieu]), voBanhGoi = crmNumber(row[columns.voBanhGoi]), thungXop = crmNumber(row[columns.thungXop]);
    const priceMi = crmMoney(row[columns.priceMi]), priceCao = crmMoney(row[columns.priceCao]), priceHoanh = crmMoney(row[columns.priceHoanh]);
    const subtotal = miKg * priceMi + caoKg * priceCao + hoanhKg * priceHoanh;
    const rawNote = row[columns.note] || "", rawTruck = row[columns.truck] || "", customerResting = crmIsResting(rawNote, rawTruck);
    return { id: mainHeader.headerRowIndex + offset + 2, date: crmDate(row[columns.date]), customerName: currentCustomer, miKg, caoKg, hoanhKg, huTieu, voBanhGoi, thungXop, priceMi, priceCao, priceHoanh, subtotal, taxAmount: crmMoney(row[columns.taxAmount]), advance: crmMoney(row[columns.advance]), total: crmMoney(row[columns.total]) || subtotal, paid: crmMoney(row[columns.paid]), debt: columns.debt === undefined ? crmMoney(row[columns.total]) - crmMoney(row[columns.paid]) : crmMoney(row[columns.debt]), customerResting, truck: customerResting ? "" : crmTruck(rawTruck, rawNote), extraShipCustomer: row[columns.extraShipCustomer] || "", note: crmCleanNote(rawNote) };
  }).filter((order) => order.customerName && (order.date || order.miKg || order.caoKg || order.hoanhKg));
  const customerSummaries = customers.map((customer) => {
    const customerOrders = orders.filter((order) => normalizeText(order.customerName) === normalizeText(customer.TenKH));
    return { ...customer, orderCount: customerOrders.length, revenue: customerOrders.reduce((sum, order) => sum + order.total, 0), debt: customerOrders.reduce((sum, order) => sum + order.debt, 0), lastOrderDate: customerOrders.map((order) => order.date).filter(Boolean).sort().at(-1) || "", suggestion: crmSuggestion(customer, orders) };
  });
  return json({ customers: customerSummaries, orders: orders.sort((a, b) => {
    if (!a.date && !b.date) return b.id - a.id;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return b.date.localeCompare(a.date) || b.id - a.id;
  }), summary: { customerCount: customers.length, orderCount: orders.length, revenue: orders.reduce((sum, order) => sum + order.total, 0), debt: customerSummaries.reduce((sum, customer) => sum + customer.debt, 0), tax: orders.reduce((sum, order) => sum + order.taxAmount, 0), advance: orders.reduce((sum, order) => sum + order.advance, 0) } });
}

async function handleOrders(env, request) {
  if (!["POST", "PUT"].includes(request.method)) {
    return json({ error: "Method not allowed" }, 405);
  }

  const payload = await request.json();
  const sessionUser = await requireAuth(env, request);
  payload.userEmail = sessionUser.email || sessionUser.username;
  assertAllowedUser(env, payload.userEmail);

  const mainSheetName = env.MAIN_SHEET_NAME || "Tiền Khách Nợ";
  const customersSheetName = env.CUSTOMERS_SHEET_NAME || "DanhSachKhach";
  const [mainValues, customersValues] = await Promise.all([
    getValues(env, mainSheetName, "A1:AZ5000"),
    getValues(env, customersSheetName, "A1:Z2000"),
  ]);

  if (request.method === "PUT") {
    const rowNumber = Number(payload.rowId);
    if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > mainValues.length + 50) throw new Error("Dòng đơn hàng cần sửa không hợp lệ.");
    const { headerRowIndex } = findHeader(mainValues, MAIN_REQUIRED_HEADERS);
    if (rowNumber <= headerRowIndex + 1) throw new Error("Không thể sửa dòng tiêu đề.");
    const headerRow = mainValues[headerRowIndex] || [];
    const columns = {};
    Object.entries(fieldToHeader).forEach(([field, aliases]) => { columns[field] = findColumnInHeaderRow(headerRow, aliases); });
    columns.miKg = optionalColumn(findColumnAfter(headerRow, fieldToHeader.miKg, columns.customerName));
    columns.caoKg = optionalColumn(findColumnAfter(headerRow, fieldToHeader.caoKg, columns.miKg));
    columns.hoanhKg = optionalColumn(findColumnAfter(headerRow, fieldToHeader.hoanhKg, columns.caoKg));
    columns.huTieu = optionalColumn(findColumnAfter(headerRow, fieldToHeader.huTieu, columns.hoanhKg));
    columns.voBanhGoi = optionalColumn(findColumnAfter(headerRow, fieldToHeader.voBanhGoi, columns.huTieu));
    const updates = [];
    const add = (field, value) => {
      const columnIndex = columns[field];
      if (columnIndex === undefined || value === undefined) return;
      updates.push({ range: sheetRange(mainSheetName, `${colToA1(columnIndex)}${rowNumber}`), values: [[value]] });
    };
    const customerResting = payload.customerResting === true || String(payload.customerResting) === "true";
    add("orderDate", toSheetDate(payload.orderDate));
    add("weekday", weekdayForSheet(payload.orderDate));
    add("miKg", customerResting ? 0 : parseNumber(payload.miKg));
    add("caoKg", customerResting ? 0 : parseNumber(payload.caoKg));
    add("hoanhKg", customerResting ? 0 : parseNumber(payload.hoanhKg));
    add("huTieu", customerResting ? 0 : parseNumber(payload.huTieu));
    add("voBanhGoi", customerResting ? 0 : parseNumber(payload.voBanhGoi));
    add("tienUng", parseNumber(payload.tienUng));
    add("thungXop", customerResting ? 0 : parseNumber(payload.thungXop));
    add("nhaXe", truckFromText(payload.nhaXe) || truckFromText(payload.ghiChu) || payload.nhaXe || "");
    add("extraShipCustomer", String(payload.extraShipCustomer || "").trim());
    add("ghiChu", [customerResting ? "Khách nghỉ" : "", noteWithoutTruck(payload.ghiChu)].filter(Boolean).join(" | "));
    add("taxAmount", parseNumber(payload.taxAmount));
    add("orderTotal", parseNumber(payload.orderTotal));
    add("paid", parseNumber(payload.paid));
    await batchUpdateValues(env, updates);
    return json({ ok: true, rowNumber });
  }

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
  const target = block
    ? findTargetRow(mainValues, block, columns, sheetDate)
    : (() => {
      const lastCustomerRow = findLastCustomerRow(mainValues, headerRowIndex, columns.customerName);
      return { rowIndex: lastCustomerRow + 1, shouldInsert: true, copyFromRowIndex: lastCustomerRow };
    })();

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
  const pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  try {
    if (pathname.startsWith("/api/")) {
      return json({ error: "Legacy API đã ngừng hoạt động. Hãy sử dụng backend Netlify hiện tại." }, 410);
    }
    if (pathname === "/api/login") return await handleLogin(env, request);
    if (pathname === "/api/customers") return await handleCustomers(env, request);
    if (pathname === "/api/production-info") return await handleProductionInfo(env, request);
    if (pathname === "/api/orders") return await handleOrders(env, request);
    if (pathname === "/api/crm") return await handleCrm(env, request);
    return json({ error: "API route not found" }, 404);
  } catch (error) {
    const message = error?.message || "Có lỗi xảy ra.";
    const status = message.includes("đăng nhập") || message.includes("Phiên đăng nhập") ? 401 : 400;
    return json({ error: message }, status);
  }
}
