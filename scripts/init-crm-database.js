const fs = require("fs");
const path = require("path");

const source = path.join(__dirname, "..", "data", "crm-snapshot.json");
const destination = path.join(__dirname, "..", "data", "crm-database.json");
const database = JSON.parse(fs.readFileSync(source, "utf8"));
database.source = "crm-database";
database.payments = database.payments || [];
database.createdAt = database.createdAt || new Date().toISOString();
database.updatedAt = new Date().toISOString();
fs.writeFileSync(destination, `${JSON.stringify(database, null, 2)}\n`);
console.log(`CRM database ready: ${destination}`);
