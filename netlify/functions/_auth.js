// Module crypto dùng để hash password và ký token đăng nhập.
const crypto = require("crypto");
// Dùng jsonResponse để trả lỗi JSON thống nhất.
const { jsonResponse } = require("./_sheets");

// Salt dùng để hash password trong file này.
const PASSWORD_SALT = "nhap-lieu-mi-v1";
// Secret dùng để ký token đăng nhập; khi deploy nên đổi bằng env APP_AUTH_SECRET.
const TOKEN_SECRET = process.env.APP_AUTH_SECRET || "doi-secret-nay-khi-deploy";
// Token có hiệu lực trong 7 ngày.
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Danh sách tài khoản nội bộ.
// Password không lưu dạng chữ thường, chỉ lưu hash.
// Muốn đổi password: tạo hash mới bằng hàm hashPassword rồi thay passwordHash.
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

// Hash password theo cùng cách đã dùng để tạo passwordHash.
function hashPassword(password) {
  return crypto.createHash("sha256").update(`${PASSWORD_SALT}|${password}`).digest("hex");
}

// Chuyển dữ liệu sang base64url để làm token.
function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// Ký dữ liệu token để người dùng không tự sửa username/role được.
function signPayload(payload) {
  return crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("base64url");
}

// Tạo token đăng nhập cho user.
function createSessionToken(user) {
  const payload = {
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    email: user.email,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = signPayload(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

// Xác minh token đăng nhập.
function verifySessionToken(token) {
  if (!token || !token.includes(".")) {
    throw new Error("Vui lòng đăng nhập trước khi ghi nhận số lượng.");
  }

  const [encodedPayload, signature] = token.split(".");
  const expectedSignature = signPayload(encodedPayload);

  if (Buffer.byteLength(signature) !== Buffer.byteLength(expectedSignature)) {
    throw new Error("Phiên đăng nhập không hợp lệ.");
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    throw new Error("Phiên đăng nhập không hợp lệ.");
  }

  const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Date.now()) {
    throw new Error("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.");
  }

  return payload;
}

// Lấy token từ header Authorization: Bearer ...
function getBearerToken(event) {
  const headers = event.headers || {};
  const authorization = headers.authorization || headers.Authorization || "";
  return authorization.replace(/^Bearer\s+/i, "").trim();
}

// Kiểm tra request đã đăng nhập chưa.
function requireAuth(event) {
  const token = getBearerToken(event);
  return verifySessionToken(token);
}

// Middleware đơn giản: nếu chưa login thì trả lỗi 401.
function authErrorResponse(error) {
  return jsonResponse(401, { error: error.message });
}

module.exports = {
  USERS,
  authErrorResponse,
  createSessionToken,
  hashPassword,
  requireAuth,
};
