const handlers = {
  "audit-log": require("./audit-log").handler,
  "ban-giao": require("./ban-giao").handler,
  "giong-noi": require("./giong-noi").handler,
  crm: require("./crm").handler,
  customers: require("./customers").handler,
  "export-customer": require("./export-customer").handler,
  "export-customer-sheet": require("./export-customer-sheet").handler,
  "export-debts": require("./export-debts").handler,
  "google-oauth/callback": require("./google-oauth").handler,
  "google-oauth/start": require("./google-oauth").handler,
  login: require("./login").handler,
  logout: require("./logout").handler,
  orders: require("./orders").handler,
  payments: require("./payments").handler,
  "production-info": require("./production-info").handler,
  "production-plans": require("./production-plans").handler,
  register: require("./register").handler,
  session: require("./session").handler,
  users: require("./users").handler,
  version: require("./version").handler,
};

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(self), geolocation=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const MAX_BODY_BYTES = 1024 * 1024;
// Vercel giới hạn body 4,5MB; ảnh bàn giao được nén ở trình duyệt trước khi gửi.
const ROUTE_BODY_LIMITS = { "ban-giao": 4.5 * 1024 * 1024, "giong-noi": 4.5 * 1024 * 1024 };

function queryParameters(request) {
  const query = { ...(request.query || {}) };
  delete query.__path;
  Object.keys(query).forEach((key) => {
    if (Array.isArray(query[key])) query[key] = query[key][0];
  });
  return query;
}

function requestBody(request) {
  if (request.body === undefined || request.body === null) return "";
  if (Buffer.isBuffer(request.body)) return request.body.toString("utf8");
  return typeof request.body === "string" ? request.body : JSON.stringify(request.body);
}

function eventPath(route) {
  return `/api/${route}`;
}

function requestOrigin(request) {
  const protocol = request.headers["x-forwarded-proto"] || "https";
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  return host ? `${protocol}://${host}` : "";
}

function sendResult(response, result) {
  response.statusCode = Number(result.statusCode || 200);
  Object.entries({ ...SECURITY_HEADERS, ...(result.headers || {}) }).forEach(([name, value]) => {
    response.setHeader(name, value);
  });
  const body = result.isBase64Encoded
    ? Buffer.from(result.body || "", "base64")
    : result.body || "";
  response.end(body);
}

async function handleVercelRequest(request, response) {
  const route = String(request.query?.__path || "").replace(/^\/+|\/+$/g, "");
  const handler = handlers[route];
  if (!handler) {
    return sendResult(response, {
      statusCode: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "API không tồn tại." }),
    });
  }

  try {
    const body = requestBody(request);
    if (Buffer.byteLength(body) > (ROUTE_BODY_LIMITS[route] || MAX_BODY_BYTES)) {
      return sendResult(response, {
        statusCode: 413,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Dữ liệu gửi lên quá lớn." }),
      });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin && origin !== requestOrigin(request)) {
        return sendResult(response, {
          statusCode: 403,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ error: "Nguồn yêu cầu không hợp lệ." }),
        });
      }
      const contentType = String(request.headers["content-type"] || "").toLowerCase();
      if (!contentType.startsWith("application/json")) {
        return sendResult(response, {
          statusCode: 415,
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ error: "API chỉ chấp nhận dữ liệu JSON." }),
        });
      }
    }

    return sendResult(response, await handler({
      body,
      headers: request.headers,
      httpMethod: request.method,
      isBase64Encoded: false,
      path: eventPath(route),
      queryStringParameters: queryParameters(request),
      rawQuery: new URL(request.url, requestOrigin(request) || "https://localhost").searchParams.toString(),
      rawUrl: `${requestOrigin(request)}${request.url}`,
    }));
  } catch (error) {
    console.error(error);
    return sendResult(response, {
      statusCode: Number(error.statusCode || 500),
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "Máy chủ gặp lỗi. Vui lòng thử lại." }),
    });
  }
}

module.exports = { handleVercelRequest };
