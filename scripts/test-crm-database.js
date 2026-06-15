process.env.CRM_DATABASE_PATH = process.argv[2];

const { createSessionToken, hashPassword } = require("../backend/_auth");
const { readDatabase, updateDatabase } = require("../backend/_database");
const auditLog = require("../backend/audit-log");
const crm = require("../backend/crm");
const customers = require("../backend/customers");
const login = require("../backend/login");
const logout = require("../backend/logout");
const session = require("../backend/session");
const orders = require("../backend/orders");
const payments = require("../backend/payments");
const productionInfo = require("../backend/production-info");
const exportDebts = require("../backend/export-debts");
const ExcelJS = require("exceljs");

let token = "";

async function call(handler, method, body) {
  const response = await handler({
    httpMethod: method,
    headers: { authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
    queryStringParameters: {},
  });
  const data = JSON.parse(response.body || "{}");
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${method} failed: ${data.error || response.statusCode}`);
  }
  return data;
}

async function main() {
  const manager = await updateDatabase((database) => {
    database.users = database.users || [];
    const user = {
      id: 1,
      email: "test-manager@example.com",
      displayName: "Test Manager",
      passwordHash: hashPassword("TestPassword123"),
      role: "manager",
      status: "active",
      tokenVersion: 0,
      createdAt: new Date().toISOString(),
    };
    database.users.push(user);
    return user;
  });
  const loginResponse = await login.handler({
    httpMethod: "POST",
    headers: { "x-forwarded-for": "127.0.0.1", "user-agent": "CRM audit test" },
    body: JSON.stringify({ email: manager.email, password: "TestPassword123" }),
  });
  if (loginResponse.statusCode !== 200) throw new Error(`Login failed: ${loginResponse.body}`);
  const loginCookie = String(loginResponse.headers?.["set-cookie"] || "").split(";")[0];
  const sessionResponse = await session.handler({
    httpMethod: "GET",
    headers: { cookie: loginCookie },
    queryStringParameters: {},
  });
  token = createSessionToken(manager);
  const before = await call(crm.handler, "GET");
  await call(customers.handler, "POST", {
    MaKH: "TEST-CRM",
    TenKH: "Khách Test Database",
    GiaMi: 60000,
    GiaCao: 42000,
    GiaHoanh: 43000,
    NhaXeMacDinh: "Test",
  });
  await call(customers.handler, "PUT", {
    MaKH: "TEST-CRM",
    TenKH: "Khách Test Database Đã Sửa",
    GiaMi: 61000,
  });
  const createdOrder = await call(orders.handler, "POST", {
    customerCode: "TEST-CRM",
    orderDate: "2026-06-11",
    miKg: 10,
    caoKg: 2,
    taxRate: 5,
    taxPayer: "customer",
    tienUng: 15000,
  });
  await call(customers.handler, "POST", {
    businessUnit: "pho",
    MaKH: "TEST-CRM",
    TenKH: "Khách Test Phở",
    GiaPhoSoi: 18000,
    GiaPhoCuon: 22000,
    NhaXeMacDinh: "Test Phở",
  });
  const createdPhoOrder = await call(orders.handler, "POST", {
    businessUnit: "pho",
    customerCode: "TEST-CRM",
    orderDate: "2026-06-12",
    phoSoiKg: 4,
    phoSoiUnit: "cay",
    phoCuonKg: 5,
    taxRate: 0,
    tienUng: 10000,
  });
  const copiedMiOrder = await call(orders.handler, "POST", {
    action: "copy",
    businessUnit: "mi",
    sourceOrderId: createdOrder.order.id,
    orderDate: "2026-06-15",
    miKg: 3,
    caoKg: 1,
    hoanhKg: 0,
    tienUng: 5000,
    taxRate: 0,
    ghiChu: "Bản sao đã điều chỉnh",
  });
  const copiedPhoOrder = await call(orders.handler, "POST", {
    action: "copy",
    businessUnit: "pho",
    sourceOrderId: createdPhoOrder.order.id,
    orderDate: "2026-06-16",
    phoSoiKg: 2,
    phoSoiUnit: "cay",
    phoCuonKg: 1,
    tienUng: 0,
    taxRate: 0,
    ghiChu: "Bản sao phở đã điều chỉnh",
  });
  await call(payments.handler, "POST", {
    customerCode: "TEST-CRM",
    amount: 100000,
    date: "2026-06-11",
    note: "Test database",
  });
  const deletableOrder = await call(orders.handler, "POST", {
    customerCode: "TEST-CRM",
    orderDate: "2026-06-12",
    miKg: 1,
    paymentMethod: "cash",
  });
  const deletedOrder = await call(orders.handler, "DELETE", {
    rowId: deletableOrder.order.id,
    businessUnit: "mi",
  });
  const production = await call(productionInfo.handler, "POST", {
    action: "create",
    customer: "Khách Test Database Đã Sửa",
    customerCode: "TEST-CRM",
    production: "Test quy cách",
  });
  const phoProduction = await call(productionInfo.handler, "POST", {
    action: "create",
    businessUnit: "pho",
    customer: "Hồ sơ chỉ thuộc xưởng Phở",
    customerCode: "TEST-CRM",
    production: "Không được liên kết sang xưởng Mì",
  });
  const crossUnitCustomerLink = await customers.handler({
    httpMethod: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      businessUnit: "mi",
      MaKH: "TEST-CROSS-UNIT",
      TenKH: "Khách liên kết sai xưởng",
      productionInfoId: phoProduction.entry.id,
    }),
    queryStringParameters: {},
  });
  await call(productionInfo.handler, "PUT", {
    id: production.entry.id,
    customer: "Khách Test Database Đã Sửa",
    customerCode: "TEST-CRM",
    production: "Đã sửa quy cách",
  });
  const pageExitResponse = await logout.handler({
    httpMethod: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ reason: "page-exit" }),
    queryStringParameters: {},
  });
  if (pageExitResponse.statusCode < 200 || pageExitResponse.statusCode >= 300) {
    throw new Error(`page-exit logout failed: ${pageExitResponse.body}`);
  }
  const explicitLogoutResponse = await logout.handler({
    httpMethod: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ reason: "explicit-logout" }),
    queryStringParameters: {},
  });
  if (explicitLogoutResponse.statusCode < 200 || explicitLogoutResponse.statusCode >= 300) {
    throw new Error(`explicit logout failed: ${explicitLogoutResponse.body}`);
  }
  token = createSessionToken((await readDatabase()).users.find((user) => user.id === manager.id));
  const after = await call(crm.handler, "GET");
  const phoResponse = await crm.handler({
    httpMethod: "GET",
    headers: { authorization: `Bearer ${token}` },
    queryStringParameters: { businessUnit: "pho" },
  });
  const phoData = JSON.parse(phoResponse.body);
  const order = after.orders.find((item) => item.id === createdOrder.order.id);
  const customer = after.customers.find((item) => item.MaKH === "TEST-CRM");
  const paymentData = await call(payments.handler, "GET");
  const auditData = await call(auditLog.handler, "GET");
  const actionNames = new Set(auditData.entries.map((entry) => entry.action));
  const delivery = await updateDatabase((database) => {
    const sensitiveCustomer = database.crm.customers.find((item) => (
      item.businessUnit === "mi" && item.MaKH === "TEST-CRM"
    ));
    sensitiveCustomer.ThongTinLienHe = "0900000000";
    sensitiveCustomer.DiaChi = "Dữ liệu chỉ quản lý được xem";
    const user = {
      id: 2,
      email: "test-delivery@example.com",
      displayName: "Test Delivery",
      passwordHash: hashPassword("TestPassword123"),
      role: "delivery",
      status: "active",
      tokenVersion: 0,
      createdAt: new Date().toISOString(),
    };
    database.users.push(user);
    return user;
  });
  const managerToken = token;
  token = createSessionToken(delivery);
  const forbiddenAudit = await auditLog.handler({
    httpMethod: "GET",
    headers: { authorization: `Bearer ${token}` },
    queryStringParameters: {},
  });
  const forbiddenDelete = await orders.handler({
    httpMethod: "DELETE",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ rowId: createdOrder.order.id, businessUnit: "mi" }),
    queryStringParameters: {},
  });
  const deliveryCrmResponse = await crm.handler({
    httpMethod: "GET",
    headers: { authorization: `Bearer ${token}` },
    queryStringParameters: { businessUnit: "mi" },
  });
  const deliveryCrmData = JSON.parse(deliveryCrmResponse.body);
  const deliveryCustomer = deliveryCrmData.customers.find((item) => item.MaKH === "TEST-CRM");
  const forgedPaidOrder = await orders.handler({
    httpMethod: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      businessUnit: "mi",
      customerCode: "TEST-CRM",
      orderDate: "2026-06-20",
      miKg: 1,
      paymentMethod: "debt",
      paid: 999999999,
    }),
    queryStringParameters: {},
  });
  const forgedPaidOrderData = JSON.parse(forgedPaidOrder.body);
  const phoExport = await exportDebts.handler({
    httpMethod: "GET",
    headers: { authorization: `Bearer ${managerToken}` },
    queryStringParameters: { businessUnit: "pho" },
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(phoExport.body, "base64"));
  const phoSheet = workbook.getWorksheet("Công nợ phở");
  token = managerToken;
  const passed = (
    after.customers.length === before.customers.length + 1
    && after.orders.length === before.orders.length + 2
    && order.subtotal === 694000
    && order.total === 743700
    && order.paid === 100000
    && order.debt === 643700
    && customer.debt === 873700
    && copiedMiOrder.order.date === "2026-06-15"
    && copiedMiOrder.order.miKg === 3
    && copiedMiOrder.order.caoKg === 1
    && copiedMiOrder.order.total === 230000
    && copiedMiOrder.order.paid === 0
    && copiedMiOrder.order.copiedFromOrderId === createdOrder.order.id
    && paymentData.payments.some((item) => item.customerCode === "TEST-CRM")
    && ["user-logout", "customer-created", "customer-updated", "order-created", "order-deleted", "payment-recorded", "production-info-created", "production-info-updated"]
      .every((action) => actionNames.has(action))
    && forbiddenAudit.statusCode === 403
    && loginCookie.startsWith("crm_session=")
    && loginResponse.headers["set-cookie"].includes("HttpOnly")
    && loginResponse.headers["set-cookie"].includes("SameSite=Strict")
    && !pageExitResponse.headers["set-cookie"]
    && explicitLogoutResponse.headers["set-cookie"]?.includes("Max-Age=0")
    && sessionResponse.statusCode === 200
    && forbiddenDelete.statusCode === 403
    && crossUnitCustomerLink.statusCode === 400
    && deliveryCrmResponse.statusCode === 200
    && deliveryCrmData.orders.length === 0
    && deliveryCustomer
    && !Object.hasOwn(deliveryCustomer, "ThongTinLienHe")
    && !Object.hasOwn(deliveryCustomer, "DiaChi")
    && !Object.hasOwn(deliveryCustomer, "ChinhSachThue")
    && forgedPaidOrder.statusCode === 201
    && forgedPaidOrderData.order.paid === 0
    && forgedPaidOrderData.order.debt === forgedPaidOrderData.order.total
    && deletedOrder.rowNumber === deletableOrder.order.id
    && deletedOrder.reversedPayment === deletableOrder.order.total
    && !after.orders.some((item) => item.id === deletableOrder.order.id)
    && !paymentData.payments.some((item) => (
      item.allocations || []
    ).some((allocation) => allocation.orderId === deletableOrder.order.id))
    && phoResponse.statusCode === 200
    && phoData.customers.some((item) => item.MaKH === "TEST-CRM" && item.TenKH === "Khách Test Phở")
    && phoData.orders.some((item) => (
      item.id === createdPhoOrder.order.id
      && item.phoSoiKg === 20
      && item.phoSoiUnit === "cay"
      && item.phoSoiInputQuantity === 4
      && item.subtotal === 470000
      && item.total === 480000
    ))
    && phoData.orders.some((item) => (
      item.id === copiedPhoOrder.order.id
      && item.date === "2026-06-16"
      && item.phoSoiKg === 10
      && item.phoSoiUnit === "cay"
      && item.phoSoiInputQuantity === 2
      && item.phoCuonKg === 1
      && item.total === 202000
      && item.copiedFromOrderId === createdPhoOrder.order.id
    ))
    && !phoData.orders.some((item) => item.id === createdOrder.order.id)
    && phoExport.statusCode === 200
    && phoSheet
    && workbook.worksheets.length === 1
    && JSON.stringify(phoSheet.getRow(1).values.slice(1)) === JSON.stringify([
      "Thứ",
      "Ngày tháng năm",
      "Tên quán",
      "Số lượng (kg)",
      "Tiền hàng",
      "Đã thu",
      "Còn nợ",
    ])
    && phoSheet.getRow(2).getCell(4).value === 25
  );
  console.log(JSON.stringify({
    passed,
    customerCount: after.customers.length,
    orderCount: after.orders.length,
    order,
    customerDebt: customer.debt,
    auditActions: [...actionNames].sort(),
    deliveryAuditStatus: forbiddenAudit.statusCode,
    deliveryDeleteStatus: forbiddenDelete.statusCode,
    crossUnitCustomerLinkStatus: crossUnitCustomerLink.statusCode,
    deliveryCustomerFields: Object.keys(deliveryCustomer || {}).sort(),
    forgedPaidOrder: forgedPaidOrderData.order,
    deletedOrder,
    phoCustomerCount: phoData.customers.length,
    phoOrder: createdPhoOrder.order,
    copiedMiOrder: copiedMiOrder.order,
    copiedPhoOrder: copiedPhoOrder.order,
    phoExportSheet: phoSheet?.name,
  }, null, 2));
  process.exit(passed ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
