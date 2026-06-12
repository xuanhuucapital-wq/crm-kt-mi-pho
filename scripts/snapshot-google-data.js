const fs = require("fs");
const path = require("path");
const { createSessionToken } = require("../netlify/functions/_auth");
const { readDatabase } = require("../netlify/functions/_database");
const crm = require("../netlify/functions/crm");
const productionInfo = require("../netlify/functions/production-info");

async function call(handler) {
  const manager = ((await readDatabase()).users || []).find((user) => user.role === "manager" && user.status === "active");
  if (!manager) throw new Error("Cần một tài khoản quản lý đang hoạt động để chạy snapshot.");
  const token = createSessionToken(manager);
  const response = await handler({
    httpMethod: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  const body = JSON.parse(response.body || "{}");
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(body.error || `API trả về HTTP ${response.statusCode}`);
  }
  return body;
}

async function main() {
  const [crmData, productionData] = await Promise.all([
    call(crm.handler),
    call(productionInfo.handler),
  ]);
  const snapshot = {
    syncedAt: new Date().toISOString(),
    source: "google-sheets",
    crm: crmData,
    productionInfo: productionData,
  };
  const outputDir = path.join(__dirname, "..", "data");
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "crm-snapshot.json"), serialized);
  console.log(JSON.stringify({
    syncedAt: snapshot.syncedAt,
    customers: crmData.customers?.length || 0,
    orders: crmData.orders?.length || 0,
    productionEntries: productionData.entries?.length || 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
