import loginFunction from "../backend/login.js";
import registerFunction from "../backend/register.js";
import logoutFunction from "../backend/logout.js";
import crmFunction from "../backend/crm.js";
import customersFunction from "../backend/customers.js";
import ordersFunction from "../backend/orders.js";
import paymentsFunction from "../backend/payments.js";
import productionInfoFunction from "../backend/production-info.js";
import usersFunction from "../backend/users.js";
import auditLogFunction from "../backend/audit-log.js";
import exportDebtsFunction from "../backend/export-debts.js";
import exportCustomerFunction from "../backend/export-customer.js";
import sessionFunction from "../backend/session.js";

const apiRoutes = {
  "/api/login": loginFunction.handler,
  "/api/register": registerFunction.handler,
  "/api/logout": logoutFunction.handler,
  "/api/crm": crmFunction.handler,
  "/api/customers": customersFunction.handler,
  "/api/orders": ordersFunction.handler,
  "/api/payments": paymentsFunction.handler,
  "/api/production-info": productionInfoFunction.handler,
  "/api/users": usersFunction.handler,
  "/api/audit-log": auditLogFunction.handler,
  "/api/export-debts": exportDebtsFunction.handler,
  "/api/export-customer": exportCustomerFunction.handler,
  "/api/session": sessionFunction.handler,
};

const securityHeaders = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const MAX_API_BODY_BYTES = 64 * 1024;
const rateLimits = new Map();
const apiRateLimitRules = {
  "/api/login": [
    { name: "burst", windowMs: 10 * 1000, limit: 3 },
    { name: "sustained", windowMs: 15 * 60 * 1000, limit: 20 },
  ],
  "/api/register": [
    { name: "burst", windowMs: 60 * 1000, limit: 5 },
    { name: "sustained", windowMs: 15 * 60 * 1000, limit: 10 },
  ],
  default: [
    { name: "sustained", windowMs: 60 * 1000, limit: 180 },
  ],
};

function jsonError(statusCode, message, extraHeaders = {}) {
  return workerResponse({
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
    body: JSON.stringify({ error: message }),
  });
}

function clientIp(request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0].trim()
    || "unknown";
}

function rateLimit(request, pathname) {
  const now = Date.now();
  if (rateLimits.size > 5000) {
    rateLimits.forEach((value, key) => {
      if (value.resetAt <= now) rateLimits.delete(key);
    });
  }
  const rules = apiRateLimitRules[pathname] || apiRateLimitRules.default;
  let retryAfter = 0;
  rules.forEach((rule) => {
    const key = `${clientIp(request)}|${pathname}|${rule.name}`;
    const current = rateLimits.get(key);
    if (!current || current.resetAt <= now) {
      rateLimits.set(key, { count: 1, resetAt: now + rule.windowMs });
      return;
    }
    current.count += 1;
    if (current.count > rule.limit) {
      retryAfter = Math.max(retryAfter, Math.ceil((current.resetAt - now) / 1000));
    }
  });
  if (retryAfter) {
    return Math.max(1, retryAfter);
  }
  return null;
}

function validateApiRequest(request, url) {
  const retryAfter = rateLimit(request, url.pathname);
  if (retryAfter) {
    return jsonError(429, "Bạn thao tác quá nhanh. Vui lòng thử lại sau.", {
      "retry-after": String(retryAfter),
    });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) {
      return jsonError(403, "Nguồn yêu cầu không hợp lệ.");
    }
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return jsonError(415, "API chỉ chấp nhận dữ liệu JSON.");
    }
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_API_BODY_BYTES) {
      return jsonError(413, "Dữ liệu gửi lên quá lớn.");
    }
  }
  return null;
}

function applyEnvironment(env) {
  Object.entries(env).forEach(([key, value]) => {
    if (typeof value === "string") process.env[key] = value;
  });
}

async function handlerEvent(request, url, context) {
  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const body = ["GET", "HEAD"].includes(request.method) ? null : await request.text();
  if (body && new TextEncoder().encode(body).byteLength > MAX_API_BODY_BYTES) {
    const error = new Error("Dữ liệu gửi lên quá lớn.");
    error.statusCode = 413;
    throw error;
  }
  return {
    body,
    headers,
    httpMethod: request.method,
    isBase64Encoded: false,
    path: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    rawQuery: url.searchParams.toString(),
    rawUrl: request.url,
    waitUntil: (promise) => context.waitUntil(promise),
  };
}

function workerResponse(result) {
  const headers = new Headers(result.headers || {});
  headers.set("cache-control", headers.get("cache-control") || "no-store");
  Object.entries(securityHeaders).forEach(([name, value]) => headers.set(name, value));
  const body = result.isBase64Encoded
    ? Uint8Array.from(atob(result.body || ""), (character) => character.charCodeAt(0))
    : result.body || "";
  return new Response(body, {
    status: Number(result.statusCode || 200),
    headers,
  });
}

async function handleApi(request, env, url, context) {
  const invalidRequest = validateApiRequest(request, url);
  if (invalidRequest) return invalidRequest;
  const handler = apiRoutes[url.pathname];
  if (!handler) {
    return workerResponse({
      statusCode: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "API không tồn tại." }),
    });
  }
  applyEnvironment(env);
  return workerResponse(await handler(await handlerEvent(request, url, context)));
}

async function handleAsset(request, env) {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  Object.entries(securityHeaders).forEach(([name, value]) => headers.set(name, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    try {
      if (url.protocol !== "https:" && env.NODE_ENV === "production") {
        url.protocol = "https:";
        return Response.redirect(url.toString(), 308);
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url, context);
      }
      return await handleAsset(request, env);
    } catch (error) {
      console.error(error);
      return workerResponse({
        statusCode: Number(error.statusCode || 500),
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Máy chủ gặp lỗi. Vui lòng thử lại." }),
      });
    }
  },
};
