const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { loadLocalEnv } = require("../backend/_sheets");

loadLocalEnv();

const outputPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(process.cwd(), "data", "crm-database.json");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Thiếu ${name}.`);
  return value;
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function summarize(database) {
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
  const supabaseUrl = required("SUPABASE_URL").replace(/\/+$/, "");
  const secretKey = process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey) throw new Error("Thiếu SUPABASE_SECRET_KEY.");

  const response = await fetch(
    `${supabaseUrl}/rest/v1/crm_state?id=eq.main&select=data,version,updated_at&limit=1`,
    {
      method: "GET",
      headers: {
        apikey: secretKey,
        authorization: `Bearer ${secretKey}`,
      },
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `Supabase trả HTTP ${response.status}`);
  }

  const row = JSON.parse(text)[0];
  if (!row?.data || typeof row.data !== "object" || Array.isArray(row.data)) {
    throw new Error("Supabase chưa có bản ghi crm_state id=main hợp lệ.");
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  let backupPath = null;
  if (fs.existsSync(outputPath)) {
    const backupDirectory = path.join(path.dirname(outputPath), "backups");
    fs.mkdirSync(backupDirectory, { recursive: true });
    backupPath = path.join(
      backupDirectory,
      `crm-database.before-supabase-export-${timestampForFilename()}.json`,
    );
    fs.copyFileSync(outputPath, backupPath, fs.constants.COPYFILE_EXCL);
  }

  const serialized = `${JSON.stringify(row.data, null, 2)}\n`;
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, serialized, { flag: "wx", mode: 0o600 });
    JSON.parse(fs.readFileSync(temporaryPath, "utf8"));
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }

  console.log(JSON.stringify({
    exported: true,
    source: "supabase:crm_state/main",
    sourceVersion: Number(row.version || 0),
    sourceUpdatedAt: row.updated_at || null,
    output: outputPath,
    backup: backupPath,
    sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
    ...summarize(row.data),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
