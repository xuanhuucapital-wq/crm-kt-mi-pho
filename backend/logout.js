const { authErrorResponse, clearSessionCookie, requireAuth } = require("./_auth");
const { appendAudit, updateDatabase } = require("./_database");
const { jsonResponse } = require("./_sheets");
const { parseJsonBody } = require("./_validation");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  try {
    const sessionUser = await requireAuth(event);
    const payload = parseJsonBody(event);
    const pageExit = payload.reason === "page-exit";
    if (pageExit) {
      return jsonResponse(200, { ok: true });
    }
    await updateDatabase((database) => {
      const user = (database.users || []).find((item) => Number(item.id) === Number(sessionUser.id));
      if (user) user.tokenVersion = Number(user.tokenVersion || 0) + 1;
      appendAudit(database, {
        action: "user-logout",
        actorUserId: sessionUser.id,
        actorEmail: sessionUser.email,
        actorName: sessionUser.displayName,
        summary: `${sessionUser.displayName} đăng xuất hệ thống.`,
        details: {
          role: sessionUser.role,
          reason: "explicit-logout",
          ip: String(event.headers?.["x-forwarded-for"] || event.headers?.["client-ip"] || "local").split(",")[0].trim(),
          userAgent: String(event.headers?.["user-agent"] || event.headers?.["User-Agent"] || ""),
        },
      });
    });
    return jsonResponse(
      200,
      { ok: true },
      { "set-cookie": clearSessionCookie() },
    );
  } catch (error) {
    if (error.statusCode) {
      const response = authErrorResponse(error);
      response.headers["set-cookie"] = clearSessionCookie();
      return response;
    }
    return jsonResponse(400, { error: error.message });
  }
};
