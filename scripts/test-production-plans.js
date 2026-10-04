process.env.CRM_DATABASE_PATH = process.argv[2];

const { createSessionToken, hashPassword } = require("../backend/_auth");
const { readDatabase, updateDatabase } = require("../backend/_database");
const plans = require("../backend/production-plans");

async function call(token, method, body, query = {}) {
  const response = await plans.handler({
    httpMethod: method,
    headers: { authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    queryStringParameters: { businessUnit: "mi", ...query },
  });
  return { status: response.statusCode, data: JSON.parse(response.body || "{}") };
}

function user(id, role) {
  return {
    id, email: `plan-${role}@example.com`, displayName: `Plan ${role}`, passwordHash: hashPassword("TestPassword123"),
    role, status: "active", tokenVersion: 0, businessUnits: ["mi", "pho"], createdAt: new Date().toISOString(),
  };
}

// Đơn 28/09: 3 mẻ DA (32 + 23 + 25) và 2 mẻ MÌ (33 + 33); mới cân được 14 kg hoành thánh.
const PLAN = {
  date: "2026-09-28",
  batches: [
    { label: "1", group: "DA", name: "cảo dày", kgTron: 32, products: [
      { name: "Cảo dày", outputs: [{ customer: "m29 châu đốc", qty: 30 }, { customer: "49c2", qty: 2, pack: "gói giấy" }] }] },
    { label: "2", group: "DA", name: "cảo dày", kgTron: 23, products: [
      { name: "Cảo dày", outputs: [{ customer: "m29 long xuyên" }, { customer: "m23", optional: true }] }] },
    { label: "3", group: "DA", name: "da cảo mỏng", kgTron: 25, products: [
      { name: "Cảo thường", kgTron: 9, outputs: [{ customer: "KM", qty: 5 }, { customer: "49c2", qty: 4 }] },
      { name: "Hoành thánh size 9", kgTron: 16, finishedKg: 14, outputs: [{ customer: "m28", qty: 12, qtyMax: 13 }] }] },
    { label: "4", group: "MI", name: "mì", kgTron: 33, products: [{ name: "Mì sợi nhỏ", outputs: [] }] },
    { label: "5", group: "MI", name: "mì", kgTron: 33, products: [
      { name: "Mì sợi nhỏ", outputs: [{ customer: "m29 châu đốc", qty: 18, unit: "gói", pack: "thùng" }] }] },
  ],
};

async function main() {
  const [manager, packer] = await updateDatabase((database) => {
    database.users = database.users || [];
    const created = [user(9101, "manager"), user(9102, "packer")];
    database.users.push(...created);
    return created;
  });
  const managerToken = createSessionToken(manager);
  const packerToken = createSessionToken(packer);
  const checks = {};

  const saved = await call(managerToken, "PUT", PLAN);
  checks.saveOk = saved.status === 200;
  checks.summary = saved.data.summary?.DA?.tron === 80 && saved.data.summary?.MI?.tron === 66
    && saved.data.summary?.DA?.thanhPham === 14 && saved.data.summary?.DA?.chuaCan === 3 && saved.data.summary?.MI?.chuaCan === 2;

  const again = await call(managerToken, "PUT", { ...PLAN, note: "sửa lần 2" });
  const db = await readDatabase();
  checks.onePerDay = db.productionPlans.filter((p) => p.date === "2026-09-28" && p.businessUnit === "mi").length === 1 && again.status === 200;
  checks.audit = db.auditLog.some((entry) => entry.action === "production-plan-created")
    && db.auditLog.some((entry) => entry.action === "production-plan-updated");

  const read = await call(packerToken, "GET", undefined, { date: "2026-09-28" });
  checks.packerCanRead = read.status === 200 && read.data.plan?.batches?.length === 5;
  const packerWrite = await call(packerToken, "PUT", PLAN);
  checks.packerCannotWrite = packerWrite.status === 403;

  const phoRead = await call(managerToken, "GET", undefined, { date: "2026-09-28", businessUnit: "pho" });
  checks.unitSeparated = phoRead.status === 200 && phoRead.data.plan === null;

  const badGroup = await call(managerToken, "PUT", { date: "2026-09-29", batches: [{ group: "XX", name: "x", kgTron: 1 }] });
  const badDate = await call(managerToken, "PUT", { date: "29/09", batches: [] });
  const negative = await call(managerToken, "PUT", { date: "2026-09-29", batches: [{ group: "DA", name: "x", kgTron: -1 }] });
  checks.validation = badGroup.status === 400 && badDate.status === 400 && negative.status === 400;

  const managerRead = await call(managerToken, "GET", undefined, { date: "2026-09-28" });
  checks.revenueForManager = managerRead.data.revenue && typeof managerRead.data.revenue.total === "number";
  checks.noRevenueForPacker = read.data.revenue === null;

  const summary = await call(managerToken, "GET", undefined, { action: "summary" });
  checks.ledger = summary.status === 200 && summary.data.days?.[0]?.date === "2026-09-28";

  const passed = Object.values(checks).every(Boolean);
  console.log(JSON.stringify({ test: "production-plans", passed, checks }, null, 2));
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
