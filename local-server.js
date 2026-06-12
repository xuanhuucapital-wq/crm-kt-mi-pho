// Local server nhỏ để test thay cho netlify dev khi Netlify CLI lỗi Node version.
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const publicDir = path.join(root, "public");
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) {
        reject(new Error("Request body quá lớn."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleFunction(req, res, name) {
  try {
    const mod = require(path.join(root, "netlify/functions", name));
    const body = await readBody(req);
    const result = await mod.handler({
      httpMethod: req.method,
      headers: req.headers,
      body,
      queryStringParameters: Object.fromEntries(new URL(req.url, "http://localhost").searchParams),
    });
    res.writeHead(result.statusCode || 200, {
      "cache-control": "no-store",
      ...(result.headers || { "content-type": "application/json; charset=utf-8" }),
    });
    res.end(result.isBase64Encoded ? Buffer.from(result.body || "", "base64") : (result.body || ""));
  } catch (error) {
    console.error("Local function error:", error);
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Máy chủ gặp lỗi nội bộ." }));
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/login") {
    return handleFunction(req, res, "login");
  }
  if (url.pathname === "/api/register") {
    return handleFunction(req, res, "register");
  }
  if (url.pathname === "/api/logout") {
    return handleFunction(req, res, "logout");
  }
  if (url.pathname === "/api/users") {
    return handleFunction(req, res, "users");
  }
  if (url.pathname === "/api/audit-log") {
    return handleFunction(req, res, "audit-log");
  }
  if (url.pathname === "/api/customers") {
    return handleFunction(req, res, "customers");
  }
  if (url.pathname === "/api/orders") {
    return handleFunction(req, res, "orders");
  }
  if (url.pathname === "/api/crm") {
    return handleFunction(req, res, "crm");
  }
  if (url.pathname === "/api/production-info") {
    return handleFunction(req, res, "production-info");
  }
  if (url.pathname === "/api/payments") {
    return handleFunction(req, res, "payments");
  }
  if (url.pathname === "/api/export-debts") {
    return handleFunction(req, res, "export-debts");
  }

  let filePath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  filePath = path.normalize(filePath).replace(/^\.\.(\/|\\|$)/, "");
  const fullPath = path.join(publicDir, filePath);

  if (!fullPath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(fullPath, (error, data) => {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    res.writeHead(200, {
      "content-type": mime[path.extname(fullPath)] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    res.end(data);
  });
});

const port = Number(process.env.PORT || 8888);
const host = process.env.HOST || "127.0.0.1";
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
if (!loopbackHosts.has(host) && process.env.LOCAL_ALLOW_NETWORK !== "true") {
  throw new Error("Từ chối mở local server ra mạng LAN. Đặt LOCAL_ALLOW_NETWORK=true nếu thật sự cần.");
}
server.listen(port, host, () => {
  console.log(`Local server ready: http://${host}:${port}`);
});
