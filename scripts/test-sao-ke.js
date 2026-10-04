// Kiểm tra phần tính số của sao kê gửi khách (public/sao-ke.js). Không dùng AI, chỉ số học trên sổ.
const assert = require("assert");
const path = require("path");
const saoKe = require(path.join(__dirname, "..", "public", "sao-ke.js"));

const order = (id, date, fields) => {
  const subtotal = Number(fields.phoSoiKg || 0) * 15000 + Number(fields.phoCuonKg || 0) * 20000;
  const total = subtotal + Number(fields.taxAmount || 0) + Number(fields.advance || 0);
  const paid = Number(fields.paid || 0);
  return { id, date, subtotal, total, paid, debt: total - paid, taxAmount: 0, advance: 0, ...fields };
};

// Sổ mẫu: 3 đơn tháng 8 (một đơn trả tiền mặt ghi phiếu), khoản trả 20/08, đơn tháng 9, ngày nghỉ 0 đ.
const orders = [
  order(1, "2026-08-01", { phoSoiKg: 15, phoSoiUnit: "cay", phoSoiInputQuantity: 3, paid: 225000 }),
  order(2, "2026-08-10", { phoSoiKg: 10, phoCuonKg: 2, paid: 190000 }),
  order(3, "2026-08-25", { phoSoiKg: 20, phoSoiUnit: "cay", phoSoiInputQuantity: 4 }),
  order(4, "2026-08-25", { phoCuonKg: 3 }),
  order(5, "2026-09-02", { phoSoiKg: 5, phoSoiUnit: "cay", phoSoiInputQuantity: 1, advance: 10000 }),
  order(6, "2026-09-03", { customerResting: true }),
];
const payments = [
  { id: 1, date: "2026-08-01", amount: 225000, allocations: [{ orderId: 1, amount: 225000 }] },
  { id: 2, date: "2026-08-20", amount: 100000, allocations: [{ orderId: 2, amount: 100000 }] },
];
// Đơn 2 có 190.000 đã trả trên sổ nhưng chỉ 100.000 có phiếu: 90.000 là tiền trả ghi từ sổ cũ, tính vào ngày 10/08.
const today = "2026-09-22";
const ledgerDebt = orders.reduce((sum, item) => sum + item.debt, 0);

// 1. Mặc định: từ ngày sau lần trả gần nhất đến hôm nay.
const range = saoKe.defaultRange({ orders, payments, today });
assert.deepStrictEqual([range.from, range.to], ["2026-08-21", today]);

// 2. Số liệu kỳ mặc định.
const statement = saoKe.buildStatement({ orders, payments, ...range });
assert.strictEqual(statement.goods, 300000 + 60000 + 85000);
assert.strictEqual(statement.paid, 0);
assert.strictEqual(statement.opening, 0);
assert.strictEqual(statement.closing, ledgerDebt, "CÒN NỢ đến hôm nay phải bằng tổng Còn lại trên sổ");
assert.deepStrictEqual(statement.months.map((month) => month.key), ["2026-08", "2026-09"]);
const aug25 = statement.months[0].days[0];
assert.strictEqual(aug25.date, "2026-08-25");
assert.strictEqual(aug25.phoSoiCay, 4);
assert.strictEqual(aug25.phoSoiKg, 20);
assert.strictEqual(aug25.phoCuonKg, 3);
assert.strictEqual(aug25.amount, 360000, "hai đơn cùng ngày gộp thành một dòng");
assert.strictEqual(statement.months[0].kg, 23);
assert.strictEqual(statement.months[1].days.length, 1, "ngày khách nghỉ 0 đ không hiện");
assert.strictEqual(statement.months[1].days[0].advance, 10000);

