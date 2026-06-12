const fs = require("fs");

const databasePath = process.argv[2];
const expectedRole = process.argv[3] || "delivery";
process.env.CRM_DATABASE_PATH = databasePath;

fs.writeFileSync(databasePath, `${JSON.stringify({
  crm: { customers: [], orders: [], summaries: {} },
  productionInfo: { title: "Thông tin khách hàng", entries: [] },
  users: [],
  payments: [],
  auditLog: [],
}, null, 2)}\n`);

const register = require("../netlify/functions/register");

async function main() {
  const response = await register.handler({
    httpMethod: "POST",
    headers: {},
    body: JSON.stringify({
      email: "bootstrap@example.com",
      displayName: "Bootstrap Test",
      password: "TestPassword123",
    }),
  });
  const data = JSON.parse(response.body || "{}");
  const passed = (
    response.statusCode === 201
    && data.user?.role === expectedRole
    && data.user?.status === (expectedRole === "manager" ? "active" : "pending")
  );
  console.log(JSON.stringify({
    passed,
    expectedRole,
    actualRole: data.user?.role,
    actualStatus: data.user?.status,
  }));
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
