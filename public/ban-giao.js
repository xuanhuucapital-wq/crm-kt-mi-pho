// Nhập liệu từ ảnh bàn giao của shipper. Dùng lại các hàm chung của app.js ($, state, notice, authHeaders...).
(() => {
  const API = "/api/ban-giao";
  const MAX_SEND_BYTES = 3 * 1024 * 1024; // Ảnh lớn hơn sẽ được nén để vừa giới hạn máy chủ.
  const bg = {
    selected: "", rows: [], pending: [], busy: false, unit: state.businessUnit,
    confirmDuplicates: false, aiDate: "", pageCash: 0, settings: null, models: [], modelsUpdatedAt: "",
    aliases: { builtin: [], learned: [] }, pickers: {}, runModel: "", defaultModelChoice: "",
  };
  const isPho = () => state.businessUnit === "pho";
  const SAVE_TEXT = "Cập nhật vào sổ";

  const productColumns = () => (isPho()
    ? [{ field: "phoSoiKg", label: "Phở sợi" }, { field: "phoCuonKg", label: "Phở cuốn (kg)" }]
    : [
      { field: "miKg", label: "Mì (kg)" },
      { field: "caoKg", label: "Da cảo (kg)" },
      { field: "hoanhKg", label: "Da hoành (kg)" },
      { field: "huTieu", label: "Hủ tiếu" },
      { field: "voBanhGoi", label: "Vỏ bánh gối" },
      { field: "thungXop", label: "Thùng xốp" },
    ]);

  async function api(method, body, query = "") {
    const url = `${API}?businessUnit=${state.businessUnit}${query}`;
    const response = await fetchWithTimeout(url, {
      method,
      headers: authHeaders(body ? { "content-type": "application/json" } : {}),
      body: body ? JSON.stringify({ businessUnit: state.businessUnit, ...body }) : undefined,
    }, 70000);
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || `Máy chủ báo lỗi (HTTP ${response.status}).`);
    return data;
  }

  const imageUrl = (name) => `${API}?action=image&name=${encodeURIComponent(name)}`;
  const sizeText = (bytes) => (bytes >= 1048576 ? `${number.format(bytes / 1048576)} MB` : `${number.format(Math.ceil(bytes / 1024))} KB`);
  const customerName = (code) => customerForCode(code)?.TenKH || code;

  // ---------- Bộ chọn model dạng mục lục ----------
  function createModelPicker(container, { onSelect, placeholder }) {
    const picker = { value: "", open: false, query: "" };
    container.innerHTML = `
      <button type="button" class="bg-picker-toggle"><span><span data-label>${escapeHtml(placeholder)}</span><small data-sub></small></span><b>▾</b></button>
      <div class="bg-picker-panel hidden">
        <input type="search" placeholder="Tìm model, hoặc gõ tên đầy đủ rồi Enter" data-search />
        <div data-list></div>
      </div>`;
    const toggle = container.querySelector(".bg-picker-toggle");
    const panel = container.querySelector(".bg-picker-panel");
    const search = container.querySelector("[data-search]");
    const list = container.querySelector("[data-list]");

    function describe(id) {
      const model = bg.models.find((item) => item.id === id);
      if (!model) return id ? "Model gõ tay" : "";
      return `${model.recommended ? "★ " : ""}$${model.promptPrice} / $${model.completionPrice} mỗi 1 triệu token${model.note ? ` · ${model.note}` : ""}`;
    }
    function item(model) {
      return `<button type="button" class="bg-picker-item${model.id === picker.value ? " active" : ""}" data-model="${escapeHtml(model.id)}">
        <strong>${model.recommended ? "★ " : ""}${escapeHtml(model.id)}</strong>
        <small>vào $${model.promptPrice} · ra $${model.completionPrice} / 1 triệu token${model.note ? ` — ${escapeHtml(model.note)}` : ""}</small></button>`;
    }
    function renderList() {
      const query = picker.query.trim().toLowerCase();
      const models = bg.models.filter((model) => !query || model.id.toLowerCase().includes(query) || String(model.name).toLowerCase().includes(query));
      const groups = [];
      const recommended = models.filter((model) => model.recommended);
      if (recommended.length) groups.push({ title: "★ Gợi ý cho chữ viết tay", items: recommended, open: true });
      const byProvider = new Map();
      models.filter((model) => !model.recommended).forEach((model) => {
        const key = model.providerName || model.provider || "Khác";
        if (!byProvider.has(key)) byProvider.set(key, []);
        byProvider.get(key).push(model);
      });
      [...byProvider.entries()].sort((x, y) => y[1].length - x[1].length)
        .forEach(([title, items]) => groups.push({ title, items, open: Boolean(query) }));
      const custom = query && !bg.models.some((model) => model.id.toLowerCase() === query) && /^[\w.~-]+\/[\w.:-]+$/.test(query)
        ? `<div class="bg-picker-custom">Enter để dùng model gõ tay: <strong>${escapeHtml(query)}</strong></div>` : "";
      list.innerHTML = custom + (groups.map((group) => `
        <details class="bg-picker-group"${group.open ? " open" : ""}>
          <summary><strong>${escapeHtml(group.title)}</strong><span>${group.items.length}</span></summary>
          ${group.items.map(item).join("")}
        </details>`).join("") || '<div class="bg-picker-custom">Không có model khớp. Bấm "Cập nhật danh sách model" trong Cài đặt AI.</div>');
    }
    function setOpen(open) {
      picker.open = open;
      panel.classList.toggle("hidden", !open);
      if (open) {
        renderList();
        search.focus();
      }
    }
    picker.set = (value) => {
      picker.value = value || "";
      container.querySelector("[data-label]").textContent = picker.value || placeholder;
      container.querySelector("[data-sub]").textContent = describe(picker.value);
      if (picker.open) renderList();
    };
    picker.refresh = () => picker.set(picker.value);
    const choose = (value) => {
      picker.set(value);
      setOpen(false);
      onSelect(value);
    };
    toggle.addEventListener("click", () => setOpen(!picker.open));
    search.addEventListener("input", () => { picker.query = search.value; renderList(); });
    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key !== "Enter") return;
      event.preventDefault();
      const query = search.value.trim();
      const exact = bg.models.find((model) => model.id.toLowerCase() === query.toLowerCase());
      const first = list.querySelector("[data-model]");
      if (exact) choose(exact.id);
      else if (/^[\w.~-]+\/[\w.:-]+$/.test(query)) choose(query);
      else if (first) choose(first.dataset.model);
    });
    list.addEventListener("click", (event) => {
      const button = event.target.closest("[data-model]");
      if (button) choose(button.dataset.model);
    });
    document.addEventListener("click", (event) => {
      if (picker.open && !container.contains(event.target)) setOpen(false);
    });
    return picker;
  }

  bg.pickers.defaultModel = createModelPicker($("#bgModelPickerDefault"), {
    placeholder: "Chọn model mặc định",
    onSelect: (value) => { bg.defaultModelChoice = value; },
  });
  bg.pickers.run = createModelPicker($("#bgModelPickerRun"), {
    placeholder: "Model mặc định",
    onSelect: (value) => { bg.runModel = value; },
  });

  // ---------- Cài đặt khóa AI + model ----------
  async function loadSettings() {
    const chip = $("#bgAiStatus");
    try {
      const data = await api("GET", null, "&action=settings");
      const previousModel = bg.settings?.model || "";
      bg.settings = data;
      chip.className = `bg-chip ${data.configured ? "ok" : "warn"}`;
      chip.textContent = data.configured ? `🔒 Đã có khóa · ${data.model}` : "Chưa có khóa OpenRouter";
      $("#bgKeyForm").querySelector("button").disabled = !data.canWriteEnvFile;
      $("#bgSaveModel").disabled = !data.canWriteEnvFile;
      if (!data.canWriteEnvFile) {
        notice($("#bgSettingsResult"), "Máy chủ này không ghi được file .env (ví dụ bản trên Vercel). Hãy đặt OPENROUTER_API_KEY trong phần biến môi trường của hosting.", "error");
      }
      if (!data.configured) $("#bgSettings").classList.remove("hidden");
      // Chỉ đổi ô chọn khi anh chưa chọn model khác mà chưa lưu.
      if (!bg.defaultModelChoice || bg.defaultModelChoice === previousModel) {
        bg.defaultModelChoice = data.model;
        bg.pickers.defaultModel.set(data.model);
      }
      if (!bg.runModel) bg.pickers.run.set(data.model);
    } catch (error) {
      chip.className = "bg-chip warn";
      chip.textContent = "Không kiểm tra được khóa AI";
    }
  }

  async function loadModels(refresh = false) {
    const button = $("#bgRefreshModels");
    button.disabled = true;
    try {
      const data = await api("GET", null, `&action=models${refresh ? "&refresh=1" : ""}`);
      bg.models = data.models || [];
      bg.modelsUpdatedAt = data.updatedAt || "";
      const when = bg.modelsUpdatedAt ? new Date(bg.modelsUpdatedAt).toLocaleString("vi-VN") : "chưa rõ";
      $("#bgModelInfo").textContent = `${number.format(bg.models.length)} model đọc được ảnh · danh sách lưu lúc ${when}${data.warning ? ` · ${data.warning}` : ""}. Tự cập nhật mỗi ngày.`;
      if (refresh) notice($("#bgSettingsResult"), data.warning || `Đã cập nhật ${number.format(bg.models.length)} model từ OpenRouter.`, data.warning ? "error" : "ok");
    } catch (error) {
      $("#bgModelInfo").textContent = error.message;
      if (refresh) notice($("#bgSettingsResult"), error.message, "error");
    } finally {
      button.disabled = false;
      Object.values(bg.pickers).forEach((picker) => picker.refresh());
    }
  }

  $("#bgToggleSettings").addEventListener("click", () => {
    $("#bgSettings").classList.toggle("hidden");
    if (!$("#bgSettings").classList.contains("hidden")) loadAliases();
  });
  $("#bgRefreshModels").addEventListener("click", () => loadModels(true));

  $("#bgKeyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button");
    button.disabled = true;
    try {
      await api("POST", { action: "settings", apiKey: form.elements.apiKey.value });
      notice($("#bgSettingsResult"), "Đã lưu khóa vào file .env trên máy chủ.");
      await loadSettings();
    } catch (error) {
      notice($("#bgSettingsResult"), error.message, "error");
    } finally {
      form.elements.apiKey.value = "";
      button.disabled = false;
    }
  });

  $("#bgSaveModel").addEventListener("click", async () => {
    const model = bg.defaultModelChoice;
    if (!model || model === bg.settings?.model) {
      notice($("#bgSettingsResult"), model ? "Model này đang là mặc định rồi." : "Chưa chọn model.", model ? "ok" : "error");
      return;
    }
    try {
      await api("POST", { action: "settings", model });
      notice($("#bgSettingsResult"), `Đã đặt ${model} làm model mặc định.`);
      bg.runModel = "";
      await loadSettings();
      bg.pickers.run.set(model);
    } catch (error) {
      notice($("#bgSettingsResult"), error.message, "error");
    }
  });

  // ---------- Sổ viết tắt ----------
  async function loadAliases() {
    try {
      bg.aliases = await api("GET", null, "&action=aliases");
    } catch (error) {
      bg.aliases = { builtin: [], learned: [] };
    }
    renderAliases();
  }

  function renderAliases() {
    $("#bgAliasCustomer").innerHTML = customerOptions("");
    const learned = bg.aliases.learned.map((item) => (
      `<span class="bg-alias"><b>${escapeHtml(item.text)}</b> → ${escapeHtml(customerName(item.customerCode))}<button type="button" data-bg-alias-remove="${escapeHtml(item.text)}" title="Xóa">×</button></span>`
    ));
    const builtin = bg.aliases.builtin.map((item) => (
      `<span class="bg-alias builtin" title="Có sẵn"><b>${escapeHtml(item.text)}</b> → ${escapeHtml(customerName(item.customerCode))}</span>`
    ));
    $("#bgAliasList").innerHTML = [...learned, ...builtin].join("") || '<span class="bg-legend">Chưa có viết tắt.</span>';
  }

  $("#bgAliasForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const data = await api("POST", { action: "alias", text: form.elements.text.value, customerCode: form.elements.customerCode.value });
      bg.aliases.learned = data.learned || [];
      form.reset();
      renderAliases();
    } catch (error) {
      notice($("#bgSettingsResult"), error.message, "error");
    }
  });
  $("#bgAliasList").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-bg-alias-remove]");
    if (!button) return;
    try {
      const data = await api("POST", { action: "alias", text: button.dataset.bgAliasRemove, remove: true });
      bg.aliases.learned = data.learned || [];
      renderAliases();
    } catch (error) {
      notice($("#bgSettingsResult"), error.message, "error");
    }
  });

  // ---------- Danh sách ảnh ----------
  async function loadPending() {
    try {
      const data = await api("GET", null, "&action=pending");
      bg.pending = data.pending || [];
      if (data.storage === "vercel") {
        notice($("#bgUploadResult"), "Bản trên Vercel không giữ được ảnh. Hãy chạy luồng này bằng npm run local hoặc trên hosting Node.js.", "error");
      }
      if (bg.selected && !bg.pending.some((item) => item.name === bg.selected)) selectImage("");
      renderDateSuggest(data.dateSuggestion);
      renderPending();
      $("#bgDoneList").innerHTML = (data.done || []).map((item) => `<li>${escapeHtml(item.name)}</li>`).join("") || "<li>Chưa có ảnh nào.</li>";
    } catch (error) {
      notice($("#bgUploadResult"), error.message, "error");
    }
  }

  // Ngày giao thông minh: tự chọn ngày gần nhất chưa có đơn nào (hôm nay trước, rồi lùi dần).
  function renderDateSuggest(info) {
    const box = $("#bgDateSuggest");
    if (!info || !info.missing || !info.missing.length) {
      box.classList.add("hidden");
      box.innerHTML = "";
      bg.dateInfo = null;
      return;
    }
    bg.dateInfo = info;
    if (!bg.dateTouched && !bg.aiDate && info.suggested) {
      const before = $("#bgOrderDate").value;
      $("#bgOrderDate").value = info.suggested;
      if (before !== info.suggested) { showDateWarning(); renderRows(); }
    }
    const older = info.missing.filter((date) => date !== info.suggested).slice(0, 6);
    box.classList.remove("hidden");
    box.innerHTML = `<p>📅 <strong>${escapeHtml(formatDate(info.suggested))}</strong> chưa có đơn nào${info.suggested === info.today ? " (hôm nay)" : ""} — đang chọn sẵn ngày này.</p>`
      + (older.length ? `<p class="bg-date-older">Ngày cũ chưa nhập: ${older.map((date) => `<button type="button" class="bg-date-chip" data-bg-date="${escapeHtml(date)}">${escapeHtml(formatDate(date).slice(0, 5))}</button>`).join(" ")}</p>` : "")
      + (info.lastEntered ? `<p class="bg-date-older">Nhập gần nhất: ${escapeHtml(formatDate(info.lastEntered))}.</p>` : "");
  }

  $("#bgDateSuggest").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-bg-date]");
    if (!chip) return;
    bg.dateTouched = true;
    saveActiveToBatch();
    $("#bgOrderDate").value = chip.dataset.bgDate;
    resetSaveConfirm();
    showDateWarning();
    renderRows();
  });

  function renderPending() {
    $("#bgPendingCount").textContent = bg.pending.length ? `${number.format(bg.pending.length)} ảnh đang chờ` : "Không còn ảnh chờ.";
    $("#bgPendingList").innerHTML = bg.pending.map((item) => `
      <div class="bg-pending-item${item.name === bg.selected ? " active" : ""}">
        <button type="button" class="bg-pending-pick" data-bg-image="${escapeHtml(item.name)}">
          <img src="${imageUrl(item.name)}" alt="" loading="lazy" />
          <span><strong>${escapeHtml(item.name)}</strong><small>${sizeText(item.size)} · ${new Date(item.modifiedAt).toLocaleString("vi-VN")}</small></span>
        </button>
        <button type="button" class="bg-pending-x" data-bg-delete="${escapeHtml(item.name)}" title="Bỏ ảnh này khỏi danh sách chờ">✕</button>
      </div>`).join("") || '<div class="empty-state">Chưa có ảnh nào.</div>';
  }

  $("#bgPendingList").addEventListener("click", async (event) => {
    const remove = event.target.closest("[data-bg-delete]");
    if (remove) {
      const name = remove.dataset.bgDelete;
      if (bg.busy || !window.confirm(`Bỏ ảnh “${name}” khỏi danh sách chờ?\nẢnh được chuyển sang thư mục da-xoa, không mất hẳn.`)) return;
      remove.disabled = true;
      try {
        const data = await api("POST", { action: "delete-pending", imageName: name });
        bg.batch = bg.batch.filter((entry) => entry.name !== name);
        if (bg.selected === name) selectImage("");
        notice($("#bgUploadResult"), `Đã bỏ ${name} khỏi danh sách chờ (ảnh nằm ở ${data.movedTo}).`, "ok");
        await loadPending();
      } catch (error) {
        remove.disabled = false;
        notice($("#bgUploadResult"), error.message, "error");
      }
      return;
    }
    const item = event.target.closest("[data-bg-image]");
    if (item && !bg.busy && item.dataset.bgImage !== bg.selected) {
      if (bg.batch.some((entry) => entry.name === item.dataset.bgImage && entry.status === "ready")) {
        openBatchItem(item.dataset.bgImage);
        return;
      }
      saveActiveToBatch();
      selectImage(item.dataset.bgImage);
      announceImage(item.dataset.bgImage, "Anh chọn ảnh này trong danh sách chờ.");
    }
  });
  $("#bgRefresh").addEventListener("click", loadPending);

  function resetSaveConfirm() {
    bg.confirmDuplicates = false;
    $("#bgSaveButton").textContent = SAVE_TEXT;
  }

  function selectImage(name) {
    bg.selected = name;
    bg.rows = [];
    bg.aiDate = "";
    bg.pageCash = 0;
    bg.aiNote = "";
    bg.unit = state.businessUnit;
    resetSaveConfirm();
    $("#bgWorkspace").classList.toggle("hidden", !name);
    $("#bgEmpty").classList.toggle("hidden", Boolean(name));
    $("#bgSelectedName").textContent = name || "Chưa chọn ảnh.";
    $("#bgReadButton").disabled = !name;

    ["#bgAiNote", "#bgDateWarning"].forEach((selector) => $(selector).classList.add("hidden"));
    ["#bgReadResult", "#bgSaveResult"].forEach((selector) => { $(selector).className = "notice bg-inner-notice"; });
    if (name) {
      $("#bgPreview").src = imageUrl(name);
      $("#bgPreviewLink").href = imageUrl(name);
    }
    renderRows();
    renderPending();
  }

  // ---------- Tải ảnh lên ----------
  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Không đọc được file ảnh."));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Trình duyệt không mở được ảnh này (ảnh HEIC hãy đổi sang JPG trước)."));
      image.src = src;
    });
  }

  async function prepareImage(file) {
    const dataUrl = await readAsDataUrl(file);
    const supported = ["image/jpeg", "image/png", "image/webp"].includes(file.type);
    if (supported && file.size <= MAX_SEND_BYTES) return { fileName: file.name, dataUrl };
    const image = await loadImage(dataUrl);
    for (const [maxSide, quality] of [[2600, 0.9], [2000, 0.85], [1600, 0.8]]) {
      const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      const compressed = canvas.toDataURL("image/jpeg", quality);
      if (compressed.length * 0.75 <= MAX_SEND_BYTES) {
        return { fileName: `${file.name.replace(/\.[^.]+$/, "")}.jpg`, dataUrl: compressed };
      }
    }
    throw new Error("Ảnh quá lớn, không nén được xuống dưới 3MB.");
  }

  async function uploadFiles(files) {
    const list = [...files].filter(Boolean);
    if (!list.length) return;
    let lastName = "";
    const uploaded = [];
    const errors = [];
    for (const [index, file] of list.entries()) {
      notice($("#bgUploadResult"), `Đang gửi ảnh ${index + 1}/${list.length}: ${file.name}...`);
      try {
        const prepared = await prepareImage(file);
        const data = await api("POST", { action: "upload", fileName: prepared.fileName, dataBase64: prepared.dataUrl });
        lastName = data.name;
        uploaded.push(data.name);
      } catch (error) {
        errors.push(`${file.name}: ${error.message}`);
      }
    }
    $("#bgFileInput").value = "";
    if (errors.length) chat("ai", `Không gửi được: ${escapeHtml(errors.join(" · "))}`, "err");
    await loadPending();
    if (uploaded.length > 1) offerBatch(uploaded);
    else if (lastName) {
      selectImage(lastName);
      announceImage(lastName);
    }
  }

  $("#bgFileInput").addEventListener("change", (event) => uploadFiles(event.target.files));
  const chatBox = $("#bgChat");
  ["dragenter", "dragover"].forEach((type) => chatBox.addEventListener(type, (event) => {
    event.preventDefault();
    chatBox.classList.add("drag");
  }));
  ["dragleave", "drop"].forEach((type) => chatBox.addEventListener(type, () => chatBox.classList.remove("drag")));
  chatBox.addEventListener("drop", (event) => {
    event.preventDefault();
    uploadFiles(event.dataTransfer.files);
  });
  $("#bgChatInput").addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
    if (files.length) {
      event.preventDefault();
      uploadFiles(files);
    }
  });

  // ---------- Ô chat ----------
  bg.version = 0;
  bg.history = [];
  function chat(role, html, tone = "") {
    const box = $("#bgChatMessages");
    const message = document.createElement("div");
    message.className = `bg-msg ${role}${tone ? ` ${tone}` : ""}`;
    message.innerHTML = html;
    box.appendChild(message);
    box.scrollTop = box.scrollHeight;
    return message;
  }
  function typing(text) {
    return chat("ai", `<span class="bg-typing">${escapeHtml(text)}</span>`);
  }
  function actions(buttons) {
    return `<div class="bg-msg-actions">${buttons.map(([act, label, cls]) => (
      `<button type="button" class="${cls}" data-bg-act="${act}" data-ver="${bg.version}">${label}</button>`
    )).join("")}</div>`;
  }
  function announceImage(name, extra = "") {
    bg.version += 1;
    chat("me", `<img src="${imageUrl(name)}" alt="" />${escapeHtml(name)}`);
    chat("ai", `Đã nhận ảnh. Ngày giao đang chọn: <strong>${formatDate($("#bgOrderDate").value || todayInVietnam())}</strong> (đổi ở cột trái nếu sai). ${escapeHtml(extra)}`
      + actions([["scan", "🔍 Scan", "bg-btn-scan"]]));
  }
  function greet() {
    if ($("#bgChatMessages").children.length) return;
    chat("ai", isPho()
      ? "Chào anh. Thả ảnh tờ giao hàng vào đây (hoặc bấm 📎), bấm <strong>Scan</strong>, tôi đọc xong sẽ báo cáo. Anh thấy đúng thì bấm <strong>Cập nhật</strong> hoặc nhắn <em>ok</em>; sai chỗ nào thì nhắn, ví dụ <em>dòng 3 là 5 cây</em>.<br>Anh cũng có thể hỏi tôi bất cứ gì về sổ, ví dụ <em>Kim Vân còn nợ bao nhiêu?</em><br>Dồn nhiều ngày? Chọn một lúc nhiều ảnh (hoặc bấm <strong>Scan tất cả</strong> ở cột trái): tôi scan hết rồi báo cáo gộp theo ngày để anh duyệt một lần."
      : "Luồng này được dạy cho tờ giao hàng Xưởng Phở. Anh chuyển sang Xưởng Phở ở trên để dùng đúng.");
  }

  // Báo cáo trong chat là bảng sửa được tại chỗ (chỉ báo cáo mới nhất sửa được).
  function statusHtml(row) {
    const amount = rowAmount(row);
    const paid = parseNumber(row.cashThousand) * 1000;
    if (amount === null) return '<span class="bad">chưa rõ khách</span>';
    if (!amount) return '<span class="bad">0 hàng?</span>';
    if (!paid) return `nợ ${money.format(amount)}`;
    if (paid === amount) return '<span class="good">thu đủ</span>';
    if (paid < amount) return `còn nợ ${money.format(amount - paid)}`;
    return `<span class="warn">dư ${money.format(paid - amount)} trừ nợ cũ</span>`;
  }

  function liveRowHtml(row, index) {
    const qty = isPho()
      ? `<span class="bg-live-qty"><input data-live-field="phoSoiKg" inputmode="decimal" value="${escapeHtml(row.phoSoiKg || "")}" placeholder="0" /><select data-live-field="phoSoiUnit"><option value="cay"${row.phoSoiUnit !== "kg" ? " selected" : ""}>cây</option><option value="kg"${row.phoSoiUnit === "kg" ? " selected" : ""}>kg</option></select></span>`
        + (parseNumber(row.phoCuonKg) ? `<small>+ ${number.format(parseNumber(row.phoCuonKg))}kg phở cuốn</small>` : "")
      : productColumns().map((c) => `<label class="bg-live-mini">${c.label}<input data-live-field="${c.field}" inputmode="decimal" value="${escapeHtml(row[c.field] || "")}" placeholder="0" /></label>`).join("");
    return `<tr data-live-row="${index}" class="${row.customerCode ? "" : "bg-missing"} ${row.sure === false ? "bg-unsure" : ""}">
      <td>${index + 1}</td>
      <td><select data-live-field="customerCode">${customerOptions(row.customerCode)}</select>
        ${row.khachTrenAnh ? `<small>Giấy: ${escapeHtml(row.khachTrenAnh)}${row.sure === false ? " ⚠" : ""}</small>` : ""}</td>
      <td><input class="bg-live-points" data-live-field="points" value="${escapeHtml(String(row.points || ""))}" placeholder="—" /></td>
      <td>${qty}</td>
      <td><input class="bg-live-cash" data-live-field="cashThousand" inputmode="decimal" value="${escapeHtml(row.cashThousand || "")}" placeholder="nợ" /><small data-live-status>${statusHtml(row)}</small></td>
      <td><button type="button" class="bg-live-del" data-live-del="${index}" title="Bỏ dòng">✕</button></td>
    </tr>`;
  }

  function liveSummaryHtml() {
    const rows = bg.rows;
    const date = $("#bgOrderDate").value;
    const amounts = rows.map(rowAmount);
    const cash = rows.reduce((sum, row) => sum + parseNumber(row.cashThousand), 0);
    const cay = rows.reduce((sum, row) => sum + (row.phoSoiUnit === "kg" ? 0 : parseNumber(row.phoSoiKg)), 0);
    const missing = rows.filter((row) => !row.customerCode).length;
    const unsure = rows.filter((row) => row.sure === false).length;
    const empty = rows.filter((row) => row.customerCode && !rowAmount(row)).length;
    const dups = rows.filter(isDuplicate).length;
    const pageCheck = bg.pageCash
      ? (cash === bg.pageCash ? ` <span class="good">✓ khớp số cuối tờ</span>` : ` <span class="bad">✗ cuối tờ ghi ${money.format(bg.pageCash * 1000)}</span>`)
      : "";
    const warnings = [
      missing ? `${missing} dòng chưa chọn khách` : "",
      empty ? `${empty} dòng 0 hàng — xem lại số cây trên giấy` : "",
      unsure ? `${unsure} dòng AI đọc không chắc (⚠)` : "",
      dups ? `${dups} khách đã có đơn ngày ${formatDate(date)} trong sổ — có thể ảnh đã nhập rồi` : "",
      bg.aiDate && date && bg.aiDate !== date ? `ngày trên giấy là ${formatDate(bg.aiDate)}, khác ngày đang chọn ${formatDate(date)}` : "",
    ].filter(Boolean);
    const buttons = [["edit", "Mở bảng chi tiết", "bg-btn-edit"]];
    if (!missing && rows.length) buttons.unshift(["update", `✅ Cập nhật ${rows.length} đơn`, "bg-btn-update"]);
    return `<p>Tổng: ${isPho() ? `<strong>${number.format(cay)} cây</strong> · ` : ""}tiền mặt <strong>${money.format(cash * 1000)}</strong>${pageCheck}
      ${amounts.every((x) => x !== null) ? ` · tiền hàng ${money.format(amounts.reduce((x, y) => x + y, 0))}` : ""}</p>
      ${warnings.length ? `<p class="bad">Cần xem: ${warnings.map(escapeHtml).join("; ")}.</p>` : `<p class="good">Không thấy điểm bất thường.</p>`}
      ${bg.aiNote ? `<p>Ghi chú của AI: ${escapeHtml(bg.aiNote)}</p>` : ""}
      ${actions(buttons)}`;
  }

  function liveBodyHtml() {
    return `<div class="table-wrap"><table class="bg-live-table"><thead><tr><th>#</th><th>Khách</th><th>Điểm</th><th>Hàng</th><th>Tiền mặt (nghìn)</th><th></th></tr></thead>
      <tbody>${bg.rows.map(liveRowHtml).join("")}</tbody></table></div>
      <div class="bg-live-tools"><button type="button" class="bg-btn-edit" data-live-add="1">＋ Thêm dòng</button><span class="bg-legend">Sửa thẳng trong bảng này; tiền mặt để trống = khách nợ.</span></div>
      <div data-live-summary>${liveSummaryHtml()}</div>`;
  }

  function liveMessage() {
    return document.querySelector("#bgChatMessages .bg-msg[data-live]");
  }

  // Báo cáo cũ thành bản chỉ đọc khi có báo cáo mới.
  function freezeLive() {
    const old = liveMessage();
    if (!old) return;
    old.removeAttribute("data-live");
    old.classList.add("bg-frozen");
    old.querySelectorAll("input, select, [data-live-del], [data-live-add]").forEach((el) => { el.disabled = true; });
  }

  function refreshLive(full) {
    const message = liveMessage();
    if (!message) return;
    if (full) {
      message.querySelector("[data-live-body]").innerHTML = liveBodyHtml();
      return;
    }
    message.querySelectorAll("[data-live-row]").forEach((tr) => {
      const row = bg.rows[Number(tr.dataset.liveRow)];
      if (row) tr.querySelector("[data-live-status]").innerHTML = statusHtml(row);
    });
    message.querySelector("[data-live-summary]").innerHTML = liveSummaryHtml();
  }

  function postReport(title) {
    freezeLive();
    bg.version += 1;
    const message = chat("ai", `<p><strong>${escapeHtml(title)}</strong> — ngày giao <span data-live-date>${formatDate($("#bgOrderDate").value)}</span></p><div data-live-body>${liveBodyHtml()}</div>`);
    message.dataset.live = "1";
    message.classList.add("bg-live");
  }

  $("#bgChatMessages").addEventListener("input", (event) => {
    const field = event.target.dataset.liveField;
    const tr = event.target.closest("[data-live-row]");
    if (!field || !tr || !event.target.closest("[data-live]")) return;
    const row = bg.rows[Number(tr.dataset.liveRow)];
    if (!row) return;
    row[field] = event.target.value;
    resetSaveConfirm();
    if (field === "customerCode") {
      row.sure = true;
      tr.classList.toggle("bg-missing", !row.customerCode);
      tr.classList.remove("bg-unsure");
    }
    bg.liveEditing = true;
    renderRows();
    bg.liveEditing = false;
    refreshLive(false);
  });
  $("#bgChatMessages").addEventListener("click", (event) => {
    if (!event.target.closest("[data-live]")) return;
    const del = event.target.closest("[data-live-del]");
    const add = event.target.closest("[data-live-add]");
    if (!del && !add) return;
    if (del) bg.rows.splice(Number(del.dataset.liveDel), 1);
    if (add) addRow();
    resetSaveConfirm();
    renderRows();
  });

  $("#bgChatMessages").addEventListener("click", (event) => {
    const button = event.target.closest("[data-bg-act]");
    if (!button) return;
    if (button.dataset.batch) {
      event.preventDefault();
      handleBatchAction(button.dataset.bgAct, button.dataset.name || "");
      return;
    }
    if (Number(button.dataset.ver) !== bg.version) {
      chat("ai", "Nút này thuộc báo cáo cũ. Dùng nút ở tin nhắn mới nhất nhé.");
      return;
    }
    const act = button.dataset.bgAct;
    if (act === "scan") scanImage();
    if (act === "update") commitRows(false);
    if (act === "update-force") commitRows(true);
    if (act === "edit") {
      $("#bgEditor").open = true;
      $("#bgEditor").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  const OK_START = /^(ok\S*|oke\S*|ừ|uh|ừa|ờ|đúng|chuẩn|chốt|cập nhật|update|lưu|ghi|nhập|được|duyệt|đồng ý)(\s|[.!,]|$)/i;
  const COMMIT_VERB = /(cập nhật|update|lưu|ghi sổ|ghi vào|nhập|chốt|duyệt)/i;
  // "ok", "ừ đúng rồi", "ok cập nhật ngày 25/8 đi"… đều là đồng ý; có số thì phải kèm động từ cập nhật.
  const isOk = (text) => text.length <= 60
    && !/\b(sai|chưa|không|ko|đừng|khoan)\b/i.test(text)
    && OK_START.test(text)
    && (!/\d/.test(text) || COMMIT_VERB.test(text));

  function nothingToCommit() {
    if (bg.busy) return "Tôi đang xử lý việc trước, anh đợi vài giây rồi nhắn lại nhé.";
    if (bg.selected && !bg.rows.length) return "";
    if (!bg.selected && !bg.batch.length) {
      return bg.pending.length
        ? `Chưa có bảng nào đang chờ duyệt nên tôi chưa ghi gì hết. Anh chọn ảnh ở cột trái rồi bấm 🔍 Scan (hoặc nhắn "scan hết" để scan cả ${bg.pending.length} ảnh).`
        : "Chưa có bảng nào đang chờ duyệt và cũng không còn ảnh nào chờ nhập, nên tôi chưa ghi gì hết.";
    }
    return "";
  }
  $("#bgChatForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("#bgChatInput");
    const text = input.value.trim();
    if (!text) return;
    if (bg.busy) {
      chat("ai", "Tôi đang xử lý việc trước, anh đợi vài giây rồi nhắn lại nhé.");
      return;
    }
    input.value = "";
    chat("me", escapeHtml(text));
    bg.history.push({ role: "me", text });
    if (bg.history.length > 20) bg.history.splice(0, bg.history.length - 20);
    if (/^(scan|đọc)\s*(hết|tất cả|all|toàn bộ)/i.test(text)) {
      scanBatch(bg.pending.map((item) => item.name));
      return;
    }
    if (/^(vẫn|cứ)\s*(cập nhật|ghi|lưu|nhập)|đúng là đơn mới/i.test(text) && bg.selected && bg.rows.length) {
      commitRows(true);
      return;
    }
    if (isOk(text)) {
      const blocked = nothingToCommit();
      if (blocked) {
        chat("ai", escapeHtml(blocked), "err");
        return;
      }
    }
    if (bg.batch.length && !bg.selected && isOk(text)) {
      commitBatch();
      return;
    }
    if (bg.selected && !bg.rows.length && (isOk(text) || /^(scan|đọc)/i.test(text))) {
      scanImage();
      return;
    }
    if (bg.selected && bg.rows.length && isOk(text)) {
      commitRows(false);
      return;
    }
    const wait = typing("Đang nghĩ...");
    bg.busy = true;
    try {
      const data = await api("POST", {
        action: "chat",
        message: text,
        rows: bg.selected ? bg.rows : [],
        date: $("#bgOrderDate").value,
        history: bg.history.slice(0, -1),
        model: bg.runModel,
      });
      wait.remove();
      if (data.edited) {
        bg.rows = (data.rows || []).map((row) => ({ ...row, points: (row.points || []).join(", ") }));
        saveActiveToBatch();
        resetSaveConfirm();
        renderRows();
        postReport(data.reply || "Đã sửa");
      } else {
        chat("ai", escapeHtml(data.reply).replace(/\n/g, "<br>"));
        // AI hiểu là anh duyệt bảng: tự bấm Cập nhật giúp, không để anh tưởng đã ghi mà chưa ghi.
        if (data.commit && bg.rows.length) {
          bg.busy = false;
          if (bg.selected) commitRows(bg.confirmDuplicates);
          else if (bg.batch.length) commitBatch();
        }
      }
      bg.history.push({ role: "ai", text: data.reply || "" });
    } catch (error) {
      wait.remove();
      chat("ai", escapeHtml(error.message), "err");
    } finally {
      bg.busy = false;
      updateTotals();
    }
  });
  $("#bgChatInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("#bgChatForm").requestSubmit();
    }
  });

  // ---------- AI đọc ảnh ----------
  function showDateWarning() {
    const box = $("#bgDateWarning");
    const chosen = $("#bgOrderDate").value;
    const differs = bg.aiDate && chosen && bg.aiDate !== chosen;
    box.classList.toggle("hidden", !differs);
    if (differs) {
      box.innerHTML = `Ngày trên ảnh là <strong>${formatDate(bg.aiDate)}</strong>, khác ngày anh đang chọn (${formatDate(chosen)}). <button type="button" class="text-button" id="bgUseAiDate">Dùng ngày trên ảnh</button>`;
    }
  }

  $("#bgDateWarning").addEventListener("click", (event) => {
    if (!event.target.closest("#bgUseAiDate")) return;
    $("#bgOrderDate").value = bg.aiDate;
    resetSaveConfirm();
    showDateWarning();
    renderRows();
  });

  async function scanImage() {
    if (!bg.selected || bg.busy) return;
    const button = $("#bgReadButton");
    const model = bg.runModel || bg.settings?.model || "";
    bg.busy = true;
    button.disabled = true;
    const wait = typing(`${model || "AI"} đang đọc tờ giấy, thường mất 5–30 giây...`);
    try {
      const data = await api("POST", { action: "read", imageName: bg.selected, model: bg.runModel });
      bg.rows = (data.rows || []).map((row) => ({ ...row, points: (row.points || []).join(", ") }));
      bg.aiDate = data.date || "";
      bg.pageCash = Number(data.pageCashThousand || 0);
      bg.aiNote = data.note || "";
      if (!$("#bgOrderDate").value) $("#bgOrderDate").value = bg.aiDate || todayInVietnam();
      resetSaveConfirm();
      const cost = data.cost ? ` · chi phí ~$${Number(data.cost).toFixed(4)}` : "";
      notice($("#bgReadResult"), `${data.model} đọc được ${number.format(bg.rows.length)} dòng${cost}.`);
      $("#bgAiNote").textContent = bg.aiNote ? `Ghi chú của AI: ${bg.aiNote}` : "";
      $("#bgAiNote").classList.toggle("hidden", !bg.aiNote);
      showDateWarning();
      if (!bg.rows.length) addRow();
      renderRows();
      wait.remove();
      postReport(`${data.model} đọc được ${bg.rows.length} dòng${cost}`);
    } catch (error) {
      wait.remove();
      chat("ai", escapeHtml(error.message), "err");
      notice($("#bgReadResult"), error.message, "error");
    } finally {
      bg.busy = false;
      button.disabled = !bg.selected;
      updateTotals();
    }
  }
  $("#bgReadButton").addEventListener("click", scanImage);

  // ---------- Bảng duyệt ----------
  function addRow() {
    const row = { khachTrenAnh: "", customerCode: "", points: "", cashThousand: "", sure: true, nhaXe: "", ghiChu: "" };
    productColumns().forEach((column) => { row[column.field] = ""; });
    if (isPho()) row.phoSoiUnit = "cay";
    bg.rows.push(row);
  }

  function customerOptions(selected) {
    return `<option value="">— Chọn khách —</option>${sortedCustomers().map((customer) => (
      `<option value="${escapeHtml(customer.MaKH)}"${customer.MaKH === selected ? " selected" : ""}>${escapeHtml(customer.TenKH)} (${escapeHtml(customer.MaKH)})</option>`
    )).join("")}`;
  }

  // Tiền hàng dự tính theo bảng giá khách (giống cách backend tính).
  function rowAmount(row) {
    const customer = customerForCode(row.customerCode);
    if (!customer) return null;
    let subtotal;
    if (isPho()) {
      const phoSoiKg = parseNumber(row.phoSoiKg) * (row.phoSoiUnit === "kg" ? 1 : 5);
      subtotal = phoSoiKg * Number(customer.GiaPhoSoi || 0) + parseNumber(row.phoCuonKg) * Number(customer.GiaPhoCuon || 0);
    } else {
      subtotal = parseNumber(row.miKg) * Number(customer.GiaMi || 0)
        + parseNumber(row.caoKg) * Number(customer.GiaCao || 0)
        + parseNumber(row.hoanhKg) * Number(customer.GiaHoanh || 0);
    }
    return subtotal + subtotal * Number(customer.ThueSuat || 0) / 100;
  }

  function moneyStatus(row) {
    const amount = rowAmount(row);
    if (amount === null) return "";
    const cash = parseNumber(row.cashThousand) * 1000;
    if (!cash) return `<small class="bg-money debt">Hàng ${money.format(amount)} · ghi nợ</small>`;
    if (cash === amount) return `<small class="bg-money ok">Hàng ${money.format(amount)} · thu đủ</small>`;
    if (cash < amount) return `<small class="bg-money debt">Hàng ${money.format(amount)} · còn nợ ${money.format(amount - cash)}</small>`;
    return `<small class="bg-money over">Hàng ${money.format(amount)} · dư ${money.format(cash - amount)} trừ nợ cũ</small>`;
  }

  function isDuplicate(row) {
    const customer = customerForCode(row.customerCode);
    const date = $("#bgOrderDate").value;
    return Boolean(customer && date && duplicateCustomerOnDate(customer.TenKH, date));
  }

  function sameSheetDuplicate(row, index) {
    return row.customerCode && bg.rows.some((other, otherIndex) => otherIndex !== index && other.customerCode === row.customerCode);
  }

  function quantityCell(column, row) {
    if (column.field === "phoSoiKg") {
      return `<td><div class="bg-pho-unit"><input class="bg-qty" data-bg-field="phoSoiKg" inputmode="decimal" value="${escapeHtml(row.phoSoiKg || "")}" placeholder="0" /><select data-bg-field="phoSoiUnit"><option value="cay"${row.phoSoiUnit !== "kg" ? " selected" : ""}>cây</option><option value="kg"${row.phoSoiUnit === "kg" ? " selected" : ""}>kg</option></select></div></td>`;
    }
    return `<td><input class="bg-qty" data-bg-field="${column.field}" inputmode="decimal" value="${escapeHtml(row[column.field] || "")}" placeholder="0" /></td>`;
  }

  function renderRows() {
    const columns = productColumns();
    $("#bgUnitHint").classList.toggle("hidden", isPho());
    $("#bgHead").innerHTML = `<tr><th>#</th><th>Khách hàng</th>${isPho() ? "<th>Điểm giao</th>" : ""}${columns.map((column) => `<th>${column.label}</th>`).join("")}<th>Tiền mặt (nghìn)</th>${isPho() ? "" : "<th>Nhà xe</th>"}<th>Ghi chú</th><th></th></tr>`;
    $("#bgRows").innerHTML = bg.rows.map((row, index) => `
      <tr data-bg-row="${index}" class="${row.customerCode ? "" : "bg-missing"} ${row.sure === false ? "bg-unsure" : ""}">
        <td>${index + 1}</td>
        <td class="bg-customer">
          <select data-bg-field="customerCode">${customerOptions(row.customerCode)}</select>
          ${row.khachTrenAnh ? `<small class="bg-raw">Trên giấy: ${escapeHtml(row.khachTrenAnh)}</small>` : ""}
          ${isDuplicate(row) ? '<small class="bg-warn">⚠ Khách đã có đơn trong ngày này ở CRM</small>' : ""}
          ${sameSheetDuplicate(row, index) ? '<small class="bg-warn">⚠ Khách xuất hiện nhiều dòng trên tờ — kiểm tra có phải 2 lần giao thật</small>' : ""}
        </td>
        ${isPho() ? `<td><input class="bg-points" data-bg-field="points" value="${escapeHtml(row.points || "")}" placeholder="5, 6" /></td>` : ""}
        ${columns.map((column) => quantityCell(column, row)).join("")}
        <td><input class="bg-qty" data-bg-field="cashThousand" inputmode="decimal" value="${escapeHtml(row.cashThousand || "")}" placeholder="0" /><span data-bg-money>${moneyStatus(row)}</span></td>
        ${isPho() ? "" : `<td><input data-bg-field="nhaXe" value="${escapeHtml(row.nhaXe || "")}" placeholder="Mặc định của khách" /></td>`}
        <td><input data-bg-field="ghiChu" value="${escapeHtml(row.ghiChu || "")}" /></td>
        <td><button type="button" class="bg-remove" data-bg-remove="${index}" title="Bỏ dòng này">×</button></td>
      </tr>`).join("") || `<tr><td colspan="${columns.length + 7}" class="empty-row">Bấm “AI đọc ảnh” hoặc “Thêm dòng” để nhập.</td></tr>`;
    updateTotals();
  }

  function updateTotals() {
    if (!bg.liveEditing) refreshLive(true);
    const liveDate = document.querySelector("#bgChatMessages [data-live] [data-live-date]");
    if (liveDate) liveDate.textContent = formatDate($("#bgOrderDate").value);
    const box = (label, value, cls = "") => `<div class="${cls}"><span>${label}</span><strong>${value}</strong></div>`;
    const parts = [];
    if (bg.rows.length) {
      productColumns().forEach((column) => {
        const total = bg.rows.reduce((sum, row) => sum + parseNumber(row[column.field]), 0);
        if (!total) return;
        const unit = column.field === "phoSoiKg" && bg.rows.every((row) => row.phoSoiUnit !== "kg") ? " cây" : "";
        parts.push(box(column.label, `${number.format(total)}${unit}`));
      });
      const cash = bg.rows.reduce((sum, row) => sum + parseNumber(row.cashThousand), 0);
      const pageMatch = bg.pageCash ? (cash === bg.pageCash ? "good" : "bad") : "";
      parts.push(box("Tiền mặt đã thu", money.format(cash * 1000), pageMatch));
      if (bg.pageCash) {
        parts.push(box("Tổng ghi cuối tờ", `${money.format(bg.pageCash * 1000)} ${cash === bg.pageCash ? "✓ khớp" : "✗ lệch"}`, pageMatch));
      }
      const amounts = bg.rows.map(rowAmount);
      if (amounts.every((amount) => amount !== null)) {
        const goods = amounts.reduce((sum, amount) => sum + amount, 0);
        parts.push(box("Tiền hàng", money.format(goods)));
        parts.push(box("Ghi nợ thêm", money.format(Math.max(0, goods - cash * 1000))));
      }
    }
    $("#bgTotals").innerHTML = parts.join("");
    const missing = bg.rows.filter((row) => !row.customerCode).length;
    $("#bgSaveHint").textContent = missing ? `${missing} dòng chưa chọn khách.` : (bg.rows.length ? `${number.format(bg.rows.length)} đơn sẽ được tạo ngày ${formatDate($("#bgOrderDate").value || "")}.` : "");
    $("#bgSaveButton").disabled = !bg.selected || !bg.rows.length || missing > 0 || bg.busy;
    $$("#bgRows [data-bg-row]").forEach((element) => {
      const moneyCell = element.querySelector("[data-bg-money]");
      if (moneyCell) moneyCell.innerHTML = moneyStatus(bg.rows[Number(element.dataset.bgRow)]);
    });
  }

  $("#bgRows").addEventListener("input", (event) => {
    const field = event.target.dataset.bgField;
    const rowElement = event.target.closest("[data-bg-row]");
    if (!field || !rowElement) return;
    const row = bg.rows[Number(rowElement.dataset.bgRow)];
    row[field] = event.target.value;
    resetSaveConfirm();
    if (field === "customerCode") {
      row.sure = true;
      renderRows();
    } else updateTotals();
  });
  $("#bgRows").addEventListener("click", (event) => {
    const remove = event.target.closest("[data-bg-remove]");
    if (!remove) return;
    bg.rows.splice(Number(remove.dataset.bgRemove), 1);
    resetSaveConfirm();
    renderRows();
  });
  $("#bgAddRow").addEventListener("click", () => { addRow(); renderRows(); });
  $("#bgOrderDate").addEventListener("change", () => {
    bg.dateTouched = true;
    saveActiveToBatch();
    resetSaveConfirm();
    showDateWarning();
    renderRows();
  });

  // ---------- Lưu ----------
  async function commitRows(force) {
    if (bg.busy) return;
    const date = $("#bgOrderDate").value;
    if (!date) {
      chat("ai", "Chưa có ngày giao. Chọn ngày ở cột trái rồi bấm lại.", "err");
      return;
    }
    if (bg.rows.some((row) => !row.customerCode)) {
      chat("ai", "Còn dòng chưa có khách, chưa cập nhật được. Bấm Chỉnh sửa hoặc nhắn tôi tên khách.", "err");
      return;
    }
    const duplicates = bg.rows.filter(isDuplicate).length;
    if (duplicates && !force && !bg.confirmDuplicates) {
      bg.version += 1;
      chat("ai", `⚠ <strong>Chưa ghi gì vào sổ.</strong> ${duplicates} khách đã có đơn ngày ${formatDate(date)} trong sổ — có thể ảnh này nhập rồi. Chắc là đơn mới thì bấm <strong>Vẫn cập nhật</strong> (hoặc nhắn “vẫn cập nhật”).`
        + actions([["update-force", "Vẫn cập nhật", "bg-btn-update"], ["edit", "✏️ Chỉnh sửa", "bg-btn-edit"]]), "err");
      bg.confirmDuplicates = true;
      $("#bgSaveButton").textContent = "Vẫn cập nhật";
      return;
    }
    bg.busy = true;
    bg.version += 1;
    $("#bgSaveButton").disabled = true;
    const wait = typing(`Đang ghi ${bg.rows.length} đơn vào sổ...`);
    try {
      const orders = bg.rows.map((row) => {
        const points = String(row.points || "").trim();
        const payload = {
          customerCode: row.customerCode,
          khachTrenAnh: row.khachTrenAnh || "",
          orderDate: date,
          nhaXe: row.nhaXe || "",
          ghiChu: [points ? `Điểm giao ${points}` : "", row.ghiChu || ""].filter(Boolean).join(" · "),
          phoSoiUnit: row.phoSoiUnit || "cay",
          cash: Math.round(parseNumber(row.cashThousand) * 1000),
        };
        productColumns().forEach((column) => { payload[column.field] = parseNumber(row[column.field]); });
        return payload;
      });
      const data = await api("POST", { action: "save", imageName: bg.selected, orders });
      applyLocalCrmPatch({ orders: data.orders || [], payments: data.payments || [] });
      const cash = (data.payments || []).reduce((sum, item) => sum + Number(item.amount || 0), 0);
      const goods = orders.reduce((sum, order, index) => sum + (rowAmount(bg.rows[index]) || 0), 0);
      wait.remove();
      chat("ai", data.warning ? escapeHtml(data.warning)
        : `✅ Đã cập nhật <strong>${orders.length} đơn</strong> ngày ${formatDate(date)}: tiền hàng ${money.format(goods)}, tiền mặt ${money.format(cash)}, công nợ tăng ${money.format(Math.max(0, goods - cash))}. Sản lượng và công nợ đã cập nhật.<br>Ảnh đã chuyển sang <code>da-nhap-lieu/${escapeHtml(data.movedTo)}</code>.${data.learned ? ` Sổ viết tắt học thêm ${data.learned} mục.` : ""}`,
      data.warning ? "err" : "ok");
      const batchItem = bg.batch.find((item) => item.name === bg.selected);
      if (batchItem) batchItem.status = "done";
      selectImage("");
      await loadPending();
      if (batchItem && bg.batch.some((item) => item.status !== "done")) postBatchReport("Các ngày còn lại trong lô");
      else if (bg.pending.length) chat("ai", `Còn ${bg.pending.length} ảnh chờ nhập ở cột trái.` + actions([["batch-offer", `🔍 Scan tất cả ${bg.pending.length} ảnh`, "bg-btn-scan"]]).replace(/data-ver/g, 'data-batch="1" data-ver'));
      if (!$("#bgSettings").classList.contains("hidden")) loadAliases();
    } catch (error) {
      wait.remove();
      chat("ai", escapeHtml(error.message), "err");
      notice($("#bgSaveResult"), error.message, "error");
    } finally {
      bg.busy = false;
      updateTotals();
    }
  }
  $("#bgSaveButton").addEventListener("click", () => commitRows(bg.confirmDuplicates));

  // ---------- Nhập hàng loạt (nhiều ngày một lần) ----------
  // Mỗi ảnh là một ngày. Scan hết, báo cáo gộp theo ngày, anh duyệt một lần rồi cập nhật cả lô.
  bg.batch = [];
  const BATCH_CONCURRENCY = 2;

  function batchButton(act, label, cls, name = "") {
    return `<button type="button" class="${cls}" data-bg-act="${act}" data-batch="1" data-name="${escapeHtml(name)}">${label}</button>`;
  }

  function offerBatch(names) {
    chat("me", `<div class="bg-thumbs">${names.map((name) => `<img src="${imageUrl(name)}" alt="" />`).join("")}</div>${names.length} ảnh`);
    const model = bg.runModel || bg.settings?.model || "";
    chat("ai", `Đã nhận <strong>${names.length} ảnh</strong>. Tôi sẽ scan hết, mỗi ảnh là một ngày (lấy ngày ghi trên giấy), rồi báo cáo gộp để anh duyệt một lần.<br>`
      + `Model đang dùng: <strong>${escapeHtml(model)}</strong>. Lô nhiều ngày nên chọn model mạnh (★ Claude Opus / GPT) ở ô trên nếu muốn chắc tay hơn.`
      + `<div class="bg-msg-actions">${batchButton("batch-scan", `🔍 Scan tất cả ${names.length} ảnh`, "bg-btn-scan", names.join("|"))}</div>`);
  }

  function batchFlags(item) {
    const flags = [];
    const missing = item.rows.filter((row) => !row.customerCode).length;
    const unsure = item.rows.filter((row) => row.sure === false).length;
    const cash = item.rows.reduce((sum, row) => sum + parseNumber(row.cashThousand), 0);
    if (!item.date) flags.push("không đọc được ngày");
    if (missing) flags.push(`${missing} dòng chưa rõ khách`);
    const empty = item.rows.filter((row) => row.customerCode && !rowAmount(row)).length;
    if (empty) flags.push(`${empty} dòng 0 hàng`);
    if (item.pageCash && cash !== item.pageCash) flags.push(`tiền mặt ${number.format(cash)} ≠ cuối tờ ${number.format(item.pageCash)}`);
    if (item.date) {
      const dups = item.rows.filter((row) => {
        const customer = customerForCode(row.customerCode);
        return customer && duplicateCustomerOnDate(customer.TenKH, item.date);
      }).length;
      if (dups) flags.push(`${dups} khách đã có đơn ngày này trong sổ`);
      const sameDay = bg.batch.filter((other) => other !== item && other.status !== "error" && other.date === item.date).length;
      if (sameDay) flags.push("trùng ngày với ảnh khác trong lô");
    }
    return { flags, soft: unsure ? [`${unsure} dòng AI không chắc`] : [] };
  }

  function batchItemHtml(item) {
    if (item.status === "error") {
      return `<details class="bg-day bad-day"><summary>✗ ${escapeHtml(item.name)} — ${escapeHtml(item.error)}</summary>${batchButton("batch-rescan", "🔍 Scan lại ảnh này", "bg-btn-scan", item.name)}</details>`;
    }
    if (item.status === "done") {
      return `<div class="bg-day done-day">✅ ${item.date ? formatDate(item.date) : ""} — đã cập nhật (${escapeHtml(item.name)})</div>`;
    }
    const { flags, soft } = batchFlags(item);
    const cay = item.rows.reduce((sum, row) => sum + parseNumber(row.phoSoiKg), 0);
    const cash = item.rows.reduce((sum, row) => sum + parseNumber(row.cashThousand), 0);
    const amounts = item.rows.map(rowAmount);
    const goods = amounts.every((x) => x !== null) ? amounts.reduce((a, b) => a + b, 0) : null;
    const lines = item.rows.map((row, index) => `<tr><td>${index + 1}</td><td>${row.customerCode ? escapeHtml(customerName(row.customerCode)) : `<span class="bad">? ${escapeHtml(row.khachTrenAnh)}</span>`}${row.sure === false ? " ⚠" : ""}</td><td>${escapeHtml(String(row.points || ""))}</td><td>${number.format(parseNumber(row.phoSoiKg))} ${row.phoSoiUnit === "kg" ? "kg" : "cây"}</td><td>${parseNumber(row.cashThousand) ? money.format(parseNumber(row.cashThousand) * 1000) : "nợ"}</td></tr>`).join("");
    return `<details class="bg-day ${flags.length ? "bad-day" : "ok-day"}">
      <summary>${flags.length ? "⚠" : "✓"} <strong>${item.date ? formatDate(item.date) : "?? ngày"}</strong> · ${item.rows.length} đơn · ${number.format(cay)} cây · tiền mặt ${money.format(cash * 1000)}${item.pageCash ? (cash === item.pageCash ? " ✓" : " ✗") : ""}${goods !== null ? ` · hàng ${money.format(goods)}` : ""}
        ${flags.length ? `<br><span class="bad">${flags.map(escapeHtml).join("; ")}</span>` : ""}${soft.length ? ` <span class="warn">(${soft.join("; ")})</span>` : ""}
        <span class="bg-day-actions">${batchButton("batch-commit-one", "✅ Cập nhật ngày này", "bg-btn-update", item.name)}${batchButton("batch-edit", "✏️ Sửa", "bg-btn-edit", item.name)}</span></summary>
      <img src="${imageUrl(item.name)}" alt="" class="bg-day-img" />
      <table><thead><tr><th>#</th><th>Khách</th><th>Điểm</th><th>Hàng</th><th>Tiền</th></tr></thead><tbody>${lines}</tbody></table>
      ${item.note ? `<p>Ghi chú AI: ${escapeHtml(item.note)}</p>` : ""}
    </details>`;
  }

  function postBatchReport(title) {
    const open = bg.batch.filter((item) => item.status === "ready");
    const ready = open.filter((item) => !batchFlags(item).flags.length);
    const flagged = open.length - ready.length;
    const sum = (items, fn) => items.reduce((total, item) => total + item.rows.reduce((s, row) => s + fn(row), 0), 0);
    const ordered = [...bg.batch].sort((a, b) => String(a.date || "9").localeCompare(String(b.date || "9")));
    chat("ai", `<p><strong>${escapeHtml(title)}</strong></p>
      <p>${open.length} ngày chờ duyệt: ${sum(open, () => 1)} đơn · ${number.format(sum(open, (row) => parseNumber(row.phoSoiKg)))} cây · tiền mặt ${money.format(sum(open, (row) => parseNumber(row.cashThousand)) * 1000)}.
      ${flagged ? `<span class="bad">${flagged} ngày cần xem (⚠) — bấm vào ngày để mở, sửa rồi cập nhật riêng.</span>` : `<span class="good">Không ngày nào bất thường.</span>`}</p>
      <p class="bg-legend">Bấm vào từng ngày để xem chi tiết và ảnh gốc.</p>
      ${ordered.map(batchItemHtml).join("")}
      <div class="bg-msg-actions">
        ${ready.length ? batchButton("batch-commit", `✅ Cập nhật ${ready.length} ngày ổn`, "bg-btn-update") : ""}
        ${flagged ? batchButton("batch-commit-all", `Cập nhật cả ${open.length} ngày (kể cả ⚠)`, "bg-btn-edit") : ""}
      </div>`);
  }

  async function scanBatch(names) {
    names = [...new Set(names.filter(Boolean))];
    if (!names.length) {
      chat("ai", "Không có ảnh nào đang chờ.");
      return;
    }
    if (bg.busy) return;
    bg.busy = true;
    selectImage("");
    const model = bg.runModel;
    names.forEach((name) => {
      const existing = bg.batch.find((item) => item.name === name);
      if (existing) Object.assign(existing, { status: "scanning", rows: [], error: "" });
      else bg.batch.push({ name, status: "scanning", rows: [], date: "", pageCash: 0, note: "" });
    });
    const progress = typing(`Đang scan 0/${names.length} ảnh...`);
    let finished = 0;
    const queue = [...names];
    async function worker() {
      while (queue.length) {
        const name = queue.shift();
        const item = bg.batch.find((entry) => entry.name === name);
        try {
          const data = await api("POST", { action: "read", imageName: name, model });
          Object.assign(item, {
            status: "ready",
            rows: (data.rows || []).map((row) => ({ ...row, points: (row.points || []).join(", ") })),
            date: data.date || "",
            aiDate: data.date || "",
            pageCash: Number(data.pageCashThousand || 0),
            note: data.note || "",
            cost: data.cost || 0,
          });
        } catch (error) {
          Object.assign(item, { status: "error", error: error.message });
        }
        finished += 1;
        progress.innerHTML = `<span class="bg-typing">Đang scan ${finished}/${names.length} ảnh...</span>`;
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, names.length) }, worker));
    } finally {
      progress.remove();
      bg.busy = false;
    }
    const cost = bg.batch.reduce((sum, item) => sum + Number(item.cost || 0), 0);
    postBatchReport(`Đã scan ${names.length} ảnh${cost ? ` · chi phí ~$${cost.toFixed(4)}` : ""}`);
  }

  function saveActiveToBatch() {
    const item = bg.batch.find((entry) => entry.name === bg.selected);
    if (!item) return;
    item.rows = bg.rows;
    item.date = $("#bgOrderDate").value || item.date;
  }

  function openBatchItem(name) {
    saveActiveToBatch();
    const item = bg.batch.find((entry) => entry.name === name);
    if (!item || item.status !== "ready") return;
    selectImage(name);
    bg.rows = item.rows;
    bg.aiDate = item.aiDate || "";
    bg.pageCash = item.pageCash;
    bg.aiNote = item.note;
    if (item.date) $("#bgOrderDate").value = item.date;
    renderRows();
    showDateWarning();
    postReport(`Đang sửa ngày ${item.date ? formatDate(item.date) : "(chưa rõ ngày — chọn ngày ở cột trái)"}`);
    $("#bgEditor").open = true;
  }

  function orderPayloads(rows, date) {
    return rows.map((row) => {
      const points = String(row.points || "").trim();
      const payload = {
        customerCode: row.customerCode,
        khachTrenAnh: row.khachTrenAnh || "",
        orderDate: date,
        nhaXe: row.nhaXe || "",
        ghiChu: [points ? `Điểm giao ${points}` : "", row.ghiChu || ""].filter(Boolean).join(" · "),
        phoSoiUnit: row.phoSoiUnit || "cay",
        cash: Math.round(parseNumber(row.cashThousand) * 1000),
      };
      productColumns().forEach((column) => { payload[column.field] = parseNumber(row[column.field]); });
      return payload;
    });
  }

  async function commitBatch(includeFlagged = false, onlyName = "") {
    if (bg.busy) return;
    saveActiveToBatch();
    const targets = bg.batch
      .filter((item) => item.status === "ready")
      .filter((item) => !onlyName || item.name === onlyName)
      .filter((item) => onlyName || includeFlagged || !batchFlags(item).flags.length)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const blocked = targets.filter((item) => !item.date || item.rows.some((row) => !row.customerCode));
    if (blocked.length) {
      chat("ai", `Có ${blocked.length} ngày chưa có ngày giao hoặc còn dòng chưa rõ khách, không thể cập nhật. Mở ngày đó ra sửa trước nhé.`, "err");
      return;
    }
    if (!targets.length) {
      const left = bg.batch.filter((item) => item.status === "ready").length;
      chat("ai", left ? `Còn ${left} ngày có dấu ⚠ nên tôi chưa tự cập nhật. Mở ngày đó sửa rồi bấm Cập nhật, hoặc bấm "Cập nhật cả … ngày (kể cả ⚠)".` : "Không có ngày nào sẵn sàng để cập nhật.");
      return;
    }
    bg.busy = true;
    selectImage("");
    const progress = typing(`Đang ghi ${targets.length} ngày vào sổ...`);
    const done = [];
    const failed = [];
    let cashTotal = 0;
    for (const item of targets) {
      try {
        const data = await api("POST", { action: "save", imageName: item.name, orders: orderPayloads(item.rows, item.date) });
        applyLocalCrmPatch({ orders: data.orders || [], payments: data.payments || [] });
        cashTotal += (data.payments || []).reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
        item.status = "done";
        done.push(item);
        progress.innerHTML = `<span class="bg-typing">Đã ghi ${done.length}/${targets.length} ngày...</span>`;
      } catch (error) {
        failed.push(`${item.date ? formatDate(item.date) : item.name}: ${error.message}`);
      }
    }
    progress.remove();
    bg.busy = false;
    const orders = done.reduce((sum, item) => sum + item.rows.length, 0);
    chat("ai", `✅ Đã cập nhật <strong>${done.length} ngày</strong> (${done.map((item) => formatDate(item.date)).join(", ")}): ${orders} đơn, tiền mặt ${money.format(cashTotal)}. Sản lượng và công nợ đã cập nhật, ảnh đã chuyển sang da-nhap-lieu.`
      + (failed.length ? `<br><span class="bad">Chưa ghi được: ${failed.map(escapeHtml).join("; ")}</span>` : ""), failed.length ? "err" : "ok");
    await loadPending();
    if (bg.batch.some((item) => item.status === "ready" || item.status === "error")) postBatchReport("Các ngày còn lại");
    else bg.batch = [];
  }

  function handleBatchAction(act, name) {
    if (bg.busy) return;
    if (act === "batch-scan") scanBatch(name.split("|"));
    if (act === "batch-offer") offerBatch(bg.pending.map((item) => item.name));
    if (act === "batch-rescan") scanBatch([name]);
    if (act === "batch-edit") openBatchItem(name);
    if (act === "batch-commit") commitBatch(false);
    if (act === "batch-commit-all") commitBatch(true);
    if (act === "batch-commit-one") commitBatch(true, name);
  }

  $("#bgScanAll").addEventListener("click", () => {
    if (bg.pending.length) offerBatch(bg.pending.map((item) => item.name));
    else chat("ai", "Không có ảnh nào đang chờ.");
  });

  // ---------- Nút chat nổi trên mọi trang ----------
  const floatButton = document.createElement("button");
  floatButton.type = "button";
  floatButton.id = "bgChatFloat";
  floatButton.className = "bg-chat-float hidden";
  floatButton.innerHTML = "💬 <strong>Trợ lý nhập liệu</strong>";
  document.body.appendChild(floatButton);
  floatButton.addEventListener("click", () => {
    switchView("banGiao");
    openView();
    setTimeout(() => {
      $("#bgChat").scrollIntoView({ behavior: "smooth", block: "center" });
      $("#bgChatInput").focus();
    }, 50);
  });
  function syncFloatButton() {
    const show = state.user?.role === "manager" && !$("#appPanel").classList.contains("hidden") && !$("#banGiaoView").classList.contains("active");
    floatButton.classList.toggle("hidden", !show);
  }
  new MutationObserver(syncFloatButton).observe($("#banGiaoView"), { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(syncFloatButton).observe($("#appPanel"), { attributes: true, attributeFilter: ["class"] });

  // ---------- Mở màn hình ----------
  $("#bgSwitchPho").addEventListener("click", () => switchBusinessUnit("pho"));

  function openView() {
    if (!$("#bgOrderDate").value) $("#bgOrderDate").value = todayInVietnam();
    bg.dateTouched = false;
    loadSettings();
    if (!bg.models.length) loadModels();
    loadPending();
    renderRows();
    greet();
  }
  document.addEventListener("click", (event) => {
    if (event.target.closest('[data-view="banGiao"]')) setTimeout(openView, 0);
  });

  // Mỗi lần CRM tải lại (đổi xưởng, lưu đơn...) thì vẽ lại bảng theo danh sách khách mới.
  // Đổi sang xưởng khác thì bỏ bảng đang xem để tránh lưu nhầm phân hệ.
  const originalRenderAll = renderAll;
  renderAll = function renderAllWithBanGiao(...args) {
    originalRenderAll(...args);
    if (bg.unit !== state.businessUnit) {
      selectImage(bg.selected);
      if (!$("#bgSettings").classList.contains("hidden")) loadAliases();
    } else renderRows();
  };
})();
