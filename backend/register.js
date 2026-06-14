const {
  hashPassword,
  normalizeEmail,
  publicUser,
  validateEmail,
  validatePassword,
} = require("./_auth");
const { appendAudit, nextId, normalizeText, updateDatabase } = require("./_database");
const { jsonResponse } = require("./_sheets");
const { boundedString, parseJsonBody } = require("./_validation");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  try {
    const payload = parseJsonBody(event);
    const email = normalizeEmail(payload.email);
    const displayName = boundedString(payload.displayName, "họ tên", 100, { required: true });
    const password = String(payload.password || "");
    if (!validateEmail(email)) return jsonResponse(400, { error: "Email không hợp lệ." });
    if (email.length > 254) return jsonResponse(400, { error: "Email quá dài." });
    if (!validatePassword(password)) {
      return jsonResponse(400, { error: "Mật khẩu cần ít nhất 10 ký tự, gồm chữ và số." });
    }

    const user = await updateDatabase((database) => {
      const users = database.users || (database.users = []);
      if (users.some((item) => normalizeText(item.email) === normalizeText(email))) {
        const error = new Error("Email này đã được đăng ký.");
        error.statusCode = 409;
        throw error;
      }
      const firstAccount = users.length === 0;
      const configuredManagerEmail = normalizeEmail(process.env.CRM_ADMIN_EMAIL);
      const mayBootstrapManager = firstAccount && (
        process.env.ALLOW_ADMIN_BOOTSTRAP === "true"
        && configuredManagerEmail
        && email === configuredManagerEmail
      );
      const created = {
        id: nextId(users),
        email,
        displayName,
        passwordHash: hashPassword(password),
        role: mayBootstrapManager ? "manager" : "delivery",
        status: mayBootstrapManager ? "active" : "pending",
        tokenVersion: 0,
        businessUnits: ["mi", "pho"],
        createdAt: new Date().toISOString(),
        approvedAt: mayBootstrapManager ? new Date().toISOString() : "",
        approvedBy: mayBootstrapManager ? "local-bootstrap" : "",
      };
      users.push(created);
      appendAudit(database, {
        action: "user-registered",
        actorUserId: created.id,
        actorEmail: created.email,
        actorName: created.displayName,
        summary: `${created.displayName} đăng ký tài khoản.`,
        details: { role: created.role, status: created.status, businessUnits: created.businessUnits },
      });
      return created;
    });

    return jsonResponse(201, {
      ok: true,
      user: publicUser(user),
      message: user.status === "active"
        ? "Đã tạo tài khoản quản lý đầu tiên. Bạn có thể đăng nhập."
        : "Đã gửi đăng ký. Vui lòng chờ quản lý phê duyệt.",
    });
  } catch (error) {
    return jsonResponse(error.statusCode || 400, { error: error.message });
  }
};
