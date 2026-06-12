const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "crm-security-test-"));
const databasePath = path.join(temporaryDirectory, "crm-database.json");
const bootstrapDatabasePath = path.join(temporaryDirectory, "bootstrap-database.json");
const allowedBootstrapDatabasePath = path.join(temporaryDirectory, "allowed-bootstrap-database.json");
const seedPath = path.join(process.cwd(), "data", "crm-snapshot.json");

try {
  fs.copyFileSync(seedPath, databasePath);
  const crmResult = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "scripts", "test-crm-database.js"), databasePath],
    { stdio: "inherit" },
  );
  const blockedBootstrapResult = spawnSync(
    process.execPath,
    [
      path.join(process.cwd(), "scripts", "test-register-bootstrap.js"),
      bootstrapDatabasePath,
      "delivery",
    ],
    { stdio: "inherit" },
  );
  const allowedBootstrapResult = spawnSync(
    process.execPath,
    [
      path.join(process.cwd(), "scripts", "test-register-bootstrap.js"),
      allowedBootstrapDatabasePath,
      "manager",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ALLOW_ADMIN_BOOTSTRAP: "true",
        CRM_ADMIN_EMAIL: "bootstrap@example.com",
      },
    },
  );
  process.exitCode = [
    crmResult.status,
    blockedBootstrapResult.status,
    allowedBootstrapResult.status,
  ].every((status) => status === 0) ? 0 : 1;
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
