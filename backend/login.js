const {
  createSessionToken,
  normalizeEmail,
  publicUser,
  sessionCookie,
  verifyPassword,
} = require("./_auth");
const {
  appendAudit,
  normalizeText,
  readDatabase,
  updateDatabase,
} = require("./_database");
const { jsonResponse } = require("./_sheets");
const { parseJsonBody } = require("./_validation");

const failedAttempts = new Map();
const loginBursts = new Map();
const LOGIN_BURST_WINDOW_MS = 10 * 1000;
const LOGIN_BURST_LIMIT = 3;
const FAILED_LOGIN_WINDOW_MS = 5 * 60 * 1000;
const FAILED_LOGIN_LIMIT = 5;

function clientIp(event) {
  const headers = event.headers || {};
  return String(
    headers["cf-connecting-ip"]
    || headers["x-forwarded-for"]
    || headers["client-ip"]
    || "local"
  ).split(",")[0].trim();
}

function clientKey(event, email) {
  return `${clientIp(event)}|${email}`;
}

function cleanupExpired(map, now) {
  if (map.size <= 5000) return;
  map.forEach((value, key) => {
    if (value.resetAt <= now) map.delete(key);
  });
}

function rateLimitError(message, retryAfter) {
  const error = new Error(message);
  error.statusCode = 429;
  error.retryAfter = retryAfter;
  return error;
}

function checkLoginBurst(event) {
  const now = Date.now();
  cleanupExpired(loginBursts, now);
  const key = clientIp(event);
  const current = loginBursts.get(key);
  if (!current || current.resetAt <= now) {
    loginBursts.set(key, { count: 1, resetAt: now + LOGIN_BURST_WINDOW_MS });
    return;
  }
  current.count += 1;
  if (current.count > LOGIN_BURST_LIMIT) {
    throw rateLimitError(
      "Bạn đăng nhập quá nhanh. Vui lòng chờ vài giây rồi thử lại.",
      Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    );
  }
}

function checkFailedLoginLimit(key) {
  const now = Date.now();
  cleanupExpired(failedAttempts, now);
  const current = failedAttempts.get(key);
  if (current && current.resetAt > now && current.count >= FAILED_LOGIN_LIMIT) {
    throw rateLimitError(
      "Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 5 phút.",
      Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    );
  }
}

function recordFailedLogin(key) {
  const now = Date.now();
  const current = failedAttempts.get(key);
  if (!current || current.resetAt <= now) {
    failedAttempts.set(key, { count: 1, resetAt: now + FAILED_LOGIN_WINDOW_MS });
    return;
  }
  current.count += 1;
  if (current.count >= FAILED_LOGIN_LIMIT) {
    throw rateLimitError(
      "Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 5 phút.",
      Math.max(1, Math.ceil((current.resetAt - now) / 1000))
    );
  }
}

function clearFailedLoginLimit(key) {
  failedAttempts.delete(key);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  try {
    checkLoginBurst(event);
    const payload = parseJsonBody(event);
    const email = normalizeEmail(payload.email);
    const password = String(payload.password || "");
    if (!email || email.length > 254 || password.length > 128) {
      return jsonResponse(400, { error: "Thông tin đăng nhập không hợp lệ." });
    }
    const key = clientKey(event, email);
    checkFailedLoginLimit(key);

    const database = await readDatabase();
    const user = (database.users || []).find((item) => normalizeText(item.email) === normalizeText(email));
    if (!user || !verifyPassword(password, user.passwordHash)) {
      recordFailedLogin(key);
      const error = new Error("Email hoặc mật khẩu không đúng.");
      error.statusCode = 401;
      throw error;
    }
    if (user.status === "pending") {
      const error = new Error("Tài khoản đang chờ quản lý phê duyệt.");
      error.statusCode = 403;
      throw error;
    }
    if (user.status !== "active") {
      const error = new Error("Tài khoản đã bị khóa.");
      error.statusCode = 403;
      throw error;
    }

    const token = createSessionToken(user);
    const result = { user: publicUser(user) };
    const recordLogin = () => updateDatabase((currentDatabase) => {
      const currentUser = (currentDatabase.users || []).find((item) => Number(item.id) === Number(user.id));
      if (!currentUser) return;
      currentUser.lastLoginAt = new Date().toISOString();
      appendAudit(currentDatabase, {
        action: "user-login",
        actorUserId: currentUser.id,
        actorEmail: currentUser.email,
        actorName: currentUser.displayName,
        summary: `${currentUser.displayName} đăng nhập hệ thống.`,
        details: {
          role: currentUser.role,
          ip: clientIp(event),
          userAgent: String(event.headers?.["user-agent"] || event.headers?.["User-Agent"] || ""),
        },
      });
    });
    if (typeof event.waitUntil === "function") {
      event.waitUntil(recordLogin().catch((error) => console.error("Không ghi được nhật ký đăng nhập:", error)));
    } else {
      await recordLogin();
    }
    clearFailedLoginLimit(key);
    return jsonResponse(200, result, { "set-cookie": sessionCookie(token) });
  } catch (error) {
    return jsonResponse(
      error.statusCode || 400,
      { error: error.message },
      error.retryAfter ? { "retry-after": String(error.retryAfter) } : {}
    );
  }
};
