// Module crypto dùng để ký JWT đăng nhập Service Account.
const crypto = require("crypto");
// Module fs dùng để đọc file .env khi chạy local.
const fs = require("fs");
// Module path dùng để tạo đường dẫn file .env đúng trên máy.
const path = require("path");

// Quyền Google API cần dùng: đọc và ghi Google Sheets.
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
// URL Google dùng để đổi JWT thành access token.
const TOKEN_URL = "https://oauth2.googleapis.com/token";
// URL gốc của Google Sheets API.
const SHEETS_URL = "https://sheets.googleapis.com/v4/spreadsheets";
// CRM dùng dữ liệu độc lập; không kết nối hay đọc lại Google Sheets.
const GOOGLE_SHEETS_CONNECTED = false;

// Đọc file .env khi chạy local bằng npm run dev.
function loadLocalEnv() {
  // File .env nằm ở thư mục gốc dự án.
  const envPath = path.join(process.cwd(), ".env");
  // Nếu không có file .env thì bỏ qua.
  if (!fs.existsSync(envPath)) {
    return;
  }

  // Đọc từng dòng trong file .env.
  const lines = fs.readFileSync(envPath, "utf8").split(/\n/);
  // Duyệt từng dòng để đưa vào process.env.
  lines.forEach((line) => {
    // Bỏ qua dòng trống và dòng comment.
    if (!line || line.trim().startsWith("#")) {
      return;
    }
    // Tìm dấu = đầu tiên để tách key/value.
    const index = line.indexOf("=");
    // Nếu dòng không có dấu = thì bỏ qua.
    if (index === -1) {
      return;
    }
    // Phần bên trái dấu = là tên biến.
    const key = line.slice(0, index);
    // Phần bên phải dấu = là giá trị.
    let value = line.slice(index + 1);
    // Nếu value được bọc bằng dấu "..." thì parse để giữ xuống dòng private key.
    if (value.startsWith('"') && value.endsWith('"')) {
      value = JSON.parse(value);
    }
    // Không ghi đè biến đã được hệ thống triển khai cấp.
    if (process.env[key] === undefined) process.env[key] = value;
  });
}

// Lấy biến môi trường bắt buộc, thiếu thì báo lỗi rõ ràng.
function requiredEnv(name) {
  // Khi chạy local thì đọc .env trước.
  loadLocalEnv();
  // Lấy giá trị biến môi trường.
  const value = process.env[name];
  // Nếu thiếu thì báo lỗi để biết cần cấu hình gì.
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  // Trả về giá trị env.
  return value;
}

// Tạo phản hồi JSON chuẩn cho các API handler.
function jsonResponse(statusCode, body, headers = {}) {
  return {
    // HTTP status, ví dụ 200 thành công, 400 lỗi nhập liệu.
    statusCode,
    // Header báo trình duyệt biết body là JSON tiếng Việt.
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    // Chuyển object thành chuỗi JSON.
    body: JSON.stringify(body),
  };
}

// Đổi dữ liệu sang base64url, định dạng Google JWT cần.
function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Chuyển private key từ env thành đúng dạng nhiều dòng.
function normalizePrivateKey(key) {
  return key.replace(/^"|"$/g, "").replace(/\\n/g, "\n");
}

// Xin access token từ Google bằng Service Account.
async function getAccessToken() {
  // Email Service Account lấy từ env.
  const email = requiredEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  // Private key Service Account lấy từ env.
  const privateKey = normalizePrivateKey(requiredEnv("GOOGLE_PRIVATE_KEY"));
  // Thời gian hiện tại tính bằng giây.
  const now = Math.floor(Date.now() / 1000);
  // Header JWT cho thuật toán ký RSA SHA256.
  const header = { alg: "RS256", typ: "JWT" };
  // Nội dung JWT nói Google biết app muốn quyền gì.
  const claim = {
    // Người phát hành token là Service Account.
    iss: email,
    // Scope là quyền đọc/ghi Sheet.
    scope: SCOPES.join(" "),
    // Audience là endpoint token của Google.
    aud: TOKEN_URL,
    // Token hết hạn sau 1 giờ.
    exp: now + 3600,
    // Token bắt đầu từ thời điểm hiện tại.
    iat: now,
  };

  // Ghép header và claim thành phần chưa ký.
  const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claim))}`;
  // Ký token bằng private key của Service Account.
  const signature = crypto.createSign("RSA-SHA256").update(unsignedToken).sign(privateKey);
  // JWT hoàn chỉnh gồm header.claim.signature.
  const jwt = `${unsignedToken}.${base64Url(signature)}`;

  // Gửi JWT lên Google để đổi lấy access token.
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  // Đọc phản hồi JSON từ Google.
  const data = await response.json();

  // Nếu Google từ chối thì báo lỗi rõ.
  if (!response.ok) {
    throw new Error(data.error_description || data.error || "Google auth failed");
  }

  // Trả access token để gọi Google Sheets API.
  return data.access_token;
}

// Hàm gọi Google Sheets API chung cho mọi request.
async function googleRequest(path, options = {}) {
  if (!GOOGLE_SHEETS_CONNECTED) {
    throw new Error("Google Sheets đang tạm ngắt kết nối.");
  }

  // Lấy access token trước khi gọi API.
  const token = await getAccessToken();
  // Gọi Google Sheets API với Sheet ID trong env.
  const response = await fetch(`${SHEETS_URL}/${requiredEnv("GOOGLE_SHEET_ID")}${path}`, {
    // Cho phép truyền method/body từ nơi gọi.
    ...options,
    // Gắn header auth và JSON.
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  // Đọc text trước vì có response có thể rỗng.
  const text = await response.text();
  // Nếu có text thì parse JSON, không có thì dùng object rỗng.
  const data = text ? JSON.parse(text) : {};

  // Nếu Google trả lỗi thì ném message dễ hiểu.
  if (!response.ok) {
    const message = data.error?.message || `Google Sheets request failed: ${response.status}`;
    throw new Error(message);
  }

  // Trả dữ liệu Google API cho nơi gọi.
  return data;
}

// Tạo range kiểu 'Tên Tab'!A1:Z100.
function sheetRange(sheetName, range) {
  return `'${String(sheetName).replace(/'/g, "''")}'!${range}`;
}

