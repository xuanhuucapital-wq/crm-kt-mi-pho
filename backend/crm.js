const { authErrorResponse, requireAuth, requireBusinessUnit } = require("./_auth");
const { readDatabase, recalculate } = require("./_database");
const { jsonResponse } = require("./_sheets");

function deliveryCustomer(customer) {
  return {
    MaKH: customer.MaKH,
    TenKH: customer.TenKH,
    GiaMi: Number(customer.GiaMi || 0),
    GiaCao: Number(customer.GiaCao || 0),
    GiaHoanh: Number(customer.GiaHoanh || 0),
    GiaPhoSoi: Number(customer.GiaPhoSoi || 0),
    GiaPhoCuon: Number(customer.GiaPhoCuon || 0),
    NhaXeMacDinh: String(customer.NhaXeMacDinh || ""),
    ThueSuat: Number(customer.ThueSuat || 0),
    businessUnit: customer.businessUnit,
  };
}

function sortCustomers(first, second) {
  const firstName = String(first.TenKH || "").trim();
  const secondName = String(second.TenKH || "").trim();
  const startsWithLetter = (value) => /^[a-z]/.test(
    value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").toLowerCase(),
  );
  if (startsWithLetter(firstName) !== startsWithLetter(secondName)) {
    return startsWithLetter(firstName) ? -1 : 1;
  }
  return firstName.localeCompare(secondName, "vi", {
    sensitivity: "base",
    numeric: true,
    ignorePunctuation: true,
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") return jsonResponse(405, { error: "Method not allowed" });
  try {
    const sessionUser = await requireAuth(event);
    const businessUnit = requireBusinessUnit(sessionUser, event.queryStringParameters?.businessUnit);
    const database = await readDatabase();
    recalculate(database);
    const customers = (database.crm.customers || [])
      .filter((item) => item.businessUnit === businessUnit)
      .sort(sortCustomers);
    const orders = (database.crm.orders || []).filter((item) => item.businessUnit === businessUnit);
    if (sessionUser.role === "delivery") {
      return jsonResponse(200, {
        customers: customers.map(deliveryCustomer),
        orders: [],
        summary: {},
      });
    }
    return jsonResponse(200, {
      customers,
      orders,
      summary: database.crm.summaries?.[businessUnit] || {},
      businessUnit,
    });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(500, { error: error.message });
  }
};
