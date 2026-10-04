const fs = require("fs");
const path = require("path");
const { loadLocalEnv } = require("./_sheets");

loadLocalEnv();

const databasePath = process.env.CRM_DATABASE_PATH
  || path.join(process.cwd(), "data", "crm-database.json");
const seedPath = path.join(process.cwd(), "data", "crm-snapshot.json");
const SUPABASE_STATE_ID = "main";
const NEON_STATE_ID = "main";
const MAX_UPDATE_RETRIES = 8;

let writeQueue = Promise.resolve();

const BUSINESS_UNITS = ["mi", "pho"];
const SUPABASE_TIMEOUT_MS = 15000;
const NEON_TIMEOUT_MS = 15000;

let neonSql = null;

function databaseUnavailableError(message = "Database tạm thời không phản hồi. Vui lòng thử lại.") {
  const error = new Error(message);
  error.statusCode = 503;
  return error;
}

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

function databaseDriver() {
  const explicitDriver = String(process.env.CRM_DATABASE_DRIVER || "").trim().toLowerCase();
  if (process.env.CRM_DATABASE_PATH || explicitDriver === "file") return "file";
  if (explicitDriver === "neon") return "neon";
  if (explicitDriver === "supabase") return "supabase";
  if (explicitDriver) throw new Error(`CRM_DATABASE_DRIVER không hợp lệ: ${explicitDriver}`);
  if (process.env.DATABASE_URL || process.env.POSTGRES_URL) return "neon";
  return "file";
}

function useNeon() {
  return databaseDriver() === "neon";
}

function useSupabase() {
  return databaseDriver() === "supabase";
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
  (database.productionPlans || (database.productionPlans = [])).forEach((plan) => {
    plan.businessUnit = normalizeBusinessUnit(plan.businessUnit);
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SUPABASE_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: supabaseHeaders(options.headers),
    });
  } catch (error) {
    throw databaseUnavailableError(
      error.name === "AbortError"
        ? "Database phản hồi quá lâu. Vui lòng thử lại."
        : "Không kết nối được database. Vui lòng thử lại.",
    );
  } finally {
    clearTimeout(timeout);
  }
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
    if (response.status >= 500) {
      throw databaseUnavailableError("Database tạm thời gặp lỗi. Vui lòng thử lại.");
    }
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

function neonConnectionString() {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString) {
    throw databaseUnavailableError("Neon chưa có DATABASE_URL.");
  }
  return connectionString;
}

function getNeonSql() {
  if (!neonSql) {
    const { neon } = require("@neondatabase/serverless");
    neonSql = neon(neonConnectionString());
  }
  return neonSql;
}

async function neonRequest(query, parameters = []) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NEON_TIMEOUT_MS);
  try {
    return await getNeonSql().query(query, parameters, {
      fetchOptions: { signal: controller.signal },
    });
  } catch (error) {
    if (error?.statusCode) throw error;
    throw databaseUnavailableError(
      error?.name === "AbortError"
        ? "Database phản hồi quá lâu. Vui lòng thử lại."
        : "Không kết nối được Neon. Vui lòng thử lại.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function readNeonDatabase() {
  const rows = await neonRequest(
    "SELECT data, version FROM crm_state WHERE id = $1 LIMIT 1",
    [NEON_STATE_ID],
  );
  if (!Array.isArray(rows) || !rows[0]?.data) {
    throw new Error("Neon chưa có dữ liệu CRM. Hãy chạy npm run db:import:neon trước.");
  }
  const data = typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
  return {
    database: normalizeDatabase(data),
    version: Number(rows[0].version || 0),
  };
}

async function replaceNeonDatabase(expectedVersion, database) {
  const rows = await neonRequest(
    `UPDATE crm_state
      SET data = CAST($3 AS jsonb), version = version + 1, updated_at = NOW()
      WHERE id = $1 AND version = $2
      RETURNING version`,
    [NEON_STATE_ID, expectedVersion, JSON.stringify(database)],
  );
  return Array.isArray(rows) && rows[0] ? Number(rows[0].version) : null;
}

async function readDatabaseSnapshot() {
  const driver = databaseDriver();
  if (driver === "neon") return readNeonDatabase();
  if (driver === "supabase") return readSupabaseDatabase();
  return readFileDatabase();
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
      const driver = databaseDriver();
      if (driver === "file") {
        writeFileDatabase(database);
        return result;
      }
      const nextVersion = driver === "neon"
        ? await replaceNeonDatabase(version, database)
        : await replaceSupabaseDatabase(version, database);
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
  const customerTotals = new Map();
  const summaries = Object.fromEntries(BUSINESS_UNITS.map((businessUnit) => [businessUnit, {
    customerCount: 0,
    orderCount: 0,
    revenue: 0,
    paid: 0,
    debt: 0,
    tax: 0,
    advance: 0,
  }]));

  customers.forEach((customer) => {
    const businessUnit = normalizeBusinessUnit(customer.businessUnit);
    customer.businessUnit = businessUnit;
    summaries[businessUnit].customerCount += 1;
    customerTotals.set(`${businessUnit}|${normalizeText(customer.TenKH)}`, {
      orderCount: 0,
      revenue: 0,
      paid: 0,
      debt: 0,
      lastOrderDate: "",
    });
  });

  orders.forEach(normalizeOrder);
  orders.forEach((order) => {
    const businessUnit = normalizeBusinessUnit(order.businessUnit);
    order.businessUnit = businessUnit;
    const summary = summaries[businessUnit];
    summary.orderCount += 1;
    summary.revenue += Number(order.subtotal || 0);
    summary.paid += Number(order.paid || 0);
    summary.debt += Number(order.debt || 0);
    summary.tax += Number(order.taxAmount || 0);
    summary.advance += Number(order.advance || 0);
    const totals = customerTotals.get(`${businessUnit}|${normalizeText(order.customerName)}`);
    if (!totals) return;
    totals.orderCount += 1;
    totals.revenue += Number(order.subtotal || 0);
    totals.paid += Number(order.paid || 0);
    totals.debt += Number(order.debt || 0);
    if (order.date && order.date > totals.lastOrderDate) totals.lastOrderDate = order.date;
  });
  customers.forEach((customer) => {
    const totals = customerTotals.get(`${customer.businessUnit}|${normalizeText(customer.TenKH)}`) || {};
    customer.orderCount = totals.orderCount || 0;
    customer.revenue = totals.revenue || 0;
    customer.paid = totals.paid || 0;
    customer.debt = totals.debt || 0;
    customer.lastOrderDate = totals.lastOrderDate || "";
  });
  crm.summaries = summaries;
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
  databaseDriver,
  nextId,
  normalizeBusinessUnit,
  normalizeOrder,
  normalizeText,
  readDatabase,
  recalculate,
  updateDatabase,
  useNeon,
  useSupabase,
};