// Đọc values từ một tab/range trong Google Sheet.
async function getValues(sheetName, range = "A1:Z5000") {
  // Encode range để đưa lên URL an toàn.
  const path = `/values/${encodeURIComponent(sheetRange(sheetName, range))}?majorDimension=ROWS`;
  // Gọi API đọc values.
  const data = await googleRequest(path);
  // Nếu Google không trả values thì dùng mảng rỗng.
  return data.values || [];
}

// Ghi nhiều ô/range cùng lúc bằng values API.
async function batchUpdateValues(data) {
  return googleRequest("/values:batchUpdate", {
    method: "POST",
    body: JSON.stringify({
      // USER_ENTERED để Google hiểu số, công thức, định dạng như người nhập tay.
      valueInputOption: "USER_ENTERED",
      // data là danh sách range + values cần ghi.
      data,
    }),
  });
}

// Gọi batchUpdate nâng cao: chèn dòng, copy format, copy công thức.
async function batchUpdate(requests) {
  return googleRequest(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({ requests }),
  });
}

// Lấy sheetId nội bộ của một tab dựa theo tên tab.
async function getSheetIdByTitle(title) {
  // Đọc metadata chỉ gồm sheetId và title cho nhẹ.
  const data = await googleRequest("?fields=sheets(properties(sheetId,title))");
  // Tìm tab có title trùng tên.
  const sheet = data.sheets.find((item) => item.properties.title === title);
  // Nếu không có tab thì báo lỗi.
  if (!sheet) {
    throw new Error(`Không tìm thấy tab "${title}" trong Google Sheet.`);
  }
  // Trả về sheetId để dùng trong batchUpdate.
  return sheet.properties.sheetId;
}

// Tìm dòng header trong một bảng values.
function findHeader(values, requiredLabels) {
  // Chuẩn hóa các label bắt buộc.
  const normalized = requiredLabels.map(normalizeText);
  // Tìm dòng có đủ các label bắt buộc.
  const index = values.findIndex((row) => {
    const rowText = row.map(normalizeText);
    return normalized.every((label) => rowText.includes(label));
  });

  // Nếu không tìm thấy header thì báo lỗi.
  if (index === -1) {
    throw new Error(`Không tìm thấy dòng tiêu đề có: ${requiredLabels.join(", ")}`);
  }

  // Tạo object map: tên cột đã chuẩn hóa -> index cột.
  const header = {};
  // Duyệt từng ô trong dòng header.
  values[index].forEach((label, columnIndex) => {
    // Chuẩn hóa tên cột để tránh lệch hoa/thường/khoảng trắng.
    const key = normalizeText(label);
    // Chỉ lấy cột đầu tiên nếu bị trùng tên.
    if (key && header[key] === undefined) {
      header[key] = columnIndex;
    }
  });

  // Trả cả vị trí dòng header và map header.
  return { headerRowIndex: index, header };
}

// Đổi số thứ tự cột 0,1,2 thành A,B,C.
function colToA1(index) {
  // Chuỗi kết quả, ví dụ A hoặc AA.
  let column = "";
  // Chuyển từ index 0-based sang 1-based.
  let n = index + 1;
  // Lặp đến khi tính xong toàn bộ ký tự cột.
  while (n > 0) {
    // Lấy phần dư để biết chữ cái hiện tại.
    const mod = (n - 1) % 26;
    // Ghép chữ cái vào đầu chuỗi.
    column = String.fromCharCode(65 + mod) + column;
    // Giảm n để xử lý ký tự tiếp theo nếu là AA, AB...
    n = Math.floor((n - mod) / 26);
  }
  // Trả về tên cột.
  return column;
}

