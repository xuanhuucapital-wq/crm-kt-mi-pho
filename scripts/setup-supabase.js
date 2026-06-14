const fs = require("fs");
const path = require("path");
const { loadLocalEnv } = require("../backend/_sheets");
const { recalculate } = require("../backend/_database");

loadLocalEnv();

const managementUrl = "https://api.supabase.com/v1";
const migrationsDirectory = path.join(process.cwd(), "supabase", "migrations");
const databasePath = path.join(process.cwd(), "data", "crm-database.json");
const envPath = path.join(process.cwd(), ".env");

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Thiếu biến môi trường ${name}.`);
  return value;
}

async function managementRequest(pathname, options = {}) {
  const token = required("SUPABASE_ACCESS_TOKEN");
  const response = await fetch(`${managementUrl}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {}),
    },
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
    throw new Error(body?.message || body?.error || text || `Supabase trả HTTP ${response.status}`);
  }
  return body;
}

function upsertEnv(values) {
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lines = existing.split(/\r?\n/);
  const pending = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match || !pending.has(match[1])) return line;
    const value = pending.get(match[1]);
    pending.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  if (updated.at(-1) !== "") updated.push("");
  pending.forEach((value, key) => updated.push(`${key}=${value}`));
  fs.writeFileSync(envPath, `${updated.filter((line, index, all) => (
    line !== "" || index === all.length - 1 || all[index + 1] !== ""
  )).join("\n").replace(/\n*$/, "\n")}`);
}

async function importDatabase(supabaseUrl, serviceKey) {
  const database = JSON.parse(fs.readFileSync(databasePath, "utf8"));
  recalculate(database);
  database.source = "supabase";
  database.updatedAt = new Date().toISOString();
  const response = await fetch(`${supabaseUrl}/rest/v1/crm_state?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify([{
      id: "main",
      data: database,
      version: 1,
      updated_at: new Date().toISOString(),
    }]),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Import trả HTTP ${response.status}`);
  return database;
}

async function main() {
  const projectRef = required("SUPABASE_PROJECT_REF");
  const migrationFiles = fs.readdirSync(migrationsDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const migrationFile of migrationFiles) {
    const migration = fs.readFileSync(path.join(migrationsDirectory, migrationFile), "utf8");
    await managementRequest(`/projects/${projectRef}/database/query`, {
      method: "POST",
      body: JSON.stringify({ query: migration, read_only: false }),
    });
  }

  const keys = await managementRequest(`/projects/${projectRef}/api-keys`, { method: "GET" });
  const backendKey = (keys || []).find((key) => (
    key.api_key
    && (key.type === "secret" || key.name === "service_role")
  ))?.api_key;
  if (!backendKey) {
    throw new Error(
      "Không lấy được backend key. Hãy tạo Secret key trong Project Settings > API Keys rồi đặt SUPABASE_SECRET_KEY trong .env.",
    );
  }

  const supabaseUrl = `https://${projectRef}.supabase.co`;
  const database = await importDatabase(supabaseUrl, backendKey);
  upsertEnv({
    SUPABASE_PROJECT_REF: projectRef,
    SUPABASE_URL: supabaseUrl,
    SUPABASE_SECRET_KEY: backendKey,
  });

  console.log(JSON.stringify({
    connected: true,
    projectRef,
    migrationsApplied: migrationFiles,
    imported: {
      users: database.users?.length || 0,
      customers: database.crm?.customers?.length || 0,
      orders: database.crm?.orders?.length || 0,
      payments: database.payments?.length || 0,
      productionEntries: database.productionInfo?.entries?.length || 0,
      auditEntries: database.auditLog?.length || 0,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
