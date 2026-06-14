const crypto = require("crypto");
const { readDatabase } = require("./_database");
const { jsonResponse, loadLocalEnv } = require("./_sheets");

loadLocalEnv();

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const SESSION_COOKIE = "crm_session";
let developmentSecret = "";

function authError(message, statusCode = 401) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function tokenSecret() {
  if (process.env.APP_AUTH_SECRET) {
    if (process.env.NODE_ENV === "production" && process.env.APP_AUTH_SECRET.length < 64) {
      throw authError("APP_AUTH_SECRET phải có ít nhất 64 ký tự.", 500);
    }
    return process.env.APP_AUTH_SECRET;
  }
  if (process.env.NODE_ENV === "production") {
    throw authError("Máy chủ chưa cấu hình APP_AUTH_SECRET.", 500);
  }
  if (!developmentSecret) developmentSecret = crypto.randomBytes(32).toString("hex");
  return developmentSecret;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function validatePassword(password) {
  const value = String(password || "");
  return value.length >= 10 && value.length <= 128 && /[a-zA-Z]/.test(value) && /\d/.test(value);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, encoded) {
  const [algorithm, salt, expected] = String(encoded || "").split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function signPayload(payload) {
  return crypto.createHmac("sha256", tokenSecret()).update(payload).digest("base64url");
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    approvedAt: user.approvedAt || "",
    lastLoginAt: user.lastLoginAt || "",
    businessUnits: Array.isArray(user.businessUnits) && user.businessUnits.length
      ? user.businessUnits
      : ["mi", "pho"],
  };
}

function requireBusinessUnit(user, value) {
  const businessUnit = ["mi", "pho"].includes(String(value || "").toLowerCase())
    ? String(value).toLowerCase()
    : "mi";
  if (!(user.businessUnits || ["mi", "pho"]).includes(businessUnit)) {
    throw authError("Tài khoản không có quyền truy cập phân hệ này.", 403);
  }
  return businessUnit;
}

function createSessionToken(user) {
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    tokenVersion: Number(user.tokenVersion || 0),
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const encodedPayload = base64Url(JSON.stringify(payload));
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes(".")) throw authError("Vui lòng đăng nhập.");
  const parts = token.split(".");
  if (parts.length !== 2) throw authError("Phiên đăng nhập không hợp lệ.");
  const [encodedPayload, signature] = parts;
  const expectedSignature = signPayload(encodedPayload);
  if (
    signature.length !== expectedSignature.length
    || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  ) {
    throw authError("Phiên đăng nhập không hợp lệ.");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw authError("Phiên đăng nhập không hợp lệ.");
  }
  if (!payload.exp || payload.exp < Date.now()) {
    throw authError("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.");
  }
  if (!Number.isInteger(Number(payload.sub)) || !payload.email || !payload.role) {
    throw authError("Phiên đăng nhập không hợp lệ.");
  }
  return payload;
}

function getBearerToken(event) {
  const headers = event.headers || {};
  return String(headers.authorization || headers.Authorization || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function getCookieToken(event) {
  const headers = event.headers || {};
  const cookie = String(headers.cookie || headers.Cookie || "");
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

function sessionCookie(token) {
  const maxAge = Math.floor(TOKEN_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

async function requireAuth(event) {
  const payload = verifySessionToken(getCookieToken(event) || getBearerToken(event));
  const database = await readDatabase();
  const user = (database.users || []).find((item) => Number(item.id) === Number(payload.sub));
  if (!user || user.status !== "active") {
    throw authError("Tài khoản chưa được duyệt hoặc đã bị khóa.", 403);
  }
  if (Number(user.tokenVersion || 0) !== Number(payload.tokenVersion || 0)) {
    throw authError("Quyền tài khoản đã thay đổi, vui lòng đăng nhập lại.");
  }
  return { ...publicUser(user), tokenVersion: Number(user.tokenVersion || 0) };
}

async function requireRole(event, roles) {
  const user = await requireAuth(event);
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(user.role)) throw authError("Bạn không có quyền thực hiện thao tác này.", 403);
  return user;
}

function authErrorResponse(error) {
  return jsonResponse(error.statusCode || 401, { error: error.message });
}

module.exports = {
  authError,
  authErrorResponse,
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  normalizeEmail,
  publicUser,
  requireBusinessUnit,
  requireAuth,
  requireRole,
  sessionCookie,
  validateEmail,
  validatePassword,
  verifyPassword,
};