// Chuẩn hóa text để so sánh tên cột/mã khách.
function normalizeText(value) {
  // Gom nhiều khoảng trắng thành một, bỏ khoảng trắng đầu/cuối, viết thường.
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Parse số lượng người dùng nhập.
function parseNumber(value) {
  // Cho phép nhập 31,5 hoặc 31.5.
  const raw = String(value ?? "").trim().replace(",", ".");
  // Nếu bỏ trống thì trả chuỗi rỗng để không ghi số.
  if (!raw) {
    return "";
  }
  // Chuyển sang number.
  const parsed = Number(raw);
  // Chặn dữ liệu không phải số hoặc số âm.
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Số lượng không hợp lệ: ${value}`);
  }
  // Trả số hợp lệ.
  return parsed;
}

// Kiểm tra một ô có trống hay không.
function isBlank(value) {
  return String(value || "").trim() === "";
}

// Đổi ngày từ website sang ngày hiển thị trong Sheet.
function toSheetDate(input) {
  // Không có ngày thì báo lỗi.
  if (!input) {
    throw new Error("Thiếu ngày đặt.");
  }

  // Nếu là yyyy-mm-dd từ input date.
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    // Tách năm tháng ngày.
    const [year, month, day] = input.split("-").map(Number);
    // Trả về d/m/yy giống Sheet.
    return `${day}/${month}/${String(year).slice(-2)}`;
  }

  // Nếu không phải dạng trên thì giữ nguyên sau khi trim.
  return String(input).trim();
}

// Chuẩn hóa ngày d/m/yy để so sánh.
function normalizeDate(value) {
  // Chuyển value thành text.
  const text = String(value || "").trim();
  // Bắt ngày dạng d/m/yy hoặc d/m/yyyy.
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  // Nếu không phải dạng ngày thì trả text gốc.
  if (!match) {
    return text;
  }
  // Lấy ngày.
  const day = Number(match[1]);
  // Lấy tháng.
  const month = Number(match[2]);
  // Lấy 2 số cuối của năm.
  const year = Number(match[3]) % 100;
  // Trả về dạng không có số 0 dư để dễ so sánh.
  return `${day}/${month}/${year}`;
}

// Đổi ngày thành số yyyymmdd để so thứ tự thời gian.
function dateKey(value) {
  // Chuyển input thành text.
  const text = String(value || "").trim();
  // Nếu là yyyy-mm-dd thì parse trực tiếp.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-").map(Number);
    return year * 10000 + month * 100 + day;
  }

  // Nếu là d/m/yy hoặc d/m/yyyy.
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  // Không parse được thì trả null.
  if (!match) {
    return null;
  }

  // Lấy ngày.
  const day = Number(match[1]);
  // Lấy tháng.
  const month = Number(match[2]);
  // Lấy năm.
  let year = Number(match[3]);
  // Nếu năm 2 chữ số thì hiểu là 20xx.
  if (year < 100) {
    year += 2000;
  }
  // Trả số yyyymmdd để so lớn nhỏ.
  return year * 10000 + month * 100 + day;
}

// Tính thứ trong tuần cho Sheet.
function weekdayForSheet(input) {
  // Chỉ tính tự động khi input là yyyy-mm-dd.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(input) ? new Date(`${input}T00:00:00+07:00`) : null;
  // Nếu ngày không hợp lệ thì trả rỗng.
  if (!date || Number.isNaN(date.getTime())) {
    return "";
  }
  // getDay trả 0 là chủ nhật, 1 là thứ hai...
  const day = date.getDay();
  // Chủ nhật thì ghi CN.
  if (day === 0) {
    return "CN";
  }
  // Thứ hai là T2, thứ ba là T3...
  return `T${day + 1}`;
}

// Kiểm tra email có được phép nhập hay không.
function assertAllowedUser(email) {
  // Đọc danh sách email được phép từ env, ngăn cách bằng dấu phẩy.
  const allowed = String(process.env.ALLOWED_USERS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  // Nếu chưa cấu hình ALLOWED_USERS thì tạm cho qua để dễ test.
  if (!allowed.length) {
    return;
  }

  // Nếu email không nằm trong danh sách thì chặn.
  if (!allowed.includes(String(email || "").trim().toLowerCase())) {
    throw new Error("Email này chưa được cấp quyền nhập liệu.");
  }
}

// Xuất các hàm để customers.js và orders.js dùng lại.
module.exports = {
  assertAllowedUser,
  batchUpdate,
  loadLocalEnv,
  batchUpdateValues,
  colToA1,
  dateKey,
  findHeader,
  getSheetIdByTitle,
  getValues,
  isBlank,
  jsonResponse,
  normalizeDate,
  normalizeText,
  parseNumber,
  sheetRange,
  toSheetDate,
  weekdayForSheet,
};
