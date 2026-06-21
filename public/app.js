const state = {
  token: localStorage.getItem("nhapLieuAuthToken") || "",
  user: null,
  customers: [],
  orders: [],
  productionInfo: [],
  productionInfoTitle: "",
  summary: {},
  pendingChatOrder: null,
  ledgerPage: 1,
  ledgerPageSize: 50,
  ledgerSortKey: "date",
  ledgerSortDirection: "desc",
  profileCustomerCode: "",
  profileCustomerName: "",
  editingOrder: null,
  editingOrderMode: "edit",
  pendingChatCustomerText: "",
  offlineCrm: false,
  payments: [],
  users: [],
  auditLog: [],
  explicitLogout: false,
  bulkCopyAddedCustomerCodes: [],
  businessUnit: localStorage.getItem("nhapLieuBusinessUnit") || "mi",
  customerSortDirections: {
    mi: localStorage.getItem("nhapLieuCustomerSortDirection:mi") === "desc" ? "desc" : "asc",
    pho: localStorage.getItem("nhapLieuCustomerSortDirection:pho") === "desc" ? "desc" : "asc",
  },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const money = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 });
const customerNameCollator = new Intl.Collator("vi", {
  sensitivity: "base",
  numeric: true,
  ignorePunctuation: true,
});
const businessUnits = {
  mi: {
    name: "Xưởng Mì",
    short: "XM",
    products: [
      { key: "mi", name: "Mì", quantity: "miKg", price: "GiaMi", orderPrice: "priceMi" },
      { key: "cao", name: "Da cảo", quantity: "caoKg", price: "GiaCao", orderPrice: "priceCao" },
      { key: "hoanh", name: "Da hoành", quantity: "hoanhKg", price: "GiaHoanh", orderPrice: "priceHoanh" },
    ],
  },
  pho: {
    name: "Xưởng Phở",
    short: "XP",
    products: [
      { key: "phoSoi", name: "Phở sợi", quantity: "phoSoiKg", price: "GiaPhoSoi", orderPrice: "pricePhoSoi" },
      { key: "phoCuon", name: "Phở cuốn", quantity: "phoCuonKg", price: "GiaPhoCuon", orderPrice: "pricePhoCuon" },
    ],
  },
};

function currentUnit() {
  return businessUnits[state.businessUnit] || businessUnits.mi;
}

function currentCustomerSortDirection() {
  return state.customerSortDirections[state.businessUnit] === "desc" ? "desc" : "asc";
}

function compareCustomerNames(first, second, direction = "asc") {
  const firstName = String(first?.TenKH || first || "").trim();
  const secondName = String(second?.TenKH || second || "").trim();
  const firstStartsWithLetter = /^[a-z]/.test(normalizeVietnamese(firstName));
  const secondStartsWithLetter = /^[a-z]/.test(normalizeVietnamese(secondName));
  if (firstStartsWithLetter !== secondStartsWithLetter) {
    return firstStartsWithLetter ? -1 : 1;
  }
  const comparison = customerNameCollator.compare(firstName, secondName);
  return direction === "desc" ? -comparison : comparison;
}

function sortedCustomers() {
  return [...state.customers].sort((first, second) => compareCustomerNames(first, second, currentCustomerSortDirection()));
}

function syncCustomerSortControls() {
  const direction = currentCustomerSortDirection();
  ["#orderCustomerSortDirection", "#customerSortDirection"].forEach((selector) => {
    const control = $(selector);
    if (control) control.value = direction;
  });
}

function renderOrderCustomerOptions() {
  const customerSelect = $("#customerCode");
  const current = customerSelect.value;
  const options = sortedCustomers().map((item) => {
    const label = state.businessUnit === "pho"
      ? item.TenKH
      : `${item.MaKH} · ${item.TenKH}`;
    return `<option value="${escapeHtml(item.MaKH)}">${escapeHtml(label)}</option>`;
  }).join("");
  customerSelect.innerHTML = `<option value="">Chọn khách hàng</option>${options}`;
  customerSelect.value = state.customers.some((item) => item.MaKH === current) ? current : "";
}

function setCustomerSortDirection(direction) {
  const normalizedDirection = direction === "desc" ? "desc" : "asc";
  state.customerSortDirections[state.businessUnit] = normalizedDirection;
  localStorage.setItem(`nhapLieuCustomerSortDirection:${state.businessUnit}`, normalizedDirection);
  syncCustomerSortControls();
  renderOrderCustomerOptions();
  renderCustomers($("#customerSearch").value);
}

function unitUrl(path) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}businessUnit=${state.businessUnit}`;
}

function authHeaders(extra = {}) {
  return state.token
    ? { ...extra, authorization: `Bearer ${state.token}` }
    : { ...extra };
}

async function readApiResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const status = response.status ? ` (HTTP ${response.status})` : "";
    if (!response.ok) {
      return {
        error: response.status === 503
          ? "Máy chủ hoặc database đang bận, vui lòng thử lại sau vài giây."
          : `Máy chủ tạm thời không phản hồi đúng định dạng${status}. Vui lòng thử lại.`,
      };
    }
    throw new Error(`Máy chủ tạm thời trả phản hồi không hợp lệ${status}. Vui lòng thử lại.`);
  }
}

function parseNumber(value) {
  const raw = String(value || "").trim();
  const normalized = /^\d{1,3}(?:\.\d{3})+$/.test(raw)
    ? raw.replace(/\./g, "")
    : raw.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function phoSoiQuantityInKg(form) {
  const amount = parseNumber(form.elements.phoSoiKg?.value);
  return form.elements.phoSoiUnit?.value === "cay" ? amount * 5 : amount;
}

function updatePhoSoiConversion(form, element) {
  if (!form.elements.phoSoiKg || !form.elements.phoSoiUnit || !element) return;
  const amount = parseNumber(form.elements.phoSoiKg.value);
  const unit = form.elements.phoSoiUnit.value;
  element.textContent = unit === "cay"
    ? `${number.format(amount || 0)} cây = ${number.format(amount * 5)}kg`
    : `${number.format(amount || 0)}kg = ${number.format((amount || 0) / 5)} cây`;
}

function formatMoneyInput(input) {
  const digits = String(input.value || "").replace(/\D/g, "");
  input.value = digits ? new Intl.NumberFormat("vi-VN").format(Number(digits)) : "";
}

function normalizeCustomerPrices(payload) {
  ["GiaMi", "GiaCao", "GiaHoanh", "GiaPhoSoi", "GiaPhoCuon"].forEach((field) => {
    payload[field] = parseNumber(payload[field]);
  });
  payload.businessUnit = state.businessUnit;
  return payload;
}

function applyBusinessUnitUi() {
  const unit = currentUnit();
  document.body.dataset.businessUnit = state.businessUnit;
  document.title = `CRM ${unit.name}`;
  $("#sidebarFactoryName").textContent = unit.name;
  $("#mobileFactoryName").textContent = `CRM ${unit.name}`;
  $$(".brand-mark").forEach((item) => { item.textContent = unit.short; });
  $$("#businessUnitSwitcher button").forEach((button) => {
    const allowed = (state.user?.businessUnits || ["mi", "pho"]).includes(button.dataset.businessUnit);
    button.classList.toggle("active", button.dataset.businessUnit === state.businessUnit);
    button.classList.toggle("hidden", !allowed);
  });
  const productKeys = new Set(unit.products.map((product) => product.key));
  $$(".product-row").forEach((row) => row.classList.toggle("hidden", !productKeys.has(row.dataset.product)));
  $("#miExtraProducts").classList.toggle("hidden", state.businessUnit !== "mi");
  const options = unit.products.map((product) => `<option value="${product.key}">${product.name}</option>`).join("");
  $("#ledgerProduct").innerHTML = `<option value="">Tất cả mặt hàng</option>${options}`;
  const ledgerHeaders = ["#ledgerProductHeader1", "#ledgerProductHeader2", "#ledgerProductHeader3"];
  const reportHeaders = ["#reportProductHeader1", "#reportProductHeader2", "#reportProductHeader3"];
  ledgerHeaders.forEach((selector, index) => {
    const header = $(selector);
    const product = unit.products[index];
    header.classList.toggle("hidden", !product);
    if (product) {
      const button = header.querySelector("button");
      button.dataset.sort = product.quantity;
      button.childNodes[0].textContent = `${product.name} `;
    }
  });
  reportHeaders.forEach((selector, index) => {
    const header = $(selector);
    const product = unit.products[index];
    header.classList.toggle("hidden", !product);
    if (product) header.textContent = product.name;
  });
  $$('#customerDialog [name^="Gia"], #customerCreateDialog [name^="Gia"]').forEach((input) => {
    const label = input.closest("label");
    const visible = unit.products.some((product) => product.price === input.name);
    label.classList.toggle("hidden", !visible);
  });
  $$('#orderEditForm [name$="Kg"], #orderEditForm [name="huTieu"], #orderEditForm [name="voBanhGoi"], #orderEditForm [name="thungXop"]').forEach((input) => {
    const product = unit.products.find((item) => item.quantity === input.name);
    const visible = Boolean(product) || (state.businessUnit === "mi" && ["huTieu", "voBanhGoi", "thungXop"].includes(input.name));
    input.closest("label").classList.toggle("hidden", !visible);
  });
  $("#aiChatButton").classList.toggle("hidden", state.businessUnit === "pho" || state.user?.role !== "manager");
}

function ensureBulkCopyUi() {
  if (!$("#copyProductionButton")) {
    const orderHead = $("#ordersView .page-head");
    const syncStatus = $("#syncStatus");
    if (orderHead && syncStatus) {
      let actions = orderHead.querySelector(".page-actions");
      if (!actions) {
        actions = document.createElement("div");
        actions.className = "page-actions";
        orderHead.appendChild(actions);
        actions.appendChild(syncStatus);
      }
      actions.insertAdjacentHTML("afterbegin", '<button id="copyProductionButton" class="secondary-button" type="button">Copy sản lượng</button>');
    }
  }
  if (!$("#bulkCopyDialog")) {
    document.body.insertAdjacentHTML("beforeend", `
      <dialog id="bulkCopyDialog" class="profile-dialog bulk-copy-dialog">
        <form id="bulkCopyForm" class="profile-shell">
          <div class="section-head">
            <div><p class="eyebrow">Copy sản lượng</p><h2>Chọn nhiều khách hàng</h2><p id="bulkCopySubtitle"></p></div>
            <button class="icon-button dialog-close" type="button" aria-label="Đóng">×</button>
          </div>
          <section class="bulk-copy-toolbar">
            <label>Lấy sản lượng từ ngày<input id="bulkCopySourceDate" type="date" required /></label>
            <label>Tạo đơn cho ngày<input id="bulkCopyTargetDate" type="date" required /></label>
            <label>Thêm khách<select id="bulkCopyAddCustomer"></select></label>
            <button id="bulkCopyAddCustomerButton" class="secondary-button" type="button">+ Thêm khách</button>
            <button id="bulkCopySelectAll" class="secondary-button" type="button">Chọn tất cả</button>
          </section>
          <div class="table-wrap bulk-copy-table-wrap">
            <table class="bulk-copy-table">
              <thead id="bulkCopyHead"></thead>
              <tbody id="bulkCopyRows"></tbody>
            </table>
          </div>
          <div id="bulkCopyResult" class="notice"></div>
          <div class="dialog-actions"><button class="dialog-close" type="button">Hủy</button><button id="saveBulkCopy" class="primary" type="submit">Tạo đơn đã chọn</button></div>
        </form>
      </dialog>
    `);
  }
  if (!$("#bulkCopyRuntimeStyles")) {
    document.head.insertAdjacentHTML("beforeend", `
      <style id="bulkCopyRuntimeStyles">
        .bulk-copy-dialog{width:min(1120px,calc(100% - 24px))}
        .bulk-copy-toolbar{display:grid;grid-template-columns:repeat(3,minmax(180px,240px)) auto auto;gap:12px;align-items:end;padding:16px 20px;border-bottom:1px solid var(--line)}
        .bulk-copy-toolbar button{height:42px}
        .bulk-copy-table-wrap{max-height:min(58vh,560px);border-bottom:1px solid var(--line)}
        .bulk-copy-table{min-width:860px}
        .bulk-copy-table th:first-child,.bulk-copy-table td:first-child{width:44px;text-align:center}
        .bulk-copy-table input[type="checkbox"]{width:18px;height:18px}
        .bulk-copy-table td{vertical-align:middle}
        .bulk-copy-quantity{display:grid;grid-template-columns:minmax(82px,1fr) auto;align-items:center;gap:6px;min-width:132px}
        .bulk-copy-quantity input{height:38px;padding:8px 9px}
        .bulk-copy-quantity small{display:flex;align-items:center;color:var(--muted);font-weight:600}
        .bulk-copy-quantity select{width:64px;height:38px;padding:6px 5px}
        .bulk-copy-quantity span{display:inline-grid;place-items:center;min-width:24px}
        .bulk-copy-dialog .dialog-actions{padding-top:14px}
        .bulk-copy-dialog .notice.show{margin-left:20px;margin-right:20px}
        @media(max-width:760px){.bulk-copy-dialog{width:100vw;height:100vh;max-height:none;border-radius:0}.bulk-copy-dialog .profile-shell{max-height:100vh;height:100vh}.bulk-copy-toolbar{grid-template-columns:1fr 1fr;padding:14px}.bulk-copy-toolbar button{grid-column:1/-1}.bulk-copy-table-wrap{max-height:none;min-height:0}.bulk-copy-table{min-width:720px}}
      </style>
    `);
  }
}

async function switchBusinessUnit(businessUnit) {
  if (!businessUnits[businessUnit] || !(state.user?.businessUnits || ["mi", "pho"]).includes(businessUnit)) return;
  state.businessUnit = businessUnit;
  localStorage.setItem("nhapLieuBusinessUnit", businessUnit);
  state.ledgerPage = 1;
  state.ledgerSortKey = "date";
  $("#orderForm").reset();
  $("#customerContext").className = "customer-context empty";
  $("#customerContext").textContent = "Chọn khách để xem bảng giá và gợi ý.";
  applyBusinessUnitUi();
  await loadCrm();
}

function matchTokens(value) {
  return normalizeVietnamese(value)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !["khach", "quan", "anh", "chi", "moi"].includes(token));
}

function levenshteinSimilarity(first, second) {
  if (!first || !second) return 0;
  const a = normalizeVietnamese(first);
  const b = normalizeVietnamese(second);
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return 1 - row[b.length] / Math.max(a.length, b.length);
}

function productionMatchScore(code, name, entry) {
  const input = normalizeVietnamese(`${code} ${name}`);
  const entryName = normalizeVietnamese(entry.customer);
  if (!input || !entryName) return 0;
  const codeText = normalizeVietnamese(code);
  const inputTokens = new Set(matchTokens(input));
  const entryTokens = new Set(matchTokens(entryName));
  const sharedTokens = [...inputTokens].filter((token) => entryTokens.has(token));
  const tokenCoverage = sharedTokens.length / Math.max(1, Math.min(inputTokens.size, entryTokens.size));
  let score = tokenCoverage * 55 + levenshteinSimilarity(input, entryName) * 25;
  if (codeText && entryName === codeText) score += 100;
  else if (codeText && new RegExp(`(^|\\s)${codeText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`).test(entryName)) score += 70;
  if (input.includes(entryName) || entryName.includes(input)) score += 25;
  return Math.round(score);
}

function customerProductionMatches() {
  const form = $("#customerCreateForm");
  const code = form.elements.MaKH.value.trim();
  const name = form.elements.TenKH.value.trim();
  if (`${code}${name}`.trim().length < 2) return [];
  return state.productionInfo
    .filter((entry) => entry.customer && !entry.customerCode)
    .map((entry) => ({ entry, score: productionMatchScore(code, name, entry) }))
    .filter((match) => match.score >= 30)
    .sort((first, second) => second.score - first.score)
    .slice(0, 3);
}

function renderCustomerMatchSuggestions() {
  const form = $("#customerCreateForm");
  const matches = customerProductionMatches();
  const container = $("#customerMatchSuggestions");
  const selectedId = Number(form.elements.productionInfoId.value || 0);
  container.classList.toggle("hidden", !matches.length);
  if (!matches.length) {
    form.elements.productionInfoId.value = "";
    $("#customerMatchList").innerHTML = "";
    return;
  }
  $("#customerMatchList").innerHTML = matches.map(({ entry, score }) => {
    const high = score >= 75;
    return `<label class="match-card ${selectedId === Number(entry.id) ? "selected" : ""}">
      <input type="radio" name="productionMatchChoice" value="${entry.id}" ${selectedId === Number(entry.id) ? "checked" : ""} />
      <span class="match-card-main"><strong>${escapeHtml(entry.customer)}</strong><small>${escapeHtml(entry.usualOrder || entry.delivery || entry.production || "Có hồ sơ thông tin sản xuất")}</small></span>
      <span class="match-score ${high ? "high" : ""}">${high ? "Khớp cao" : "Có thể khớp"} · ${Math.min(score, 100)}%</span>
    </label>`;
  }).join("");
}

function formatDate(value) {
  if (!value) return "Chưa có";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function newestOrderFirst(first, second) {
  if (!first.date && !second.date) return Number(second.id || 0) - Number(first.id || 0);
  if (!first.date) return 1;
  if (!second.date) return -1;
  return second.date.localeCompare(first.date) || Number(second.id || 0) - Number(first.id || 0);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function notice(element, message, type = "ok") {
  element.textContent = message;
  element.className = `notice show ${type}`;
}

function clearLocalSession() {
  localStorage.removeItem("nhapLieuAuthToken");
  localStorage.removeItem("nhapLieuAuthUser");
  state.token = "";
  state.user = null;
  renderAuth();
}

async function logout() {
  state.explicitLogout = true;
  const hadSession = Boolean(state.user || state.token);
  if (!hadSession) return;
  try {
    await fetch("/api/logout", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ reason: "explicit-logout" }),
      keepalive: true,
    });
  } catch {
    // The local state is still cleared if the server is temporarily unavailable.
  } finally {
    clearLocalSession();
  }
}

function renderAuth() {
  const loggedIn = Boolean(state.user);
  const isManager = state.user?.role === "manager";
  $("#loginPanel").classList.toggle("hidden", loggedIn);
  $("#appPanel").classList.toggle("hidden", !loggedIn);
  $("#aiChatButton").classList.toggle("hidden", !loggedIn || !isManager);
  if (!loggedIn) {
    $("#aiChatPanel").classList.remove("open");
    $("#aiChatPanel").setAttribute("aria-hidden", "true");
  }
  if (!loggedIn) return;
  const allowedUnits = state.user.businessUnits || ["mi", "pho"];
  if (!allowedUnits.includes(state.businessUnit)) state.businessUnit = allowedUnits[0] || "mi";
  applyBusinessUnitUi();
  $("#userName").textContent = state.user.displayName || state.user.email;
  $("#userRole").textContent = isManager ? "Quản lý" : "Giao hàng";
  $("#userAvatar").textContent = (state.user.displayName || state.user.email || "A").slice(0, 1).toUpperCase();
  $("#userEmail").value = state.user.email;
  $("#addCustomerButton").classList.toggle("hidden", !isManager);
  $("#copyProductionButton")?.classList.toggle("hidden", !isManager);
  $("#addProductionInfo").classList.toggle("hidden", !isManager);
  $("#syncProductionCustomers").classList.toggle("hidden", !isManager);
  $$(".nav-item").forEach((button) => {
    const deliveryAllowed = button.dataset.view === "orders";
    button.classList.toggle("hidden", !isManager && !deliveryAllowed);
  });
  if (!isManager) switchView("orders");
}

function switchView(name) {
  if (state.user?.role === "delivery" && name !== "orders") name = "orders";
  if (name === "reports") resetReportToLast30Days();
  if (name === "productionStats") resetProductionStatsToLast30Days();
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === `${name}View`));
  $$(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === name));
  $(".sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function productSummary(order) {
  if (order.customerResting) return "Khách nghỉ";
  return currentUnit().products
    .map((product) => {
      if (!order[product.quantity]) return "";
      if (product.key === "phoSoi" && order.phoSoiUnit === "cay") {
        return `${product.name} ${number.format(order.phoSoiInputQuantity || order.phoSoiKg / 5)} cây (${number.format(order.phoSoiKg)}kg)`;
      }
      return `${product.name} ${number.format(order[product.quantity])}kg`;
    })
    .filter(Boolean).join(", ") || "Hàng khác";
}

function paymentHistory() {
  return state.payments;
}

function normalizeCrmFinancials() {
  state.orders.forEach((order) => {
    order.subtotal = currentUnit().products.reduce((sum, product) => (
      sum + Number(order[product.quantity] || 0) * Number(order[product.orderPrice] || 0)
    ), 0);
    order.taxAmount = Math.max(0, Number(order.taxAmount || 0));
    order.advance = Math.max(0, Number(order.advance || 0));
    order.total = order.subtotal + order.taxAmount + order.advance;
    order.paid = Math.min(order.total, Math.max(0, Number(order.paid || 0)));
    order.debt = Math.max(0, order.total - order.paid);
  });
}

function recalculateCrmTotals() {
  state.customers.forEach((customer) => {
    const orders = state.orders.filter((order) => normalizeVietnamese(order.customerName) === normalizeVietnamese(customer.TenKH));
    customer.orderCount = orders.length;
    customer.revenue = orders.reduce((sum, order) => sum + Number(order.subtotal || 0), 0);
    customer.paid = orders.reduce((sum, order) => sum + Number(order.paid || 0), 0);
    customer.debt = orders.reduce((sum, order) => sum + Number(order.debt || 0), 0);
    customer.lastOrderDate = orders.map((order) => order.date).filter(Boolean).sort().at(-1) || "";
  });
  state.summary = {
    ...state.summary,
    customerCount: state.customers.length,
    orderCount: state.orders.length,
    revenue: state.orders.reduce((sum, order) => sum + Number(order.subtotal || 0), 0),
    paid: state.orders.reduce((sum, order) => sum + Number(order.paid || 0), 0),
    debt: state.orders.reduce((sum, order) => sum + Number(order.debt || 0), 0),
    tax: state.orders.reduce((sum, order) => sum + Number(order.taxAmount || 0), 0),
    advance: state.orders.reduce((sum, order) => sum + Number(order.advance || 0), 0),
  };
}

function renderSummary() {
  const today = todayInVietnam();
  const todayOrders = state.orders.filter((order) => order.date === today);
  const todayCustomers = new Set(
    todayOrders
      .filter((order) => !order.customerResting)
      .map((order) => normalizeVietnamese(order.customerName)),
  ).size;
  const todayRevenue = todayOrders.reduce((sum, order) => sum + Number(order.subtotal || 0), 0);
  const cards = [
    ["Tổng công nợ", money.format(state.summary.debt || 0), "danger", `${state.customers.filter((item) => item.debt > 0).length} khách còn nợ`],
    ["Doanh thu hôm nay", money.format(todayRevenue), "green", formatDate(today)],
    ["Đơn hàng hôm nay", number.format(todayOrders.length), "gold", "Gồm cả ngày khách nghỉ"],
    ["Khách lấy hôm nay", number.format(todayCustomers), "blue", "Số khách hàng duy nhất"],
  ];
  $("#summaryCards").innerHTML = cards.map(([label, value, color, note]) => `
    <article class="metric"><span class="metric-icon ${color}">${label.includes("Khách") ? "♙" : label.includes("Đơn") ? "▤" : "₫"}</span><div><p>${label}</p><strong>${value}</strong><small>${note}</small></div></article>
  `).join("");
}

function renderDashboard() {
  renderSummary();
  const todayOrders = state.orders.filter((order) => order.date === todayInVietnam());
  $("#recentOrders").innerHTML = todayOrders.map((order) => `
    <tr><td>${formatDate(order.date)}</td><td><strong>${escapeHtml(order.customerName)}</strong></td><td>${productSummary(order)}</td><td>${money.format(order.total)}</td><td><span class="amount ${order.debt > 0 ? "overdue" : "paid"}">${money.format(order.debt)}</span></td></tr>
  `).join("") || '<tr><td colspan="5" class="empty-row">Hôm nay chưa có đơn hàng.</td></tr>';

  const due = [...state.customers].filter((item) => item.debt > 0).sort((a, b) => b.debt - a.debt).slice(0, 4);
  const predicted = state.customers.filter((item) => item.suggestion?.nextDate).sort((a, b) => a.suggestion.nextDate.localeCompare(b.suggestion.nextDate))[0];
  $("#attentionList").innerHTML = [
    ...due.map((item) => `<button data-customer="${escapeHtml(item.MaKH)}"><span class="attention-icon debt">₫</span><span><strong>${escapeHtml(item.TenKH)}</strong><small>Còn nợ ${money.format(item.debt)}</small></span><b>›</b></button>`),
    predicted ? `<button data-insight="${escapeHtml(predicted.MaKH)}"><span class="attention-icon ai">✦</span><span><strong>${escapeHtml(predicted.TenKH)}</strong><small>Có thể đặt lại ${formatDate(predicted.suggestion.nextDate)}</small></span><b>›</b></button>` : "",
  ].join("") || '<p class="empty-state">Không có việc cần chú ý.</p>';
}

function renderCustomers(filter = "") {
  const query = filter.trim().toLowerCase();
  const rows = state.customers
    .filter((item) => `${item.MaKH} ${item.TenKH}`.toLowerCase().includes(query))
    .sort((first, second) => compareCustomerNames(first, second, currentCustomerSortDirection()));
  $("#customerTable").innerHTML = rows.map((item) => `
    <tr><td><div class="customer-cell"><span class="avatar">${escapeHtml(item.TenKH.slice(0, 1))}</span><span><strong>${escapeHtml(item.TenKH)}</strong><small>${escapeHtml(item.MaKH)}</small></span></div></td>
    <td>${number.format(item.orderCount || 0)}</td><td>${money.format(item.revenue || 0)}</td><td>${money.format(item.paid || 0)}</td><td><strong class="${item.debt > 0 ? "debt-value" : ""}">${money.format(item.debt || 0)}</strong></td><td>${formatDate(item.lastOrderDate)}</td><td>${escapeHtml(item.NhaXeMacDinh || "Chưa đặt")}</td>
    <td><div class="row-actions"><button class="small-button view-customer" data-code="${escapeHtml(item.MaKH)}">Chi tiết</button>${item.debt > 0 ? `<button class="small-button payment-button record-payment" data-code="${escapeHtml(item.MaKH)}">Thu tiền</button>` : ""}<button class="small-button edit-customer" data-code="${escapeHtml(item.MaKH)}">Sửa giá</button></div></td></tr>
  `).join("") || '<tr><td colspan="8" class="empty-row">Không tìm thấy khách hàng.</td></tr>';
}

function renderUsers() {
  if (state.user?.role !== "manager") return;
  const pending = state.users.filter((user) => user.status === "pending").length;
  const active = state.users.filter((user) => user.status === "active").length;
  const disabled = state.users.filter((user) => user.status === "disabled").length;
  $("#userApprovalSummary").innerHTML = [
    ["Chờ duyệt", pending],
    ["Đang hoạt động", active],
    ["Đã khóa", disabled],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${number.format(value)}</strong></div>`).join("");
  $("#userTable").innerHTML = state.users.map((user) => {
    const access = user.businessUnits || ["mi", "pho"];
    return `<tr data-user-id="${user.id}">
      <td><div class="user-identity"><strong>${escapeHtml(user.displayName)}</strong><small>${escapeHtml(user.email)}</small></div></td>
      <td><select class="user-role-select"><option value="delivery" ${user.role === "delivery" ? "selected" : ""}>Giao hàng</option><option value="manager" ${user.role === "manager" ? "selected" : ""}>Quản lý</option></select></td>
      <td><select class="user-status-select"><option value="pending" ${user.status === "pending" ? "selected" : ""}>Chờ duyệt</option><option value="active" ${user.status === "active" ? "selected" : ""}>Hoạt động</option><option value="disabled" ${user.status === "disabled" ? "selected" : ""}>Đã khóa</option></select></td>
      <td><div class="unit-permissions"><label><input class="user-unit-input" type="checkbox" value="mi" ${access.includes("mi") ? "checked" : ""}/> Mì</label><label><input class="user-unit-input" type="checkbox" value="pho" ${access.includes("pho") ? "checked" : ""}/> Phở</label></div></td>
      <td>${formatDate(String(user.createdAt || "").slice(0, 10))}</td>
      <td>${user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" }) : "Chưa đăng nhập"}</td>
      <td><button class="small-button user-save" type="button">Lưu quyền</button></td>
    </tr>`;
  }).join("") || '<tr><td colspan="7" class="empty-row">Chưa có người dùng.</td></tr>';
}

