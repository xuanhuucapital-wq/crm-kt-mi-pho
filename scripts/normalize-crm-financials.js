const fs = require("fs");
const path = require("path");

const files = [
  path.join(__dirname, "..", "data", "crm-snapshot.json"),
];

const recordedAt = new Date().toISOString();
let result;

files.forEach((file) => {
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  let changedOrders = 0;

  snapshot.crm.orders.forEach((order) => {
    const subtotal = (
      Number(order.miKg || 0) * Number(order.priceMi || 0)
      + Number(order.caoKg || 0) * Number(order.priceCao || 0)
      + Number(order.hoanhKg || 0) * Number(order.priceHoanh || 0)
    );
    const taxAmount = Math.max(0, Number(order.taxAmount || 0));
    const advance = Math.max(0, Number(order.advance || 0));
    const total = subtotal + taxAmount + advance;
    const paid = Math.min(total, Math.max(0, Number(order.paid || 0)));
    const debt = Math.max(0, total - paid);

    if (
      order.subtotal !== subtotal
      || order.total !== total
      || order.paid !== paid
      || order.debt !== debt
    ) {
      changedOrders += 1;
    }
    Object.assign(order, { subtotal, taxAmount, advance, total, paid, debt });
  });

  snapshot.crm.customers.forEach((customer) => {
    const orders = snapshot.crm.orders.filter((order) => (
      String(order.customerName || "").trim().toLowerCase()
      === String(customer.TenKH || "").trim().toLowerCase()
    ));
    customer.orderCount = orders.length;
    customer.revenue = orders.reduce((sum, order) => sum + order.subtotal, 0);
    customer.paid = orders.reduce((sum, order) => sum + order.paid, 0);
    customer.debt = orders.reduce((sum, order) => sum + order.debt, 0);
  });

  snapshot.crm.summary = {
    customerCount: snapshot.crm.customers.length,
    orderCount: snapshot.crm.orders.length,
    revenue: snapshot.crm.orders.reduce((sum, order) => sum + order.subtotal, 0),
    paid: snapshot.crm.orders.reduce((sum, order) => sum + order.paid, 0),
    debt: snapshot.crm.orders.reduce((sum, order) => sum + order.debt, 0),
    tax: snapshot.crm.orders.reduce((sum, order) => sum + order.taxAmount, 0),
    advance: snapshot.crm.orders.reduce((sum, order) => sum + order.advance, 0),
  };
  snapshot.adjustments = snapshot.adjustments || [];
  snapshot.adjustments.push({
    type: "normalize-crm-financials",
    changedOrders,
    recordedAt,
    note: "Tính lại tiền hàng, tổng phải trả và công nợ hoàn toàn trong CRM.",
  });
  fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  result = { changedOrders, summary: snapshot.crm.summary };
});

console.log(JSON.stringify(result, null, 2));