// 3. Xem toàn bộ: không còn nợ đầu kỳ; tiền trả ghi từ sổ cũ hiện thành dòng Đã trả đúng ngày của đơn.
const all = saoKe.buildStatement({ orders, payments, ...saoKe.fullRange({ orders, payments, today }) });
assert.strictEqual(all.from, "2026-08-01");
assert.strictEqual(all.opening, 0);
const aug10 = all.months[0].days.find((day) => day.date === "2026-08-10");
assert.deepStrictEqual([aug10.amount, aug10.paid], [190000, 90000]);
assert.strictEqual(all.goods, orders.reduce((sum, item) => sum + item.total, 0));
assert.strictEqual(all.paid, 415000);
assert.strictEqual(all.closing, ledgerDebt);
const aug20 = all.months[0].days.find((day) => day.date === "2026-08-20");
assert.deepStrictEqual([aug20.amount, aug20.paid], [0, 100000], "ngày chỉ có thanh toán vẫn có dòng Đã trả");
assert.strictEqual(all.months[0].paid, 415000);

// 3b. Phiếu chưa phân bổ vào đơn nào (trước kỳ): tự cân ở đầu kỳ, CÒN NỢ vẫn khớp sổ.
const overPayments = [...payments, { id: 3, date: "2026-06-01", amount: 50000, allocations: [] }];
const over = saoKe.buildStatement({ orders, payments: overPayments, from: "2026-08-01", to: today });
assert.strictEqual(over.opening, 0);
assert.strictEqual(over.closing, ledgerDebt);

// 4. Khoảng ngày nhập ngược vẫn được xử lý, kỳ giữa chừng cân sổ: đầu kỳ + hàng - trả = cuối kỳ.
const mid = saoKe.buildStatement({ orders, payments, from: "2026-08-31", to: "2026-08-05" });
assert.deepStrictEqual([mid.from, mid.to], ["2026-08-05", "2026-08-31"]);
assert.strictEqual(mid.closing, mid.opening + mid.goods - mid.paid);
assert.strictEqual(mid.goods, 190000 + 360000);

// 5. Chưa có phiếu thanh toán: bắt đầu từ đơn cũ nhất còn nợ.
assert.strictEqual(saoKe.defaultRange({ orders, payments: [], today }).from, "2026-08-25");
assert.strictEqual(saoKe.defaultRange({ orders: [], payments: [], today }).from, today);
assert.strictEqual(saoKe.defaultRange({ orders, payments: [{ date: today, amount: 1 }], today }).from, today);

// 6. Tên file.
assert.strictEqual(saoKe.statementFilename("m29 Châu Đốc", "2026-08-21", today), "saoke_m29-chau-doc_2026-08-21_2026-09-22.png");
assert.strictEqual(saoKe.addDays("2026-08-31", 1), "2026-09-01");

// 7. Dữ liệu thật trong snapshot (nếu có): CÒN NỢ hôm nay khớp sổ cho mọi khách phở.
const snapshotPath = path.join(__dirname, "..", "data", "crm-database.json");
let checked = 0;
try {
  const database = JSON.parse(require("fs").readFileSync(snapshotPath, "utf8"));
  (database.crm?.customers || []).filter((customer) => customer.businessUnit === "pho").forEach((customer) => {
    const customerOrders = database.crm.orders.filter((item) => item.businessUnit === "pho" && item.customerName.trim() === customer.TenKH.trim());
    const customerPayments = (database.payments || []).filter((item) => item.customerCode === customer.MaKH);
    const debt = customerOrders.reduce((sum, item) => sum + Number(item.debt || 0), 0);
    const result = saoKe.buildStatement({ orders: customerOrders, payments: customerPayments, ...saoKe.defaultRange({ orders: customerOrders, payments: customerPayments, today: "2099-12-31" }) });
    assert.ok(Math.abs(result.closing - debt) < 1, `${customer.TenKH}: sao kê ${result.closing} khác sổ ${debt}`);
    checked += 1;
  });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

console.log(`Sao kê gửi khách: đạt (${checked} khách phở trong dữ liệu thật đã đối chiếu).`);