const auditActionLabels = {
  "user-login": "Đăng nhập",
  "user-logout": "Đăng xuất",
  "user-page-exit": "Rời trang / đóng tab",
  "user-registered": "Đăng ký tài khoản",
  "user-permission-updated": "Thay đổi phân quyền",
  "order-created": "Tạo đơn",
  "order-copied": "Copy đơn",
  "order-updated": "Điều chỉnh đơn",
  "order-deleted": "Xóa đơn",
  "payment-recorded": "Ghi nhận thu tiền",
  "customer-created": "Thêm khách hàng",
  "customer-updated": "Cập nhật khách hàng",
  "production-info-created": "Thêm thông tin SX",
  "production-info-updated": "Sửa thông tin SX",
  "production-customers-matched": "Khớp khách CRM",
};

const auditSessionActions = new Set(["user-login", "user-logout", "user-page-exit"]);

function formatAuditTime(value) {
  if (!value) return "Chưa rõ";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return date.toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function auditDetailSummary(entry) {
  const details = entry.details || {};
  if (auditSessionActions.has(entry.action)) {
    return [
      details.ip ? `IP ${details.ip}` : "",
      details.role === "manager" ? "Quản lý" : "Giao hàng",
      details.importedLastLogin ? "Lần đăng nhập gần nhất trước khi bật nhật ký" : "",
    ].filter(Boolean).join(" · ");
  }
  if (entry.action === "order-created" || entry.action === "order-copied") {
    return [
      details.customerName,
      details.date ? formatDate(details.date) : "",
      details.total !== undefined ? money.format(details.total) : "",
    ].filter(Boolean).join(" · ");
  }
  if (entry.action === "payment-recorded") {
    return [details.customerName, money.format(details.amount || 0), details.date ? formatDate(details.date) : ""].filter(Boolean).join(" · ");
  }
  if (entry.action === "user-permission-updated") {
    const before = details.before || {};
    const after = details.after || {};
    return `${details.targetEmail || ""} · ${before.role || "?"}/${before.status || "?"} → ${after.role || "?"}/${after.status || "?"}`;
  }
  if (entry.action === "customer-updated") {
    return `Khách ${entry.targetCustomerCode || details.after?.MaKH || ""}`;
  }
  if (entry.action === "order-updated") {
    return `Đơn #${entry.targetOrderId || details.after?.id || ""}`;
  }
  if (entry.action === "order-deleted") {
    return [
      `Đơn #${entry.targetOrderId || details.deletedOrder?.id || ""}`,
      details.deletedOrder?.customerName,
      details.reversedPayment ? `Hoàn tác ${money.format(details.reversedPayment)}` : "",
    ].filter(Boolean).join(" · ");
  }
  return "";
}

function renderAuditLog() {
  if (state.user?.role !== "manager") return;
  const query = normalizeVietnamese($("#auditSearch").value);
  const selectedGroup = $("#auditGroup").value;
  const selectedSession = $("#auditSession").value;
  const selectedAccount = $("#auditAccount").value;
  $("#auditSession").disabled = selectedGroup !== "session";
  const entries = state.auditLog.filter((entry) => {
    const sessionAction = auditSessionActions.has(entry.action);
    if (selectedGroup === "data" && sessionAction) return false;
    if (selectedGroup === "session" && !sessionAction) return false;
    if (selectedGroup === "session" && selectedSession === "user-login" && entry.action !== "user-login") return false;
    if (selectedGroup === "session" && selectedSession === "logout" && !["user-logout", "user-page-exit"].includes(entry.action)) return false;
    if (selectedAccount && normalizeVietnamese(entry.actorEmail) !== normalizeVietnamese(selectedAccount)) return false;
    if (!query) return true;
    return normalizeVietnamese([
      entry.actorName,
      entry.actorEmail,
      entry.summary,
      auditActionLabels[entry.action] || entry.action,
      JSON.stringify(entry.details || {}),
    ].join(" ")).includes(query);
  });
  const loginCount = entries.filter((entry) => entry.action === "user-login").length;
  const logoutCount = entries.filter((entry) => ["user-logout", "user-page-exit"].includes(entry.action)).length;
  const dataChangeCount = entries.filter((entry) => !auditSessionActions.has(entry.action)).length;
  $("#auditSummary").innerHTML = [
    ["Thay đổi dữ liệu", dataChangeCount],
    ["Đăng nhập", loginCount],
    ["Đăng xuất / rời trang", logoutCount],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${number.format(value)}</strong></div>`).join("");
  $("#auditCount").textContent = `Hiển thị ${number.format(entries.length)} / ${number.format(state.auditLog.length)} sự kiện gần nhất`;
  $("#auditTable").innerHTML = entries.map((entry) => {
    const label = auditActionLabels[entry.action] || entry.action;
    const detailSummary = auditDetailSummary(entry);
    const details = entry.details && Object.keys(entry.details).length
      ? `<details class="audit-details"><summary>Xem dữ liệu</summary><pre>${escapeHtml(JSON.stringify(entry.details, null, 2))}</pre></details>`
      : "";
    return `<tr>
      <td><strong>${formatAuditTime(entry.createdAt)}</strong></td>
      <td><div class="user-identity"><strong>${escapeHtml(entry.actorName || "Hệ thống")}</strong><small>${escapeHtml(entry.actorEmail || "")}</small></div></td>
      <td><span class="audit-action">${escapeHtml(label)}</span></td>
      <td class="audit-description"><strong>${escapeHtml(entry.summary || label)}</strong>${detailSummary ? `<small>${escapeHtml(detailSummary)}</small>` : ""}${details}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="4" class="empty-row">Không có hoạt động phù hợp.</td></tr>';
}

function renderAuditAccounts() {
  if (state.user?.role !== "manager") return;
  const current = $("#auditAccount").value;
  const accounts = new Map();
  state.users.forEach((user) => accounts.set(normalizeVietnamese(user.email), {
    email: user.email,
    name: user.displayName,
  }));
  state.auditLog.forEach((entry) => {
    if (!entry.actorEmail) return;
    accounts.set(normalizeVietnamese(entry.actorEmail), {
      email: entry.actorEmail,
      name: entry.actorName || entry.actorEmail,
    });
  });
  const sorted = [...accounts.values()].sort((first, second) => first.name.localeCompare(second.name, "vi"));
  $("#auditAccount").innerHTML = `<option value="">Tất cả tài khoản</option>${sorted.map((account) => (
    `<option value="${escapeHtml(account.email)}">${escapeHtml(account.name)} · ${escapeHtml(account.email)}</option>`
  )).join("")}`;
  $("#auditAccount").value = sorted.some((account) => account.email === current) ? current : "";
}

function filteredProductionInfo() {
  const query = normalizeVietnamese($("#productionSearch").value);
  const filter = $("#productionFilter").value;
  return state.productionInfo.filter((entry) => {
    const haystack = normalizeVietnamese([entry.customerCode, entry.customer, entry.usualOrder, entry.production, entry.delivery, entry.additional, entry.invoice].join(" "));
    if (query && !haystack.includes(query)) return false;
    if (filter && !String(entry[filter] || "").trim()) return false;
    return true;
  });
}

function renderProductionInfo() {
  const entries = filteredProductionInfo();
  const linkedCount = state.productionInfo.filter((entry) => entry.customerCode).length;
  const unlinkedCount = state.productionInfo.length - linkedCount;
  $("#productionInfoTitle").textContent = state.productionInfoTitle || "Quy cách và thông tin giao hàng theo khách.";
  $("#productionCount").textContent = `${number.format(entries.length)} / ${number.format(state.productionInfo.length)} khách hàng`;
  $("#productionLinkedCount").textContent = `Đã khớp ${number.format(linkedCount)}`;
  $("#productionUnlinkedCount").textContent = `Chưa khớp ${number.format(unlinkedCount)}`;
  $("#productionTable").innerHTML = entries.map((entry) => `
    <tr>
      <td><strong>${escapeHtml(entry.customer || "Chưa đặt tên")}</strong><small class="block">Hồ sơ SX #${entry.id}</small></td>
      <td>${entry.customerCode
        ? `<span class="production-link-status linked">Đã khớp<small>${escapeHtml(entry.customerCode)}${state.customers.find((customer) => normalizeVietnamese(customer.MaKH) === normalizeVietnamese(entry.customerCode)) ? ` · ${escapeHtml(state.customers.find((customer) => normalizeVietnamese(customer.MaKH) === normalizeVietnamese(entry.customerCode)).TenKH)}` : ""}</small></span>`
        : '<span class="production-link-status">Chưa khớp</span>'}</td>
      <td><div class="production-text">${escapeHtml(entry.usualOrder || "—")}</div></td>
      <td><div class="production-text">${escapeHtml(entry.production || "—")}</div></td>
      <td><div class="production-text">${escapeHtml(entry.delivery || entry.additional || "—")}</div></td>
      <td><div class="production-actions"><button class="small-button view-production-info" data-id="${entry.id}">Chi tiết</button>${state.user?.role === "manager" ? `<button class="small-button edit-production-info" data-id="${entry.id}">Sửa</button>` : ""}</div></td>
    </tr>
  `).join("") || '<tr><td colspan="6" class="empty-row">Không tìm thấy thông tin phù hợp.</td></tr>';
}

function openProductionInfo(id) {
  const entry = state.productionInfo.find((item) => Number(item.id) === Number(id));
  if (!entry) return;
  $("#productionDetailCustomer").textContent = entry.customer || "Thông tin khách hàng";
  $("#productionDetailRow").textContent = `Hồ sơ SX #${entry.id}`;
  const sections = [
    ["Số lượng thường lấy", entry.usualOrder],
    ["Hướng dẫn sản xuất", entry.production],
    ["Nơi gửi", entry.delivery],
    ["Thông tin bổ sung", entry.additional],
    ["Thông tin xuất hóa đơn", entry.invoice],
  ];
  $("#productionDetail").innerHTML = sections.map(([label, value]) => `
    <section><h3>${label}</h3><p class="${value ? "" : "empty-detail"}">${escapeHtml(value || "Chưa có thông tin")}</p></section>
  `).join("");
  $("#productionInfoDialog").showModal();
}

function openProductionEdit(id) {
  const entry = state.productionInfo.find((item) => Number(item.id) === Number(id));
  if (!entry) return;
  const form = $("#productionEditForm");
  form.reset();
  form.elements.customerCode.innerHTML = `<option value="">Chưa liên kết</option>${[...state.customers].sort(compareCustomerNames).map((customer) => `<option value="${escapeHtml(customer.MaKH)}">${escapeHtml(customer.MaKH)} · ${escapeHtml(customer.TenKH)}</option>`).join("")}`;
  ["id", "customer", "usualOrder", "production", "delivery", "additional", "invoice", "customerCode"].forEach((field) => {
    form.elements[field].value = entry[field] || "";
  });
  $("#productionEditEyebrow").textContent = "Chỉnh sửa thông tin SX";
  $("#productionEditTitle").textContent = entry.customer || `Hồ sơ SX #${entry.id}`;
  $("#saveProductionInfo").textContent = "Lưu thông tin";
  $("#productionEditResult").className = "notice";
  $("#productionEditDialog").showModal();
}

function openProductionCreate() {
  const form = $("#productionEditForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.customerCode.innerHTML = `<option value="">Chưa liên kết</option>${[...state.customers].sort(compareCustomerNames).map((customer) => `<option value="${escapeHtml(customer.MaKH)}">${escapeHtml(customer.MaKH)} · ${escapeHtml(customer.TenKH)}</option>`).join("")}`;
  $("#productionEditEyebrow").textContent = "Thêm thông tin SX";
  $("#productionEditTitle").textContent = "Khách hàng mới";
  $("#saveProductionInfo").textContent = "Thêm thông tin";
  $("#productionEditResult").className = "notice";
  $("#productionEditDialog").showModal();
  form.elements.customerCode.focus();
}

function customerCodeForName(name) {
  return state.customers.find((item) => item.TenKH.trim().toLowerCase() === String(name || "").trim().toLowerCase())?.MaKH || "";
}

function sortValue(order, key) {
  if (key === "customerResting") return order.customerResting ? 1 : 0;
  if (["miKg", "caoKg", "hoanhKg", "phoSoiKg", "phoCuonKg", "subtotal", "taxAmount", "advance", "paid", "debt"].includes(key)) return Number(order[key] || 0);
  if (key === "date") return order.date || "";
  return normalizeVietnamese(order[key] || "");
}

function compareLedgerOrders(first, second) {
  const key = state.ledgerSortKey;
  const direction = state.ledgerSortDirection === "asc" ? 1 : -1;
  if (key === "date") {
    if (!first.date && second.date) return 1;
    if (first.date && !second.date) return -1;
  }
  const a = sortValue(first, key);
  const b = sortValue(second, key);
  let result = 0;
  if (typeof a === "number" && typeof b === "number") {
    result = a - b;
  } else {
    if (!a && b) result = 1;
    else if (a && !b) result = -1;
    else result = String(a).localeCompare(String(b), "vi", { numeric: true });
  }
  return result * direction || newestOrderFirst(first, second);
}

function filteredLedgerOrders() {
  const search = normalizeVietnamese($("#ledgerSearch").value);
  const customerName = $("#ledgerCustomer").value;
  const from = $("#ledgerFrom").value;
  const to = $("#ledgerTo").value;
  const product = $("#ledgerProduct").value;
  return state.orders.filter((order) => {
    const haystack = normalizeVietnamese(`${order.customerName} ${customerCodeForName(order.customerName)} ${order.extraShipCustomer} ${order.note} ${order.truck}`);
    if (search && !haystack.includes(search)) return false;
    if (customerName && normalizeVietnamese(order.customerName.trim()) !== normalizeVietnamese(customerName.trim())) return false;
    if (from && (!order.date || order.date < from)) return false;
    if (to && (!order.date || order.date > to)) return false;
    const productConfig = currentUnit().products.find((item) => item.key === product);
    if (productConfig && !(order[productConfig.quantity] > 0)) return false;
    return true;
  }).sort(compareLedgerOrders);
}

function renderLedger() {
  const products = currentUnit().products;
  const orders = filteredLedgerOrders();
  const totalPages = Math.max(1, Math.ceil(orders.length / state.ledgerPageSize));
  state.ledgerPage = Math.min(state.ledgerPage, totalPages);
  const start = (state.ledgerPage - 1) * state.ledgerPageSize;
  const pageOrders = orders.slice(start, start + state.ledgerPageSize);
  $("#ledgerCount").textContent = `${number.format(orders.length)} / ${number.format(state.orders.length)} giao dịch`;
  $("#ledgerTable").innerHTML = pageOrders.map((order) => `
    <tr>
      <td>${formatDate(order.date)}</td>
      <td><button class="customer-link view-customer" data-code="${escapeHtml(customerCodeForName(order.customerName))}" data-name="${escapeHtml(order.customerName)}">${escapeHtml(order.customerName)}</button></td>
      ${products.map((product) => `<td>${order[product.quantity] ? `${number.format(order[product.quantity])} kg` : "—"}</td>`).join("")}
      <td>${money.format(order.subtotal)}</td><td>${money.format(order.taxAmount)}</td><td>${money.format(order.advance)}</td>
      <td>${money.format(order.paid)}</td><td><strong class="${order.debt > 0 ? "debt-value" : ""}">${money.format(order.debt)}</strong></td>
      <td>${escapeHtml(order.truck || "—")}</td>
      <td>
        <details class="action-menu">
          <summary aria-label="Mở thao tác">...</summary>
          <div>
            <button class="copy-order" data-id="${order.id}" type="button">Copy đơn và điều chỉnh</button>
            <button class="edit-order" data-id="${order.id}" type="button">Điều chỉnh</button>
            ${state.user?.role === "manager" ? `<button class="delete-order" data-id="${order.id}" type="button">Xóa đơn</button>` : ""}
          </div>
        </details>
      </td>
      <td>${escapeHtml(order.extraShipCustomer || "—")}</td>
      <td>${order.customerResting ? '<span class="rest-mark" title="Khách nghỉ">✓</span>' : "—"}</td>
      <td class="note-cell">${escapeHtml(order.note || "—")}</td>
    </tr>
  `).join("") || `<tr><td colspan="${12 + products.length}" class="empty-row">Không có giao dịch phù hợp.</td></tr>`;

  const totals = orders.reduce((result, order) => ({
    subtotal: result.subtotal + order.subtotal,
    tax: result.tax + order.taxAmount,
    advance: result.advance + order.advance,
    paid: result.paid + order.paid,
    debt: result.debt + order.debt,
  }), { subtotal: 0, tax: 0, advance: 0, paid: 0, debt: 0 });
  $("#ledgerTotals").innerHTML = [
    ["Tiền hàng", totals.subtotal],
    ["Tiền thuế", totals.tax],
    ["Ứng chành xe", totals.advance],
    ["Đã thanh toán", totals.paid],
    ["Còn lại", totals.debt],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${money.format(value)}</strong></div>`).join("");
  $("#ledgerPage").textContent = `Trang ${state.ledgerPage} / ${totalPages}`;
  $("#ledgerPrev").disabled = state.ledgerPage <= 1;
  $("#ledgerNext").disabled = state.ledgerPage >= totalPages;
  $$(".sort-button[data-sort]").forEach((button) => {
    const active = button.dataset.sort === state.ledgerSortKey;
    button.classList.toggle("active", active);
    button.querySelector("span").textContent = active ? (state.ledgerSortDirection === "desc" ? "↓" : "↑") : "↕";
  });
}

function renderLedgerCustomers() {
  const names = [...new Set(state.orders.map((order) => order.customerName.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "vi"));
  $("#ledgerCustomer").innerHTML = `<option value="">Tất cả khách hàng</option>${names.map((name) => {
    const code = customerCodeForName(name);
    return `<option value="${escapeHtml(name)}">${code ? `${escapeHtml(code)} · ` : ""}${escapeHtml(name)}</option>`;
  }).join("")}`;
}

function copyLedgerOrder(button) {
  const sourceOrder = state.orders.find((order) => Number(order.id) === Number(button.dataset.id));
  if (!sourceOrder) return;
  openOrderEditDialog(sourceOrder.id, "copy");
}

async function deleteLedgerOrder(button) {
  const order = state.orders.find((item) => Number(item.id) === Number(button.dataset.id));
  if (!order || state.user?.role !== "manager") return;
  const confirmed = window.confirm(
    `Xóa đơn #${order.id} của ${order.customerName} ngày ${formatDate(order.date)}?\n\n`
    + "Công nợ và khoản thanh toán đã phân bổ cho đơn này sẽ được tính lại.",
  );
  if (!confirmed) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Đang xóa...";
  try {
    const response = await fetch("/api/orders", {
      method: "DELETE",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        rowId: order.id,
        businessUnit: state.businessUnit,
      }),
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Không xóa được đơn hàng.");
    await loadCrm();
    const paymentText = data.reversedPayment
      ? ` Đã hoàn tác ${money.format(data.reversedPayment)} thanh toán liên quan.`
      : "";
    notice($("#ledgerResult"), `Đã xóa đơn #${data.rowNumber} của ${data.customerName}.${paymentText}`);
  } catch (error) {
    notice($("#ledgerResult"), error.message, "error");
    button.disabled = false;
    button.textContent = originalText;
  }
}

function openCustomerProfile(code, historicalName = "") {
  const knownCustomer = state.customers.find((item) => item.MaKH === code);
  const customerName = knownCustomer?.TenKH || historicalName;
  if (!customerName) return;
  const matchingOrders = state.orders.filter((order) => normalizeVietnamese(order.customerName.trim()) === normalizeVietnamese(customerName.trim()));
  const latestPricedOrder = matchingOrders.find((order) => currentUnit().products.some((product) => order[product.orderPrice])) || {};
  const customer = knownCustomer || {
    MaKH: "Khách lịch sử",
    TenKH: customerName,
    NhaXeMacDinh: matchingOrders.find((order) => order.truck)?.truck || "",
    GiaMi: latestPricedOrder.priceMi || 0,
    GiaCao: latestPricedOrder.priceCao || 0,
    GiaHoanh: latestPricedOrder.priceHoanh || 0,
    GiaPhoSoi: latestPricedOrder.pricePhoSoi || 0,
    GiaPhoCuon: latestPricedOrder.pricePhoCuon || 0,
  };
  state.profileCustomerCode = knownCustomer ? code : "";
  state.profileCustomerName = customerName;
  const productionEntry = knownCustomer
    ? state.productionInfo.find((entry) => normalizeVietnamese(entry.customerCode) === normalizeVietnamese(code))
    : null;
  const profileExportButton = ensureProfileExportButton();
  const profileSheetButton = ensureProfileSheetButton();
  $("#profileProductionInfo").classList.toggle("hidden", !productionEntry);
  $("#profileProductionInfo").dataset.id = productionEntry?.id || "";
  $("#profileCreateOrder").classList.toggle("hidden", !knownCustomer);
  if (profileExportButton) {
    profileExportButton.classList.toggle("hidden", !knownCustomer);
    profileExportButton.dataset.code = knownCustomer?.MaKH || "";
  }
  if (profileSheetButton) {
    profileSheetButton.classList.toggle("hidden", !knownCustomer);
    profileSheetButton.dataset.code = knownCustomer?.MaKH || "";
  }
  const orders = matchingOrders.sort(newestOrderFirst);
  const totals = orders.reduce((result, order) => ({
    revenue: result.revenue + order.total,
    debt: result.debt + order.debt,
    paid: result.paid + order.paid,
    tax: result.tax + order.taxAmount,
  }), { revenue: 0, debt: 0, paid: 0, tax: 0 });
  $("#profileCustomerName").textContent = customer.TenKH;
  $("#profileCustomerCode").textContent = `${customer.MaKH} · ${customer.NhaXeMacDinh || "Chưa có nhà xe mặc định"}`;
  $("#profileMetrics").innerHTML = [
    ["Số giao dịch", number.format(orders.length)],
    ["Tiền hàng", money.format(orders.reduce((sum, order) => sum + Number(order.subtotal || 0), 0))],
    ["Đã thanh toán", money.format(totals.paid)],
    ["Còn lại", money.format(totals.debt)],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#profilePrices").innerHTML = [
    ...currentUnit().products.map((product) => [`Giá ${product.name.toLowerCase()}`, money.format(customer[product.price] || 0)]),
    ["Tổng thuế", money.format(totals.tax)],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#profileOrderCount").textContent = `${number.format(orders.length)} giao dịch`;
  $("#profilePayment").classList.toggle("hidden", !knownCustomer || totals.debt <= 0);
  $("#profilePayment").dataset.code = knownCustomer?.MaKH || "";
  $("#profileOrders").innerHTML = orders.map((order) => `
    <tr><td>${formatDate(order.date)}</td><td>${productSummary(order)}</td><td>${money.format(order.subtotal)}</td><td>${money.format(order.taxAmount)}</td><td>${money.format(order.paid)}</td><td><strong class="${order.debt > 0 ? "debt-value" : ""}">${money.format(order.debt)}</strong></td><td class="note-cell">${escapeHtml(order.note || "—")}</td><td><button class="small-button edit-order" data-id="${order.id}">Điều chỉnh</button></td></tr>
  `).join("") || '<tr><td colspan="8" class="empty-row">Khách chưa có giao dịch.</td></tr>';
  const payments = paymentHistory().filter((payment) => payment.customerCode === code).slice(0, 5);
  $("#profilePayments").innerHTML = payments.length
    ? `<h3>Thanh toán đã ghi nhận khi test CRM</h3>${payments.map((payment) => `<div><span>${formatDate(payment.date)} · ${escapeHtml(payment.note || "Không ghi chú")}</span><strong>${money.format(payment.amount)}</strong></div>`).join("")}`
    : "";
  if (!$("#customerProfileDialog").open) $("#customerProfileDialog").showModal();
}

function ensureProfileExportButton() {
  let button = $("#profileExportExcel");
  if (button) return button;
  const actions = $("#customerProfileDialog .profile-history-head .row-actions");
  if (!actions) return null;
  button = document.createElement("button");
  button.id = "profileExportExcel";
  button.className = "secondary-button hidden";
  button.type = "button";
  button.textContent = "↓ Xuất Excel";
  actions.prepend(button);
  return button;
}

function ensureProfileSheetButton() {
  let button = $("#profileExportSheet");
  if (button) return button;
  const actions = $("#customerProfileDialog .profile-history-head .row-actions");
  if (!actions) return null;
  button = document.createElement("button");
  button.id = "profileExportSheet";
  button.className = "secondary-button hidden";
  button.type = "button";
  button.textContent = "↗ Xuất Google Sheet";
  const excelButton = $("#profileExportExcel");
  if (excelButton && excelButton.parentElement === actions) {
    actions.insertBefore(button, excelButton);
  } else {
    actions.prepend(button);
  }
  return button;
}

function excelHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function excelFilename(value) {
  return normalizeVietnamese(value || "khach-hang")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "khach-hang";
}

function excelTable(headers, rows) {
  return `<table><thead><tr>${headers.map((header) => `<th>${excelHtml(header)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => (
    `<tr>${row.map(excelCell).join("")}</tr>`
  )).join("")}</tbody></table>`;
}

function excelNumber(value) {
  return Number(value || 0).toLocaleString("vi-VN", { maximumFractionDigits: 2 });
}

function excelQuantityText(value) {
  return Number(value || 0).toLocaleString("vi-VN", { maximumFractionDigits: 2 });
}

function excelCell(cell) {
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
    return `<td>${excelHtml(cell)}</td>`;
  }
  const attributes = [];
  let text = cell.value;
  if (cell.number !== undefined) {
    attributes.push(`x:num="${Number(cell.number || 0)}"`);
    text = excelNumber(cell.number);
  }
  if (cell.formula) attributes.push(`x:fmla="${excelHtml(cell.formula)}"`);
  return `<td ${attributes.join(" ")}>${excelHtml(text)}</td>`;
}

function profileExcelProducts(orders) {
  return currentUnit().products.filter((product) => (
    orders.some((order) => Number(order[product.quantity] || 0) > 0)
  ));
}

function profileExcelExtras(orders, totals) {
  return [
    { key: "subtotal", header: "Tiền hàng", value: (order) => Number(order.subtotal || 0) },
    ...(totals.tax > 0 ? [{ key: "tax", header: "Thuế", value: (order) => Number(order.taxAmount || 0) }] : []),
    ...(totals.advance > 0 ? [{ key: "advance", header: "Ứng xe", value: (order) => Number(order.advance || 0) }] : []),
    { key: "paid", header: "Đã trả", value: (order) => Number(order.paid || 0) },
    { key: "debt", header: "Còn lại", value: (order) => Number(order.debt || 0) },
    ...(orders.some((order) => order.truck) ? [{ header: "Nhà xe", value: (order) => order.truck || "" }] : []),
    ...(orders.some((order) => order.extraShipCustomer) ? [{ header: "Khách phụ ship", value: (order) => order.extraShipCustomer || "" }] : []),
    ...(orders.some((order) => order.customerResting) ? [{ header: "Khách nghỉ", value: (order) => (order.customerResting ? "Có" : "") }] : []),
    ...(orders.some((order) => order.note) ? [{ header: "Ghi chú", value: (order) => order.note || "" }] : []),
  ];
}

function relativeCellReference(offset) {
  if (offset === 0) return "RC";
  return `RC[${offset}]`;
}

function exportCustomerProfileBrowserXls(code) {
  const knownCustomer = state.customers.find((item) => item.MaKH === code);
  const customerName = knownCustomer?.TenKH || state.profileCustomerName;
  if (!customerName) throw new Error("Không tìm thấy dữ liệu khách hàng để xuất.");
  const orders = state.orders
    .filter((order) => normalizeVietnamese(order.customerName.trim()) === normalizeVietnamese(customerName.trim()))
    .sort(newestOrderFirst);
  const payments = paymentHistory().filter((payment) => payment.customerCode === code);
  const totals = orders.reduce((result, order) => ({
    subtotal: result.subtotal + Number(order.subtotal || 0),
    tax: result.tax + Number(order.taxAmount || 0),
    advance: result.advance + Number(order.advance || 0),
    paid: result.paid + Number(order.paid || 0),
    debt: result.debt + Number(order.debt || 0),
  }), { subtotal: 0, tax: 0, advance: 0, paid: 0, debt: 0 });
  const products = profileExcelProducts(orders);
  const extras = profileExcelExtras(orders, totals);
  const detailHeaders = [
    "Ngày",
    "Mã đơn",
    ...products.flatMap((product) => [`${product.name} - SL kg`, `${product.name} - Đơn giá`, `${product.name} - Thành tiền`]),
    ...extras.map((column) => column.header),
  ];
  const detailRows = orders.map((order) => {
    const productCells = products.flatMap((product) => {
      const quantity = Number(order[product.quantity] || 0);
      const price = Number(order[product.orderPrice] || 0);
      return [
        excelQuantityText(quantity),
        { number: price },
        { number: quantity * price, formula: '=NUMBERVALUE(RC[-2],",",".")*RC[-1]' },
      ];
    });
    const productAmountOffsets = products.map((_, index) => 2 + index * 3 - products.length * 3);
    const extraCells = extras.map((column, columnIndex) => {
      if (column.key === "subtotal" && productAmountOffsets.length) {
        return {
          number: Number(order.subtotal || 0),
          formula: `=SUM(${productAmountOffsets.map((offset) => `RC[${offset}]`).join(",")})`,
        };
      }
      if (column.key === "debt") {
        const referenceFor = (key) => {
          const index = extras.findIndex((item) => item.key === key);
          return index === -1 ? null : relativeCellReference(index - columnIndex);
        };
        const addends = [referenceFor("subtotal"), referenceFor("tax"), referenceFor("advance")].filter(Boolean);
        const paidReference = referenceFor("paid") || "0";
        return {
          number: Number(order.debt || 0),
          formula: `=${addends.join("+") || "0"}-${paidReference}`,
        };
      }
      const value = column.value(order);
      return typeof value === "number" ? { number: value } : value;
    });
    return [
      formatDate(order.date),
      { number: Number(order.id || 0) },
      ...productCells,
      ...extraCells,
    ];
  });
  const paymentRows = payments.map((payment) => [
    formatDate(payment.date),
    { number: Number(payment.amount || 0) },
    payment.note || "",
    (payment.allocations || []).map((item) => `#${item.orderId}: ${Number(item.amount || 0)}`).join("; "),
  ]);
  const html = `<!doctype html>
<html><head><meta charset="utf-8" /><style>
body{font-family:Arial,sans-serif} h1{font-size:18pt;color:#17352f} h2{font-size:13pt;color:#246b59;margin-top:22px}
table{border-collapse:collapse;margin-bottom:18px} th{background:#246b59;color:#fff;font-weight:bold}
th,td{border:1px solid #dfe5e2;padding:6px 8px;vertical-align:top}
</style></head><body>
<h1>Hồ sơ khách hàng - ${excelHtml(customerName)}</h1>
<p>Mã khách: ${excelHtml(code)} - Nhà xe: ${excelHtml(knownCustomer?.NhaXeMacDinh || "")}</p>
${excelTable(
    ["Số giao dịch", "Tiền hàng", ...(totals.tax > 0 ? ["Thuế"] : []), ...(totals.advance > 0 ? ["Ứng xe"] : []), "Đã trả", "Còn lại"],
    [[{ number: orders.length }, { number: totals.subtotal }, ...(totals.tax > 0 ? [{ number: totals.tax }] : []), ...(totals.advance > 0 ? [{ number: totals.advance }] : []), { number: totals.paid }, { number: totals.debt }]],
  )}
<h2>Lịch sử giao dịch</h2>
${excelTable(detailHeaders, detailRows)}
<h2>Lịch sử thanh toán</h2>
${excelTable(["Ngày", "Số tiền", "Ghi chú", "Giao dịch được phân bổ"], paymentRows)}
</body></html>`;
  const blob = new Blob([`\ufeff${html.replace("<html>", '<html xmlns:x="urn:schemas-microsoft-com:office:excel">')}`], { type: "application/vnd.ms-excel;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `ho-so-${excelFilename(customerName)}-${todayInVietnam()}.xls`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function exportCustomerProfileExcel(button) {
  const code = button.dataset.code || state.profileCustomerCode;
  if (!code) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Đang tạo Excel...";
  try {
    const response = await fetch(unitUrl(`/api/export-customer?customerCode=${encodeURIComponent(code)}`), {
      headers: authHeaders(),
    });
    if (!response.ok) {
      const data = await readApiResponse(response);
      throw new Error(data.error || "Không xuất được Excel hồ sơ khách hàng.");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `ho-so-khach-${code}-${todayInVietnam()}.xlsx`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
    button.textContent = "Đã xuất Excel";
  } catch (error) {
    try {
      exportCustomerProfileBrowserXls(code);
      button.textContent = "Đã xuất Excel";
    } catch {
      button.textContent = error.message;
    }
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 1800);
  }
}

async function exportCustomerProfileSheet(button) {
  const code = button.dataset.code || state.profileCustomerCode;
  if (!code) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Đang đồng bộ...";
  const sheetWindow = window.open("about:blank", "_blank");
  try {
    const response = await fetch(unitUrl(`/api/export-customer?customerCode=${encodeURIComponent(code)}&format=google-sheet`), {
      headers: authHeaders(),
    });
    const contentType = response.headers.get("content-type") || "";
    if (response.ok && !contentType.includes("application/json")) {
      throw new Error("Backend production chưa cập nhật xuất Google Sheet. Hãy deploy/restart server bản mới nhất.");
    }
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Không xuất được Google Sheet.");
    button.textContent = "Đã xuất Sheet";
    if (data.url) {
      if (sheetWindow) {
        sheetWindow.location.href = data.url;
      } else {
        window.open(data.url, "_blank", "noopener");
      }
    } else if (sheetWindow) {
      sheetWindow.close();
    }
    if (data.warning) window.alert(data.warning);
  } catch (error) {
    if (sheetWindow) sheetWindow.close();
    button.textContent = error.message;
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = originalText;
    }, 2200);
  }
}

function exportLedgerCsv() {
  const rows = filteredLedgerOrders();
  const products = currentUnit().products;
  const headers = ["Ngày", "Mã khách", "Khách hàng", ...products.map((product) => `${product.name} kg`), "Tiền hàng", "Thuế", "Ứng xe", "Đã trả", "Còn lại", "Nhà xe", "Khách phụ ship", "Khách nghỉ", "Ghi chú"];
  const escapeCsv = (value) => {
    const text = String(value ?? "");
    const safeText = /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
    return `"${safeText.replace(/"/g, '""')}"`;
  };
  const csv = [
    headers.map(escapeCsv).join(","),
    ...rows.map((order) => [
      order.date, customerCodeForName(order.customerName), order.customerName, ...products.map((product) => order[product.quantity] || ""),
      order.subtotal, order.taxAmount, order.advance, order.paid, order.debt, order.truck,
      order.extraShipCustomer, order.customerResting ? "Có" : "", order.note,
    ].map(escapeCsv).join(",")),
  ].join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `so-don-hang-${state.businessUnit}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function setFormValue(form, name, value) {
  if (form.elements[name]) form.elements[name].value = value ?? "";
}

function editOrderPrices(order) {
  const customer = state.customers.find((item) => normalizeVietnamese(item.TenKH.trim()) === normalizeVietnamese(order.customerName.trim()));
  return Object.fromEntries(currentUnit().products.map((product) => [
    product.key,
    order[product.orderPrice] || customer?.[product.price] || 0,
  ]));
}

function ordersForBulkCopy(sourceDate) {
  const rows = new Map();
  state.orders
    .filter((order) => order.date === sourceDate)
    .sort(newestOrderFirst)
    .forEach((order) => {
      const key = normalizeVietnamese(order.customerName.trim());
      if (!key || rows.has(key)) return;
      rows.set(key, order);
    });
  return [...rows.values()].sort((first, second) => compareCustomerNames(first.customerName, second.customerName));
}

function customerForCode(code) {
  return state.customers.find((customer) => normalizeVietnamese(customer.MaKH) === normalizeVietnamese(code));
}

function latestOrderDateBefore(dateValue) {
  return state.orders
    .map((order) => order.date)
    .filter((date) => date && date < dateValue)
    .sort()
    .at(-1) || dateDaysBefore(dateValue, 1);
}

function duplicateCustomerOnDate(customerName, targetDate) {
  const key = normalizeVietnamese(String(customerName || "").trim());
  return state.orders.some((item) => (
    item.date === targetDate
    && normalizeVietnamese(item.customerName.trim()) === key
  ));
}

function duplicateOrderOnDate(order, targetDate) {
  return duplicateCustomerOnDate(order.customerName, targetDate);
}

function bulkCopyInputValue(order, product) {
  if (product.key === "phoSoi" && order.phoSoiUnit === "cay") {
    return order.phoSoiInputQuantity || Number(order.phoSoiKg || 0) / 5 || "";
  }
  return order[product.quantity] || "";
}

function bulkCopyQuantityCell(product, value = "", unit = "kg") {
  const unitSelector = product.key === "phoSoi"
    ? `<select data-field="phoSoiUnit" aria-label="Đơn vị phở sợi"><option value="kg" ${unit !== "cay" ? "selected" : ""}>kg</option><option value="cay" ${unit === "cay" ? "selected" : ""}>cây</option></select>`
    : "<span>kg</span>";
  return `<td><label class="bulk-copy-quantity"><input data-field="${escapeHtml(product.quantity)}" inputmode="decimal" value="${escapeHtml(value)}" /><small>${unitSelector}</small></label></td>`;
}

function updateBulkCopyAddCustomerOptions(sourceRows = ordersForBulkCopy($("#bulkCopySourceDate").value)) {
  const sourceNames = new Set(sourceRows.map((order) => normalizeVietnamese(order.customerName)));
  const addedCodes = new Set(state.bulkCopyAddedCustomerCodes.map((code) => normalizeVietnamese(code)));
  const options = sortedCustomers()
    .filter((customer) => !sourceNames.has(normalizeVietnamese(customer.TenKH)))
    .filter((customer) => !addedCodes.has(normalizeVietnamese(customer.MaKH)))
    .map((customer) => `<option value="${escapeHtml(customer.MaKH)}">${escapeHtml(customer.MaKH)} · ${escapeHtml(customer.TenKH)}</option>`)
    .join("");
  const select = $("#bulkCopyAddCustomer");
  if (!select) return;
  select.innerHTML = `<option value="">Chọn khách cần thêm</option>${options}`;
  $("#bulkCopyAddCustomerButton").disabled = !options;
}

function renderBulkCopyRows() {
  const sourceDate = $("#bulkCopySourceDate").value;
  const targetDate = $("#bulkCopyTargetDate").value;
  const products = currentUnit().products;
  const rows = ordersForBulkCopy(sourceDate);
  const sourceNames = new Set(rows.map((order) => normalizeVietnamese(order.customerName)));
  const manualCustomers = state.bulkCopyAddedCustomerCodes
    .map(customerForCode)
    .filter(Boolean)
    .filter((customer) => !sourceNames.has(normalizeVietnamese(customer.TenKH)))
    .sort(compareCustomerNames);
  $("#bulkCopyHead").innerHTML = `
    <tr>
      <th><input id="bulkCopyMasterCheck" type="checkbox" aria-label="Chọn tất cả khách" ${rows.length || manualCustomers.length ? "checked" : ""} /></th>
      <th>Khách hàng</th>
      ${products.map((product) => `<th>${escapeHtml(product.name)}</th>`).join("")}
      <th>Nhà xe</th>
      <th>Trạng thái</th>
    </tr>`;
  const sourceHtml = rows.map((order) => {
    const duplicate = duplicateOrderOnDate(order, targetDate);
    const cells = products.map((product) => {
      return bulkCopyQuantityCell(product, bulkCopyInputValue(order, product), order.phoSoiUnit || "kg");
    }).join("");
    return `
      <tr data-source-id="${order.id}">
        <td><input class="bulk-copy-check" type="checkbox" ${duplicate ? "" : "checked"} aria-label="Chọn ${escapeHtml(order.customerName)}" /></td>
        <td><strong>${escapeHtml(order.customerName)}</strong><small class="block">Mẫu #${order.id} · ${formatDate(order.date)}</small></td>
        ${cells}
        <td>${escapeHtml(order.truck || "—")}</td>
        <td>${duplicate ? '<span class="status watch">Đã có đơn ngày này</span>' : '<span class="status ok">Sẵn sàng</span>'}</td>
      </tr>`;
  }).join("");
  const manualHtml = manualCustomers.map((customer) => {
    const duplicate = duplicateCustomerOnDate(customer.TenKH, targetDate);
    const cells = products.map((product) => bulkCopyQuantityCell(product)).join("");
    return `
      <tr data-customer-code="${escapeHtml(customer.MaKH)}">
        <td><input class="bulk-copy-check" type="checkbox" ${duplicate ? "" : "checked"} aria-label="Chọn ${escapeHtml(customer.TenKH)}" /></td>
        <td><strong>${escapeHtml(customer.TenKH)}</strong><small class="block">Thêm tay · ${escapeHtml(customer.MaKH)}</small></td>
        ${cells}
        <td>${escapeHtml(customer.NhaXeMacDinh || "—")}</td>
        <td>${duplicate ? '<span class="status watch">Đã có đơn ngày này</span>' : '<span class="status ok">Thêm mới</span>'}</td>
      </tr>`;
  }).join("");
  const tableHtml = `${sourceHtml}${manualHtml}`;
  $("#bulkCopyRows").innerHTML = tableHtml
    || `<tr><td colspan="${4 + products.length}" class="empty-row">Không có đơn hàng trong ngày này để copy. Bạn vẫn có thể chọn khách ở trên để thêm tay.</td></tr>`;
  $("#bulkCopySubtitle").textContent = rows.length || manualCustomers.length
    ? `Tìm thấy ${number.format(rows.length)} khách từ ngày ${formatDate(sourceDate)}${manualCustomers.length ? `, thêm tay ${number.format(manualCustomers.length)} khách` : ""}. Giá và thông tin đơn sẽ lấy theo hồ sơ khách.`
    : `Không có đơn trong ngày ${formatDate(sourceDate)}. Hãy chọn ngày khác.`;
  updateBulkCopyAddCustomerOptions(rows);
  updateBulkCopySelection();
}

function updateBulkCopySelection() {
  const checks = $$(".bulk-copy-check");
  const selected = checks.filter((input) => input.checked).length;
  const master = $("#bulkCopyMasterCheck");
  if (master) {
    master.checked = checks.length > 0 && selected === checks.length;
    master.indeterminate = selected > 0 && selected < checks.length;
  }
  $("#saveBulkCopy").disabled = selected === 0;
  $("#saveBulkCopy").textContent = selected ? `Tạo ${number.format(selected)} đơn đã chọn` : "Chọn khách để tạo đơn";
}

function openBulkCopyDialog() {
  const today = todayInVietnam();
  $("#bulkCopyTargetDate").value = today;
  $("#bulkCopySourceDate").value = latestOrderDateBefore(today);
  state.bulkCopyAddedCustomerCodes = [];
  $("#bulkCopyResult").className = "notice";
  renderBulkCopyRows();
  $("#bulkCopyDialog").showModal();
}

function bulkCopyPayloadFromRow(row) {
  const customerCode = row.dataset.customerCode;
  if (customerCode) {
    const customer = customerForCode(customerCode);
    if (!customer) throw new Error("Không tìm thấy khách cần thêm.");
    const valueFor = (field, fallback = "") => row.querySelector(`[data-field="${field}"]`)?.value ?? fallback;
    const payload = {
      businessUnit: state.businessUnit,
      customerCode: customer.MaKH,
      orderDate: $("#bulkCopyTargetDate").value,
      nhaXe: customer.NhaXeMacDinh || "",
      extraShipCustomer: "",
      tienUng: "",
      taxRate: customer.ThueSuat || 0,
      taxPayer: "customer",
      customerResting: false,
      ghiChu: "",
      paymentMethod: "debt",
      paid: 0,
      miKg: 0,
      caoKg: 0,
      hoanhKg: 0,
      huTieu: 0,
      voBanhGoi: 0,
      thungXop: 0,
      phoSoiKg: 0,
      phoSoiUnit: "kg",
      phoCuonKg: 0,
    };
    currentUnit().products.forEach((product) => {
      payload[product.quantity] = valueFor(product.quantity, payload[product.quantity]);
    });
    if (state.businessUnit === "pho") payload.phoSoiUnit = valueFor("phoSoiUnit", payload.phoSoiUnit);
    return payload;
  }
  const source = state.orders.find((order) => Number(order.id) === Number(row.dataset.sourceId));
  if (!source) throw new Error("Không tìm thấy đơn mẫu.");
  const valueFor = (field, fallback = "") => row.querySelector(`[data-field="${field}"]`)?.value ?? fallback;
  const payload = {
    action: "copy",
    sourceOrderId: source.id,
    useCustomerPrices: true,
    businessUnit: state.businessUnit,
    orderDate: $("#bulkCopyTargetDate").value,
    nhaXe: source.truck || "",
    extraShipCustomer: source.extraShipCustomer || "",
    tienUng: source.advance || "",
    taxRate: source.taxRate || 0,
    taxPayer: source.taxPayer || "customer",
    customerResting: source.customerResting,
    ghiChu: source.note || "",
    paymentMethod: "debt",
    paid: 0,
    miKg: source.miKg || 0,
    caoKg: source.caoKg || 0,
    hoanhKg: source.hoanhKg || 0,
    huTieu: source.huTieu || 0,
    voBanhGoi: source.voBanhGoi || 0,
    thungXop: source.thungXop || 0,
    phoSoiKg: source.phoSoiUnit === "cay" ? (source.phoSoiInputQuantity || Number(source.phoSoiKg || 0) / 5) : (source.phoSoiKg || 0),
    phoSoiUnit: source.phoSoiUnit || "kg",
    phoCuonKg: source.phoCuonKg || 0,
  };
  currentUnit().products.forEach((product) => {
    payload[product.quantity] = valueFor(product.quantity, payload[product.quantity]);
  });
  if (state.businessUnit === "pho") payload.phoSoiUnit = valueFor("phoSoiUnit", payload.phoSoiUnit);
  return payload;
}

async function saveBulkCopiedOrders(button) {
  const selectedRows = $$(".bulk-copy-check:checked").map((input) => input.closest("tr"));
  if (!selectedRows.length) return;
  button.disabled = true;
  notice($("#bulkCopyResult"), `Đang tạo ${number.format(selectedRows.length)} đơn...`);
  const errors = [];
  let created = 0;
  for (const row of selectedRows) {
    const source = state.orders.find((order) => Number(order.id) === Number(row.dataset.sourceId));
    const manualCustomer = row.dataset.customerCode ? customerForCode(row.dataset.customerCode) : null;
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(bulkCopyPayloadFromRow(row)),
      });
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.error || "Không tạo được đơn.");
      created += 1;
    } catch (error) {
      errors.push(`${source?.customerName || manualCustomer?.TenKH || `Đơn #${row.dataset.sourceId || row.dataset.customerCode}`}: ${error.message}`);
    }
  }
  await loadCrm();
  if (errors.length) {
    notice($("#bulkCopyResult"), `Đã tạo ${number.format(created)} đơn, ${number.format(errors.length)} đơn lỗi: ${errors.join("; ")}`, "error");
    button.disabled = false;
    updateBulkCopySelection();
    return;
  }
  notice($("#result"), `Đã copy sản lượng và tạo ${number.format(created)} đơn cho ngày ${formatDate($("#bulkCopyTargetDate").value)}.`);
  $("#bulkCopyDialog").close();
}

function calculateEditOrder() {
  const form = $("#orderEditForm");
  const order = state.editingOrder;
  if (!order) return;
  const resting = form.elements.customerResting.checked;
  const quantityFields = [...currentUnit().products.map((product) => product.quantity), ...(state.businessUnit === "mi" ? ["huTieu", "voBanhGoi", "thungXop"] : [])];
  quantityFields.forEach((name) => {
    form.elements[name].disabled = resting;
    if (resting) form.elements[name].value = "0";
  });
  const prices = editOrderPrices(order);
  const subtotal = currentUnit().products.reduce((sum, product) => (
    sum + (
      resting
        ? 0
        : product.key === "phoSoi"
          ? phoSoiQuantityInKg(form)
          : parseNumber(form.elements[product.quantity].value)
    ) * prices[product.key]
  ), 0);
  updatePhoSoiConversion(form, $("#editPhoSoiConversion"));
  const taxRate = parseNumber(form.elements.taxRate.value);
  const taxAmount = subtotal * taxRate / 100;
  const advance = parseNumber(form.elements.tienUng.value);
  const sheetTotal = subtotal + advance;
  const total = sheetTotal + taxAmount;
  form.elements.subtotal.value = subtotal;
  form.elements.taxAmount.value = taxAmount;
  form.elements.orderTotal.value = sheetTotal;
  $("#editOrderTotals").innerHTML = [
    ["Tiền hàng", subtotal],
    ["Thuế", taxAmount],
    ["Ứng xe", advance],
    ["Khách phải trả", total],
  ].map(([label, value]) => `<div><span>${label}</span><strong>${money.format(value)}</strong></div>`).join("");
}

function openOrderEditDialog(id, mode = "edit") {
  const order = state.orders.find((item) => Number(item.id) === Number(id));
  if (!order) return;
  state.editingOrder = order;
  state.editingOrderMode = mode;
  const form = $("#orderEditForm");
  form.reset();
  form.elements.rowId.value = mode === "edit" ? order.id : "";
  form.elements.sourceOrderId.value = mode === "copy" ? order.id : "";
  setFormValue(form, "orderDate", mode === "copy" ? todayInVietnam() : order.date);
  setFormValue(form, "nhaXe", order.truck);
  setFormValue(form, "extraShipCustomer", order.extraShipCustomer);
  setFormValue(form, "miKg", order.miKg || "");
  setFormValue(form, "caoKg", order.caoKg || "");
  setFormValue(form, "hoanhKg", order.hoanhKg || "");
  setFormValue(
    form,
    "phoSoiKg",
    order.phoSoiUnit === "cay"
      ? (order.phoSoiInputQuantity || Number(order.phoSoiKg || 0) / 5)
      : (order.phoSoiKg || ""),
  );
  setFormValue(form, "phoSoiUnit", order.phoSoiUnit || "kg");
  setFormValue(form, "phoCuonKg", order.phoCuonKg || "");
  setFormValue(form, "huTieu", order.huTieu || "");
  setFormValue(form, "voBanhGoi", order.voBanhGoi || "");
  setFormValue(form, "thungXop", order.thungXop || "");
  setFormValue(form, "tienUng", order.advance || "");
  setFormValue(form, "taxRate", order.taxRate || (order.taxAmount ? 5 : 0));
  setFormValue(form, "paid", mode === "copy" ? 0 : (order.paid || ""));
  setFormValue(form, "ghiChu", order.note || "");
  form.elements.customerResting.checked = Boolean(order.customerResting);
  form.elements.paid.disabled = mode === "copy";
  $("#editOrderTitle").textContent = mode === "copy"
    ? `Copy đơn và điều chỉnh · ${order.customerName}`
    : order.customerName;
  $("#editOrderSubtitle").textContent = mode === "copy"
    ? `Bản sao từ giao dịch #${order.id} · Hãy kiểm tra lại ngày và số lượng trước khi tạo`
    : `Giao dịch #${order.id} · ${formatDate(order.date)} · ${productSummary(order)}`;
  $("#saveOrderEdit").textContent = mode === "copy" ? "Tạo đơn bản sao" : "Lưu giao dịch";
  $("#orderEditResult").className = "notice";
  calculateEditOrder();
  $("#orderEditDialog").showModal();
}

function renderDebts(filter = "") {
  const query = filter.trim().toLowerCase();
  const debtors = state.customers.filter((item) => item.debt > 0 && item.TenKH.toLowerCase().includes(query)).sort((a, b) => b.debt - a.debt);
  $("#debtSummary").innerHTML = `<div><span>Tổng phải thu</span><strong>${money.format(state.summary.debt || 0)}</strong></div><div><span>Khách còn nợ</span><strong>${debtors.length}</strong></div><div><span>Nợ lớn nhất</span><strong>${money.format(debtors[0]?.debt || 0)}</strong></div>`;
  $("#debtTable").innerHTML = debtors.map((item) => {
    const level = item.debt >= 10000000 ? "Cao" : item.debt >= 3000000 ? "Theo dõi" : "Ổn";
    return `<tr><td><button class="customer-link view-customer" data-code="${escapeHtml(item.MaKH)}">${escapeHtml(item.TenKH)}</button><small class="block">${escapeHtml(item.MaKH)}</small></td><td>${item.orderCount}</td><td>${money.format(item.revenue)}</td><td>${money.format(item.paid || 0)}</td><td><strong class="debt-value">${money.format(item.debt)}</strong></td><td>${formatDate(item.lastOrderDate)}</td><td><span class="status ${level === "Cao" ? "high" : level === "Theo dõi" ? "watch" : "ok"}">${level}</span></td><td><div class="row-actions"><button class="small-button view-customer" data-code="${escapeHtml(item.MaKH)}">Chi tiết</button><button class="small-button payment-button record-payment" data-code="${escapeHtml(item.MaKH)}">Thu tiền</button></div></td></tr>`;
  }).join("") || '<tr><td colspan="8" class="empty-row">Hiện không có công nợ.</td></tr>';
}

function openPaymentDialog(code) {
  const customer = state.customers.find((item) => item.MaKH === code);
  if (!customer || customer.debt <= 0) return;
  const form = $("#paymentForm");
  form.reset();
  form.elements.customerCode.value = code;
  form.elements.date.value = todayInVietnam();
  $("#paymentCustomerName").textContent = customer.TenKH;
  $("#paymentCustomerDebt").textContent = `Còn nợ ${money.format(customer.debt)}`;
  $("#paymentResult").className = "notice";
  $("#paymentDialog").showModal();
  form.elements.amount.focus();
}

function renderInsights() {
  const customers = [...state.customers].sort((a, b) => {
    const aDate = a.suggestion?.nextDate || "9999";
    const bDate = b.suggestion?.nextDate || "9999";
    return aDate.localeCompare(bDate);
  });
  $("#insightGrid").innerHTML = customers.map((item) => {
    const suggestion = item.suggestion || {};
    const products = (suggestion.products || []).map((product) => `<span>${product.name}: <strong>${number.format(product.quantity)} kg</strong> <small>${product.frequency}% đơn</small></span>`).join("");
    return `<article class="insight-card"><div class="insight-top"><div class="customer-cell"><span class="avatar">${escapeHtml(item.TenKH.slice(0, 1))}</span><span><strong>${escapeHtml(item.TenKH)}</strong><small>${escapeHtml(item.MaKH)}</small></span></div><span class="confidence ${suggestion.confidence || "new"}">${suggestion.confidence === "high" ? "Tin cậy cao" : suggestion.confidence === "medium" ? "Đang học" : "Khách mới"}</span></div>
    <p>${escapeHtml(suggestion.message || "")}</p>${suggestion.nextDate ? `<div class="next-order"><span>Ngày dự kiến mua lại</span><strong>${formatDate(suggestion.nextDate)}</strong></div>` : ""}<div class="product-predictions">${products}</div><button class="primary create-suggested-order" data-code="${escapeHtml(item.MaKH)}">Tạo đơn theo gợi ý</button></article>`;
  }).join("");
}

function reportDateOrders() {
  const from = $("#reportFrom").value;
  const to = $("#reportTo").value;
  return state.orders.filter((order) => {
    if (from && (!order.date || order.date < from)) return false;
    if (to && (!order.date || order.date > to)) return false;
    return true;
  });
}

function dateDaysBefore(isoDate, days) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function productionStatsProducts() {
  return currentUnit().products.map((product) => ({
    ...product,
    statsName: product.key === "phoCuon" ? "Phở lá" : product.name,
  }));
}

function productionWeekday(dateValue) {
  const [year, month, day] = String(dateValue || "").split("-").map(Number);
  if (!year || !month || !day) return "";
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? "CN" : `T${weekday + 1}`;
}

function resetProductionStatsToLast30Days() {
  const to = todayInVietnam();
  $("#productionStatsFrom").value = dateDaysBefore(to, 29);
  $("#productionStatsTo").value = to;
  renderProductionStats();
}

function syncProductionStatsTableHeader() {
  const table = $(".production-stats-table");
  if (!table) return;
  table.querySelector("thead").innerHTML = `
    <tr>
      <th>Thứ</th>
      <th>Ngày</th>
      <th id="productionStatsProductHeader1">Mì</th>
      <th id="productionStatsProductHeader2">Da cảo</th>
      <th id="productionStatsProductHeader3">Da hoành</th>
      <th>Tổng kg</th>
      <th>Doanh thu</th>
      <th>Số đơn</th>
    </tr>`;
}

function renderProductionStats() {
  syncProductionStatsTableHeader();
  const products = productionStatsProducts();
  const from = $("#productionStatsFrom").value;
  const to = $("#productionStatsTo").value;
  const grouped = new Map();

  state.orders.forEach((order) => {
    if (!order.date || (from && order.date < from) || (to && order.date > to)) return;
    const quantities = Object.fromEntries(products.map((product) => [
      product.quantity,
      Number(order[product.quantity] || 0),
    ]));
    const orderKg = products.reduce((sum, product) => sum + quantities[product.quantity], 0);
    if (orderKg <= 0) return;
    const current = grouped.get(order.date) || {
      date: order.date,
      orders: 0,
      totalKg: 0,
      revenue: 0,
      quantities: Object.fromEntries(products.map((product) => [product.quantity, 0])),
    };
    current.orders += 1;
    current.totalKg += orderKg;
    current.revenue += Number(order.subtotal || 0);
    products.forEach((product) => {
      current.quantities[product.quantity] += quantities[product.quantity];
    });
    grouped.set(order.date, current);
  });

  const rows = [...grouped.values()].sort((first, second) => second.date.localeCompare(first.date));
  const totals = rows.reduce((result, row) => {
    result.totalKg += row.totalKg;
    result.revenue += row.revenue;
    result.orders += row.orders;
    products.forEach((product) => {
      result.quantities[product.quantity] += row.quantities[product.quantity];
    });
    return result;
  }, {
    totalKg: 0,
    revenue: 0,
    orders: 0,
    quantities: Object.fromEntries(products.map((product) => [product.quantity, 0])),
  });
  const averagePerDay = rows.length ? totals.totalKg / rows.length : 0;

  $("#productionStatsDescription").textContent = state.businessUnit === "pho"
    ? "Tổng hợp phở sợi và phở lá bán ra theo ngày giao; số cây phở sợi đã quy đổi sang kg."
    : "Tổng hợp mì, da cảo và da hoành bán ra theo ngày giao.";
  $("#productionStatsTableTitle").textContent = `Chi tiết sản lượng ${currentUnit().name}`;
  $("#productionStatsPeriod").textContent = from && to
    ? `${formatDate(from)} đến ${formatDate(to)}`
    : "Toàn bộ thời gian";

  const headers = ["#productionStatsProductHeader1", "#productionStatsProductHeader2", "#productionStatsProductHeader3"];
  headers.forEach((selector, index) => {
    const header = $(selector);
    const product = products[index];
    header.classList.toggle("hidden", !product);
    if (product) header.textContent = `${product.statsName} (kg)`;
  });

  $("#productionStatsMetrics").innerHTML = [
    ["Tổng sản lượng", `${number.format(totals.totalKg)} kg`, `${number.format(rows.length)} ngày có sản xuất`],
    ...products.map((product) => [
      product.statsName,
      `${number.format(totals.quantities[product.quantity])} kg`,
      "Theo đơn hàng đã ghi nhận",
    ]),
    ["Doanh thu", money.format(totals.revenue), "Tiền hàng theo ngày giao"],
    ["Trung bình/ngày", `${number.format(averagePerDay)} kg`, "Tính trên ngày có sản lượng"],
    ["Số đơn", number.format(totals.orders), "Không tính đơn khách nghỉ"],
  ].map(([label, value, note]) => `<div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join("");

  $("#productionStatsTable").innerHTML = rows.map((row) => {
    const productCells = Array.from({ length: 3 }, (_, index) => {
      const product = products[index];
      return product
        ? `<td>${number.format(row.quantities[product.quantity])}</td>`
        : '<td class="hidden"></td>';
    }).join("");
    return `<tr>
      <td>${productionWeekday(row.date)}</td>
      <td><strong>${formatDate(row.date)}</strong></td>
      ${productCells}
      <td><strong class="daily-total">${number.format(row.totalKg)}</strong></td>
      <td><strong>${money.format(row.revenue)}</strong></td>
      <td>${number.format(row.orders)}</td>
    </tr>`;
  }).join("") || '<tr><td colspan="8" class="empty-row">Không có sản lượng trong khoảng ngày đã chọn.</td></tr>';
}

function resetReportToLast30Days() {
  const to = todayInVietnam();
  $("#reportCustomer").value = "";
  $("#reportFrom").value = dateDaysBefore(to, 29);
  $("#reportTo").value = to;
  $('[name="reportPeriod"][value="day"]').checked = true;
  renderReports();
}

function reportPeriod() {
  return $('[name="reportPeriod"]:checked')?.value || "day";
}

function reportPeriodKey(date, period) {
  if (period === "year") return date.slice(0, 4);
  if (period === "month") return date.slice(0, 7);
  return date;
}

function reportPeriodLabel(key, period) {
  if (period === "year") return key;
  if (period === "month") {
    const [year, month] = key.split("-");
    return `${month}/${year}`;
  }
  return formatDate(key).slice(0, 5);
}

function compactMoney(value) {
  const amount = Number(value || 0);
  if (amount >= 1000000000) return `${number.format(amount / 1000000000)} tỷ`;
  if (amount >= 1000000) return `${number.format(amount / 1000000)} tr`;
  if (amount >= 1000) return `${number.format(amount / 1000)}k`;
  return number.format(amount);
}

function aggregateReportCustomers(orders) {
  const rows = new Map();
  orders.forEach((order) => {
    const key = normalizeVietnamese(order.customerName.trim());
    if (!key) return;
    const current = rows.get(key) || {
      customerName: order.customerName,
      code: customerCodeForName(order.customerName),
      orders: 0,
      revenue: 0,
      tax: 0,
      paid: 0,
      debt: 0,
      miKg: 0,
      caoKg: 0,
      hoanhKg: 0,
      phoSoiKg: 0,
      phoCuonKg: 0,
    };
    current.orders += 1;
    current.revenue += Number(order.subtotal || 0);
    current.tax += Number(order.taxAmount || 0);
    current.paid += Number(order.paid || 0);
    current.debt += Number(order.debt || 0);
    current.miKg += Number(order.miKg || 0);
    current.caoKg += Number(order.caoKg || 0);
    current.hoanhKg += Number(order.hoanhKg || 0);
    current.phoSoiKg += Number(order.phoSoiKg || 0);
    current.phoCuonKg += Number(order.phoCuonKg || 0);
    rows.set(key, current);
  });
  return [...rows.values()].sort((first, second) => second.revenue - first.revenue);
}

function renderRevenueLineChart(orders, period) {
  const grouped = new Map();
  orders.filter((order) => order.date).forEach((order) => {
    const key = reportPeriodKey(order.date, period);
    grouped.set(key, (grouped.get(key) || 0) + Number(order.subtotal || 0));
  });
  const points = [...grouped.entries()].sort(([first], [second]) => first.localeCompare(second));
  const container = $("#revenueLineChart");
  if (!points.length) {
    container.innerHTML = '<div class="chart-empty">Không có đơn hàng có ngày trong khoảng đã chọn.</div>';
    return;
  }

  const width = 920;
  const height = 320;
  const padding = { top: 22, right: 18, bottom: 42, left: 72 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...points.map(([, value]) => value), 1);
  const xAt = (index) => padding.left + (points.length === 1 ? chartWidth / 2 : index * chartWidth / (points.length - 1));
  const yAt = (value) => padding.top + chartHeight - value / maxValue * chartHeight;
  const linePoints = points.map(([, value], index) => `${xAt(index)},${yAt(value)}`).join(" ");
  const areaPoints = `${padding.left},${padding.top + chartHeight} ${linePoints} ${xAt(points.length - 1)},${padding.top + chartHeight}`;
  const yTicks = Array.from({ length: 5 }, (_, index) => maxValue * index / 4);
  const labelStep = Math.max(1, Math.ceil(points.length / 7));
  const xLabels = points.map(([key], index) => ({ key, index })).filter((item, index) => index % labelStep === 0 || index === points.length - 1);
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      ${yTicks.map((value) => {
        const y = yAt(value);
        return `<line class="chart-grid-line" x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" />
          <text class="chart-axis-label" x="${padding.left - 10}" y="${y + 4}" text-anchor="end">${escapeHtml(compactMoney(value))}</text>`;
      }).join("")}
      <polygon class="chart-area" points="${areaPoints}" />
      <polyline class="chart-line" points="${linePoints}" />
      ${points.map(([key, value], index) => `
        <circle class="chart-point" cx="${xAt(index)}" cy="${yAt(value)}" r="4"></circle>
        <circle class="chart-hit" cx="${xAt(index)}" cy="${yAt(value)}" r="15"
          data-label="${escapeHtml(reportPeriodLabel(key, period))}"
          data-value="${escapeHtml(money.format(value))}"></circle>
      `).join("")}
      ${xLabels.map(({ key, index }) => `<text class="chart-axis-label" x="${xAt(index)}" y="${height - 12}" text-anchor="middle">${escapeHtml(reportPeriodLabel(key, period))}</text>`).join("")}
    </svg>
    <div class="chart-tooltip" aria-hidden="true"><span></span><strong></strong></div>`;
  const tooltip = container.querySelector(".chart-tooltip");
  container.querySelectorAll(".chart-hit").forEach((point) => {
    const showTooltip = (event) => {
      const bounds = container.getBoundingClientRect();
      tooltip.querySelector("span").textContent = point.dataset.label;
      tooltip.querySelector("strong").textContent = point.dataset.value;
      container.querySelectorAll(".chart-point.active").forEach((item) => item.classList.remove("active"));
      point.previousElementSibling?.classList.add("active");
      tooltip.classList.add("show");
      const tooltipWidth = tooltip.offsetWidth;
      const x = Math.min(Math.max(event.clientX - bounds.left, tooltipWidth / 2 + 8), bounds.width - tooltipWidth / 2 - 8);
      const y = Math.max(event.clientY - bounds.top - 18, 50);
      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${y}px`;
    };
    point.addEventListener("pointerenter", showTooltip);
    point.addEventListener("pointermove", showTooltip);
    point.addEventListener("pointerdown", showTooltip);
    point.addEventListener("pointerleave", () => {
      tooltip.classList.remove("show");
      point.previousElementSibling?.classList.remove("active");
    });
  });
}

function renderReports() {
  const customerName = $("#reportCustomer").value;
  const period = reportPeriod();
  const today = todayInVietnam();
  const todayOrders = state.orders.filter((order) => order.date === today);
  const todayRevenue = todayOrders.reduce((sum, order) => sum + Number(order.subtotal || 0), 0);
  const allPeriodOrders = reportDateOrders();
  const selectedOrders = customerName
    ? allPeriodOrders.filter((order) => normalizeVietnamese(order.customerName.trim()) === normalizeVietnamese(customerName.trim()))
    : allPeriodOrders;
  const totals = selectedOrders.reduce((result, order) => ({
    revenue: result.revenue + Number(order.subtotal || 0),
    tax: result.tax + Number(order.taxAmount || 0),
    paid: result.paid + Number(order.paid || 0),
    debt: result.debt + Number(order.debt || 0),
    miKg: result.miKg + Number(order.miKg || 0),
    caoKg: result.caoKg + Number(order.caoKg || 0),
    hoanhKg: result.hoanhKg + Number(order.hoanhKg || 0),
    phoSoiKg: result.phoSoiKg + Number(order.phoSoiKg || 0),
    phoCuonKg: result.phoCuonKg + Number(order.phoCuonKg || 0),
  }), { revenue: 0, tax: 0, paid: 0, debt: 0, miKg: 0, caoKg: 0, hoanhKg: 0, phoSoiKg: 0, phoCuonKg: 0 });
  const totalRevenue = allPeriodOrders.reduce((sum, order) => sum + Number(order.subtotal || 0), 0);
  const share = totalRevenue ? totals.revenue / totalRevenue * 100 : 0;
  const averageOrder = selectedOrders.length ? totals.revenue / selectedOrders.length : 0;
  const datedOrders = selectedOrders.filter((order) => order.date);
  const firstDate = datedOrders.length ? datedOrders.reduce((first, order) => !first || order.date < first ? order.date : first, "") : "";
  const lastDate = datedOrders.length ? datedOrders.reduce((last, order) => order.date > last ? order.date : last, "") : "";

  $("#reportMetrics").innerHTML = [
    ["Doanh thu trong ngày", money.format(todayRevenue), `${number.format(todayOrders.length)} đơn ngày ${formatDate(today)}`],
    ["Doanh thu", money.format(totals.revenue), `${number.format(selectedOrders.length)} đơn hàng`],
    ["Trung bình/đơn", money.format(averageOrder), "Theo tiền hàng"],
    ["Tiền thuế", money.format(totals.tax), "Tách riêng doanh thu"],
    ["Đã thanh toán", money.format(totals.paid), "Theo dữ liệu hiện có"],
    ["Còn lại", money.format(totals.debt), "Công nợ cần thu"],
    ["Tỷ trọng", `${number.format(share)}%`, customerName ? "Trong tổng doanh thu" : "Toàn bộ khách hàng"],
  ].map(([label, value, note]) => `<div><span>${label}</span><strong>${value}</strong><small>${note}</small></div>`).join("");

  const periodNames = { day: "ngày", month: "tháng", year: "năm" };
  $("#reportChartTitle").textContent = `Doanh thu theo ${periodNames[period]}`;
  $("#reportChartSubtitle").textContent = `${customerName || "Tất cả khách hàng"}${firstDate ? ` · ${formatDate(firstDate)} đến ${formatDate(lastDate)}` : ""}`;
  renderRevenueLineChart(selectedOrders, period);

  const customerRows = aggregateReportCustomers(allPeriodOrders);
  const detail = customerName
    ? customerRows.find((row) => normalizeVietnamese(row.customerName) === normalizeVietnamese(customerName))
    : customerRows[0];
  const detailShare = detail && totalRevenue ? detail.revenue / totalRevenue * 100 : 0;
  $("#reportCustomerSubtitle").textContent = detail?.customerName || "Chưa có dữ liệu";
  $("#customerRevenueShare").innerHTML = detail ? `
    <span>Tỷ trọng trong tổng doanh thu</span>
    <strong>${number.format(detailShare)}%</strong>
    <div class="share-track"><i style="width:${Math.min(detailShare, 100)}%"></i></div>
    <small>${money.format(detail.revenue)} trên tổng ${money.format(totalRevenue)} · ${number.format(detail.orders)} đơn</small>
  ` : '<span>Chưa có doanh thu trong khoảng đã chọn.</span>';

  const productSource = detail || totals;
  const products = currentUnit().products.map((product, index) => [
    product.name,
    productSource[product.quantity] || 0,
    ["mix-mi", "mix-cao", "mix-hoanh"][index],
  ]);
  const totalKg = products.reduce((sum, [, quantity]) => sum + quantity, 0);
  $("#reportProductMix").innerHTML = products.map(([name, quantity, className]) => {
    const percent = totalKg ? quantity / totalKg * 100 : 0;
    return `<div class="${className}"><span>${name}</span><div class="mix-track"><i style="width:${percent}%"></i></div><strong>${number.format(quantity)} kg</strong></div>`;
  }).join("");

  $("#reportCustomerTable").innerHTML = customerRows.map((row, index) => {
    const percent = totalRevenue ? row.revenue / totalRevenue * 100 : 0;
    return `<tr>
      <td>${index + 1}</td>
      <td><button class="customer-link report-customer-link" data-name="${escapeHtml(row.customerName)}">${escapeHtml(row.customerName)}</button>${row.code ? `<small class="block">${escapeHtml(row.code)}</small>` : ""}</td>
      <td>${number.format(row.orders)}</td><td><strong>${money.format(row.revenue)}</strong></td>
      <td><div class="ranking-share"><div class="ranking-track"><i style="width:${Math.min(percent, 100)}%"></i></div><span>${number.format(percent)}%</span></div></td>
      ${currentUnit().products.map((product) => `<td>${number.format(row[product.quantity] || 0)} kg</td>`).join("")}
      <td><strong class="${row.debt > 0 ? "debt-value" : ""}">${money.format(row.debt)}</strong></td>
    </tr>`;
  }).join("") || `<tr><td colspan="${6 + currentUnit().products.length}" class="empty-row">Không có dữ liệu báo cáo phù hợp.</td></tr>`;
}

function renderReportCustomers() {
  const current = $("#reportCustomer").value;
  const names = [...new Set(state.orders.map((order) => order.customerName.trim()).filter(Boolean))].sort((first, second) => first.localeCompare(second, "vi"));
  $("#reportCustomer").innerHTML = `<option value="">Tất cả khách hàng</option>${names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
  $("#reportCustomer").value = names.includes(current) ? current : "";
}

function renderAll() {
  applyBusinessUnitUi();
  syncCustomerSortControls();
  renderDashboard();
  renderCustomers();
  renderProductionInfo();
  renderDebts();
  renderInsights();
  renderLedgerCustomers();
  renderLedger();
  renderReportCustomers();
  renderReports();
  renderProductionStats();
  renderUsers();
  renderAuditAccounts();
  renderAuditLog();
  renderOrderCustomerOptions();
}

async function loadCrm() {
  $("#syncStatus").textContent = "Đang tải dữ liệu CRM...";
  const isManager = state.user?.role === "manager";
  const crmResponse = await fetch(unitUrl(isManager ? "/api/crm?include=manager" : "/api/crm"), { headers: authHeaders() });
  const crmData = await readApiResponse(crmResponse);
  if (!crmResponse.ok) throw new Error(crmData.error || "Không tải được database CRM.");
  state.customers = crmData.customers || [];
  state.orders = (crmData.orders || []).sort(newestOrderFirst);
  state.productionInfo = crmData.productionInfo?.entries || [];
  state.productionInfoTitle = crmData.productionInfo?.title || "";
  state.summary = crmData.summary || {};
  state.payments = crmData.payments || [];
  state.users = crmData.users || [];
  state.auditLog = crmData.auditLog || [];
  state.offlineCrm = false;
  normalizeCrmFinancials();
  recalculateCrmTotals();
  renderAll();
  $("#syncStatus").textContent = `Database CRM · ${currentUnit().name}`;
}

function selectedCustomer() {
  return state.customers.find((item) => item.MaKH === $("#customerCode").value);
}

function customerTruckSuggestions(customerName, query = "") {
  const normalizedName = normalizeVietnamese(customerName).trim();
  const normalizedQuery = normalizeVietnamese(query).trim();
  const groups = new Map();
  state.orders.forEach((order) => {
    if (normalizeVietnamese(order.customerName).trim() !== normalizedName) return;
    const truck = String(order.truck || "").trim();
    if (!truck || (normalizedQuery && !normalizeVietnamese(truck).includes(normalizedQuery))) return;
    const key = normalizeVietnamese(truck);
    const current = groups.get(key) || {
      name: truck,
      count: 0,
      lastDate: "",
      advances: new Map(),
    };
    current.count += 1;
    if (order.date && order.date > current.lastDate) current.lastDate = order.date;
    const advance = Number(order.advance || 0);
    current.advances.set(advance, (current.advances.get(advance) || 0) + 1);
    groups.set(key, current);
  });
  return [...groups.values()]
    .map((item) => ({
      ...item,
      usualAdvance: [...item.advances.entries()]
        .sort((first, second) => second[1] - first[1] || second[0] - first[0])[0]?.[0] || 0,
    }))
    .sort((first, second) => second.count - first.count || second.lastDate.localeCompare(first.lastDate))
    .slice(0, 4);
}

function renderTruckSuggestions() {
  const customer = selectedCustomer();
  const container = $("#truckSuggestions");
  if (!customer) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  const suggestions = customerTruckSuggestions(customer.TenKH, $("#nhaXe").value);
  container.classList.toggle("hidden", !suggestions.length);
  container.innerHTML = suggestions.length ? `
    <div class="truck-suggestion-head"><strong>✦ Nhà xe khách này hay dùng</strong><small>Bấm để điền nhà xe và tiền ứng thường dùng</small></div>
    <div class="truck-suggestion-list">${suggestions.map((item) => `
      <button class="truck-suggestion" type="button" data-truck="${escapeHtml(item.name)}" data-advance="${item.usualAdvance}">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${number.format(item.count)} lần · gần nhất ${formatDate(item.lastDate)}</span>
        <b>Ứng thường: ${money.format(item.usualAdvance)}</b>
      </button>
    `).join("")}</div>
  ` : "";
}

function calculateOrder() {
  const customer = selectedCustomer();
  const resting = $("#customerResting").checked;
  const quantities = Object.fromEntries(currentUnit().products.map((product) => [
    product.key,
    resting
      ? 0
      : product.key === "phoSoi"
        ? phoSoiQuantityInKg($("#orderForm"))
        : parseNumber($(`[name="${product.quantity}"]`).value),
  ]));
  updatePhoSoiConversion($("#orderForm"), $("#phoSoiConversion"));
  const prices = Object.fromEntries(currentUnit().products.map((product) => [
    product.key,
    customer?.[product.price] || 0,
  ]));
  let subtotal = 0;
  Object.keys(quantities).forEach((key) => {
    const lineTotal = quantities[key] * prices[key];
    subtotal += lineTotal;
    $(`[data-price="${key}"]`).textContent = money.format(prices[key]);
    $(`[data-line-total="${key}"]`).textContent = money.format(lineTotal);
  });
  const taxRate = parseNumber($("#taxRate").value);
  const taxAmount = subtotal * taxRate / 100;
  const customerPaysTax = $('[name="taxPayer"]:checked').value === "customer";
  const advance = parseNumber($("#tienUng").value);
  const sheetTotal = subtotal + advance;
  const total = sheetTotal + (customerPaysTax ? taxAmount : 0);
  $("#subtotalText").textContent = money.format(subtotal);
  $("#taxText").textContent = `${money.format(taxAmount)}${customerPaysTax ? "" : " (xưởng chịu)"}`;
  $("#advanceText").textContent = money.format(advance);
  $("#totalText").textContent = money.format(total);
  $("#subtotal").value = subtotal;
  $("#taxAmount").value = taxAmount;
  $("#orderTotal").value = sheetTotal;
}

function applyRestingState() {
  const resting = $("#customerResting").checked;
  [...currentUnit().products.map((product) => product.quantity), ...(state.businessUnit === "mi" ? ["huTieu", "voBanhGoi", "thungXop"] : [])].forEach((name) => {
    const input = $(`[name="${name}"]`);
    input.disabled = resting;
    if (resting) input.value = "0";
  });
  $(".product-lines").classList.toggle("resting", resting);
  calculateOrder();
}

function applyCustomer(code, useSuggestion = false) {
  $("#customerCode").value = code;
  const customer = selectedCustomer();
  if (!customer) return;
  const truckSuggestions = customerTruckSuggestions(customer.TenKH);
  $("#nhaXe").value = customer.NhaXeMacDinh || truckSuggestions[0]?.name || "";
  $("#extraShipCustomer").value = "";
  $("#tienUng").value = "";
  $("#taxRate").value = String(customer.ThueSuat || 0);
  const suggestion = customer.suggestion || {};
  $("#customerContext").className = "customer-context";
  const priceText = currentUnit().products.map((product) => `${product.name} ${money.format(customer[product.price] || 0)}`).join(" · ");
  $("#customerContext").innerHTML = `<div><strong>${escapeHtml(customer.TenKH)}</strong><span>${escapeHtml(priceText)}</span></div><div class="ai-hint"><b>✦ Gợi ý</b><span>${escapeHtml(suggestion.message || "Chưa có đủ lịch sử mua.")}</span></div>`;
  if (useSuggestion) {
    const productFields = { "Mì": "miKg", "Da cảo": "caoKg", "Da hoành": "hoanhKg" };
    (suggestion.products || []).forEach((product) => {
      const field = productFields[product.name];
      if (field) $(`[name="${field}"]`).value = product.quantity || "";
    });
  }
  renderTruckSuggestions();
  calculateOrder();
}

function normalizeVietnamese(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase();
}

function todayInVietnam() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseChatDate(text) {
  const match = text.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})\b/);
  if (!match) return todayInVietnam();
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  const month = Number(match[2]);
  const day = Number(match[1]);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (year < 2000 || year > 2099 || day < 1 || day > daysInMonth) {
    throw new Error("Ngày nhập không hợp lệ.");
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const chatProductAliases = {
  mi: ["mi"],
  cao: ["da cao", "sui cao", "cao"],
  hoanh: ["da hoanh thanh", "da hoanh", "hoanh thanh", "hoanh"],
};

function parseChatProducts(text) {
  const aliasEntries = Object.entries(chatProductAliases)
    .flatMap(([product, aliases]) => aliases.map((alias) => ({ product, alias })))
    .sort((first, second) => second.alias.length - first.alias.length);
  const aliasPattern = aliasEntries
    .map(({ alias }) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"))
    .join("|");
  const aliasToProduct = new Map(aliasEntries.map(({ product, alias }) => [alias, product]));
  const withoutDate = text.replace(/\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/g, " ");
  const tokenPattern = new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(kg)?\\b|\\b(${aliasPattern})\\b`, "gi");
  const tokens = [...withoutDate.matchAll(tokenPattern)].map((match) => {
    if (match[1]) return { type: "quantity", value: parseNumber(match[1]) };
    const alias = String(match[3] || "").replace(/\s+/g, " ").trim();
    return { type: "product", value: aliasToProduct.get(alias) };
  }).filter((token) => token.value !== undefined);
  const quantities = { mi: 0, cao: 0, hoanh: 0 };
  const productFirst = tokens[0]?.type === "product";
  const matchedProductIndexes = new Set();

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const first = tokens[index];
    const second = tokens[index + 1];
    if (productFirst && first.type === "product" && second.type === "quantity") {
      quantities[first.value] += second.value;
      matchedProductIndexes.add(index);
      index += 1;
    } else if (!productFirst && first.type === "quantity" && second.type === "product") {
      quantities[second.value] += first.value;
      matchedProductIndexes.add(index + 1);
      index += 1;
    }
  }
  const unresolvedProduct = tokens.find((token, index) => token.type === "product" && !matchedProductIndexes.has(index));
  if (unresolvedProduct) {
    throw new Error("Chưa xác định được số lượng cho một mặt hàng. Hãy nhập cùng một kiểu, ví dụ: Mì 26kg Cảo 20kg.");
  }
  return quantities;
}

function parseChatMoney(text, pattern) {
  const match = text.match(pattern);
  if (!match) return 0;
  const value = parseNumber(match[1]);
  const suffix = normalizeVietnamese(match[2] || "");
  if (suffix === "k" || suffix.includes("nghin")) return value * 1000;
  if (suffix.includes("tr")) return value * 1000000;
  return value;
}

function parseChatTax(text, customer) {
  const noTax = /khong\s+(?:tinh\s+)?thue|bo\s+thue/.test(text);
  const explicitTax = text.match(/(?:thue\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*%\s*thue)/);
  const mentionsTax = /\bthue\b/.test(text);
  const ownerPays = /xuong\s+chiu(?:\s+thue)?|toi\s+chiu(?:\s+thue)?|chu\s+chiu(?:\s+thue)?|bao\s+thue|mien\s+thue\s+cho\s+khach/.test(text);
  const customerPays = /khach\s+(?:tra|chiu)\s+thue|cong\s+thue|them\s+thue/.test(text);
  let rate = Number(customer.ThueSuat || 0);
  if (noTax) rate = 0;
  else if (explicitTax) rate = parseNumber(explicitTax[1] || explicitTax[2]);
  else if (mentionsTax || customerPays || ownerPays) rate = 5;
  return { rate, payer: ownerPays ? "owner" : "customer" };
}

const chatCustomerAliases = [
  { phrases: ["chau doc"], code: "m29", name: "chau doc" },
  { phrases: ["long xuyen"], name: "a hao long xuyen" },
];

function normalizeChatWords(value) {
  return normalizeVietnamese(value).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function textHasPhrase(text, phrase) {
  const normalizedText = normalizeChatWords(text);
  const escaped = normalizeChatWords(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|\\s)${escaped}(?=\\s|$)`).test(normalizedText);
}

function chatCustomerCandidates(text) {
  const ignored = new Set(["kg", "mi", "cao", "da", "hoanh", "thanh", "sui", "thue", "ung", "xe", "khach", "tra", "xuong", "chiu"]);
  const words = normalizeChatWords(text).split(/\s+/).filter((word) => word.length >= 3 && !ignored.has(word) && !/^\d/.test(word));
  return state.customers.filter((customer) => {
    const name = normalizeChatWords(customer.TenKH);
    return words.some((word) => name.includes(word));
  }).slice(0, 5);
}

function findChatCustomer(text) {
  const byCode = state.customers.find((item) => {
    const code = normalizeVietnamese(item.MaKH).trim();
    return code && textHasPhrase(text, code);
  });
  if (byCode) return byCode;

  for (const alias of chatCustomerAliases) {
    if (!alias.phrases.some((phrase) => textHasPhrase(text, phrase))) continue;
    const byAliasCode = alias.code
      ? state.customers.find((item) => normalizeVietnamese(item.MaKH).trim() === alias.code)
      : null;
    const byAliasName = state.customers.find((item) => normalizeChatWords(item.TenKH).includes(normalizeChatWords(alias.name)));
    if (byAliasCode || byAliasName) return byAliasCode || byAliasName;
  }

  const byFullName = state.customers.filter((item) => {
    const name = normalizeChatWords(item.TenKH);
    return name.length >= 3 && textHasPhrase(text, name);
  });
  if (byFullName.length === 1) return byFullName[0];

  const error = new Error("Anh đang nói khách hàng nào? Chọn khách bên dưới hoặc nhập thêm mã khách.");
  error.customerCandidates = byFullName.length > 1 ? byFullName.slice(0, 5) : chatCustomerCandidates(text);
  throw error;
}

function parseChatOrder(rawText) {
  const text = normalizeVietnamese(rawText).replace(/\s+/g, " ").trim();
  const date = parseChatDate(text);
  const customer = findChatCustomer(text);

  const customerResting = /khach nghi|nghi ban|nghi lay|hom nay nghi|\bnghi\b/.test(text);
  const products = parseChatProducts(text);
  const miKg = customerResting ? 0 : products.mi;
  const caoKg = products.cao;
  const hoanhKg = customerResting ? 0 : products.hoanh;
  const finalCaoKg = customerResting ? 0 : caoKg;
  if (!customerResting && !miKg && !finalCaoKg && !hoanhKg) {
    throw new Error("Chưa thấy số lượng mì, cảo hoặc hoành.");
  }

  const tax = parseChatTax(text, customer);
  const taxRate = tax.rate;
  const taxPayer = tax.payer;
  const advance = parseChatMoney(text, /(?:ung(?:\s+xe|\s+chanh\s+xe)?|tien\s+ung)\s*(\d+(?:[.,]\d+)?)\s*(k|nghin|tr|trieu)?/);
  const subtotal = miKg * customer.GiaMi + finalCaoKg * customer.GiaCao + hoanhKg * customer.GiaHoanh;
  const taxAmount = subtotal * taxRate / 100;
  const orderTotal = subtotal + advance;

  return {
    customer,
    payload: {
      customerCode: customer.MaKH,
      orderDate: date,
      miKg: miKg || "",
      caoKg: customerResting ? 0 : (finalCaoKg || ""),
      hoanhKg: hoanhKg || "",
      huTieu: "",
      voBanhGoi: "",
      thungXop: "",
      nhaXe: customer.NhaXeMacDinh || "",
      extraShipCustomer: "",
      tienUng: advance || "",
      taxRate,
      taxPayer,
      taxAmount,
      subtotal,
      orderTotal,
      customerResting,
      ghiChu: "Chat AI",
      userEmail: state.user?.email || state.user?.username || "",
    },
  };
}

function addChatMessage(content, type = "assistant") {
  const message = document.createElement("div");
  message.className = `chat-message ${type}`;
  message.innerHTML = content;
  $("#aiChatMessages").appendChild(message);
  $("#aiChatMessages").scrollTop = $("#aiChatMessages").scrollHeight;
  return message;
}

function chatCustomerQuestion(error) {
  const choices = error.customerCandidates || [];
  const buttons = choices.map((customer) => (
    `<button type="button" class="select-chat-customer" data-code="${escapeHtml(customer.MaKH)}">${escapeHtml(customer.TenKH)}</button>`
  )).join("");
  return `<p>${escapeHtml(error.message)}</p>${buttons ? `<div class="chat-actions customer-choices">${buttons}</div>` : "<small>Ví dụ: m29 2kg cảo</small>"}`;
}

function chatOrderPreview(order) {
  const payload = order.payload;
  const customerTotal = payload.orderTotal + (payload.taxPayer === "customer" ? payload.taxAmount : 0);
  const products = payload.customerResting ? "Khách nghỉ · Số lượng tất cả mặt hàng = 0" : [
    payload.miKg ? `Mì ${number.format(payload.miKg)} kg` : "",
    payload.caoKg ? `Da cảo ${number.format(payload.caoKg)} kg` : "",
    payload.hoanhKg ? `Da hoành ${number.format(payload.hoanhKg)} kg` : "",
  ].filter(Boolean).join(" + ");
  return `
    <p>Mình hiểu đơn hàng như sau:</p>
    <div class="chat-order-preview">
      <div><span>Ngày</span><strong>${formatDate(payload.orderDate)}</strong></div>
      <div><span>Khách</span><strong>${escapeHtml(order.customer.TenKH)}</strong></div>
      <div><span>Hàng</span><strong>${escapeHtml(products)}</strong></div>
      <div><span>Tiền hàng</span><strong>${money.format(payload.subtotal)}</strong></div>
      <div><span>Thuế</span><strong>${payload.taxRate}% · ${payload.taxPayer === "owner" ? "xưởng chịu" : "khách trả"}</strong></div>
      <div><span>Ứng xe</span><strong>${money.format(payload.tienUng || 0)}</strong></div>
      <div><span>Khách phải trả</span><strong>${money.format(customerTotal)}</strong></div>
    </div>
    <div class="chat-actions"><button type="button" class="cancel-chat-order">Nhập lại</button><button type="button" class="confirm-chat-order">Ghi đơn</button></div>
  `;
}

async function saveChatOrder(button) {
  if (!state.pendingChatOrder) return;
  button.disabled = true;
  button.textContent = "Đang ghi...";
  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ ...state.pendingChatOrder.payload, businessUnit: state.businessUnit }),
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Không ghi được đơn hàng.");
    addChatMessage(`<p>Đã ghi đơn cho <strong>${escapeHtml(data.customerName)}</strong>.</p><small>Tiền hàng và công nợ đã cập nhật trong database CRM.</small>`, "success");
    state.pendingChatOrder = null;
    await loadCrm();
  } catch (error) {
    addChatMessage(`<p>${escapeHtml(error.message)}</p>`, "error");
    button.disabled = false;
    button.textContent = "Ghi đơn";
  }
}

function openCustomerDialog(code) {
  const customer = state.customers.find((item) => item.MaKH === code);
  if (!customer) return;
  const form = $("#customerEditForm");
  ["MaKH", "TenKH", "GiaMi", "GiaCao", "GiaHoanh", "GiaPhoSoi", "GiaPhoCuon", "NhaXeMacDinh", "ThueSuat"].forEach((key) => {
    form.elements[key].value = customer[key] || "";
  });
  form.querySelectorAll("[data-money-input]").forEach(formatMoneyInput);
  $("#editCustomerName").textContent = `${customer.MaKH} · ${customer.TenKH}`;
  $("#editResult").className = "notice";
  $("#customerDialog").showModal();
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    const response = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Đăng nhập thất bại.");
    state.user = data.user;
    localStorage.removeItem("nhapLieuAuthToken");
    localStorage.removeItem("nhapLieuAuthUser");
    state.token = "";
    renderAuth();
    await loadCrm();
  } catch (error) {
    notice($("#loginResult"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#showRegister").addEventListener("click", () => {
  $("#loginForm").classList.add("hidden");
  $("#registerForm").classList.remove("hidden");
  $("#registerResult").className = "notice";
});

$("#showLogin").addEventListener("click", () => {
  $("#registerForm").classList.add("hidden");
  $("#loginForm").classList.remove("hidden");
  $("#loginResult").className = "notice";
});

$("#registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    const response = await fetch("/api/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Không đăng ký được tài khoản.");
    notice($("#registerResult"), data.message);
    form.reset();
  } catch (error) {
    notice($("#registerResult"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#orderForm").addEventListener("input", calculateOrder);
$("#customerResting").addEventListener("change", applyRestingState);
$("#customerCode").addEventListener("change", () => applyCustomer($("#customerCode").value));
$("#nhaXe").addEventListener("input", renderTruckSuggestions);
$("#truckSuggestions").addEventListener("click", (event) => {
  const suggestion = event.target.closest(".truck-suggestion");
  if (!suggestion) return;
  $("#nhaXe").value = suggestion.dataset.truck || "";
  $("#tienUng").value = Number(suggestion.dataset.advance || 0)
    ? new Intl.NumberFormat("vi-VN").format(Number(suggestion.dataset.advance))
    : "";
  renderTruckSuggestions();
  calculateOrder();
});
ensureBulkCopyUi();
if ($("#copyProductionButton") && $("#bulkCopyForm")) {
  $("#copyProductionButton").addEventListener("click", openBulkCopyDialog);
  $("#bulkCopySourceDate").addEventListener("change", renderBulkCopyRows);
  $("#bulkCopyTargetDate").addEventListener("change", renderBulkCopyRows);
  $("#bulkCopySelectAll").addEventListener("click", () => {
    const checks = $$(".bulk-copy-check");
    const shouldCheck = checks.some((input) => !input.checked);
    checks.forEach((input) => { input.checked = shouldCheck; });
    updateBulkCopySelection();
  });
  $("#bulkCopyAddCustomerButton").addEventListener("click", () => {
    const code = $("#bulkCopyAddCustomer").value;
    if (!code) return;
    if (!state.bulkCopyAddedCustomerCodes.some((item) => normalizeVietnamese(item) === normalizeVietnamese(code))) {
      state.bulkCopyAddedCustomerCodes.push(code);
    }
    renderBulkCopyRows();
  });
  $("#bulkCopyRows").addEventListener("input", updateBulkCopySelection);
  $("#bulkCopyRows").addEventListener("change", updateBulkCopySelection);
  $("#bulkCopyHead").addEventListener("change", (event) => {
    if (!event.target.matches("#bulkCopyMasterCheck")) return;
    $$(".bulk-copy-check").forEach((input) => { input.checked = event.target.checked; });
    updateBulkCopySelection();
  });
  $("#bulkCopyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveBulkCopiedOrders($("#saveBulkCopy"));
  });
}
$("#orderForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const buttons = [...form.querySelectorAll("button[type='submit']")];
  const paymentMethod = event.submitter?.value || "debt";
  const paymentLabels = {
    debt: "công nợ",
    cash: "tiền mặt",
    transfer: "chuyển khoản",
  };
  buttons.forEach((button) => { button.disabled = true; });
  notice($("#result"), "Đang lưu đơn hàng...");
  try {
    calculateOrder();
    const payload = Object.fromEntries(new FormData(form));
    payload.paymentMethod = paymentMethod;
    payload.businessUnit = state.businessUnit;
    const response = await fetch("/api/orders", { method: "POST", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(payload) });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Không lưu được đơn hàng.");
    notice($("#result"), `Đã lưu đơn ${paymentLabels[paymentMethod]} cho ${data.customerName}, mã giao dịch #${data.rowNumber}.`);
    form.reset();
    $("#orderDate").value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    $("#customerContext").className = "customer-context empty";
    $("#customerContext").textContent = "Chọn khách để xem bảng giá và gợi ý.";
    $("#truckSuggestions").classList.add("hidden");
    $("#truckSuggestions").innerHTML = "";
    applyRestingState();
    await loadCrm();
  } catch (error) {
    notice($("#result"), error.message, "error");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
});

$("#customerEditForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = normalizeCustomerPrices(Object.fromEntries(new FormData(event.currentTarget)));
  try {
    const response = await fetch(unitUrl("/api/customers"), { method: "PUT", headers: authHeaders({ "content-type": "application/json" }), body: JSON.stringify(payload) });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Không cập nhật được bảng giá.");
    const syncText = data.syncedOrders || data.syncedProduction
      ? ` Đã cập nhật ${data.syncedOrders || 0} đơn hàng và ${data.syncedProduction || 0} hồ sơ sản xuất trong database.`
      : "";
    notice($("#editResult"), `Đã cập nhật khách hàng.${syncText}`);
    await loadCrm();
    setTimeout(() => $("#customerDialog").close(), 450);
  } catch (error) {
    notice($("#editResult"), error.message, "error");
  }
});

$("#addCustomerButton").addEventListener("click", () => {
  const form = $("#customerCreateForm");
  form.reset();
  form.elements.productionInfoId.value = "";
  $("#customerMatchSuggestions").classList.add("hidden");
  $("#customerMatchList").innerHTML = "";
  $("#createCustomerResult").className = "notice";
  $("#customerCreateDialog").showModal();
  form.elements.MaKH.focus();
});

$("#customerCreateForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    const payload = normalizeCustomerPrices(Object.fromEntries(new FormData(event.currentTarget)));
    const response = await fetch(unitUrl("/api/customers"), {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Không thêm được khách hàng.");
    const linkedText = data.linkedProduction
      ? ` Đã liên kết thông tin SX "${data.linkedProduction.customer}".`
      : "";
    notice($("#createCustomerResult"), `Đã thêm ${payload.TenKH}.${linkedText}`);
    await loadCrm();
    $("#customerCode").value = payload.MaKH;
    applyCustomer(payload.MaKH);
    setTimeout(() => $("#customerCreateDialog").close(), 450);
  } catch (error) {
    notice($("#createCustomerResult"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

["MaKH", "TenKH"].forEach((field) => {
  $("#customerCreateForm").elements[field].addEventListener("input", renderCustomerMatchSuggestions);
});
$("#customerMatchList").addEventListener("change", (event) => {
  if (!event.target.matches('[name="productionMatchChoice"]')) return;
  $("#customerCreateForm").elements.productionInfoId.value = event.target.value;
  renderCustomerMatchSuggestions();
});
$("#clearCustomerMatch").addEventListener("click", () => {
  $("#customerCreateForm").elements.productionInfoId.value = "";
  renderCustomerMatchSuggestions();
});

$("#productionEditForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    payload.businessUnit = state.businessUnit;
    const isCreating = !payload.id;
    if (isCreating) payload.action = "create";
    const response = await fetch(unitUrl("/api/production-info"), {
      method: isCreating ? "POST" : "PUT",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || `Không ${isCreating ? "thêm" : "sửa"} được thông tin sản xuất.`);
    notice($("#productionEditResult"), isCreating ? "Đã thêm thông tin sản xuất." : "Đã cập nhật thông tin sản xuất.");
    await loadCrm();
    setTimeout(() => $("#productionEditDialog").close(), 450);
  } catch (error) {
    notice($("#productionEditResult"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#addProductionInfo").addEventListener("click", openProductionCreate);
$("#productionEditForm").elements.customerCode.addEventListener("change", (event) => {
  if (!event.target.value) return;
  const customer = state.customers.find((item) => normalizeVietnamese(item.MaKH) === normalizeVietnamese(event.target.value));
  if (customer && !$("#productionEditForm").elements.customer.value.trim()) {
    $("#productionEditForm").elements.customer.value = customer.TenKH;
  }
});

$("#syncProductionCustomers").addEventListener("click", async () => {
  const button = $("#syncProductionCustomers");
  button.disabled = true;
  button.textContent = "Đang khớp...";
  try {
    const response = await fetch(unitUrl("/api/production-info"), {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ businessUnit: state.businessUnit }),
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Không khớp được khách hàng CRM.");
    await loadCrm();
    button.textContent = `Đã khớp thêm ${data.matched} khách`;
    setTimeout(() => { button.textContent = "Khớp khách CRM"; }, 1800);
  } catch (error) {
    button.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("input", (event) => {
  if (event.target.matches("[data-money-input]")) formatMoneyInput(event.target);
});

$("#orderEditForm").addEventListener("input", calculateEditOrder);
$("#orderEditForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  calculateEditOrder();
  const button = event.currentTarget.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    const payload = Object.fromEntries(new FormData(event.currentTarget));
    payload.customerResting = event.currentTarget.elements.customerResting.checked;
    payload.businessUnit = state.businessUnit;
    const copying = state.editingOrderMode === "copy";
    if (copying) {
      payload.action = "copy";
      payload.sourceOrderId = event.currentTarget.elements.sourceOrderId.value;
      payload.paid = 0;
      payload.paymentMethod = "debt";
    }
    const response = await fetch("/api/orders", {
      method: copying ? "POST" : "PUT",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload),
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || (copying ? "Không tạo được đơn bản sao." : "Không sửa được đơn hàng."));
    notice(
      $("#orderEditResult"),
      copying
        ? `Đã tạo đơn #${data.rowNumber} từ bản sao và giữ nguyên đơn gốc.`
        : `Đã cập nhật giao dịch #${data.rowNumber}.`,
    );
    await loadCrm();
    if ($("#customerProfileDialog").open && state.profileCustomerName) {
      openCustomerProfile(state.profileCustomerCode, state.profileCustomerName);
    }
    setTimeout(() => $("#orderEditDialog").close(), 450);
  } catch (error) {
    notice($("#orderEditResult"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

$("#paymentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const amount = parseNumber(form.elements.amount.value);
  const button = form.querySelector("button[type='submit']");
  button.disabled = true;
  try {
    const response = await fetch("/api/payments", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        customerCode: form.elements.customerCode.value,
        amount,
        date: form.elements.date.value,
        note: form.elements.note.value.trim(),
        businessUnit: state.businessUnit,
      }),
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Không cập nhật được thanh toán.");
    notice($("#paymentResult"), `Đã ghi nhận thanh toán ${money.format(amount)}.`);
    await loadCrm();
    if ($("#customerProfileDialog").open && state.profileCustomerName) {
      openCustomerProfile(state.profileCustomerCode, state.profileCustomerName);
    }
    setTimeout(() => $("#paymentDialog").close(), 500);
  } catch (error) {
    notice($("#paymentResult"), error.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("click", (event) => {
  const dialogClose = event.target.closest(".dialog-close");
  if (dialogClose) {
    dialogClose.closest("dialog")?.close();
    return;
  }
  const nav = event.target.closest("[data-view]");
  const jump = event.target.closest("[data-jump]");
  const edit = event.target.closest(".edit-customer");
  const editOrder = event.target.closest(".edit-order");
  const copyOrder = event.target.closest(".copy-order");
  const deleteOrder = event.target.closest(".delete-order");
  const viewCustomer = event.target.closest(".view-customer");
  const suggested = event.target.closest(".create-suggested-order");
  const confirmChatOrder = event.target.closest(".confirm-chat-order");
  const cancelChatOrder = event.target.closest(".cancel-chat-order");
  const selectChatCustomer = event.target.closest(".select-chat-customer");
  const reportCustomerLink = event.target.closest(".report-customer-link");
  const productionInfo = event.target.closest(".view-production-info");
  const editProductionInfo = event.target.closest(".edit-production-info");
  const attentionCustomer = event.target.closest("[data-customer]");
  const recordPayment = event.target.closest(".record-payment");
  const userSave = event.target.closest(".user-save");
  const profileExportExcel = event.target.closest("#profileExportExcel");
  const profileExportSheet = event.target.closest("#profileExportSheet");
  if (nav) switchView(nav.dataset.view);
  if (jump) switchView(jump.dataset.jump);
  if (edit) openCustomerDialog(edit.dataset.code);
  if (editOrder) {
    editOrder.closest("details")?.removeAttribute("open");
    openOrderEditDialog(editOrder.dataset.id);
  }
  if (copyOrder) {
    copyOrder.closest("details")?.removeAttribute("open");
    copyLedgerOrder(copyOrder);
  }
  if (deleteOrder) {
    deleteOrder.closest("details")?.removeAttribute("open");
    deleteLedgerOrder(deleteOrder);
  }
  if (viewCustomer) openCustomerProfile(viewCustomer.dataset.code, viewCustomer.dataset.name);
  if (suggested) { switchView("orders"); applyCustomer(suggested.dataset.code, true); }
  if (confirmChatOrder) saveChatOrder(confirmChatOrder);
  if (cancelChatOrder) {
    state.pendingChatOrder = null;
    $("#aiChatInput").focus();
  }
  if (selectChatCustomer && state.pendingChatCustomerText) {
    try {
      state.pendingChatOrder = parseChatOrder(`${state.pendingChatCustomerText} ${selectChatCustomer.dataset.code}`);
      state.pendingChatCustomerText = "";
      addChatMessage(chatOrderPreview(state.pendingChatOrder));
    } catch (error) {
      addChatMessage(`<p>${escapeHtml(error.message)}</p>`, "error");
    }
  }
  if (reportCustomerLink) {
    $("#reportCustomer").value = reportCustomerLink.dataset.name;
    renderReports();
    $("#reportsView").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  if (productionInfo) openProductionInfo(productionInfo.dataset.id);
  if (editProductionInfo) openProductionEdit(editProductionInfo.dataset.id);
  if (attentionCustomer) openCustomerProfile(attentionCustomer.dataset.customer);
  if (recordPayment) openPaymentDialog(recordPayment.dataset.code);
  if (profileExportExcel) exportCustomerProfileExcel(profileExportExcel);
  if (profileExportSheet) exportCustomerProfileSheet(profileExportSheet);
  if (userSave) {
    const row = userSave.closest("[data-user-id]");
    userSave.disabled = true;
    userSave.textContent = "Đang lưu...";
    fetch("/api/users", {
      method: "PUT",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        id: Number(row.dataset.userId),
        role: row.querySelector(".user-role-select").value,
        status: row.querySelector(".user-status-select").value,
        businessUnits: [...row.querySelectorAll(".user-unit-input:checked")].map((input) => input.value),
      }),
    }).then(async (response) => {
      const data = await readApiResponse(response);
      if (!response.ok) throw new Error(data.error || "Không cập nhật được quyền.");
      await loadCrm();
      notice($("#userManagementResult"), `Đã cập nhật quyền cho ${data.user.email}.`);
    }).catch((error) => {
      notice($("#userManagementResult"), error.message, "error");
      userSave.disabled = false;
      userSave.textContent = "Lưu quyền";
    });
  }
});

$$(".jump-order").forEach((button) => button.addEventListener("click", () => switchView("orders")));
$("#customerSearch").addEventListener("input", (event) => renderCustomers(event.target.value));
$("#customerSortDirection").addEventListener("change", (event) => setCustomerSortDirection(event.target.value));
$("#orderCustomerSortDirection").addEventListener("change", (event) => setCustomerSortDirection(event.target.value));
$("#productionSearch").addEventListener("input", renderProductionInfo);
$("#productionFilter").addEventListener("change", renderProductionInfo);
$("#debtSearch").addEventListener("input", (event) => renderDebts(event.target.value));
$("#auditSearch").addEventListener("input", renderAuditLog);
$("#auditGroup").addEventListener("change", renderAuditLog);
$("#auditSession").addEventListener("change", renderAuditLog);
$("#auditAccount").addEventListener("change", renderAuditLog);
$("#refreshAudit").addEventListener("click", async () => {
  const button = $("#refreshAudit");
  button.disabled = true;
  button.textContent = "Đang tải...";
  try {
    const response = await fetch(unitUrl("/api/audit-log?limit=500"), { headers: authHeaders() });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Không tải được nhật ký hoạt động.");
    state.auditLog = data.entries || [];
    renderAuditAccounts();
    renderAuditLog();
    button.textContent = "Đã cập nhật";
  } catch (error) {
    button.textContent = error.message;
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = "Làm mới";
    }, 1200);
  }
});
$("#exportDebtsExcel").addEventListener("click", async () => {
  const button = $("#exportDebtsExcel");
  button.disabled = true;
  button.textContent = "Đang tạo Excel...";
  try {
    const response = await fetch(unitUrl("/api/export-debts"), { headers: authHeaders() });
    if (!response.ok) {
      const data = await readApiResponse(response);
      throw new Error(data.error || "Không xuất được Excel công nợ.");
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `cong-no-crm-${todayInVietnam()}.xlsx`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
    button.textContent = "Đã xuất Excel";
  } catch (error) {
    button.textContent = error.message;
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.textContent = "↓ Xuất Excel công nợ";
    }, 1800);
  }
});
$("#logoutButton").addEventListener("click", logout);
window.addEventListener("pagehide", () => {
  if (!state.user || state.explicitLogout) return;
  fetch("/api/logout", {
    method: "POST",
    headers: authHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ reason: "page-exit" }),
    keepalive: true,
  }).catch(() => {});
});
$("#mobileMenu").addEventListener("click", () => $(".sidebar").classList.toggle("open"));
$$("#businessUnitSwitcher button").forEach((button) => {
  button.addEventListener("click", () => {
    switchBusinessUnit(button.dataset.businessUnit).catch((error) => {
      notice($("#result"), error.message, "error");
    });
  });
});
["#reportCustomer", "#reportFrom", "#reportTo"].forEach((selector) => {
  $(selector).addEventListener("input", renderReports);
});
["#productionStatsFrom", "#productionStatsTo"].forEach((selector) => {
  $(selector).addEventListener("input", renderProductionStats);
});
$("#clearProductionStatsFilters").addEventListener("click", resetProductionStatsToLast30Days);
$$('[name="reportPeriod"]').forEach((input) => input.addEventListener("change", renderReports));
$("#clearReportFilters").addEventListener("click", () => {
  resetReportToLast30Days();
});
["#ledgerSearch", "#ledgerCustomer", "#ledgerFrom", "#ledgerTo", "#ledgerProduct"].forEach((selector) => {
  $(selector).addEventListener("input", () => {
    state.ledgerPage = 1;
    renderLedger();
  });
});
$("#clearLedgerFilters").addEventListener("click", () => {
  ["#ledgerSearch", "#ledgerCustomer", "#ledgerFrom", "#ledgerTo", "#ledgerProduct"].forEach((selector) => { $(selector).value = ""; });
  state.ledgerPage = 1;
  renderLedger();
});
$("#ledgerPrev").addEventListener("click", () => { state.ledgerPage -= 1; renderLedger(); });
$("#ledgerNext").addEventListener("click", () => { state.ledgerPage += 1; renderLedger(); });
document.addEventListener("click", (event) => {
  const sortButton = event.target.closest(".sort-button[data-sort]");
  if (!sortButton) return;
  if (state.ledgerSortKey === sortButton.dataset.sort) {
    state.ledgerSortDirection = state.ledgerSortDirection === "desc" ? "asc" : "desc";
  } else {
    state.ledgerSortKey = sortButton.dataset.sort;
    state.ledgerSortDirection = ["customerName", "truck", "note"].includes(state.ledgerSortKey) ? "asc" : "desc";
  }
  state.ledgerPage = 1;
  renderLedger();
});
$("#exportLedger").addEventListener("click", exportLedgerCsv);
$("#closeCustomerProfile").addEventListener("click", () => $("#customerProfileDialog").close());
$("#closeProductionInfo").addEventListener("click", () => $("#productionInfoDialog").close());
$("#profileCreateOrder").addEventListener("click", () => {
  const code = state.profileCustomerCode;
  $("#customerProfileDialog").close();
  if (!code) {
    switchView("customers");
    return;
  }
  switchView("orders");
  applyCustomer(code);
});
$("#profileProductionInfo").addEventListener("click", () => {
  const id = $("#profileProductionInfo").dataset.id;
  if (!id) return;
  $("#customerProfileDialog").close();
  openProductionInfo(id);
});
$("#profilePayment").addEventListener("click", () => openPaymentDialog($("#profilePayment").dataset.code));
$("#aiChatButton").addEventListener("click", () => {
  $("#aiChatPanel").classList.toggle("open");
  $("#aiChatPanel").setAttribute("aria-hidden", String(!$("#aiChatPanel").classList.contains("open")));
  if ($("#aiChatPanel").classList.contains("open")) $("#aiChatInput").focus();
});
$("#closeAiChat").addEventListener("click", () => {
  $("#aiChatPanel").classList.remove("open");
  $("#aiChatPanel").setAttribute("aria-hidden", "true");
});
$("#aiChatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("#aiChatInput").value.trim();
  if (!text) return;
  addChatMessage(`<p>${escapeHtml(text)}</p>`, "user");
  $("#aiChatInput").value = "";
  try {
    if (/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}$/.test(text)) {
      const normalizedDate = parseChatDate(text);
      addChatMessage(`<p>Đã hiểu ngày <strong>${formatDate(normalizedDate)}</strong>.</p><small>Nhập thêm mã khách và số lượng hàng để tạo đơn.</small>`);
      return;
    }
    state.pendingChatOrder = parseChatOrder(text);
    state.pendingChatCustomerText = "";
    addChatMessage(chatOrderPreview(state.pendingChatOrder));
  } catch (error) {
    state.pendingChatOrder = null;
    if (error.customerCandidates) {
      state.pendingChatCustomerText = text;
      addChatMessage(chatCustomerQuestion(error));
    } else {
      state.pendingChatCustomerText = "";
      addChatMessage(`<p>${escapeHtml(error.message)}</p><small>Ví dụ đúng: 8/6/23 m23 4kg cảo + 2kg hoành</small>`, "error");
    }
  }
});
$("#aiChatInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("#aiChatForm").requestSubmit();
  }
});
$("#orderDate").value = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

applyBusinessUnitUi();
renderAuth();
async function restoreSession() {
  const hadLegacyToken = Boolean(state.token);
  try {
    const response = await fetch("/api/session", { headers: authHeaders() });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "Phiên đăng nhập không còn hiệu lực.");
    state.user = data.user;
    state.token = "";
    localStorage.removeItem("nhapLieuAuthToken");
    localStorage.removeItem("nhapLieuAuthUser");
    renderAuth();
    await loadCrm();
  } catch (error) {
    clearLocalSession();
    if (hadLegacyToken) {
      notice($("#loginResult"), `${error.message} Vui lòng đăng nhập lại bằng email.`, "error");
    }
  }
}
restoreSession();
