const {
  authErrorResponse,
  createSessionToken,
  publicUser,
  requireAuth,
  sessionCookie,
} = require("./_auth");
const { jsonResponse } = require("./_sheets");

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method not allowed" });
  try {
    const authenticatedUser = await requireAuth(event);
    return jsonResponse(
      200,
      { user: publicUser(authenticatedUser) },
      { "set-cookie": sessionCookie(createSessionToken(authenticatedUser)) },
    );
  } catch (error) {
    if (error.statusCode) {
      const response = authErrorResponse(error);
      response.headers["set-cookie"] = "crm_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
      return response;
    }
    return jsonResponse(500, { error: "Không kiểm tra được phiên đăng nhập." });
  }
};
