const fs = require("fs");
const path = require("path");
const { neon } = require("@neondatabase/serverless");
const { loadLocalEnv } = require("../backend/_sheets");
const { recalculate } = require("../backend/_database");

loadLocalEnv();

const sourcePath = process.argv[2] && process.argv[2] !== "--force"
  ? path.resolve(process.argv[2])
  : path.join(process.cwd(), "data", "crm-database.json");
const force = process.argv.includes("--force");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name}.`);
  return value;
}

function counts(database) {
  return {
    users: database.users?.length || 0,
    customers: database.crm?.customers?.length || 0,
    orders: database.crm?.orders?.length || 0,
    payments: database.payments?.length || 0,
    productionEntries: database.productionInfo?.entries?.length || 0,
    auditEntries: database.auditLog?.length || 0,
  };
}

async function main() {
  const sql = neon(required("DATABASE_URL"));
  const database = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  recalculate(database);
  database.source = "neon";
  database.updatedAt = new Date().toISOString();

  await sql.query(`CREATE TABLE IF NOT EXISTS crm_state (
    id text PRIMARY KEY,
    data jsonb NOT NULL,
    version bigint NOT NULL DEFAULT 1,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

  const existing = await sql.query("SELECT version, updated_at FROM crm_state WHERE id = $1", ["main"]);
  if (existing[0] && !force) {
    throw new Error(
      `Neon đã có dữ liệu CRM main (version ${existing[0].version}). Không ghi đè; chỉ dùng --force sau khi đã đối chiếu.`,
    );
  }

  const rows = existing[0]
    ? await sql.query(
      `UPDATE crm_state
        SET data = CAST($2 AS jsonb), version = version + 1, updated_at = NOW()
        WHERE id = $1 RETURNING version, updated_at`,
      ["main", JSON.stringify(database)],
    )
    : await sql.query(
      `INSERT INTO crm_state (id, data, version)
        VALUES ($1, CAST($2 AS jsonb), 1)
        RETURNING version, updated_at`,
      ["main", JSON.stringify(database)],
    );

  console.log(JSON.stringify({
    imported: true,
    source: sourcePath,
    version: Number(rows[0].version),
    updatedAt: rows[0].updated_at,
    ...counts(database),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
