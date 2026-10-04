const { neon } = require("@neondatabase/serverless");
const { loadLocalEnv } = require("../backend/_sheets");

loadLocalEnv();

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name}.`);
  return value;
}

async function main() {
  const sql = neon(required("DATABASE_URL"));
  const rows = await sql.query("SELECT data, version, updated_at FROM crm_state WHERE id = $1", ["main"]);
  const row = rows[0];
  if (!row) throw new Error("Chưa có bản ghi CRM main trên Neon.");
  const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
  console.log(JSON.stringify({
    connected: true,
    version: Number(row.version),
    updatedAt: row.updated_at,
    users: data.users?.length || 0,
    customers: data.crm?.customers?.length || 0,
    orders: data.crm?.orders?.length || 0,
    payments: data.payments?.length || 0,
    productionEntries: data.productionInfo?.entries?.length || 0,
    auditEntries: data.auditLog?.length || 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
