const fs = require("fs");
const path = require("path");
const { loadLocalEnv } = require("./_sheets");

loadLocalEnv();

const databasePath = process.env.CRM_DATABASE_PATH
  || path.join(process.cwd(), "data", "crm-database.json");
const seedPath = path.join(process.cwd(), "data", "crm-snapshot.json");
const SUPABASE_STATE_ID = "main";
const MAX_UPDATE_RETRIES = 8;

let writeQueue = Promise.resolve();

const BUSINESS_UNITS = ["mi", "pho"];

function normalizeBusinessUnit(value) {
  return BUSINESS_UNITS.includes(String(value || "").toLowerCase())
    ? String(value).toLowerCase()
    : "mi";
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function useSupabase() {
  if (process.env.CRM_DATABASE_DRIVER === "file") return false;
  if (process.env.CRM_DATABASE_PATH) return false;
  return Boolean(
    process.env.SUPABASE_URL
    && (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY),
  );
}

function ensureFileDatabase() {
  if (fs.existsSync(databasePath)) return;
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  seed.source = "crm-database";
  seed.payments = seed.payments || [];
  seed.users = seed.users || [];
  seed.auditLog = seed.auditLog || [];
  fs.writeFileSync(databasePath, `${JSON.stringify(seed, null, 2)}\n`);
}

function normalizeDatabase(database) {
  database.users = database.users || [];
  database.auditLog = database.auditLog || [];
  database.payments = database.payments || [];
  const crm = database.crm || (database.crm = {});
  (crm.customers || (crm.customers = [])).forEach((customer) => {
    customer.businessUnit = normalizeBusinessUnit(customer.businessUnit);
  });
  (crm.orders || (crm.orders = [])).forEach((order) => {
    order.businessUnit = normalizeBusinessUnit(order.businessUnit);
  });
  database.payments.forEach((payment) => {
    payment.businessUnit = normalizeBusinessUnit(payment.businessUnit);
  });
  const productionInfo = database.productionInfo || (database.productionInfo = {
    title: "Thông tin khách hàng",
    entries: [],
  });
  (productionInfo.entries || (productionInfo.entries = [])).forEach((entry) => {
    entry.businessUnit = normalizeBusinessUnit(entry.businessUnit);
  });
  database.users.forEach((user) => {
    user.businessUnits = Array.isArray(user.businessUnits) && user.businessUnits.length
      ? [...new Set(user.businessUnits.map(normalizeBusinessUnit))]
      : [...BUSINESS_UNITS];
  });
  database.auditLog.forEach((entry) => {
    if (entry.businessUnit) entry.businessUnit = normalizeBusinessUnit(entry.businessUnit);
  });
  return database;
}

function readFileDatabase() {
  ensureFileDatabase();
  return {
    database: normalizeDatabase(JSON.parse(fs.readFileSync(databasePath, "utf8"))),
    version: 0,
  };
}

function writeFileDatabase(database) {
  database.updatedAt = new Date().toISOString();
  const temporaryPath = `${databasePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(database, null, 2)}\n`);
  fs.renameSync(temporaryPath, databasePath);
}

function supabaseHeaders(extra = {}) {
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function supabaseRequest(pathname, options = {}) {
  const baseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: supabaseHeaders(options.headers),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message = body?.message || body?.hint || body?.error || text || `HTTP ${response.status}`;
    throw new Error(`Supabase database error: ${message}`);
  }
  return body;
}

async function readSupabaseDatabase() {
  const rows = await supabaseRequest(
    `/rest/v1/crm_state?id=eq.${encodeURIComponent(SUPABASE_STATE_ID)}&select=data,version&limit=1`,
    { method: "GET" },
  );
  if (!Array.isArray(rows) || !rows[0]?.data) {
    throw new Error("Supabase chưa có dữ liệu CRM. Hãy chạy migration và import trước.");
  }
  return {
    database: normalizeDatabase(rows[0].data),
    version: Number(rows[0].version || 0),
  };
}

async function replaceSupabaseDatabase(expectedVersion, database) {
  const nextVersion = await supabaseRequest("/rest/v1/rpc/replace_crm_state", {
    method: "POST",
    body: JSON.stringify({
      state_id: SUPABASE_STATE_ID,
      expected_version: expectedVersion,
      next_data: database,
    }),
  });
  return nextVersion === null ? null : Number(nextVersion);
}

