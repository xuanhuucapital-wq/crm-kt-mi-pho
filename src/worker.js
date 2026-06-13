import loginFunction from "../netlify/functions/login.js";
import registerFunction from "../netlify/functions/register.js";
import logoutFunction from "../netlify/functions/logout.js";
import crmFunction from "../netlify/functions/crm.js";
import customersFunction from "../netlify/functions/customers.js";
import ordersFunction from "../netlify/functions/orders.js";
import paymentsFunction from "../netlify/functions/payments.js";
import productionInfoFunction from "../netlify/functions/production-info.js";
import usersFunction from "../netlify/functions/users.js";
import auditLogFunction from "../netlify/functions/audit-log.js";
import exportDebtsFunction from "../netlify/functions/export-debts.js";

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
};

const securityHeaders = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function applyEnvironment(env) {
  Object.entries(env).forEach(([key, value]) => {
    if (typeof value === "string") process.env[key] = value;
  });
}

async function netlifyEvent(request, url) {
  const headers = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return {
    body: ["GET", "HEAD"].includes(request.method) ? null : await request.text(),
    headers,
    httpMethod: request.method,
    isBase64Encoded: false,
    path: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    rawQuery: url.searchParams.toString(),
    rawUrl: request.url,
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

async function handleApi(request, env, url) {
  const handler = apiRoutes[url.pathname];
  if (!handler) {
    return workerResponse({
      statusCode: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "API không tồn tại." }),
    });
  }
  applyEnvironment(env);
  return workerResponse(await handler(await netlifyEvent(request, url)));
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
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(request, env, url);
      }
      return await handleAsset(request, env);
    } catch (error) {
      console.error(error);
      return workerResponse({
        statusCode: 500,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ error: "Máy chủ gặp lỗi. Vui lòng thử lại." }),
      });
    }
  },
};
