const {
  createSessionToken,
  normalizeEmail,
  publicUser,
  verifyPassword,
} = require("./_auth");
const {
  appendAudit,
  normalizeText,
  readDatabase,
  updateDatabase,
} = require("./_database");
const { jsonResponse } = require("./_sheets");

const attempts = new Map();

function clientKey(event, email) {
  const headers = event.headers || {};
  const ip = String(headers["x-forwarded-for"] || headers["client-ip"] || "local").split(",")[0].trim();
  return `${ip}|${email}`;
}

function checkRateLimit(key) {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return;
  }
  current.count += 1;
  if (current.count > 8) {
    const error = new Error("Đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.");
    error.statusCode = 429;
    throw error;
  }
}

function clearRateLimit(key) {
  attempts.delete(key);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  try {
    const payload = JSON.parse(event.body || "{}");
    const email = normalizeEmail(payload.email);
    const password = String(payload.password || "");
    const key = clientKey(event, email);
    checkRateLimit(key);

    const database = await readDatabase();
    const user = (database.users || []).find((item) => normalizeText(item.email) === normalizeText(email));
    if (!user || !verifyPassword(password, user.passwordHash)) {
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

    const result = { token: createSessionToken(user), user: publicUser(user) };
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
          ip: clientKey(event, email).split("|")[0],
          userAgent: String(event.headers?.["user-agent"] || event.headers?.["User-Agent"] || ""),
        },
      });
    });
    if (typeof event.waitUntil === "function") {
      event.waitUntil(recordLogin().catch((error) => console.error("Không ghi được nhật ký đăng nhập:", error)));
    } else {
      await recordLogin();
    }
    clearRateLimit(key);
    return jsonResponse(200, result);
  } catch (error) {
    return jsonResponse(error.statusCode || 400, { error: error.message });
  }
};
