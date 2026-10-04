// Sao kê gửi khách (Xưởng Phở). Màn riêng, chỉ đọc sổ: không sửa đơn, không sửa bảng quản lý.
// Phần tính số (SaoKeCore) là hàm thuần để chạy được cả trong trình duyệt lẫn trong test Node.
(function (root) {
  const KG_PER_CAY = 5;

  function addDays(isoDate, days) {
    const [year, month, day] = isoDate.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + days));
    return date.toISOString().slice(0, 10);
  }

  const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  const toNumber = (value) => Number(value || 0) || 0;

  function orderTotal(order) {
    if (order.total !== undefined && order.total !== null) return toNumber(order.total);
    return toNumber(order.subtotal) + toNumber(order.taxAmount) + toNumber(order.advance);
  }

  function phoSoiCay(order) {
    if (order.phoSoiUnit === "cay" && toNumber(order.phoSoiInputQuantity) > 0) return toNumber(order.phoSoiInputQuantity);
    return toNumber(order.phoSoiKg) / KG_PER_CAY;
  }

  // Mặc định: từ ngày sau lần thanh toán gần nhất đến hôm nay.
  // Chưa có lần thanh toán nào được ghi thì bắt đầu từ đơn cũ nhất còn nợ (không còn nợ thì từ đơn đầu tiên).
  function defaultRange({ orders = [], payments = [], today }) {
    const paymentDates = payments.map((payment) => payment.date).filter(isIsoDate).sort();
    const lastPayment = paymentDates.at(-1);
    if (lastPayment) {
      const from = addDays(lastPayment, 1);
      return { from: from > today ? today : from, to: today, basis: "after-payment", lastPayment };
    }
    const dated = orders.filter((order) => isIsoDate(order.date));
    const unpaid = dated.filter((order) => toNumber(order.debt) > 0).map((order) => order.date).sort();
    const any = dated.map((order) => order.date).sort();
    const from = unpaid[0] || any[0] || today;
    return { from: from > today ? today : from, to: today, basis: unpaid[0] ? "oldest-debt" : "first-order", lastPayment: "" };
  }

  function fullRange({ orders = [], payments = [], today }) {
    const dates = [...orders.map((order) => order.date), ...payments.map((payment) => payment.date)].filter(isIsoDate).sort();
    const from = dates[0] || today;
    return { from: from > today ? today : from, to: today };
  }

  // Sổ được giữ theo từng đơn (order.paid). Phần đã trả trên đơn mà không có phiếu thanh toán nào phân bổ vào
  // (dữ liệu nhập từ sổ cũ, trả ngay khi giao) được tính là trả đúng ngày của đơn đó.
  // Chênh lệch còn lại giữa phiếu và sổ (phiếu trả dư chưa phân bổ...) đưa vào đầu kỳ,
  // nhờ vậy số CÒN NỢ tính đến hôm nay luôn bằng đúng tổng "Còn lại" của hồ sơ khách.
  function buildStatement({ orders = [], payments = [], from, to }) {
    if (!isIsoDate(from) || !isIsoDate(to)) throw new Error("Khoảng ngày không hợp lệ.");
    if (from > to) [from, to] = [to, from];
    const allocated = new Map();
    payments.forEach((payment) => (payment.allocations || []).forEach((allocation) => {
      const key = String(allocation.orderId);
      allocated.set(key, (allocated.get(key) || 0) + toNumber(allocation.amount));
    }));
    const untrackedPaid = (order) => Math.max(0, toNumber(order.paid) - (allocated.get(String(order.id)) || 0));
    const recordedPaid = payments.reduce((sum, payment) => sum + toNumber(payment.amount), 0);
    const ledgerPaid = orders.reduce((sum, order) => sum + toNumber(order.paid), 0);
    const untrackedTotal = orders.reduce((sum, order) => sum + untrackedPaid(order), 0);

    let opening = recordedPaid + untrackedTotal - ledgerPaid;
    const days = new Map();
    const dayFor = (date) => {
      if (!days.has(date)) {
        days.set(date, { date, phoSoiKg: 0, phoSoiCay: 0, phoCuonKg: 0, otherAmount: 0, tax: 0, advance: 0, amount: 0, paid: 0 });
      }
      return days.get(date);
    };

    orders.forEach((order) => {
      const total = orderTotal(order);
      const paidOnOrder = untrackedPaid(order);
      const date = isIsoDate(order.date) ? order.date : "";
      if (!date || date < from) {
        opening += total - paidOnOrder;
        return;
      }
      if (date > to || (total === 0 && paidOnOrder === 0)) return;
      const day = dayFor(date);
      day.paid += paidOnOrder;
      day.phoSoiKg += toNumber(order.phoSoiKg);
      day.phoSoiCay += phoSoiCay(order);
      day.phoCuonKg += toNumber(order.phoCuonKg);
      day.tax += toNumber(order.taxAmount);
      day.advance += toNumber(order.advance);
      day.amount += total;
      if (!toNumber(order.phoSoiKg) && !toNumber(order.phoCuonKg)) day.otherAmount += total;
    });

    payments.forEach((payment) => {
      const amount = toNumber(payment.amount);
      const date = isIsoDate(payment.date) ? payment.date : "";
      if (!date || date < from) {
        opening -= amount;
        return;
      }
      if (date > to || amount === 0) return;
      const day = dayFor(date);
      day.paid += amount;
    });

    const months = [];
    [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).forEach((day) => {
      const key = day.date.slice(0, 7);
      let month = months.at(-1);
      if (!month || month.key !== key) {
        month = { key, days: [], kg: 0, amount: 0, paid: 0 };
        months.push(month);
      }
      day.kg = day.phoSoiKg + day.phoCuonKg;
      month.days.push(day);
      month.kg += day.kg;
      month.amount += day.amount;
      month.paid += day.paid;
    });

    const goods = months.reduce((sum, month) => sum + month.amount, 0);
    const paid = months.reduce((sum, month) => sum + month.paid, 0);
    return {
      from,
      to,
      opening,
      goods,
      paid,
      closing: opening + goods - paid,
      kg: months.reduce((sum, month) => sum + month.kg, 0),
      months,
    };
  }

  function statementFilename(customerCode, from, to) {
    const code = String(customerCode || "khach")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "khach";
    return `saoke_${code}_${from}_${to}.png`;
  }

  const core = { KG_PER_CAY, addDays, defaultRange, fullRange, buildStatement, statementFilename };
  if (typeof module === "object" && module.exports) {
    module.exports = core;
    return;
  }
  root.SaoKeCore = core;
  if (typeof document !== "undefined") initStatementUi(core);

  // ---------------- Giao diện ----------------
  function initStatementUi(saoKe) {
    const SETTINGS_KEY = "nhapLieuSaoKeSettings:pho";
    const view = { code: "", name: "", orders: [], payments: [], from: "", to: "" };

    const shortDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
    const longDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
    const kgText = (value) => `${number.format(value)}kg`;

    function readSettings() {
      try {
        return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
      } catch {
        return {};
      }
    }

    function writeSettings(settings) {
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
        return true;
      } catch {
        return false;
      }
    }

    function buildDialog() {
      const dialog = document.createElement("dialog");
      dialog.id = "statementDialog";
      dialog.className = "statement-dialog";
      dialog.innerHTML = `
        <div class="statement-toolbar">
          <div class="statement-toolbar-row">
            <strong>Sao kê gửi khách</strong>
            <button id="statementClose" class="icon-button" type="button" aria-label="Đóng">×</button>
          </div>
          <div class="statement-range">
            <label>Từ ngày<input id="statementFrom" type="date" /></label>
            <label>Đến ngày<input id="statementTo" type="date" /></label>
          </div>
          <div class="statement-actions">
            <button id="statementDefault" class="secondary-button" type="button">Từ lần trả gần nhất</button>
            <button id="statementAll" class="secondary-button" type="button">Xem toàn bộ</button>
            <button id="statementPng" class="primary" type="button">Tải hình</button>
            <button id="statementPrint" class="secondary-button" type="button">In / PDF</button>
            <button id="statementSettingsToggle" class="secondary-button" type="button">⚙ Số tài khoản / QR</button>
          </div>
          <form id="statementSettings" class="statement-settings hidden">
            <label>Tên xưởng in trên sao kê<input name="shopName" placeholder="Xưởng Phở" /></label>
            <label>Thông tin chuyển khoản<textarea name="bankText" rows="3" placeholder="Ngân hàng ...&#10;STK: ...&#10;Chủ TK: ..."></textarea></label>
            <label>Ảnh mã QR<input name="qrFile" type="file" accept="image/*" /></label>
            <div class="statement-settings-actions">
              <button id="statementQrRemove" class="text-button" type="button">Bỏ ảnh QR</button>
              <button class="primary" type="submit">Lưu cài đặt</button>
            </div>
            <small>Cài đặt được lưu trên máy này.</small>
          </form>
          <div id="statementNotice" class="notice"></div>
        </div>
        <div class="statement-stage"><div id="statementSheet" class="statement-sheet"></div></div>`;
      document.body.append(dialog);
      return dialog;
    }

    function ensureButton() {
      let button = $("#profileStatement");
      if (button) return button;
      const excel = $("#profileExportExcel");
      if (!excel) return null;
      button = document.createElement("button");
      button.id = "profileStatement";
      button.className = "secondary-button hidden";
      button.type = "button";
      button.textContent = "📄 Sao kê gửi khách";
      excel.after(button);
      return button;
    }

    function syncProfileButton() {
      const button = ensureButton();
      if (!button) return;
      const known = state.customers.some((customer) => customer.MaKH === state.profileCustomerCode);
      button.classList.toggle("hidden", state.businessUnit !== "pho" || !state.profileCustomerCode || !known);
    }

    function loadCustomerData() {
      const customer = state.customers.find((item) => item.MaKH === view.code);
      view.name = customer?.TenKH || state.profileCustomerName;
      const key = normalizeVietnamese(view.name.trim());
      view.orders = state.orders.filter((order) => normalizeVietnamese(String(order.customerName || "").trim()) === key);
      view.payments = paymentHistory().filter((payment) => payment.customerCode === view.code);
    }

    function dayItemsText(day) {
      const parts = [];
      if (day.phoSoiKg) parts.push(`Phở sợi ${number.format(day.phoSoiCay)} cây · ${kgText(day.phoSoiKg)}`);
      if (day.phoCuonKg) parts.push(`Phở cuốn ${kgText(day.phoCuonKg)}`);
      if (!parts.length && day.otherAmount) parts.push("Hàng khác");
      const extras = [];
      if (day.tax) extras.push(`thuế ${money.format(day.tax)}`);
      if (day.advance) extras.push(`ứng xe ${money.format(day.advance)}`);
      return parts.join(" + ") + (extras.length ? ` (gồm ${extras.join(", ")})` : "");
    }

    function renderSheet() {
      const data = saoKe.buildStatement({ orders: view.orders, payments: view.payments, from: view.from, to: view.to });
      view.from = data.from;
      view.to = data.to;
      $("#statementFrom").value = data.from;
      $("#statementTo").value = data.to;
      const settings = readSettings();
      const shopName = settings.shopName || currentUnit().name;
      const rows = data.months.map((month) => {
        const [year, monthNumber] = month.key.split("-");
        const dayRows = month.days.map((day) => [
          day.amount ? `<div class="sk-row"><span class="sk-date">${shortDate(day.date)}</span><span class="sk-item">${escapeHtml(dayItemsText(day))}</span><span class="sk-amount">${money.format(day.amount)}</span></div>` : "",
          day.paid ? `<div class="sk-row sk-paid"><span class="sk-date">${shortDate(day.date)}</span><span class="sk-item">Đã trả</span><span class="sk-amount">−${money.format(day.paid)}</span></div>` : "",
        ].join("")).join("");
        return `<section class="sk-month">
          <div class="sk-month-title">Tháng ${monthNumber}/${year}</div>
          ${dayRows}
          <div class="sk-month-total"><span>Cộng tháng ${Number(monthNumber)}</span><span>${kgText(month.kg)}</span><span>${money.format(month.amount)}</span></div>
        </section>`;
      }).join("");
      const openingRow = data.opening !== 0
        ? `<div class="sk-sum"><span>${data.opening > 0 ? "Nợ kỳ trước chuyển sang" : "Trả dư kỳ trước"}</span><strong>${money.format(Math.abs(data.opening))}</strong></div>`
        : "";
      const bankText = String(settings.bankText || "").trim();
      const payBlock = bankText || settings.qrDataUrl
        ? `<div class="sk-pay">${bankText ? `<div class="sk-bank">${escapeHtml(bankText)}</div>` : ""}${settings.qrDataUrl ? `<img class="sk-qr" alt="Mã QR chuyển khoản" src="${escapeHtml(settings.qrDataUrl)}" />` : ""}</div>`
        : '<div class="sk-pay sk-pay-empty">Chưa có số tài khoản / QR. Mở "⚙ Số tài khoản / QR" để thêm.</div>';
      $("#statementSheet").innerHTML = `
        <header class="sk-head">
          <div class="sk-shop">${escapeHtml(shopName)}</div>
          <div class="sk-title">SAO KÊ CÔNG NỢ</div>
          <div class="sk-customer">${escapeHtml(view.name)}</div>
          <div class="sk-range">Từ ${longDate(data.from)} đến ${longDate(data.to)}</div>
          <div class="sk-debt-label">${data.closing >= 0 ? "CÒN NỢ" : "TRẢ DƯ"}</div>
          <div class="sk-debt">${money.format(Math.abs(data.closing))}</div>
          ${data.opening > 0 ? `<div class="sk-debt-note">gồm nợ kỳ trước ${money.format(data.opening)}</div>` : ""}
        </header>
        <div class="sk-body">${rows || '<div class="sk-empty">Không có giao dịch trong khoảng ngày này.</div>'}</div>
        <footer class="sk-foot">
          ${openingRow}
          <div class="sk-sum"><span>Tổng tiền hàng</span><strong>${money.format(data.goods)}</strong></div>
          <div class="sk-sum sk-sum-paid"><span>Đã thanh toán</span><strong>${money.format(data.paid)}</strong></div>
          <div class="sk-sum sk-sum-debt"><span>${data.closing >= 0 ? "Còn nợ" : "Trả dư"}</span><strong>${money.format(Math.abs(data.closing))}</strong></div>
          ${payBlock}
        </footer>`;
    }

    // Màn hình hẹp hơn 420px (điện thoại) thì thu nhỏ bản xem trước cho vừa; hình tải về vẫn đúng 420px.
    function fitSheet() {
      const sheet = $("#statementSheet");
      const available = $(".statement-stage").clientWidth;
      sheet.style.zoom = available && available < 420 ? String(available / 420) : "";
    }

    function setRange(range) {
      view.from = range.from;
      view.to = range.to;
      renderSheet();
    }

    function open() {
      view.code = state.profileCustomerCode;
      if (!view.code) return;
      loadCustomerData();
      $("#statementNotice").className = "notice";
      $("#statementSettings").classList.add("hidden");
      setRange(saoKe.defaultRange({ orders: view.orders, payments: view.payments, today: todayInVietnam() }));
      if (!dialog.open) dialog.showModal();
      fitSheet();
    }

    let html2canvasLoading = null;
    function loadHtml2canvas() {
      if (window.html2canvas) return Promise.resolve(window.html2canvas);
      html2canvasLoading ||= new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/vendor/html2canvas.min.js";
        script.onload = () => (window.html2canvas ? resolve(window.html2canvas) : reject(new Error("Không tải được thư viện xuất hình.")));
        script.onerror = () => {
          html2canvasLoading = null;
          reject(new Error("Không tải được thư viện xuất hình."));
        };
        document.head.append(script);
      });
      return html2canvasLoading;
    }

    async function downloadPng(button) {
      const original = button.textContent;
      button.disabled = true;
      button.textContent = "Đang tạo hình...";
      try {
        const html2canvas = await loadHtml2canvas();
        const sheet = $("#statementSheet");
        // Canvas trình duyệt giới hạn khoảng 32.000px chiều cao: sao kê rất dài thì giảm độ nét cho vừa.
        const scale = Math.max(1, Math.min(2, 30000 / Math.max(1, sheet.scrollHeight)));
        const canvas = await html2canvas(sheet, {
          scale,
          backgroundColor: "#ffffff",
          logging: false,
          onclone: (clonedDocument) => {
            const clonedSheet = clonedDocument.getElementById("statementSheet");
            const body = clonedDocument.body;
            [...body.children].forEach((child) => { child.style.display = "none"; });
            body.style.margin = "0";
            body.style.background = "#ffffff";
            body.append(clonedSheet);
            clonedSheet.style.display = "block";
            clonedSheet.style.zoom = "1";
            clonedSheet.style.margin = "0";
            clonedSheet.style.boxShadow = "none";
          },
        });
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("Sao kê quá dài để xuất một hình. Hãy chọn khoảng ngày ngắn hơn.");
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = saoKe.statementFilename(view.code, view.from, view.to);
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        notice($("#statementNotice"), `Đã tải ${link.download}`);
      } catch (error) {
        notice($("#statementNotice"), error.message || "Không xuất được hình.", "error");
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    }

    function printStatement() {
      document.body.classList.add("statement-printing");
      const cleanup = () => document.body.classList.remove("statement-printing");
      window.addEventListener("afterprint", cleanup, { once: true });
      window.print();
    }

    function fillSettingsForm() {
      const form = $("#statementSettings");
      const settings = readSettings();
      form.elements.shopName.value = settings.shopName || "";
      form.elements.bankText.value = settings.bankText || "";
      form.elements.qrFile.value = "";
    }

    function readQrFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Không đọc được ảnh QR."));
        reader.onload = () => {
          const image = new Image();
          image.onerror = () => reject(new Error("File chọn không phải ảnh."));
          image.onload = () => {
            const size = Math.min(480, Math.max(image.width, image.height));
            const ratio = size / Math.max(image.width, image.height);
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(image.width * ratio);
            canvas.height = Math.round(image.height * ratio);
            const context = canvas.getContext("2d");
            context.fillStyle = "#fff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL("image/png"));
          };
          image.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    }

    async function saveSettings(event) {
      event.preventDefault();
      const form = event.currentTarget;
      const settings = readSettings();
      settings.shopName = form.elements.shopName.value.trim();
      settings.bankText = form.elements.bankText.value.trim();
      try {
        const file = form.elements.qrFile.files?.[0];
        if (file) settings.qrDataUrl = await readQrFile(file);
        if (!writeSettings(settings)) throw new Error("Không lưu được cài đặt trên trình duyệt này.");
        form.classList.add("hidden");
        notice($("#statementNotice"), "Đã lưu cài đặt sao kê.");
        renderSheet();
      } catch (error) {
        notice($("#statementNotice"), error.message, "error");
      }
    }

    const dialog = buildDialog();
    ensureButton();

    document.addEventListener("click", (event) => {
      if (event.target.closest("#profileStatement")) open();
    });
    $("#statementClose").addEventListener("click", () => dialog.close());
    window.addEventListener("resize", () => { if (dialog.open) fitSheet(); });
    $("#statementDefault").addEventListener("click", () => setRange(saoKe.defaultRange({ orders: view.orders, payments: view.payments, today: todayInVietnam() })));
    $("#statementAll").addEventListener("click", () => setRange(saoKe.fullRange({ orders: view.orders, payments: view.payments, today: todayInVietnam() })));
    ["#statementFrom", "#statementTo"].forEach((selector) => {
      $(selector).addEventListener("change", () => {
        const from = $("#statementFrom").value;
        const to = $("#statementTo").value;
        if (from && to) setRange({ from, to });
      });
    });
    $("#statementPng").addEventListener("click", (event) => downloadPng(event.currentTarget));
    $("#statementPrint").addEventListener("click", printStatement);
    $("#statementSettingsToggle").addEventListener("click", () => {
      const form = $("#statementSettings");
      if (form.classList.contains("hidden")) fillSettingsForm();
      form.classList.toggle("hidden");
    });
    $("#statementSettings").addEventListener("submit", saveSettings);
    $("#statementQrRemove").addEventListener("click", () => {
      const settings = readSettings();
      delete settings.qrDataUrl;
      writeSettings(settings);
      $("#statementSettings").elements.qrFile.value = "";
      notice($("#statementNotice"), "Đã bỏ ảnh QR.");
      renderSheet();
    });

    root.saoKeUi = { syncProfileButton };
  }
})(typeof window !== "undefined" ? window : globalThis);
