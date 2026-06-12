const fs = require("fs");
const path = require("path");
const { recalculate } = require("../netlify/functions/_database");

const customerName = process.argv[2];
const throughDate = process.argv[3];

if (!customerName || !/^\d{4}-\d{2}-\d{2}$/.test(throughDate || "")) {
  console.error("Usage: node scripts/mark-customer-paid-through.js <customer-name> <yyyy-mm-dd>");
  process.exit(1);
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase()
    .trim();
}

const files = [
  path.join(__dirname, "..", "data", "crm-database.json"),
];

let result;
const recordedAt = new Date().toISOString();
files.forEach((file) => {
  const database = JSON.parse(fs.readFileSync(file, "utf8"));
  const orders = database.crm.orders.filter((order) => (
    normalize(order.customerName) === normalize(customerName)
    && order.date
    && order.date <= throughDate
  ));
  const unpaidOrders = orders.filter((order) => Number(order.debt || 0) > 0);
  const amount = unpaidOrders.reduce((sum, order) => sum + Number(order.debt || 0), 0);

  unpaidOrders.forEach((order) => {
    order.paid = Number(order.paid || 0) + Number(order.debt || 0);
    order.debt = 0;
  });

  database.adjustments = database.adjustments || [];
  database.adjustments.push({
    type: "mark-paid-through",
    customerName,
    throughDate,
    orderCount: unpaidOrders.length,
    amount,
    recordedAt,
    note: `Đã thu tiền các đơn đến hết ${throughDate}.`,
  });
  recalculate(database);
  fs.writeFileSync(file, `${JSON.stringify(database, null, 2)}\n`);
  result = { customerName, throughDate, orders: orders.length, updatedOrders: unpaidOrders.length, amount };
});

console.log(JSON.stringify(result, null, 2));
