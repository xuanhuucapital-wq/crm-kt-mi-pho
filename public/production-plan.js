// Kế hoạch sản xuất ngày: nhập mẻ → xem theo mẻ (xưởng) → xem theo khách (đóng hàng) → sổ sản lượng.
// Dùng lại các hàm chung của app.js ($, $$, state, authHeaders, fetchWithTimeout, readApiResponse, escapeHtml, number...).
(() => {
  const API = "/api/production-plans";
  const GROUP_LABEL = { DA: "DA", MI: "MÌ" };
  const PRODUCT_NAMES = [
    "Cảo dày", "Cảo mỏng", "Cảo thường", "Hoành thánh size 8", "Hoành thánh size 9",
    "Mì sợi nhỏ", "Mì dẹp", "Mì lớn", "Mì trộn (sợi nhỏ + dẹp)",
  ];
  const pp = { date: "", plan: null, revenue: null, dirty: false, tab: "batch", unit: state.businessUnit, loading: false };
  const money = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 });

  const emptyOutput = () => ({ customer: "", qty: null, qtyMax: null, unit: "kg", pack: "", optional: false, note: "" });
  const emptyProduct = () => ({ name: "", kgTron: null, finishedKg: null, note: "", outputs: [emptyOutput()] });
  const emptyBatch = (index) => ({ label: String(index + 1), group: "DA", name: "", kgTron: 0, note: "", products: [emptyProduct()] });
  const emptyPlan = () => ({ batches: [], note: "" });

  async function api(method, body, query = "") {
    const url = `${API}?businessUnit=${state.businessUnit}${query}`;
    const response = await fetchWithTimeout(url, {
      method,
      headers: authHeaders(body ? { "content-type": "application/json" } : {}),
      body: body ? JSON.stringify({ businessUnit: state.businessUnit, ...body }) : undefined,
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || `Máy chủ báo lỗi (HTTP ${response.status}).`);
    return data;
  }

  const kg = (value) => (value === null || value === undefined || value === "" ? "" : number.format(Number(value)));
  const dayText = (date) => (date ? `${date.slice(8, 10)}/${date.slice(5, 7)}` : "");
  const shiftDate = (date, days) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const say = (message, type = "ok") => notice($("#ppNotice"), message, type);

  function crmCustomer(text) {
    const key = normalizeVietnamese(String(text || "").trim());
    if (!key) return null;
    return state.customers.find((c) => normalizeVietnamese(c.MaKH) === key)
      || state.customers.find((c) => normalizeVietnamese(c.TenKH) === key)
      || null;
  }

  function qtyText(output) {
    if (output.qty === null && output.qtyMax === null) return "";
    const range = output.qtyMax !== null && output.qtyMax !== undefined && output.qtyMax !== output.qty
      ? `${kg(output.qty)}–${kg(output.qtyMax)}` : kg(output.qty);
    return `${range} ${output.unit || "kg"}`;
  }

  // ---------- Sản lượng ----------
  function summarize(plan) {
    const total = { DA: { tron: 0, thanhPham: 0, chuaCan: 0 }, MI: { tron: 0, thanhPham: 0, chuaCan: 0 } };
    (plan?.batches || []).forEach((batch) => {
      const bucket = total[batch.group];
      if (!bucket) return;
      bucket.tron += Number(batch.kgTron) || 0;
      (batch.products || []).forEach((product) => {
        if (product.finishedKg === null || product.finishedKg === undefined || product.finishedKg === "") bucket.chuaCan += 1;
        else bucket.thanhPham += Number(product.finishedKg) || 0;
      });
    });
    return total;
  }

  function renderSummary() {
    const sum = summarize(pp.plan);
    const stat = (label, bucket, cls) => `
      <div class="pp-stat ${cls}">
        <span>${label} thành phẩm</span>
        <strong>${kg(bucket.thanhPham)}<em>kg</em></strong>
        <small>${bucket.chuaCan ? `⏳ ${bucket.chuaCan} món chưa cân` : "✓ Đã cân đủ"}</small>
        <small>Trộn ${kg(bucket.tron)} kg</small>
      </div>`;
    const rev = pp.revenue;
    const revenue = rev ? `
      <div class="pp-stat pp-stat-money">
        <span>Doanh thu ${dayText(pp.date)}</span>
        <strong>${money.format(rev.total)}</strong>
        <small>${rev.orderCount} đơn đã nhập · mì ${kg(rev.miKg)} · cảo ${kg(rev.caoKg)} · hoành ${kg(rev.hoanhKg)} kg</small>
      </div>` : "";
    const checks = (pp.plan?.batches || []).map((batch) => {
      const parts = batch.products.map((p) => p.kgTron).filter((v) => v !== null && v !== undefined && v !== "");
      if (!parts.length) return "";
      const total = parts.reduce((a, b) => a + Number(b), 0);
      const ok = Math.abs(total - Number(batch.kgTron)) < 0.01;
      return `<span class="pp-check ${ok ? "ok" : "bad"}">Mẻ ${escapeHtml(batch.label)}: ${parts.map(kg).join(" + ")} = ${kg(total)} ${ok ? "✓" : `≠ ${kg(batch.kgTron)}`}</span>`;
    }).filter(Boolean).join("");
    $("#ppSummary").innerHTML = `<div class="pp-stats">${stat("DA", sum.DA, "pp-stat-da")}${stat("MÌ", sum.MI, "pp-stat-mi")}${revenue}</div>${checks ? `<div class="pp-checks">${checks}</div>` : ""}`;
  }

  // ---------- Nhập liệu ----------
  function input(path, field, value, attrs = "") {
    return `<input data-path="${path}" data-field="${field}" value="${escapeHtml(value ?? "")}" ${attrs} />`;
  }
  const NUM = 'type="number" min="0" step="0.1" inputmode="decimal"';
  const suffix = (html, unit) => `<span class="pp-suffix">${html}<i>${unit}</i></span>`;

  function outputRow(output, b, p, o) {
    const path = `${b}.${p}.${o}`;
    const match = crmCustomer(output.customer);
    return `
      <div class="pp-out${output.optional ? " is-optional" : ""}">
        <div class="pp-out-main">
          <div class="pp-out-who">${input(path, "customer", output.customer, 'list="ppCustomerList" placeholder="Khách nhận (mã hoặc tên)" autocomplete="off"')}
            <small class="pp-match">${match ? `✓ ${escapeHtml(match.TenKH)}${match.NhaXeMacDinh ? ` · ${escapeHtml(match.NhaXeMacDinh)}` : ""}` : ""}</small></div>
          <div class="pp-out-qty">${input(path, "qty", output.qty, `${NUM} placeholder="SL"`)}
            <select data-path="${path}" data-field="unit" aria-label="Đơn vị"><option${output.unit === "kg" ? " selected" : ""}>kg</option><option${output.unit === "gói" ? " selected" : ""}>gói</option></select></div>
          <button type="button" class="pp-x" data-pp-act="remove-output" data-b="${b}" data-p="${p}" data-o="${o}" aria-label="Xoá khách">✕</button>
        </div>
        <div class="pp-out-more">
          <label class="pp-mini">đến${input(path, "qtyMax", output.qtyMax, `${NUM} placeholder="—"`)}</label>
          ${input(path, "pack", output.pack, 'placeholder="Cách gói: thùng, bịch…" class="pp-pack"')}
          <label class="pp-chip-check"><input type="checkbox" data-path="${path}" data-field="optional"${output.optional ? " checked" : ""} /><span>Nếu có / dư</span></label>
        </div>
        ${input(path, "note", output.note, 'placeholder="Ghi chú" class="pp-note"')}
      </div>`;
  }

  function renderEditor() {
    const plan = pp.plan;
    if (!plan.batches.length) {
      $("#ppEdit").innerHTML = `
        <section class="pp-card pp-empty">
          <div class="pp-empty-icon">⚒</div>
          <p><b>Ngày ${dayText(pp.date)} chưa có kế hoạch</b></p>
          <p>Thêm mẻ đầu tiên, hoặc chép lại ngày gần nhất rồi sửa số.</p>
          <button type="button" class="pp-btn pp-btn-main" data-pp-act="add-batch">+ Thêm mẻ đầu tiên</button>
          <button type="button" class="pp-btn" data-pp-act="copy-prev">Chép kế hoạch ngày gần nhất</button>
        </section>`;
      return;
    }
    const batches = plan.batches.map((batch, b) => `
      <section class="pp-card pp-batch-card pp-group-${batch.group}">
        <div class="pp-batch-top">
          <div class="pp-badge">${input(`${b}`, "label", batch.label, 'aria-label="Số mẻ"')}</div>
          <div class="pp-seg" role="group" aria-label="Nhóm">
            <button type="button" data-pp-act="set-group" data-b="${b}" data-value="DA" class="${batch.group === "DA" ? "on" : ""}">DA</button>
            <button type="button" data-pp-act="set-group" data-b="${b}" data-value="MI" class="${batch.group === "MI" ? "on" : ""}">MÌ</button>
          </div>
          ${suffix(input(`${b}`, "kgTron", batch.kgTron, `${NUM} aria-label="Kg trộn" class="pp-big"`), "kg trộn")}
          <button type="button" class="pp-x" data-pp-act="remove-batch" data-b="${b}" aria-label="Xoá mẻ">✕</button>
        </div>
        ${input(`${b}`, "name", batch.name, 'placeholder="Loại bột: cảo dày, da cảo mỏng (máy 2, trục 3-5)…" class="pp-name"')}
        ${input(`${b}`, "note", batch.note, 'placeholder="Ghi chú mẻ" class="pp-note"')}
        ${batch.products.map((product, p) => `
          <div class="pp-product">
            <div class="pp-product-top">
              ${input(`${b}.${p}`, "name", product.name, 'list="ppProductList" placeholder="Sản phẩm: Cảo thường…" class="pp-product-name"')}
              <button type="button" class="pp-x" data-pp-act="remove-product" data-b="${b}" data-p="${p}" aria-label="Xoá sản phẩm">✕</button>
            </div>
            <div class="pp-product-nums">
              <label class="pp-mini">Bột soạn${suffix(input(`${b}.${p}`, "kgTron", product.kgTron, `${NUM} placeholder="nếu tách"`), "kg")}</label>
              <label class="pp-mini pp-finished">Thành phẩm${suffix(input(`${b}.${p}`, "finishedKg", product.finishedKg, `${NUM} placeholder="chưa cân"`), "kg")}</label>
            </div>
            ${input(`${b}.${p}`, "note", product.note, 'placeholder="Ghi chú sản phẩm (vd: cắt size 9)" class="pp-note"')}
            <div class="pp-outs">${product.outputs.map((output, o) => outputRow(output, b, p, o)).join("")}</div>
            <button type="button" class="pp-add" data-pp-act="add-output" data-b="${b}" data-p="${p}">+ Khách nhận</button>
          </div>`).join("")}
        <button type="button" class="pp-add pp-add-product" data-pp-act="add-product" data-b="${b}">+ Sản phẩm trong mẻ</button>
      </section>`).join("");
    $("#ppEdit").innerHTML = `${batches}
      <button type="button" class="pp-btn pp-btn-wide" data-pp-act="add-batch">+ Thêm mẻ</button>
      <section class="pp-card">
        <label class="pp-mini pp-day-note">Ghi chú ngày<input data-path="" data-field="note" value="${escapeHtml(plan.note || "")}" placeholder="vd: M23 chờ báo" /></label>
      </section>`;
  }

  function target(path) {
    if (path === "") return pp.plan;
    const [b, p, o] = path.split(".").map(Number);
    const batch = pp.plan.batches[b];
    if (p === undefined || Number.isNaN(p)) return batch;
    const product = batch.products[p];
    return o === undefined || Number.isNaN(o) ? product : product.outputs[o];
  }

  function onEdit(event) {
    const el = event.target.closest("[data-field]");
    if (!el || !$("#ppEdit").contains(el)) return;
    const obj = target(el.dataset.path);
    const field = el.dataset.field;
    if (el.type === "checkbox") obj[field] = el.checked;
    else if (el.type === "number") obj[field] = el.value === "" ? (field === "kgTron" && obj.products ? 0 : null) : Number(el.value);
    else obj[field] = el.value;
    pp.dirty = true;
    if (field === "customer") {
      const match = crmCustomer(el.value);
      el.parentElement.querySelector(".pp-match").textContent = match
        ? `✓ ${match.TenKH}${match.NhaXeMacDinh ? ` · ${match.NhaXeMacDinh}` : ""}` : "";
    }
    if (field === "optional") el.closest(".pp-out").classList.toggle("is-optional", el.checked);
    renderSummary();
    renderSaveState();
  }

  async function onAction(event) {
    const button = event.target.closest("[data-pp-act]");
    if (!button) return;
    const { b, p, o } = Object.fromEntries(["b", "p", "o"].map((k) => [k, Number(button.dataset[k])]));
    const act = button.dataset.ppAct;
    const batches = pp.plan.batches;
    if (act === "add-batch") batches.push(emptyBatch(batches.length));
    if (act === "set-group") batches[b].group = button.dataset.value;
    if (act === "remove-batch" && confirm(`Xoá mẻ ${batches[b].label}?`)) batches.splice(b, 1);
    if (act === "add-product") batches[b].products.push(emptyProduct());
    if (act === "remove-product") batches[b].products.splice(p, 1);
    if (act === "add-output") batches[b].products[p].outputs.push(emptyOutput());
    if (act === "remove-output") batches[b].products[p].outputs.splice(o, 1);
    if (act === "copy-prev") return copyPrevious();
    pp.dirty = true;
    renderEditor();
    renderSummary();
    renderSaveState();
  }

  async function copyPrevious() {
    for (let back = 1; back <= 14; back += 1) {
      const date = shiftDate(pp.date, -back);
      const { plan } = await api("GET", null, `&date=${date}`);
      if (plan?.batches?.length) {
        const copy = JSON.parse(JSON.stringify({ batches: plan.batches, note: "" }));
        copy.batches.forEach((batch) => batch.products.forEach((product) => { product.finishedKg = null; }));
        pp.plan = copy;
        pp.dirty = true;
        renderAllPanes();
        say(`Đã chép kế hoạch ngày ${dayText(date)} (bỏ số thành phẩm). Sửa lại rồi bấm Lưu.`);
        return;
      }
    }
    say("Không tìm thấy kế hoạch nào trong 14 ngày trước.", "error");
  }

  // ---------- Sơ đồ ----------
  function node(cls, title, sub = "") {
    return `<div class="pp-node ${cls}"><b>${escapeHtml(title)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</div>`;
  }
  function tree(head, kids) {
    if (!kids.length) return `<div class="pp-row">${head}</div>`;
    return `<div class="pp-row pp-has-kids">${head}<div class="pp-kids">${kids.map((kid) => `<div class="pp-kid">${kid}</div>`).join("")}</div></div>`;
  }
  function customerLabel(text) {
    const match = crmCustomer(text);
    return { title: text || "Chưa ghi khách", sub: match && normalizeVietnamese(match.TenKH) !== normalizeVietnamese(text) ? match.TenKH : "" };
  }

  function batchMap() {
    const batches = pp.plan.batches;
    const kids = batches.map((batch) => {
      const products = batch.products.map((product) => {
        const outs = product.outputs.filter((o) => o.customer || o.qty !== null).map((output) => {
          const who = customerLabel(output.customer);
          const sub = [who.sub, output.pack, output.optional ? "nếu có / nếu dư" : "", output.note].filter(Boolean).join(" · ");
          return node(output.optional ? "pp-maybe" : "pp-give", `${who.title}${qtyText(output) ? ` · ${qtyText(output)}` : ""}`, sub);
        });
        const sub = [product.kgTron !== null && product.kgTron !== undefined ? `soạn ${kg(product.kgTron)} kg bột` : "", product.note,
          product.finishedKg !== null && product.finishedKg !== undefined ? `thành phẩm ${kg(product.finishedKg)} kg` : "chưa cân"].filter(Boolean).join(" · ");
        return tree(node("pp-make", product.name || "Sản phẩm", sub), outs);
      });
      const head = node(`pp-batch pp-group-${batch.group}`, `MẺ ${batch.label} · ${kg(batch.kgTron)} kg ${batch.name}`.toUpperCase(),
        [GROUP_LABEL[batch.group], batch.note].filter(Boolean).join(" · "));
      return tree(head, products);
    });
    return `<div class="pp-map">${tree(node("pp-root", `ĐƠN ${dayText(pp.date)}`, `${batches.length} mẻ · xưởng nhìn theo mẻ`), kids)}</div>`;
  }

  function customerMap() {
    const groups = new Map();
    pp.plan.batches.forEach((batch) => batch.products.forEach((product) => product.outputs.forEach((output) => {
      if (!output.customer && output.qty === null) return;
      const key = normalizeVietnamese(output.customer || "chua ghi khach");
      if (!groups.has(key)) groups.set(key, { text: output.customer, items: [], batches: new Set() });
      const group = groups.get(key);
      group.items.push({ product, output, batch });
      group.batches.add(batch.label);
    })));
    const list = [...groups.values()].sort((a, b) => {
      const optA = a.items.every((i) => i.output.optional);
      const optB = b.items.every((i) => i.output.optional);
      return optA - optB || b.batches.size - a.batches.size;
    });
    const kids = list.map((group) => {
      const who = customerLabel(group.text);
      const match = crmCustomer(group.text);
      const allOptional = group.items.every((i) => i.output.optional);
      const hot = !allOptional && group.batches.size >= 3;
      const sub = [who.sub, `${group.items.length} món`, match?.NhaXeMacDinh ? `nhà xe ${match.NhaXeMacDinh}` : "",
        group.batches.size > 1 ? `lấy từ ${group.batches.size} mẻ${hot ? " · dễ sót, soạn trước" : ""}` : ""].filter(Boolean).join(" · ");
      const items = group.items.map(({ product, output, batch }) => node(
        output.optional ? "pp-maybe" : "pp-give",
        `${product.name}${qtyText(output) ? ` · ${qtyText(output)}` : ""}`,
        [output.pack, `mẻ ${batch.label}`, output.optional ? "nếu có / nếu dư" : "", output.note].filter(Boolean).join(" · "),
      ));
      return tree(node(allOptional ? "pp-maybe pp-customer" : `pp-customer${hot ? " pp-hot" : ""}`, who.title.toUpperCase(), sub), items);
    });
    return `<div class="pp-map">${tree(node("pp-root", `SOẠN HÀNG ${dayText(pp.date)}`, "theo từng khách"), kids)}</div>`;
  }

  function mapFooter() {
    const sum = summarize(pp.plan);
    const part = (label, b) => `${label}: thành phẩm ${kg(b.thanhPham)} kg${b.chuaCan ? ` (⏳ ${b.chuaCan} chưa cân)` : ""} · trộn ${kg(b.tron)} kg`;
    return `<p class="pp-map-foot">${part("DA", sum.DA)}  |  ${part("MÌ", sum.MI)}</p>`;
  }

  function renderMaps() {
    const empty = !pp.plan.batches.length;
    $("#ppByBatch").innerHTML = empty ? `<section class="pp-card pp-empty"><p>Chưa có mẻ nào.</p></section>`
      : `<section class="pp-map-wrap">${batchMap()}${mapFooter()}</section>`;
    $("#ppByCustomer").innerHTML = empty ? `<section class="pp-card pp-empty"><p>Chưa có mẻ nào.</p></section>`
      : `<section class="pp-map-wrap">${customerMap()}${mapFooter()}</section>`;
  }

  // ---------- Sổ sản lượng ----------
  async function renderLedger() {
    $("#ppLedger").innerHTML = `<section class="pp-card"><p>Đang tải sổ sản lượng…</p></section>`;
    try {
      const { days } = await api("GET", null, "&action=summary");
      const cell = (b) => `${kg(b.thanhPham)}${b.chuaCan ? ` <small class="pp-wait">⏳ ${b.chuaCan} chưa cân</small>` : ""}`;
      const rev = (d) => (d.revenue ? `${money.format(d.revenue.total)} <small>${d.revenue.orderCount} đơn</small>` : "");
      const rows = days.map((d) => `<tr><td data-l="Ngày"><b>${dayText(d.date)}</b> <small>${escapeHtml(d.date.slice(0, 4))}</small></td><td data-l="Số mẻ">${d.batchCount}</td><td data-l="DA thành phẩm">${cell(d.DA)}</td><td data-l="MÌ thành phẩm">${cell(d.MI)}</td><td data-l="DA trộn">${kg(d.DA.tron)}</td><td data-l="MÌ trộn">${kg(d.MI.tron)}</td><td data-l="Doanh thu">${rev(d)}</td></tr>`).join("");
      $("#ppLedger").innerHTML = `<section class="pp-card">
        <div class="section-head"><div><h2>Sổ sản lượng theo ngày</h2>
        <p>Tính theo <b>thành phẩm</b> (kg cân thật). DA = cảo dày, cảo mỏng, cảo thường, hoành thánh. MÌ = mì dẹp, mì sợi nhỏ, mì lớn. Số trộn chỉ để đối chiếu.</p></div></div>
        <div class="table-wrap"><table class="pp-ledger"><thead><tr><th>Ngày</th><th>Số mẻ</th><th>DA thành phẩm (kg)</th><th>MÌ thành phẩm (kg)</th><th>DA trộn</th><th>MÌ trộn</th><th>Doanh thu</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="7">Chưa có ngày nào.</td></tr>`}</tbody></table></div></section>`;
    } catch (error) {
      $("#ppLedger").innerHTML = `<section class="pp-card"><p class="notice show error">${escapeHtml(error.message)}</p></section>`;
    }
  }

  // ---------- Khung chung ----------
  function renderSaveState() {
    $("#ppSave").textContent = pp.dirty ? "Lưu kế hoạch" : "✓ Đã lưu";
    $("#ppSave").classList.toggle("is-dirty", pp.dirty);
    $("#ppSave").disabled = !pp.dirty;
  }

  function renderDateLabel() {
    const weekday = new Date(`${pp.date}T00:00:00`).toLocaleDateString("vi-VN", { weekday: "long" });
    const today = pp.date === todayInVietnam();
    const day = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    $("#ppDateLabel").innerHTML = `<small>${today ? "Hôm nay · " : ""}${escapeHtml(day)}</small><span>${dayText(pp.date)}/${pp.date.slice(0, 4)}</span>`;
  }

  function renderTabs() {
    $$("[data-pp-tab]").forEach((button) => button.classList.toggle("active", button.dataset.ppTab === pp.tab));
    const panes = { edit: "#ppEdit", batch: "#ppByBatch", customer: "#ppByCustomer", ledger: "#ppLedger" };
    Object.entries(panes).forEach(([tab, sel]) => $(sel).classList.toggle("hidden", tab !== pp.tab));
    $("#ppSummary").classList.toggle("hidden", pp.tab === "ledger");
  }

  function renderAllPanes() {
    renderDateLabel();
    renderEditor();
    renderMaps();
    renderSummary();
    renderSaveState();
    renderTabs();
  }

  function fillLists() {
    $("#ppCustomerList").innerHTML = [...state.customers].sort((a, b) => String(a.MaKH).localeCompare(String(b.MaKH)))
      .map((c) => `<option value="${escapeHtml(c.MaKH)}">${escapeHtml(c.TenKH)}</option>`).join("");
    $("#ppProductList").innerHTML = PRODUCT_NAMES.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
  }

  async function load(date) {
    if (pp.dirty && !confirm("Kế hoạch đang sửa chưa lưu. Bỏ thay đổi?")) {
      $("#ppDate").value = pp.date;
      return;
    }
    pp.date = date;
    $("#ppDate").value = date;
    renderDateLabel();
    pp.loading = true;
    try {
      const { plan, revenue } = await api("GET", null, `&date=${date}`);
      pp.plan = plan ? { batches: plan.batches || [], note: plan.note || "" } : emptyPlan();
      pp.revenue = revenue;
      pp.dirty = false;
      pp.unit = state.businessUnit;
      $("#ppNotice").className = "notice";
      renderAllPanes();
    } catch (error) {
      say(error.message, "error");
    } finally {
      pp.loading = false;
    }
  }

  async function save() {
    const button = $("#ppSave");
    button.disabled = true;
    button.textContent = "Đang lưu…";
    try {
      const { plan } = await api("PUT", { date: pp.date, batches: pp.plan.batches, note: pp.plan.note });
      pp.plan = { batches: plan.batches, note: plan.note };
      pp.dirty = false;
      renderAllPanes();
      say(`Đã lưu kế hoạch ngày ${dayText(pp.date)}.`);
    } catch (error) {
      say(error.message, "error");
      renderSaveState();
    }
  }

  function print() {
    renderMaps();
    const area = $("#ppPrintArea");
    area.innerHTML = `
      <div class="pp-print-page"><h1>XƯỞNG SẢN XUẤT · ĐƠN ${dayText(pp.date)}</h1>${batchMap()}${mapFooter()}</div>
      <div class="pp-print-page"><h1>ĐÓNG HÀNG THEO KHÁCH · ${dayText(pp.date)}</h1>${customerMap()}${mapFooter()}</div>`;
    document.body.classList.add("pp-printing");
    window.addEventListener("afterprint", () => document.body.classList.remove("pp-printing"), { once: true });
    window.print();
  }

  function openView() {
    fillLists();
    if (!pp.date) pp.date = todayInVietnam();
    if (!pp.plan || pp.unit !== state.businessUnit) {
      pp.dirty = false;
      load(pp.date);
    } else renderAllPanes();
  }


  // ---------- Nói thay gõ ----------
  // Bấm 🎤 là mở phiên nói: nghe → AI xếp vào kế hoạch → đọc lại → tự nghe tiếp. Nói "ok" thì lưu.
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder) && window.isSecureContext;
  const talk = { on: false, busy: false, history: [], recognizer: null, recorder: null, empties: 0 };

  function bubble(role, html) {
    const log = $("#ppTalkLog");
    log.insertAdjacentHTML("beforeend", `<div class="pp-bubble ${role}">${html}</div>`);
    while (log.children.length > 6) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  function speakOut(text) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis || !text) return resolve();
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "vi-VN";
      const voice = window.speechSynthesis.getVoices().find((item) => /^vi/i.test(item.lang));
      if (voice) utterance.voice = voice;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      utterance.onend = finish;
      utterance.onerror = finish;
      setTimeout(finish, Math.min(60000, 1500 + text.length * 90));
      window.speechSynthesis.speak(utterance);
    });
  }

  function setMic(stateName) {
    const button = $("#ppMic");
    button.dataset.state = stateName;
    button.querySelector("b").textContent = { idle: "Nói", listening: "Đang nghe… bấm để dừng", thinking: "Đang hiểu…", speaking: "Đang đọc lại…" }[stateName] || "Nói";
  }

  function listenOnceChrome() {
    return new Promise((resolve, reject) => {
      const recognizer = new Recognition();
      talk.recognizer = recognizer;
      recognizer.lang = "vi-VN";
      recognizer.interimResults = false;
      recognizer.continuous = false;
      let text = "";
      recognizer.onresult = (event) => { text = [...event.results].map((result) => result[0].transcript).join(" "); };
      recognizer.onerror = (event) => (event.error === "no-speech" || event.error === "aborted" ? resolve("") : reject(new Error(event.error)));
      recognizer.onend = () => resolve(text.trim());
      recognizer.start();
    });
  }

  async function toWav16k(blob) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    ctx.close();
    const rate = 16000;
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const samples = (await offline.startRendering()).getChannelData(0);
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const put = (offset, text) => { for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i)); };
    put(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); put(8, "WAVE"); put(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    put(36, "data"); view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, index) => {
      const value = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    });
    let binary = "";
    new Uint8Array(buffer).forEach((byte) => { binary += String.fromCharCode(byte); });
    return { data: btoa(binary), seconds: decoded.duration };
  }

  // Máy không có nhận giọng của trình duyệt (vd Safari cũ): ghi âm, tự dừng khi im 1,6 giây, rồi nhờ AI chép lời.
  async function listenOnceRecord() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const recorder = new MediaRecorder(stream);
    talk.recorder = recorder;
    const chunks = [];
    const actx = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = actx.createAnalyser();
    actx.createMediaStreamSource(stream).connect(analyser);
    const levels = new Uint8Array(analyser.fftSize);
    const started = Date.now();
    let heard = false;
    let quiet = 0;
    const blob = await new Promise((resolve) => {
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
      recorder.start();
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(levels);
        const rms = Math.sqrt(levels.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / levels.length);
        if (rms > 0.035) { heard = true; quiet = 0; } else if (heard && !quiet) quiet = Date.now();
        if ((heard && quiet && Date.now() - quiet > 1600) || (!heard && Date.now() - started > 12000) || Date.now() - started > 60000 || recorder.state !== "recording") {
          clearInterval(timer);
          if (recorder.state === "recording") recorder.stop();
        }
      }, 120);
    });
    stream.getTracks().forEach((track) => track.stop());
    actx.close();
    talk.recorder = null;
    if (!heard) return "";
    const wav = await toWav16k(blob);
    const response = await fetchWithTimeout(`/api/giong-noi?businessUnit=${state.businessUnit}`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ businessUnit: state.businessUnit, action: "transcribe", audio: { data: wav.data, format: "wav" }, seconds: wav.seconds, date: pp.date }),
    }, 70000);
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || "AI chưa chép được lời nói.");
    return String(data.text || "").trim();
  }

  async function understand(text) {
    bubble("me", escapeHtml(text));
    talk.history.push({ role: "me", text });
    setMic("thinking");
    const data = await api("POST", { action: "voice", text, date: pp.date, plan: pp.plan, history: talk.history });
    if (data.command !== "huy") {
      pp.plan = { batches: data.plan.batches, note: pp.plan.note || "" };
      pp.dirty = true;
    }
    const speech = data.speech || data.question || "Tôi chưa hiểu, bạn nói lại giúp tôi.";
    talk.history.push({ role: "ai", text: speech });
    bubble("ai", escapeHtml(speech));
    if (data.command === "huy") {
      pp.dirty = false;
      await load(pp.date);
    } else renderAllPanes();
    setMic("speaking");
    await speakOut(speech);
    if (data.command === "luu") {
      await save();
      bubble("ai", "✓ Đã lưu kế hoạch.");
      await speakOut("Đã lưu.");
      stopTalk();
    }
  }

  async function talkLoop() {
    while (talk.on) {
      setMic("listening");
      let text = "";
      try {
        text = Recognition ? await listenOnceChrome() : await listenOnceRecord();
      } catch (error) {
        bubble("ai", `⚠ Micro báo lỗi: ${escapeHtml(error.message)}`);
        stopTalk();
        return;
      }
      if (!talk.on) return;
      if (!text) {
        talk.empties += 1;
        if (talk.empties >= 2) { bubble("ai", "Tôi không nghe thấy gì nên tạm dừng. Bấm 🎤 để nói tiếp."); stopTalk(); return; }
        continue;
      }
      talk.empties = 0;
      try {
        await understand(text);
      } catch (error) {
        bubble("ai", `⚠ ${escapeHtml(error.message)}`);
        await speakOut("Có lỗi, bạn nói lại giúp tôi.");
      }
    }
  }

  function stopTalk() {
    talk.on = false;
    try { talk.recognizer?.stop(); } catch { /* đã dừng */ }
    if (talk.recorder?.state === "recording") talk.recorder.stop();
    window.speechSynthesis?.cancel();
    setMic("idle");
  }

  function micReady() {
    return (Recognition && window.isSecureContext) || canRecord;
  }

  $("#ppMic").addEventListener("click", () => {
    if (talk.on) return stopTalk();
    if (!micReady()) {
      $("#ppTypeForm").classList.remove("hidden");
      bubble("ai", "Máy này chưa cho dùng micro (cần mở bằng https hoặc ngay trên máy chủ). Tạm gõ câu nói vào ô bên dưới, tôi hiểu y như nói.");
      $("#ppTypeInput").focus();
      return;
    }
    if (pp.tab !== "edit" && pp.tab !== "batch") { pp.tab = "batch"; renderMaps(); renderTabs(); }
    talk.on = true;
    talk.empties = 0;
    talkLoop();
  });
  $("#ppTypeForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("#ppTypeInput").value.trim();
    if (!text) return;
    $("#ppTypeInput").value = "";
    try { await understand(text); } catch (error) { bubble("ai", `⚠ ${escapeHtml(error.message)}`); }
    setMic("idle");
  });
  setMic("idle");

  $("#ppDate").addEventListener("change", (event) => event.target.value && load(event.target.value));
  $("#ppPrev").addEventListener("click", () => load(shiftDate(pp.date || todayInVietnam(), -1)));
  $("#ppNext").addEventListener("click", () => load(shiftDate(pp.date || todayInVietnam(), 1)));
  $("#ppSave").addEventListener("click", save);
  $("#ppPrint").addEventListener("click", print);
  $$("[data-pp-tab]").forEach((button) => button.addEventListener("click", () => {
    pp.tab = button.dataset.ppTab;
    if (pp.tab === "ledger") renderLedger();
    else renderMaps();
    renderTabs();
  }));
  $("#ppEdit").addEventListener("input", onEdit);
  $("#ppEdit").addEventListener("change", onEdit);
  $("#productionPlanView").addEventListener("click", onAction);
  window.addEventListener("beforeunload", (event) => {
    if (pp.dirty) event.preventDefault();
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest('[data-view="productionPlan"]')) setTimeout(openView, 0);
  });

  // Đổi xưởng thì tải lại kế hoạch của xưởng mới.
  const originalRenderAll = renderAll;
  renderAll = function renderAllWithProductionPlan(...args) {
    originalRenderAll(...args);
    if ($("#productionPlanView").classList.contains("active") && pp.unit !== state.businessUnit) {
      pp.dirty = false;
      openView();
    }
  };
})();
