const { jsonResponse, loadLocalEnv } = require("./_sheets");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

function env(name) {
  loadLocalEnv();
  return String(process.env[name] || "").trim();
}

function redirectUri(event) {
  return env("GOOGLE_OAUTH_REDIRECT_URI") || `${event.headers["x-forwarded-proto"] || "https"}://${event.headers.host}/api/google-oauth/callback`;
}

function htmlResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
    body,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tokenPage({ refreshToken, accessToken, scope }) {
  const envLine = refreshToken ? `GOOGLE_OAUTH_REFRESH_TOKEN=${refreshToken}` : "";
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Google OAuth token</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; line-height: 1.5; color: #12352e; }
    code, textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    textarea { width: min(960px, 100%); height: 120px; padding: 12px; }
    .box { border: 1px solid #d7e3df; border-radius: 8px; padding: 16px; max-width: 1000px; }
  </style>
</head>
<body>
  <h1>Google OAuth đã kết nối</h1>
  <div class="box">
    ${refreshToken ? `
      <p>Dán dòng này vào file/env production rồi restart server:</p>
      <textarea readonly>${escapeHtml(envLine)}</textarea>
      <p>Sau đó app sẽ dùng Gmail của bạn để tạo Google Sheet mới.</p>
    ` : `
      <p>Google chưa trả refresh token. Hãy mở lại <code>/api/google-oauth/start</code> và chọn Allow. Nếu vẫn không có, hãy xóa quyền app trong Google Account rồi cấp lại.</p>
      <p>Access token tạm thời đã có: <code>${accessToken ? "có" : "không"}</code></p>
    `}
    <p>Scope: <code>${escapeHtml(scope || SCOPES.join(" "))}</code></p>
  </div>
</body>
</html>`;
}

async function start(event) {
  const clientId = env("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = env("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return jsonResponse(400, {
      error: "Thiếu GOOGLE_OAUTH_CLIENT_ID hoặc GOOGLE_OAUTH_CLIENT_SECRET trong env.",
    });
  }
  const url = new URL(AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri(event));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  return {
    statusCode: 302,
    headers: {
      location: url.toString(),
      "cache-control": "no-store",
    },
    body: "",
  };
}

async function callback(event) {
  const params = event.queryStringParameters || {};
  if (params.error) {
    return jsonResponse(400, { error: params.error_description || params.error });
  }
  const code = String(params.code || "").trim();
  if (!code) return jsonResponse(400, { error: "Thiếu OAuth code từ Google." });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env("GOOGLE_OAUTH_CLIENT_ID"),
      client_secret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
      redirect_uri: redirectUri(event),
      grant_type: "authorization_code",
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    return jsonResponse(400, {
      error: data.error_description || data.error || "Google OAuth token exchange failed",
    });
  }
  return htmlResponse(200, tokenPage({
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    scope: data.scope,
  }));
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method not allowed" });
  try {
    const path = event.path || "";
    if (path.endsWith("/callback")) return callback(event);
    return start(event);
  } catch (error) {
    return jsonResponse(500, { error: error.message || "Google OAuth failed" });
  }
};
