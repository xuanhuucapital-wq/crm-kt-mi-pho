const { authErrorResponse, requireAuth } = require("./_auth");
const { appendAudit, updateDatabase } = require("./_database");
const { jsonResponse } = require("./_sheets");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return jsonResponse(405, { error: "Method not allowed" });
  try {
    const sessionUser = await requireAuth(event);
    const payload = JSON.parse(event.body || "{}");
    const pageExit = payload.reason === "page-exit";
    await updateDatabase((database) => {
      const user = (database.users || []).find((item) => Number(item.id) === Number(sessionUser.id));
      if (!pageExit && user) user.tokenVersion = Number(user.tokenVersion || 0) + 1;
      appendAudit(database, {
        action: pageExit ? "user-page-exit" : "user-logout",
        actorUserId: sessionUser.id,
        actorEmail: sessionUser.email,
        actorName: sessionUser.displayName,
        summary: pageExit
          ? `${sessionUser.displayName} rời trang hoặc đóng tab CRM.`
          : `${sessionUser.displayName} đăng xuất hệ thống.`,
        details: {
          role: sessionUser.role,
          reason: pageExit ? "page-exit" : "explicit-logout",
          ip: String(event.headers?.["x-forwarded-for"] || event.headers?.["client-ip"] || "local").split(",")[0].trim(),
          userAgent: String(event.headers?.["user-agent"] || event.headers?.["User-Agent"] || ""),
        },
      });
    });
    return jsonResponse(200, { ok: true });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(400, { error: error.message });
  }
};
