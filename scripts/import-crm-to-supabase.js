const fs = require("fs");
const path = require("path");
const { loadLocalEnv } = require("../netlify/functions/_sheets");
const { recalculate } = require("../netlify/functions/_database");

loadLocalEnv();

const sourcePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(process.cwd(), "data", "crm-database.json");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu biến môi trường ${name}.`);
  return value;
}

async function main() {
  const supabaseUrl = required("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) throw new Error("Thiếu SUPABASE_SECRET_KEY.");
  const database = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  recalculate(database);
  database.source = "supabase";
  database.updatedAt = new Date().toISOString();

  const response = await fetch(`${supabaseUrl}/rest/v1/crm_state?on_conflict=id`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([{
      id: "main",
      data: database,
      version: 1,
      updated_at: new Date().toISOString(),
    }]),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Supabase trả HTTP ${response.status}`);

  console.log(JSON.stringify({
    imported: true,
    source: sourcePath,
    users: database.users?.length || 0,
    customers: database.crm?.customers?.length || 0,
    orders: database.crm?.orders?.length || 0,
    payments: database.payments?.length || 0,
    productionEntries: database.productionInfo?.entries?.length || 0,
    auditEntries: database.auditLog?.length || 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
