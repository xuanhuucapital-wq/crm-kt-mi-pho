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
    });
    res.writeHead(result.statusCode || 200, result.headers || { "content-type": "application/json; charset=utf-8" });
    res.end(result.body || "");
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message }));
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/login") {
    return handleFunction(req, res, "login");
  }
  if (url.pathname === "/api/customers") {
    return handleFunction(req, res, "customers");
  }
  if (url.pathname === "/api/orders") {
    return handleFunction(req, res, "orders");
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
    res.writeHead(200, { "content-type": mime[path.extname(fullPath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(8888, "0.0.0.0", () => {
  console.log("Local server ready: http://localhost:8888");
});