async function readDatabaseSnapshot() {
  return useSupabase() ? readSupabaseDatabase() : readFileDatabase();
}

async function readDatabase() {
  return (await readDatabaseSnapshot()).database;
}

async function updateDatabase(mutator) {
  const operation = writeQueue.then(async () => {
    for (let attempt = 0; attempt < MAX_UPDATE_RETRIES; attempt += 1) {
      const { database, version } = await readDatabaseSnapshot();
      const result = await mutator(database);
      recalculate(database);
      database.updatedAt = new Date().toISOString();
      if (!useSupabase()) {
        writeFileDatabase(database);
        return result;
      }
      const nextVersion = await replaceSupabaseDatabase(version, database);
      if (nextVersion !== null) return result;
    }
    throw new Error("Dữ liệu vừa được người khác cập nhật. Vui lòng thử lại.");
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

function orderSubtotal(order) {
  if (normalizeBusinessUnit(order.businessUnit) === "pho") {
    return (
      Number(order.phoSoiKg || 0) * Number(order.pricePhoSoi || 0)
      + Number(order.phoCuonKg || 0) * Number(order.pricePhoCuon || 0)
    );
  }
  return (
    Number(order.miKg || 0) * Number(order.priceMi || 0)
    + Number(order.caoKg || 0) * Number(order.priceCao || 0)
    + Number(order.hoanhKg || 0) * Number(order.priceHoanh || 0)
  );
}

function normalizeOrder(order) {
  order.subtotal = orderSubtotal(order);
  order.taxAmount = Math.max(0, Number(order.taxAmount || 0));
  order.advance = Math.max(0, Number(order.advance || 0));
  order.total = order.subtotal + order.taxAmount + order.advance;
  order.paid = Math.min(order.total, Math.max(0, Number(order.paid || 0)));
  order.debt = Math.max(0, order.total - order.paid);
  return order;
}

function recalculate(database) {
  const crm = database.crm || (database.crm = {});
  const orders = crm.orders || (crm.orders = []);
  const customers = crm.customers || (crm.customers = []);
  orders.forEach(normalizeOrder);
  customers.forEach((customer) => {
    const businessUnit = normalizeBusinessUnit(customer.businessUnit);
    const customerOrders = orders.filter((order) => (
      normalizeBusinessUnit(order.businessUnit) === businessUnit
      && normalizeText(order.customerName) === normalizeText(customer.TenKH)
    ));
    customer.orderCount = customerOrders.length;
    customer.revenue = customerOrders.reduce((sum, order) => sum + order.subtotal, 0);
    customer.paid = customerOrders.reduce((sum, order) => sum + order.paid, 0);
    customer.debt = customerOrders.reduce((sum, order) => sum + order.debt, 0);
    customer.lastOrderDate = customerOrders.map((order) => order.date).filter(Boolean).sort().at(-1) || "";
  });
  crm.summaries = Object.fromEntries(BUSINESS_UNITS.map((businessUnit) => {
    const unitCustomers = customers.filter((customer) => customer.businessUnit === businessUnit);
    const unitOrders = orders.filter((order) => order.businessUnit === businessUnit);
    return [businessUnit, {
      customerCount: unitCustomers.length,
      orderCount: unitOrders.length,
      revenue: unitOrders.reduce((sum, order) => sum + order.subtotal, 0),
      paid: unitOrders.reduce((sum, order) => sum + order.paid, 0),
      debt: unitOrders.reduce((sum, order) => sum + order.debt, 0),
      tax: unitOrders.reduce((sum, order) => sum + order.taxAmount, 0),
      advance: unitOrders.reduce((sum, order) => sum + order.advance, 0),
    }];
  }));
  crm.summary = crm.summaries.mi;
}

function nextId(items) {
  return items.reduce((maximum, item) => Math.max(maximum, Number(item.id || 0)), 0) + 1;
}

function appendAudit(database, entry) {
  const auditLog = database.auditLog || (database.auditLog = []);
  auditLog.unshift({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...entry,
    createdAt: entry.createdAt || new Date().toISOString(),
  });
  if (auditLog.length > 10000) auditLog.length = 10000;
}

module.exports = {
  appendAudit,
  nextId,
  normalizeBusinessUnit,
  normalizeOrder,
  normalizeText,
  readDatabase,
  recalculate,
  updateDatabase,
  useSupabase,
};
