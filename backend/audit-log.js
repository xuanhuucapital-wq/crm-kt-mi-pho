const { authErrorResponse, requireBusinessUnit, requireRole } = require("./_auth");
const { normalizeBusinessUnit, normalizeText, readDatabase } = require("./_database");
const { jsonResponse } = require("./_sheets");

exports.handler = async (event) => {
  try {
    const manager = await requireRole(event, "manager");
    if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method not allowed" });
    const database = await readDatabase();
    const businessUnit = requireBusinessUnit(manager, event.queryStringParameters?.businessUnit);
    const query = normalizeText(event.queryStringParameters?.search || "");
    const action = String(event.queryStringParameters?.action || "").trim();
    const limit = Math.min(500, Math.max(20, Number(event.queryStringParameters?.limit || 200)));
    const storedEntries = database.auditLog || [];
    const legacyLoginEntries = (database.users || [])
      .filter((user) => (
        user.lastLoginAt
        && !storedEntries.some((entry) => (
          entry.action === "user-login"
          && Number(entry.actorUserId) === Number(user.id)
        ))
      ))
      .map((user) => ({
        id: `legacy-login-${user.id}`,
        action: "user-login",
        actorUserId: user.id,
        actorEmail: user.email,
        actorName: user.displayName,
        summary: `${user.displayName} đăng nhập hệ thống.`,
        details: { role: user.role, importedLastLogin: true },
        createdAt: user.lastLoginAt,
      }));
    const allEntries = [...storedEntries, ...legacyLoginEntries]
      .sort((first, second) => String(second.createdAt || "").localeCompare(String(first.createdAt || "")));
    const entries = allEntries.filter((entry) => {
      if (entry.businessUnit && normalizeBusinessUnit(entry.businessUnit) !== businessUnit) return false;
      if (action && entry.action !== action) return false;
      if (!query) return true;
      return normalizeText([
        entry.actorEmail,
        entry.actorName,
        entry.action,
        entry.summary,
        JSON.stringify(entry.details || {}),
      ].join(" ")).includes(query);
    }).slice(0, limit);
    return jsonResponse(200, { entries, total: allEntries.length });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(400, { error: error.message });
  }
};
