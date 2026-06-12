const { loadLocalEnv } = require("../netlify/functions/_sheets");

loadLocalEnv();

async function main() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Thiếu SUPABASE_URL hoặc SUPABASE_SECRET_KEY.");
  const response = await fetch(`${url}/rest/v1/crm_state?id=eq.main&select=data,version,updated_at`, {
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Supabase trả HTTP ${response.status}`);
  const row = JSON.parse(text)[0];
  if (!row) throw new Error("Chưa có bản ghi CRM main trên Supabase.");
  console.log(JSON.stringify({
    connected: true,
    version: row.version,
    updatedAt: row.updated_at,
    users: row.data?.users?.length || 0,
    customers: row.data?.crm?.customers?.length || 0,
    orders: row.data?.crm?.orders?.length || 0,
    payments: row.data?.payments?.length || 0,
    productionEntries: row.data?.productionInfo?.entries?.length || 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
