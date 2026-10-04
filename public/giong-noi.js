// Nhập đơn Xưởng Mì bằng giọng nói (dùng hàm chung của app.js).
(() => {
  const API = "/api/giong-noi";
  const QTY = [
    { field: "miKg", label: "Mì", unit: "kg", main: true },
    { field: "caoKg", label: "Da cảo", unit: "kg", main: true },
    { field: "hoanhKg", label: "Da hoành", unit: "kg", main: true },
    { field: "huTieu", label: "Hủ tiếu", unit: "" },
    { field: "voBanhGoi", label: "Vỏ bánh gối", unit: "" },
    { field: "thungXop", label: "Thùng xốp", unit: "thùng" },
  ];
  const vc = { pending: [], history: [], busy: false, listening: false, recognition: null, finalText: "", transcript: [], recordings: [], heardFull: [] };
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canListen = Boolean(Recognition) && window.isSecureContext;

  async function api(method, body, query = "") {
    const response = await fetchWithTimeout(`${API}?businessUnit=${state.businessUnit}${query}`, {
      method,
      headers: authHeaders(body ? { "content-type": "application/json" } : {}),
      body: body ? JSON.stringify({ businessUnit: state.businessUnit, ...body }) : undefined,
    }, 70000);
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || `Máy chủ báo lỗi (HTTP ${response.status}).`);
    return data;
  }

  const kg = (value) => number.format(parseNumber(value));
  const nameOf = (code) => customerForCode(code)?.TenKH || code || "";

  // ---------- Cài đặt nghe ----------
  const store = {
    get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* bỏ qua */ } },
  };
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder) && window.isSecureContext;
  vc.mode = store.get("vcListenMode", "chrome");
  if (vc.mode === "ai" && !canRecord) vc.mode = "chrome";
  if (vc.mode === "chrome" && !canListen && canRecord) vc.mode = "ai";

  // ---------- Đọc to ----------
  function speak(text) {
    return new Promise((resolve) => {
      if (!$("#vcSpeak").checked || !window.speechSynthesis || !text) {
        resolve();
        return;
      }
      try {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = "vi-VN";
        const voice = window.speechSynthesis.getVoices().find((item) => /^vi/i.test(item.lang));
        if (voice) utterance.voice = voice;
        utterance.rate = Number(store.get("vcRate", "1"));
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        utterance.onend = finish;
        utterance.onerror = finish;
        // Một số máy không báo xong: tự mở lại micro sau thời gian ước lượng.
        setTimeout(finish, Math.min(60000, 1500 + text.length * 90));
        window.speechSynthesis.speak(utterance);
      } catch {
        resolve();
      }
    });
  }

  // ---------- Hội thoại ----------
  function say(role, html, tone = "") {
    const box = $("#vcLog");
    const message = document.createElement("div");
    message.className = `bg-msg ${role === "me" ? "me" : "ai"}${tone ? ` ${tone}` : ""}`;
    message.innerHTML = html;
    box.appendChild(message);
    box.scrollTop = box.scrollHeight;
    return message;
  }

  // Lời đang nói hiện thẳng lên khung chat (chữ nghiêng), chốt câu thì mới gửi đi phân tích.
  function liveBubble(text) {
    const value = String(text || "").trim();
    if (!value) return;
    if (!vc.live || !vc.live.isConnected) vc.live = say("me", "", "live");
    vc.live.innerHTML = `🎙 ${escapeHtml(value)} <span class="bg-typing">…</span>`;
    $("#vcLog").scrollTop = $("#vcLog").scrollHeight;
  }
  function takeLive() {
    const bubble = vc.live && vc.live.isConnected ? vc.live : null;
    vc.live = null;
    return bubble;
  }
  function meBubble(html, bubble) {
    if (!bubble) return say("me", html);
    bubble.classList.remove("live");
    bubble.innerHTML = html;
    return bubble;
  }

  // Bước 1: mô hình nghe âm thanh chép lại lời nói (chưa phân tích).
  function transcribe(audio, extra = {}) {
    return api("POST", { action: "transcribe", audio, date: $("#vcDate").value, session: vc.sessionId, ...extra });
  }

  // "📝 Hiểu là": đọc lại những đơn vừa thêm/sửa để người nói yên tâm trước khi vào bảng.
  function orderLine(row) {
    const customer = row.customerCode ? customerForCode(row.customerCode) : null;
    const name = customer
      ? (normalizeVietnamese(customer.TenKH).includes(normalizeVietnamese(customer.MaKH)) ? customer.TenKH : `${customer.MaKH} ${customer.TenKH}`)
      : `❓ “${row.tenKhachNoi || "?"}” (chưa rõ khách)`;
    const goods = QTY.filter((item) => parseNumber(row[item.field])).map((item) => `${item.label.toLowerCase()} ${kg(row[item.field])}${item.unit === "kg" ? " ký" : item.unit ? ` ${item.unit}` : ""}`);
    const bits = [
      `📅 ${formatDate(row.orderDate || $("#vcDate").value)}`,
      goods.length ? goods.join(", ") : "⚠ chưa có số lượng",
      row.nhaXe ? `xe ${row.nhaXe}` : "",
      parseNumber(row.tienUng) ? `chành ${money.format(parseNumber(row.tienUng))}đ` : "",
      row.taxRate !== null && row.taxRate !== undefined && row.taxRate !== "" ? `thuế ${row.taxRate}%` : "",
    ].filter(Boolean);
    return `<strong>${escapeHtml(name)}</strong> · ${escapeHtml(bits.join(" · "))}`;
  }
  const rowKey = (row) => JSON.stringify([row.customerCode, row.tenKhachNoi, row.orderDate, row.nhaXe, parseNumber(row.tienUng), row.taxRate ?? null, ...QTY.map((item) => parseNumber(row[item.field]))]);
  function understood(before, after, title = "📝 Hiểu là") {
    const old = new Set(before.map(rowKey));
    const changed = after.filter((row) => !old.has(rowKey(row)));
    const removed = before.length > after.length ? before.length - after.length : 0;
    if (!changed.length && !removed) return null;
    return say("ai", `${title}:<ul class="vc-understood">${changed.map((row) => `<li>${orderLine(row)}</li>`).join("")}</ul>${removed ? `<small class="bg-legend">Bỏ ${removed} dòng.</small>` : ""}`);
  }

  // So từng chữ bản nghe nhanh với bản nghe lại, tô những chữ đã sửa.
  function wordDiff(draft, fixed) {
    const a = String(draft || "").split(/\s+/).filter(Boolean).slice(0, 1500);
    const b = String(fixed || "").split(/\s+/).filter(Boolean).slice(0, 1500);
    const key = (word) => normalizeVietnamese(word).replace(/[.,;:!?]/g, "");
    const dp = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i -= 1) {
      for (let j = b.length - 1; j >= 0; j -= 1) {
        dp[i][j] = key(a[i]) === key(b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    let fixes = 0;
    while (j < b.length) {
      if (i < a.length && key(a[i]) === key(b[j])) { out.push(escapeHtml(b[j])); i += 1; j += 1; }
      else if (i < a.length && dp[i + 1][j] >= dp[i][j + 1]) { out.push(`<del>${escapeHtml(a[i])}</del>`); i += 1; fixes += 1; }
      else { out.push(`<ins>${escapeHtml(b[j])}</ins>`); j += 1; fixes += 1; }
    }
    while (i < a.length) { out.push(`<del>${escapeHtml(a[i])}</del>`); i += 1; fixes += 1; }
    return { html: out.join(" "), fixes };
  }

  const GREETING = "Chào bạn. Hôm nay bạn cần báo hàng cho khách nào? Bạn nói tên khách, xe gì nếu có gửi xe, tiền chành nếu có, rồi mì, cảo, hoành bao nhiêu ký. Không biết nói sao thì cứ hỏi tôi.";
  const HELP = "Bạn nói theo thứ tự: tên khách, xe gì nếu có gửi xe, tiền chành nếu có, rồi số ký. Ví dụ: Long Xuyên, xe Ba Nhi, chành 20, mì 28 ký, cảo 24 ký. Nói mã khách kèm tên cũng được, ví dụ: Wiki Fresh em 69, hoành 30 ký. Tôi đọc lại, đúng thì bạn nói: lưu.";

  // Hướng dẫn: mở sẵn cho lần đầu, có nút đọc to cho người không quen chữ.
  const GUIDE_SPEECH = "Hướng dẫn. Bước một: bấm nút màu vàng, bắt đầu nói chuyện. Bước hai: nói tên khách, xe gì nếu có gửi xe, tiền chành nếu có, rồi mì, cảo, hoành bao nhiêu ký. Ví dụ: Long Xuyên, xe Ba Nhi, chành 20, mì 28 ký, cảo 24 ký. Bước ba: nghe tôi đọc lại, mỗi khách hiện thành một dòng trong bảng, sai thì nói lại chỗ sai. Bước bốn: đúng rồi thì nói, lưu. Xong việc thì nói, xong rồi.";
  if (store.get("vcGuideSeen", "") !== "1") $("#vcGuide").open = true;
  $("#vcGuide").addEventListener("toggle", () => { if (!$("#vcGuide").open) store.set("vcGuideSeen", "1"); });
  $("#vcGuideSpeak").addEventListener("click", (event) => {
    event.preventDefault();
    const wasOff = !$("#vcSpeak").checked;
    $("#vcSpeak").checked = true;
    speak(GUIDE_SPEECH).then(() => { if (wasOff) $("#vcSpeak").checked = false; });
  });

  function greet() {
    if ($("#vcLog").children.length) return;
    say("ai", `Chào ${escapeHtml(state.user?.displayName || "bạn")}. Bấm <strong>🗣 Bắt đầu nói chuyện</strong>, tôi sẽ hỏi và đọc lại bằng giọng nói, bạn chỉ cần nói.<br>
      Ví dụ: <em>“Long Xuyên, xe Ba Nhi, chành 20, mì 28 ký, cảo 24 ký”</em> · <em>“Wiki Fresh M69, hoành 30 ký”</em><br>
      Nghe tôi đọc lại, đúng thì nói <strong>“lưu”</strong>; không biết nói sao thì nói <strong>“hướng dẫn”</strong>; xong việc thì nói <strong>“xong rồi”</strong>.`);
  }

  // ---------- Micro: Chrome nhận giọng ----------
  function setMicHint() {
    const modeText = vc.mode === "ai"
      ? "Đang nghe bằng AI (ghi âm gửi thẳng cho AI, chỗ ồn vẫn nghe tốt)."
      : "Đang nghe bằng Chrome (nhanh, miễn phí).";
    $("#vcMicHint").innerHTML = (canListen || canRecord)
      ? `${modeText} Bấm 🎤 để nói một câu, hoặc 🗣 để nói chuyện rảnh tay (tự nghe, tự đọc lại).`
      : (window.isSecureContext
        ? "Trình duyệt này không có nhận giọng nói. Bấm vào ô chữ rồi dùng <strong>nút micro trên bàn phím điện thoại</strong>, xong bấm Gửi. (Chrome hỗ trợ tốt nhất.)"
        : "Trang đang mở bằng địa chỉ không bảo mật nên trình duyệt chặn micro. Bấm vào ô chữ rồi dùng <strong>nút micro trên bàn phím điện thoại</strong>, xong bấm Gửi.");
    $("#vcTalk").classList.toggle("hidden", !(canListen || canRecord));
    $("#vcMode").value = vc.mode;
    [...$("#vcMode").options].forEach((option) => {
      option.disabled = option.value === "ai" ? !canRecord : !canListen;
    });
  }

  function setListening(on, label) {
    vc.listening = on;
    if (on) vc.lastMicError = "";
    $("#vcMic").classList.toggle("on", on);
    $("#vcMicLabel").textContent = label || (on ? "Đang nghe… bấm để gửi" : "Bấm để nói");
  }

  // Máy chủ bản cũ gửi lệnh cấm micro cho cả trang (Permissions-Policy microphone=()), trình duyệt tự chặn không hỏi.
  function pageBlocksMic() {
    const policy = document.permissionsPolicy || document.featurePolicy;
    try {
      return Boolean(policy && !policy.allowsFeature("microphone"));
    } catch {
      return false;
    }
  }
  const OLD_SERVER = "⚠ <strong>Máy chủ đang chạy bản cũ</strong> nên chặn micro và chưa có phần giọng nói. Mở Terminal, bấm <strong>Ctrl+C</strong> rồi chạy lại <code>npm run local</code>, sau đó tải lại trang (Cmd+Shift+R).";

  function micError(error) {
    if (error === "not-allowed" || error === "service-not-allowed" || error === "NotAllowedError") {
      stopTalk();
      if (vc.lastMicError === error) return;
      vc.lastMicError = error;
      if (pageBlocksMic()) say("ai", OLD_SERVER, "err");
      else say("ai", "Trình duyệt chưa cho dùng micro. Bấm biểu tượng bên trái địa chỉ trang (hình ⓘ hoặc ổ khóa) → Micrô → Cho phép, rồi tải lại trang. Máy Mac: Cài đặt hệ thống → Quyền riêng tư & Bảo mật → Micrô → bật Google Chrome.", "err");
    } else if (error && error !== "no-speech" && error !== "aborted") {
      say("ai", `Micro lỗi: ${escapeHtml(error)}. Thử lại hoặc gõ chữ.`, "err");
    }
  }

  // Chrome bản mới nhận giọng từ đúng micro đã chọn qua recognition.start(track) (cách của trang ghi âm).
  async function sessionStream() {
    if (vc.micStream && vc.micStream.getAudioTracks().some((track) => track.readyState === "live")) return vc.micStream;
    // Ghi âm cả phiên và Chrome nghe nhanh cùng xin mic một lúc: dùng chung một luồng.
    if (!vc.micOpening) vc.micOpening = getMicStream().finally(() => { vc.micOpening = null; });
    vc.micStream = await vc.micOpening;
    return vc.micStream;
  }
  function releaseStream() {
    if (vc.sessionRec && vc.sessionRec.state !== "inactive") return;
    vc.micStream?.getTracks().forEach((track) => track.stop());
    vc.micStream = null;
  }

  async function listenChrome() {
    window.speechSynthesis?.cancel();
    let track = null;
    if (vc.micId && canRecord) {
      try {
        track = (await sessionStream()).getAudioTracks()[0];
      } catch (error) {
        micError(error.name);
        return;
      }
    }
    const recognition = new Recognition();
    recognition.lang = "vi-VN";
    // Chế độ nói chuyện: dừng khi người nói ngừng; bấm tay: nghe liên tục tới khi bấm lại.
    recognition.continuous = vc.batchMode || !vc.talking;
    recognition.interimResults = true;
    vc.finalText = $("#vcText").value.trim();
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const piece = event.results[index][0].transcript;
        if (event.results[index].isFinal) {
          if (vc.batchMode) collectDraft(piece, takeLive());
          else vc.finalText = `${vc.finalText} ${piece}`.trim();
        } else interim += piece;
      }
      $("#vcText").value = vc.batchMode ? interim.trim() : `${vc.finalText} ${interim}`.trim();
      liveBubble($("#vcText").value);
    };
    recognition.onerror = (event) => micError(event.error);
    recognition.onend = () => {
      const wasListening = vc.listening;
      setListening(false);
      vc.recognition = null;
      const hasText = Boolean($("#vcText").value.trim());
      if (vc.batchMode) {
        // Chrome tự ngắt sau một lúc im lặng: đọc một loạt thì mở lại ngay.
        if (hasText) collectDraft($("#vcText").value, takeLive());
        else takeLive()?.remove();
        $("#vcText").value = "";
        if (vc.batchMode) setTimeout(() => vc.batchMode && !vc.listening && listen(), 150);
      } else if (wasListening && (vc.autoSend || vc.talking) && hasText) send();
      else if (vc.talking && !vc.busy) setTimeout(() => vc.talking && !vc.listening && !vc.busy && listen(), 400);
      vc.autoSend = false;
    };
    vc.recognition = recognition;
    setListening(true, vc.batchMode ? "Đang nghe một loạt…" : vc.talking ? "Đang nghe… nói đi" : undefined);
    try {
      if (track) recognition.start(track);
      else recognition.start();
    } catch {
      recognition.start();
      if (track && !vc.warnedTrack) {
        vc.warnedTrack = true;
        say("ai", "Chrome trên máy này chưa hỗ trợ nghe bằng micro đã chọn, đang dùng micro mặc định. Cập nhật Chrome, hoặc chọn <strong>Nghe bằng: AI nghe ghi âm</strong>.", "err");
      }
    }
  }

  // ---------- Micro: ghi âm gửi AI ----------
  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const text = (offset, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); text(8, "WAVE"); text(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data");
    view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, index) => {
      const value = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
    });
    return buffer;
  }

  async function decodeBlob(blob) {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    try {
      return await context.decodeAudioData(await blob.arrayBuffer());
    } finally {
      context.close();
    }
  }

  async function listenAi() {
    window.speechSynthesis?.cancel();
    let stream;
    try {
      stream = await getMicStream();
    } catch (error) {
      micError(error.name || error.message);
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    audioContext.createMediaStreamSource(stream).connect(analyser);
    const levels = new Uint8Array(analyser.fftSize);
    const started = Date.now();
    let heard = false;
    let quietSince = 0;
    // Tự dừng khi im lặng 1,6 giây sau khi đã nói (chế độ nói chuyện), hoặc sau 60 giây.
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(levels);
      const rms = Math.sqrt(levels.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / levels.length);
      $("#vcMic").style.setProperty("--level", Math.min(1, rms * 8).toFixed(2));
      showLevel(rms);
      if (rms > 0.035) { heard = true; quietSince = 0; } else if (heard && !quietSince) quietSince = Date.now();
      const auto = vc.talking;
      const silentLong = auto && heard && quietSince && Date.now() - quietSince > 1600;
      const nothing = auto && !heard && Date.now() - started > 12000;
      if (silentLong || nothing || Date.now() - started > 60000) stop(nothing ? "nothing" : "auto");
    }, 120);
    let stopped = false;
    function stop(reason) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      vc.stopReason = reason;
      if (recorder.state !== "inactive") recorder.stop();
    }
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      audioContext.close();
      showLevel(0);
      setListening(false);
      vc.recorderStop = null;
      if (vc.stopReason === "cancel") return;
      if (!heard || vc.stopReason === "nothing") {
        if (vc.talking) setTimeout(() => vc.talking && listen(), 300);
        return;
      }
      try {
        const decoded = await decodeBlob(new Blob(chunks, { type: recorder.mimeType }));
        const speech = speechOnly(decoded);
        if (speech.speechSeconds < 0.6) {
          if (vc.talking) setTimeout(() => vc.talking && listen(), 300);
          return;
        }
        const data = await samplesToWavBase64(speech.samples, speech.rate);
        send({ audio: { data, format: "wav" }, seconds: speech.seconds });
      } catch (error) {
        say("ai", `Không đọc được đoạn ghi âm: ${escapeHtml(error.message)}`, "err");
      }
    };
    vc.recorderStop = stop;
    recorder.start(250);
    setListening(true, vc.talking ? "Đang nghe… nói đi" : "Đang ghi âm… bấm để gửi");
  }

  function listen() {
    if ((vc.busy && !vc.batchMode) || vc.listening || state.businessUnit !== "mi") return;
    if (pageBlocksMic()) {
      if (vc.lastMicError !== "policy") say("ai", OLD_SERVER, "err");
      vc.lastMicError = "policy";
      stopTalk();
      return;
    }
    if (vc.noMic) {
      say("ai", "Chưa thấy micro nào. Cắm micro vào (hoặc bật micro trong cài đặt âm thanh của máy), rồi bấm Thử.", "err");
      stopTalk();
      return;
    }
    if (vc.batchMode) {
      // Đọc một loạt: phiên ghi âm lo phần nghe chính; Chrome (nếu có) chỉ để hiện chữ ngay trên chat.
      if (canListen && vc.mode !== "ai") listenChrome();
      return;
    }
    if (vc.mode === "ai" && canRecord) listenAi();
    else if (canListen) listenChrome();
    else $("#vcText").focus();
  }

  function stopListening(sendIt) {
    if (vc.recognition) {
      vc.autoSend = sendIt;
      if (!sendIt) vc.listening = false;
      vc.recognition.stop();
    }
    if (vc.recorderStop) vc.recorderStop(sendIt ? "manual" : "cancel");
  }

  $("#vcMic").addEventListener("click", () => {
    if (vc.busy) return;
    if (vc.listening) stopListening(true);
    else listen();
  });

  // ---------- Chọn micro ----------
  // Chrome (Web Speech) chỉ nghe micro mặc định của hệ điều hành; chọn micro khác thì dùng chế độ AI ghi âm.
  const isPhone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  vc.micId = isPhone ? "" : store.get("vcMicId", "");

  function showLevel(rms) {
    const bar = $("#vcLevel");
    if (bar) bar.style.width = `${Math.round(Math.min(1, rms * 8) * 100)}%`;
  }

  async function getMicStream() {
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (vc.micId) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: vc.micId } } });
      } catch (error) {
        if (error.name !== "OverconstrainedError" && error.name !== "NotFoundError") throw error;
        say("ai", "Micro đã chọn không còn cắm vào máy, tôi dùng micro mặc định.", "err");
        chooseMic("", false);
      }
    }
    return navigator.mediaDevices.getUserMedia({ audio: base });
  }

  async function loadMics(askPermission) {
    const select = $("#vcMicSelect");
    if (isPhone || !navigator.mediaDevices?.enumerateDevices) {
      select.closest(".vc-mic-row").classList.add("hidden");
      $("#vcMicPhone").classList.toggle("hidden", !isPhone);
      return;
    }
    let devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
    if (askPermission && devices.length && !devices.some((device) => device.label) && window.isSecureContext) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((track) => track.stop());
        devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
      } catch (error) {
        micError(error.name);
      }
    }
    vc.noMic = devices.length === 0;
    if (vc.noMic) {
      select.innerHTML = '<option value="">⚠ Chưa có micro</option>';
      select.disabled = true;
      $("#vcMicHint").innerHTML = "⚠ <strong>Máy chưa có micro.</strong> Cắm micro/tai nghe có micro, hoặc bật micro trong cài đặt âm thanh (Mac: Cài đặt hệ thống → Âm thanh → Đầu vào; Windows: Cài đặt → Âm thanh → Đầu vào), rồi bấm Thử.";
      return;
    }
    select.disabled = false;
    const defaultDevice = devices.find((device) => device.deviceId === "default");
    const defaultName = defaultDevice?.label.replace(/^(Default|Mặc định)\s*-\s*/i, "") || "";
    const real = devices.filter((device) => !["default", "communications"].includes(device.deviceId));
    const named = real.some((device) => device.label);
    select.innerHTML = `<option value="">Mặc định của máy${defaultName ? ` (${escapeHtml(defaultName)})` : ""}</option>`
      + real.map((device, index) => `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.label || `Micro ${index + 1}`)}${/built-in|tích hợp|macbook/i.test(device.label) ? " · có sẵn trong máy" : ""}</option>`).join("")
      + (named ? "" : '<option value="__ask">🔓 Cho phép micro để xem tên từng micro…</option>');
    if (vc.micId && !real.some((device) => device.deviceId === vc.micId)) {
      if (store.get("vcMicId", "")) say("ai", "Micro đã chọn lần trước không còn cắm, đang dùng micro mặc định của máy.", "err");
      chooseMic("", false);
    }
    select.value = vc.micId;
  }

  function chooseMic(id, announce = true) {
    vc.micId = id;
    store.set("vcMicId", id);
    $("#vcMicSelect").value = id;
    vc.micStream?.getTracks().forEach((track) => track.stop());
    vc.micStream = null;
    if (announce && id) testMic();
  }

  async function testMic() {
    if (vc.listening || vc.testing) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      say("ai", "Trang này chưa được dùng micro trực tiếp. Dùng micro trên bàn phím điện thoại nhé.", "err");
      return;
    }
    vc.testing = true;
    $("#vcMicTest").textContent = "Nói đi…";
    let stream;
    try {
      stream = await getMicStream();
    } catch (error) {
      micError(error.name);
      vc.testing = false;
      $("#vcMicTest").textContent = "Thử";
      return;
    }
    const name = stream.getAudioTracks()[0]?.label || "micro";
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const analyser = context.createAnalyser();
    context.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let peak = 0;
    const started = Date.now();
    await new Promise((resolve) => {
      const tick = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length);
        peak = Math.max(peak, rms);
        showLevel(rms);
        if (Date.now() - started > 4000) { clearInterval(tick); resolve(); }
      }, 100);
    });
    stream.getTracks().forEach((track) => track.stop());
    context.close();
    showLevel(0);
    vc.testing = false;
    $("#vcMicTest").textContent = "Thử";
    loadMics(false);
    if (peak > 0.03) say("ai", `🎤 <strong>${escapeHtml(name)}</strong> nghe tốt.`, "ok");
    else say("ai", `🎤 <strong>${escapeHtml(name)}</strong> không nghe thấy tiếng. Kiểm tra micro có bị tắt tiếng, hoặc chọn micro khác.`, "err");
  }

  $("#vcMicSelect").addEventListener("change", () => {
    const value = $("#vcMicSelect").value;
    if (value === "__ask") {
      $("#vcMicSelect").value = vc.micId;
      loadMics(true);
      return;
    }
    chooseMic(value);
  });
  $("#vcMicTest").addEventListener("click", testMic);
  navigator.mediaDevices?.addEventListener?.("devicechange", () => loadMics(false));

  // ---------- Chế độ nói chuyện rảnh tay ----------
  async function startTalk() {
    if (vc.batchMode) stopBatch();
    vc.talking = true;
    $("#vcTalk").classList.add("on");
    $("#vcTalk").textContent = "⏹ Dừng nói chuyện";
    say("ai", escapeHtml(GREETING));
    await speak(GREETING);
    if (vc.talking) listen();
  }
  function stopTalk() {
    vc.talking = false;
    releaseStream();
    $("#vcTalk").classList.remove("on");
    $("#vcTalk").textContent = "🗣 Bắt đầu nói chuyện";
    stopListening(false);
    window.speechSynthesis?.cancel();
  }
  $("#vcTalk").addEventListener("click", () => (vc.talking ? stopTalk() : startTalk()));
  $("#vcMode").addEventListener("change", () => {
    vc.mode = $("#vcMode").value;

    store.set("vcListenMode", vc.mode);
    stopListening(false);
    setMicHint();
  });

  // ---------- Đọc một loạt ----------
  // Đơn giản: bấm 📋 → đọc (ghi âm cả lượt, chữ Chrome chỉ hiện để xem) → bấm ⏹ →
  // mô hình nghe âm thanh chép lời + tự kiểm tra lại với ghi âm → hiện bản chép → phân tích MỘT lần → 📝 Hiểu là → bảng.
  vc.batchMode = false;
  vc.batchDraft = [];

  function normalizeSpeech(text) {
    return String(text || "")
      .replace(/\b(cạo|cáo|kháo)\b/gi, "cảo")
      .replace(/(\d|một|hai|ba|bốn|năm|sáu|bảy|tám|chín|mười|chục|rưỡi)\s+(vành|hoàn|hoằn)\b/gi, "$1 hoành")
      .replace(/\b(em|mờ)\s*(\d{1,3})\b/gi, "M$2");
  }

  function batchStatus() {
    const box = $("#vcBatchStatus");
    box.classList.toggle("hidden", !vc.batchMode && !vc.relistening);
    if (vc.batchMode) {
      const seconds = vc.sessionStart && vc.sessionRec ? Math.round((Date.now() - vc.sessionStart) / 1000) : 0;
      box.innerHTML = `🔴 Đang ghi âm${seconds ? ` ${clock(seconds)}` : ""}. Đọc ngắn gọn: ngày, khách, xe, mì/cảo/hoành bao nhiêu ký. Đọc xong bấm <strong>⏹ Đọc xong</strong>.`;
    } else if (vc.relistening) box.textContent = "Đang nghe lại ghi âm và phân tích…";
  }

  const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

  function collectDraft(text, bubble) {
    const value = normalizeSpeech(String(text || "").trim());
    if (!value) { bubble?.remove(); return; }
    vc.batchDraft.push(value);
    meBubble(`🎙 ${escapeHtml(value)} <small class="bg-legend">(nghe nhanh, chưa phân tích)</small>`, bubble).classList.add("draft");
  }

  async function startSessionRecording() {
    vc.sessionChunks = [];
    vc.sessionRec = null;
    if (!canRecord || (!$("#vcRelisten").checked && vc.mode !== "ai")) return;
    try {
      const stream = await sessionStream();
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((item) => window.MediaRecorder.isTypeSupported?.(item));
      const recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
      recorder.ondataavailable = (event) => { if (event.data.size) vc.sessionChunks.push(event.data); };
      recorder.start(1000);
      vc.sessionRec = recorder;
      vc.sessionStart = Date.now();
      vc.sessionId = String(Date.now());
      vc.batchTimer = setInterval(batchStatus, 1000);
      refreshButtons();
    } catch (error) {
      say("ai", `Không ghi âm được (${escapeHtml(error.name || error.message)}), chỉ dùng chữ Chrome nghe được.`, "err");
    }
  }

  function stopSessionRecording() {
    clearInterval(vc.batchTimer);
    const recorder = vc.sessionRec;
    if (!recorder || recorder.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(vc.sessionChunks, { type: recorder.mimeType || "audio/webm" });
        vc.sessionRec = null;
        releaseStream();
        resolve(blob.size ? blob : null);
      };
      recorder.stop();
    });
  }

  // Cắt bỏ khoảng lặng: chỉ gửi phần có tiếng nói (AI nghe đoạn im lặng dài hay bịa chữ).
  function speechOnly(decoded) {
    const rate = decoded.sampleRate;
    const data = decoded.getChannelData(0);
    const win = Math.max(1, Math.floor(rate * 0.05));
    const levels = [];
    for (let i = 0; i < data.length; i += win) {
      let sum = 0;
      let count = 0;
      for (let k = i; k < Math.min(data.length, i + win); k += 4) { sum += data[k] * data[k]; count += 1; }
      levels.push(Math.sqrt(sum / Math.max(1, count)));
    }
    const sorted = levels.slice().sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
    const threshold = Math.max(0.012, floor * 3);
    const pad = 6; // 6 × 50ms = 0,3 giây mỗi bên
    const keep = new Uint8Array(levels.length);
    let speechWindows = 0;
    levels.forEach((level, index) => {
      if (level < threshold) return;
      speechWindows += 1;
      for (let j = Math.max(0, index - pad); j <= Math.min(levels.length - 1, index + pad); j += 1) keep[j] = 1;
    });
    const gap = Math.floor(rate * 0.25);
    const pieces = [];
    let total = 0;
    for (let i = 0; i < levels.length;) {
      if (!keep[i]) { i += 1; continue; }
      let j = i;
      while (j < levels.length && keep[j]) j += 1;
      const piece = data.subarray(i * win, Math.min(data.length, j * win));
      pieces.push(piece);
      total += piece.length + gap;
      i = j;
    }
    const samples = new Float32Array(total);
    let offset = 0;
    pieces.forEach((piece) => { samples.set(piece, offset); offset += piece.length + gap; });
    return { samples, rate, seconds: samples.length / rate, speechSeconds: (speechWindows * win) / rate };
  }

  async function samplesToWavBase64(samples, rate, from = 0, to = samples.length / rate) {
    const target = 16000;
    const start = Math.floor(from * rate);
    const end = Math.min(samples.length, Math.floor(to * rate));
    const length = Math.max(1, end - start);
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil((length / rate) * target)), target);
    const piece = offline.createBuffer(1, length, rate);
    piece.copyToChannel(samples.subarray(start, end), 0);
    const source = offline.createBufferSource();
    source.buffer = piece;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    const bytes = new Uint8Array(encodeWav(rendered.getChannelData(0), target));
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  const PART_SECONDS = 90; // mỗi phần WAV 16kHz tối đa ~2,9MB

  // Ghi âm → chữ (mỗi phần: AI chép rồi tự nghe lại để kiểm tra). Trả về cả bản chép.
  async function transcribeRecording(blob) {
    const decoded = await decodeBlob(blob);
    const speech = speechOnly(decoded);
    if (speech.speechSeconds < 0.6) return { text: "", empty: true };
    const parts = Math.max(1, Math.ceil(speech.seconds / PART_SECONDS));
    const texts = [];
    for (let part = 1; part <= parts; part += 1) {
      const from = (part - 1) * PART_SECONDS;
      const to = Math.min(speech.seconds, part * PART_SECONDS);
      const bubble = say("me", `<span class="bg-typing">🎧 AI đang nghe ghi âm${parts > 1 ? ` (phần ${part}/${parts})` : ""} rồi kiểm tra lại…</span>`);
      const data = await samplesToWavBase64(speech.samples, speech.rate, from, to);
      const heard = await transcribe({ data, format: "wav" }, { keep: true, part, parts, seconds: to - from });
      if (heard.savedAudio) vc.recordings.push(heard.savedAudio);
      vc.lastListenModel = heard.model;
      const text = normalizeSpeech(heard.text);
      bubble.innerHTML = `🎧 ${escapeHtml(text || "(không nghe rõ)")}<br><small class="bg-legend">${escapeHtml(heard.model)} chép từ ghi âm${heard.checked ? " · ✔ đã nghe lại để kiểm tra" : ""}${heard.fixes ? ` · sửa ${escapeHtml(heard.fixes)}` : ""}</small>`;
      if (text) texts.push(text);
    }
    return { text: texts.join(" ").trim(), seconds: decoded.duration };
  }

  function startBatch() {
    if (vc.talking) stopTalk();
    stopListening(false);
    window.speechSynthesis?.cancel();
    vc.batchMode = true;
    vc.batchDraft = [];
    vc.spokenDate = "";
    vc.recordings = [];
    vc.sessionReady = startSessionRecording();
    $("#vcBatch").classList.add("on");
    $("#vcBatch").textContent = "⏹ Đọc xong";
    say("ai", "Bắt đầu ghi âm. Đọc ngắn gọn, ví dụ: <em>“Ngày 15 tháng 9. M67 mì 18 ký. M29 Châu Đốc xe Huệ Nghĩa, mì 39, cảo 41.”</em> Đọc xong bấm <strong>⏹ Đọc xong</strong>, tôi nghe lại ghi âm rồi mới phân tích.");
    batchStatus();
    refreshButtons();
    listen();
  }

  function stopBatch() {
    if (!vc.batchMode) return;
    vc.batchMode = false;
    if (vc.recognition) {
      const interim = $("#vcText").value.trim();
      $("#vcText").value = "";
      const bubble = takeLive();
      vc.listening = false;
      vc.recognition.onend = () => { setListening(false); vc.recognition = null; };
      vc.recognition.stop();
      if (interim) collectDraft(interim, bubble);
      else bubble?.remove();
    }
    $("#vcBatch").classList.remove("on");
    $("#vcBatch").textContent = "📋 Đọc một loạt";
    finishBatch();
  }

  async function finishBatch() {
    vc.relistening = true;
    refreshButtons();
    batchStatus();
    const draft = vc.batchDraft.join(" ").trim();
    let full = draft;
    let fromAudio = false;
    try {
      await vc.sessionReady;
      const recording = await stopSessionRecording();
      if (recording) {
        try {
          const result = await transcribeRecording(recording);
          if (result.empty) {
            say("ai", "Tôi không nghe thấy tiếng nói trong ghi âm. Kiểm tra micro (nút Thử) rồi đọc lại giúp tôi.", "err");
            speak("Tôi không nghe thấy tiếng nói. Bạn đọc lại giúp tôi.");
            return;
          }
          full = result.text;
          fromAudio = true;
        } catch (error) {
          say("ai", `⚠ Chưa nghe lại được ghi âm: ${escapeHtml(error.message)}.${draft ? " Tạm dùng chữ Chrome nghe nhanh — xem thật kỹ trước khi lưu." : ""}`, "err");
        }
      }
      if (!full) {
        say("ai", "Chưa nghe được gì. Bạn đọc lại giúp tôi.", "err");
        return;
      }
      if (fromAudio && draft && normalizeVietnamese(draft) !== normalizeVietnamese(full)) {
        const diff = wordDiff(draft, full);
        if (diff.fixes) say("ai", `<div class="vc-diff"><small class="bg-legend">So với chữ Chrome nghe nhanh — <ins>chữ xanh</ins> là chữ đúng theo ghi âm, <del>chữ gạch</del> là chữ nghe nhanh bị sai:</small><p>${diff.html}</p></div>`);
      }
      vc.transcript.push(full);
      const wait = say("ai", '<span class="bg-typing">🧠 Đang phân tích…</span>');
      const before = vc.pending.map((row) => ({ ...row }));
      let result;
      try {
        result = await api("POST", {
          action: "parse",
          multi: true,
          text: full,
          model: vc.runModel || undefined,
          pending: vc.pending,
          history: [],
          date: $("#vcDate").value,
        });
      } finally {
        wait.remove();
      }
      mergeOrders(result.orders || []);
      if (fromAudio) vc.pending.forEach((row) => { if (!before.some((old) => rowKey(old) === rowKey(row))) row.checked = true; });
      const shown = understood(before, vc.pending);
      if (!shown) say("ai", "📝 Không thấy đơn mới trong lời vừa đọc.", "err");
      if (result.question) say("ai", `<strong>❓ ${escapeHtml(result.question)}</strong>`);
      const ready = readyRows().length;
      const missing = vc.pending.length - ready;
      const text = vc.pending.length
        ? `Đã ghi ${vc.pending.length} khách${missing ? `, còn ${missing} dòng cần sửa` : ""}. Xem bảng, đúng thì bấm Lưu.`
        : "Chưa ghi được khách nào. Bạn đọc lại giúp tôi.";
      say("ai", escapeHtml(text), missing ? "err" : "ok");
      speak(result.question || text);
    } catch (error) {
      say("ai", `Có lỗi khi phân tích: ${escapeHtml(error.message)}`, "err");
    } finally {
      vc.relistening = false;
      vc.batchDraft = [];
      refreshButtons();
      renderPending();
      batchStatus();
    }
  }

  $("#vcBatch").addEventListener("click", () => (vc.batchMode ? stopBatch() : startBatch()));

  // Gộp kết quả AI vào bảng, giữ lựa chọn khách đã chọn tay và trạng thái đang sửa.
  function mergeOrders(orders) {
    const previous = new Map(vc.pending.map((row) => [normalizeVietnamese(row.tenKhachNoi), row]));
    vc.pending = orders.map((row) => {
      const before = previous.get(normalizeVietnamese(row.tenKhachNoi));
      const merged = { ...row, learn: Boolean(before?.learn), editing: Boolean(before?.editing) };
      if (before?.learn && before.customerCode && !row.customerCode) merged.customerCode = before.customerCode;
      return merged;
    });
    renderPending();
  }

  // ---------- Gửi cho AI ----------
  function readyRows() {
    return vc.pending.filter((row) => row.customerCode && QTY.some((item) => parseNumber(row[item.field]) > 0));
  }

  async function reply(text) {
    await speak(text);
    if (vc.talking && !vc.busy) listen();
  }

  async function send(extra = {}) {
    if (vc.batchMode) {
      const typed = $("#vcText").value.trim();
      $("#vcText").value = "";
      if (typed) collectDraft(typed, null);
      return;
    }
    const text = normalizeSpeech($("#vcText").value.trim());
    if ((!text && !extra.audio) || vc.busy) return;
    if (state.businessUnit !== "mi") {
      say("ai", "Đang ở Xưởng Phở. Chuyển sang Xưởng Mì trước nhé.", "err");
      return;
    }
    $("#vcText").value = "";
    vc.finalText = "";
    const live = takeLive();
    const mine = extra.audio ? say("me", '🎧 <span class="bg-typing">đang nghe…</span>') : meBubble(`🎙 ${escapeHtml(text)}`, live);
    vc.busy = true;
    $("#vcSend").disabled = true;
    let said = text;
    let wait = null;
    try {
      // Nghe trước (hiện nguyên văn lên chat) rồi mới phân tích.
      if (extra.audio) {
        const heard = await transcribe(extra.audio, { seconds: extra.seconds });
        said = normalizeSpeech(heard.text);
        mine.innerHTML = `🎧 ${escapeHtml(said || "(không nghe rõ)")}`;
        if (!said) throw new Error("Tôi chưa nghe rõ.");
      }
      vc.history.push({ role: "me", text: said });
      vc.transcript.push(said);
      wait = say("ai", '<span class="bg-typing">Đang phân tích…</span>');
      const data = await api("POST", {
        action: "parse",
        text: said,
        model: vc.runModel || undefined,
        pending: vc.pending,
        history: vc.history.slice(0, -1).slice(-8),
        date: $("#vcDate").value,
      });
      wait.remove();
      vc.busy = false;
      $("#vcSend").disabled = false;
      await handleResult(data);
    } catch (error) {
      wait?.remove();
      if (extra.audio && !said) mine.innerHTML = "🎧 (không nghe rõ)";
      vc.busy = false;
      $("#vcSend").disabled = false;
      say("ai", escapeHtml(error.message), "err");
      await reply("Có lỗi, bạn nói lại giúp tôi.");
    }
  }

  async function handleResult(data) {
    if (data.command === "luu") {
      const ready = readyRows();
      if (!vc.pending.length) {
        say("ai", "Chưa có đơn nào để lưu.");
        await reply("Chưa có đơn nào để lưu. Bạn nói tên khách và số ký trước nhé.");
        return;
      }
      if (ready.length !== vc.pending.length) {
        const text = "Còn đơn chưa rõ khách hoặc chưa có số ký, tôi chưa lưu được. Bạn nói bổ sung giúp tôi.";
        say("ai", escapeHtml(text), "err");
        await reply(text);
        return;
      }
      await save(vc.pending.map((_, index) => index));
      return;
    }
    if (data.command === "huy") {
      vc.pending = [];
      vc.transcript = [];
      renderPending();
      say("ai", "Đã bỏ hết đơn đang chờ.");
      await reply("Đã bỏ hết. Bạn nói lại từ đầu nhé.");
      return;
    }
    if (data.command === "ketthuc" && !vc.pending.length) {
      say("ai", "Chào bạn, hẹn lần sau.");
      await speak("Chào bạn, hẹn lần sau.");
      stopTalk();
      return;
    }
    const before = vc.pending.map((row) => ({ ...row }));
    mergeOrders(data.orders || []);
    understood(before, vc.pending);
    const help = data.command === "huongdan";
    const spoken = data.speech || [data.reply, data.question].filter(Boolean).join(" ") || (help ? HELP : "");
    say("ai", `${escapeHtml(data.reply || (help ? "Hướng dẫn cách báo" : "Đã ghi."))}${data.question ? `<br><strong>❓ ${escapeHtml(data.question)}</strong>` : ""}${data.cost ? ` <small class="bg-legend">· ~$${Number(data.cost).toFixed(4)}</small>` : ""}`);
    vc.history.push({ role: "ai", text: spoken });
    renderPending();
    await reply(help && !data.speech ? HELP : spoken);
  }

  $("#vcSend").addEventListener("click", () => send());
  $("#vcText").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  // ---------- Model giọng nói (quản lý) ----------
  async function loadVoiceSettings() {
    if (state.user?.role !== "manager") return;
    $("#vcModelBox").classList.remove("hidden");
    try {
      const [settings, list] = await Promise.all([
        api("GET", null, "&action=settings"),
        (async () => {
          const response = await fetch(`/api/ban-giao?action=models&businessUnit=${state.businessUnit}`, { headers: authHeaders() });
          return readApiResponse(response);
        })(),
      ]);
      const models = (list.models || []).slice().sort((a, b) => (a.voiceRank - b.voiceRank) || (b.created - a.created));
      const label = (model) => `${model.voiceRank < 99 ? "★ " : ""}${model.audio ? "🎧 " : ""}${model.id} · $${model.promptPrice}/$${model.completionPrice}${model.voiceNote ? ` — ${model.voiceNote}` : ""}`;
      const current = settings.voiceModel;
      const listenCurrent = settings.listenModel;
      const audioModels = models.filter((model) => model.audio !== false);
      const listenOptions = audioModels.some((model) => model.id === listenCurrent) ? audioModels : [{ id: listenCurrent, promptPrice: "?", completionPrice: "?", voiceRank: 0, audio: true }, ...audioModels];
      $("#vcListenModel").innerHTML = `<optgroup label="Gợi ý (🎧 nghe được âm thanh)">${listenOptions.filter((m) => m.voiceRank < 99).map((m) => `<option value="${escapeHtml(m.id)}"${m.id === listenCurrent ? " selected" : ""}>${escapeHtml(label(m))}</option>`).join("")}</optgroup>
        <optgroup label="Mô hình khác nghe được âm thanh">${listenOptions.filter((m) => m.voiceRank >= 99 && m.audio).map((m) => `<option value="${escapeHtml(m.id)}"${m.id === listenCurrent ? " selected" : ""}>${escapeHtml(label(m))}</option>`).join("")}</optgroup>`;
      const options = models.some((model) => model.id === current) ? models : [{ id: current, promptPrice: "?", completionPrice: "?", voiceRank: 99 }, ...models];
      const recommended = options.filter((model) => model.voiceRank < 99);
      const others = options.filter((model) => model.voiceRank >= 99);
      $("#vcModel").innerHTML = `<optgroup label="Gợi ý cho giọng nói (🎧 = nghe được ghi âm)">${recommended.map((m) => `<option value="${escapeHtml(m.id)}"${m.id === current ? " selected" : ""}>${escapeHtml(label(m))}</option>`).join("")}</optgroup>
        <optgroup label="Model khác">${others.map((m) => `<option value="${escapeHtml(m.id)}"${m.id === current ? " selected" : ""}>${escapeHtml(label(m))}</option>`).join("")}</optgroup>`;
      vc.voiceModel = current;
    } catch (error) {
      $("#vcModelNote").textContent = error.message;
    }
  }
  $("#vcSaveModel").addEventListener("click", async () => {
    const model = $("#vcModel").value;
    const listenModel = $("#vcListenModel").value;
    try {
      await api("POST", { action: "voice-model", model, listenModel });
      vc.voiceModel = model;
      $("#vcModelNote").textContent = `Đã lưu. Hiểu chữ: ${model} · Nghe âm thanh: ${listenModel}. Mọi tài khoản đóng hàng dùng chung.`;
    } catch (error) {
      $("#vcModelNote").textContent = error.message;
    }
  });

  // ---------- Thẻ đơn chờ ----------
  function customerSelect(row) {
    const candidates = (row.candidates || []).filter((code) => customerForCode(code));
    const others = sortedCustomers().filter((customer) => !candidates.includes(customer.MaKH));
    const option = (customer) => `<option value="${escapeHtml(customer.MaKH)}"${customer.MaKH === row.customerCode ? " selected" : ""}>${escapeHtml(customer.TenKH)} (${escapeHtml(customer.MaKH)})</option>`;
    return `<select data-vc-field="customerCode"><option value="">— Chọn khách —</option>
      ${candidates.length ? `<optgroup label="Có thể là">${candidates.map((code) => option(customerForCode(code))).join("")}</optgroup>` : ""}
      <optgroup label="Tất cả khách">${others.map(option).join("")}</optgroup></select>`;
  }

  function cardWarnings(row) {
    const list = [];
    if (!row.customerCode) list.push("chưa rõ khách");
    if (!QTY.some((item) => parseNumber(row[item.field]) > 0)) list.push("chưa có số lượng");
    (row.warnings || []).forEach((item) => {
      if (item === "chưa rõ khách" || item === "chưa có số lượng") return;
      list.push(item);
    });
    return list;
  }

  const TAX_OPTIONS = [["", "Theo khách"], ["0", "0%"], ["5", "5%"], ["8", "8%"], ["10", "10%"]];
  const isManager = () => state.user?.role === "manager";
  const hasQty = (row) => QTY.some((item) => parseNumber(row[item.field]) > 0);
  const isReady = (row) => Boolean(row.customerCode) && hasQty(row);

  function effectiveTax(row) {
    if (row.taxRate !== null && row.taxRate !== undefined && row.taxRate !== "") return Number(row.taxRate);
    return Number(customerForCode(row.customerCode)?.ThueSuat || 0);
  }

  // Tiền hàng dự tính (chỉ quản lý thấy): hàng × giá khách + thuế + tiền chành.
  function amountText(row) {
    const customer = customerForCode(row.customerCode);
    if (!customer) return "";
    const goods = parseNumber(row.miKg) * Number(customer.GiaMi || 0)
      + parseNumber(row.caoKg) * Number(customer.GiaCao || 0)
      + parseNumber(row.hoanhKg) * Number(customer.GiaHoanh || 0);
    const tax = goods * effectiveTax(row) / 100;
    return money.format(goods + tax + parseNumber(row.tienUng));
  }

  function dateTag(row) {
    const date = row.orderDate || $("#vcDate").value;
    const other = date !== $("#vcDate").value;
    return `<small class="vc-date${other ? " other" : ""}">📅 ${escapeHtml(formatDate(date))}${other ? " (khác ngày đang chọn)" : ""}${row.checked ? " · ✅ đã đối chiếu ghi âm" : ""}</small>`;
  }

  function viewRowHtml(row, index, warns) {
    const q = (field) => (parseNumber(row[field]) ? `<strong>${kg(row[field])}</strong>` : '<span class="vc-dim">—</span>');
    const extra = QTY.filter((item) => !item.main && parseNumber(row[item.field]))
      .map((item) => `${item.label} ${kg(row[item.field])}`).concat(row.ghiChu ? [row.ghiChu] : []).join(", ");
    return `<tr data-vc-row="${index}" class="vc-view ${warns.length ? "vc-warn-row" : ""}">
      <td data-label="#">${index + 1}</td>
      <td data-label="Khách" class="vc-cell-customer"><strong>${escapeHtml(nameOf(row.customerCode))}</strong>
        ${dateTag(row)}
        ${row.tenKhachNoi ? `<small>Nghe: “${escapeHtml(row.tenKhachNoi)}”</small>` : ""}
        ${warns.length ? `<small class="vc-warn">⚠ ${warns.map(escapeHtml).join(" · ")}</small>` : ""}</td>
      <td data-label="Xe">${row.nhaXe ? escapeHtml(row.nhaXe) : '<span class="vc-dim">—</span>'}</td>
      <td data-label="Chành (đ)">${parseNumber(row.tienUng) ? money.format(parseNumber(row.tienUng)) : '<span class="vc-dim">—</span>'}</td>
      <td data-label="Mì (kg)">${q("miKg")}</td>
      <td data-label="Cảo (kg)">${q("caoKg")}</td>
      <td data-label="Hoành (kg)">${q("hoanhKg")}</td>
      <td data-label="Thuế">${effectiveTax(row)}%${row.taxRate === null || row.taxRate === undefined || row.taxRate === "" ? ' <small class="vc-dim">theo khách</small>' : ""}</td>
      <td data-label="Khác">${extra ? escapeHtml(extra) : '<span class="vc-dim">—</span>'}</td>
      ${isManager() ? `<td data-label="Thành tiền" class="vc-amount" data-vc-amount>${amountText(row)}</td>` : ""}
      <td data-label="" class="vc-actions">
        <button type="button" class="primary" data-vc-save="${index}"${isReady(row) ? "" : " disabled"}>Lưu</button>
        <button type="button" class="secondary-button" data-vc-edit="${index}">✏️ Sửa</button>
        <button type="button" class="vc-x" data-vc-remove="${index}" title="Bỏ dòng">✕</button></td>
    </tr>`;
  }

  function rowHtml(row, index) {
    const warns = cardWarnings(row);
    // Dòng đủ thông tin hiển thị gọn; bấm Sửa (hoặc dòng thiếu khách) mới hiện ô nhập.
    if (!row.editing && row.customerCode) return viewRowHtml(row, index, warns);
    const num = (field, placeholder = "") => `<input data-vc-field="${field}" inputmode="decimal" value="${parseNumber(row[field]) ? escapeHtml(String(row[field])) : ""}" placeholder="${placeholder}" />`;
    const extra = QTY.filter((item) => !item.main && parseNumber(row[item.field]))
      .map((item) => `${item.label} ${kg(row[item.field])}`).join(", ");
    return `<tr data-vc-row="${index}" class="${row.customerCode ? "" : "vc-missing"} ${warns.length ? "vc-warn-row" : ""}">
      <td data-label="#">${index + 1}</td>
      <td data-label="Khách" class="vc-cell-customer">${customerSelect(row)}
        <label class="vc-date-edit">📅 <input type="date" data-vc-field="orderDate" value="${escapeHtml(row.orderDate || $("#vcDate").value)}" /></label>
        ${row.tenKhachNoi ? `<small>Nghe: “${escapeHtml(row.tenKhachNoi)}”</small>` : ""}
        ${warns.length ? `<small class="vc-warn">⚠ ${warns.map(escapeHtml).join(" · ")}</small>` : ""}</td>
      <td data-label="Xe"><input data-vc-field="nhaXe" value="${escapeHtml(row.nhaXe || "")}" placeholder="—" /></td>
      <td data-label="Chành (đ)">${num("tienUng", "—")}</td>
      <td data-label="Mì (kg)">${num("miKg", "0")}</td>
      <td data-label="Cảo (kg)">${num("caoKg", "0")}</td>
      <td data-label="Hoành (kg)">${num("hoanhKg", "0")}</td>
      <td data-label="Thuế"><select data-vc-field="taxRate">${TAX_OPTIONS.map(([value, label]) => `<option value="${value}"${String(row.taxRate ?? "") === value ? " selected" : ""}>${value === "" ? `${label} (${effectiveTax({ customerCode: row.customerCode })}%)` : label}</option>`).join("")}</select></td>
      <td data-label="Khác">
        <details><summary>${extra ? escapeHtml(extra) : "Thêm"}</summary>
          ${QTY.filter((item) => !item.main).map((item) => `<label>${item.label}<input data-vc-field="${item.field}" inputmode="decimal" value="${parseNumber(row[item.field]) ? escapeHtml(String(row[item.field])) : ""}" placeholder="0" /></label>`).join("")}
          <label>Ghi chú<input data-vc-field="ghiChu" value="${escapeHtml(row.ghiChu || "")}" /></label>
        </details></td>
      ${isManager() ? `<td data-label="Thành tiền" class="vc-amount" data-vc-amount>${amountText(row)}</td>` : ""}
      <td data-label="" class="vc-actions">
        <button type="button" class="primary" data-vc-save="${index}"${isReady(row) ? "" : " disabled"}>Lưu</button>
        ${row.customerCode ? `<button type="button" class="secondary-button" data-vc-done="${index}">✓ Xong</button>` : ""}
        <button type="button" class="vc-x" data-vc-remove="${index}" title="Bỏ dòng">✕</button></td>
    </tr>`;
  }

  function totalsHtml() {
    const parts = QTY.map((item) => [item, vc.pending.reduce((sum, row) => sum + parseNumber(row[item.field]), 0)])
      .filter(([, value]) => value).map(([item, value]) => `${item.label.toLowerCase()} ${kg(value)}${item.unit ? ` ${item.unit}` : ""}`);
    const chanh = vc.pending.reduce((sum, row) => sum + parseNumber(row.tienUng), 0);
    return `<strong>${vc.pending.length} khách</strong>${parts.length ? ` · ${parts.join(" · ")}` : ""}${chanh ? ` · chành ${money.format(chanh)}` : ""}`;
  }

  function renderPending() {
    if (!vc.pending.length) {
      $("#vcPending").innerHTML = "";
    } else {
      $("#vcPending").innerHTML = `<div class="table-wrap"><table class="vc-table">
        <thead><tr><th>#</th><th>Khách</th><th>Xe</th><th>Chành (đ)</th><th>Mì (kg)</th><th>Cảo (kg)</th><th>Hoành (kg)</th><th>Thuế</th><th>Khác</th>${isManager() ? "<th>Thành tiền</th>" : ""}<th></th></tr></thead>
        <tbody>${vc.pending.map(rowHtml).join("")}</tbody></table></div>
        <p class="vc-totals" data-vc-totals>${totalsHtml()}</p>`;
    }
    $("#vcPendingActions").classList.toggle("hidden", !vc.pending.length);
    refreshButtons();
  }

  function refreshButtons() {
    const ready = vc.pending.filter(isReady).length;
    $("#vcSaveAll").textContent = `✅ Lưu tất cả (${ready}/${vc.pending.length})`;
    // Đang ghi âm đối chiếu hoặc đang nghe lại thì chưa cho lưu: lưu chính thức phải là bản đã kiểm tra.
    const locked = vc.relistening || Boolean(vc.batchMode && vc.sessionRec);
    $("#vcSaveAll").disabled = !ready || ready !== vc.pending.length || vc.busy || locked;
    $$("#vcPending [data-vc-save]").forEach((button) => { if (locked) button.disabled = true; });
  }

  $("#vcPending").addEventListener("input", (event) => {
    const field = event.target.dataset.vcField;
    const tr = event.target.closest("[data-vc-row]");
    if (!field || !tr) return;
    const row = vc.pending[Number(tr.dataset.vcRow)];
    row[field] = event.target.value;
    if (field === "customerCode") {
      row.learn = true;
      row.editing = true;
      row.warnings = (row.warnings || []).filter((item) => item !== "khách đã có đơn ngày này");
      renderPending();
      return;
    }
    const amount = tr.querySelector("[data-vc-amount]");
    if (amount) amount.textContent = amountText(row);
    tr.querySelector("[data-vc-save]").disabled = !isReady(row);
    $("#vcPending [data-vc-totals]").innerHTML = totalsHtml();
    refreshButtons();
  });
  $("#vcPending").addEventListener("change", (event) => {
    const field = event.target.dataset.vcField;
    if (field === "taxRate" || (field && QTY.some((item) => item.field === field))) renderPending();
  });

  $("#vcPending").addEventListener("click", (event) => {
    const remove = event.target.closest("[data-vc-remove]");
    const saveOne = event.target.closest("[data-vc-save]");
    const editOne = event.target.closest("[data-vc-edit]");
    const doneOne = event.target.closest("[data-vc-done]");
    if (editOne || doneOne) {
      const row = vc.pending[Number((editOne || doneOne).dataset[editOne ? "vcEdit" : "vcDone"])];
      row.editing = Boolean(editOne);
      renderPending();
      if (editOne) $(`#vcPending [data-vc-row="${editOne.dataset.vcEdit}"] input[data-vc-field="miKg"]`)?.focus();
      return;
    }
    if (remove) {
      vc.pending.splice(Number(remove.dataset.vcRemove), 1);
      renderPending();
    }
    if (saveOne) save([Number(saveOne.dataset.vcSave)]);
  });
  $("#vcSaveAll").addEventListener("click", () => save(vc.pending.map((_, index) => index)));
  $("#vcAddRow").addEventListener("click", () => {
    vc.pending.push({ tenKhachNoi: "", customerCode: "", candidates: [], nhaXe: "", tienUng: 0, taxRate: null, orderDate: $("#vcDate").value, ghiChu: "", editing: true, miKg: 0, caoKg: 0, hoanhKg: 0, huTieu: 0, voBanhGoi: 0, thungXop: 0 });
    renderPending();
  });
  $("#vcClear").addEventListener("click", () => {
    vc.pending = [];
    vc.transcript = [];
    renderPending();
    say("ai", "Đã xóa hết đơn chờ.");
  });

  // ---------- Lưu ----------
  async function save(indexes) {
    if (vc.busy || !indexes.length) return;
    const rows = indexes.map((index) => vc.pending[index]).filter(Boolean);
    vc.busy = true;
    $$("#vcPending [data-vc-save], #vcSaveAll").forEach((button) => { button.disabled = true; });
    try {
      const data = await api("POST", {
        action: "save",
        transcript: vc.transcript.join(" | "),
        recordings: vc.recordings,
        orders: rows.map((row) => ({
          ...row,
          taxRate: row.taxRate === "" || row.taxRate === undefined ? null : row.taxRate,
          tienUng: parseNumber(row.tienUng),
          orderDate: row.orderDate || $("#vcDate").value,
        })),
      });
      vc.pending = vc.pending.filter((row) => !rows.includes(row));
      if (!vc.pending.length) {
        vc.transcript = [];
        vc.recordings = [];
      }
      const saved = data.orders || [];
      if (state.user?.role === "manager") applyLocalCrmPatch({ orders: saved });
      const lines = saved.map((order) => `${order.customerName}: ${QTY.filter((item) => parseNumber(order[item.field])).map((item) => `${item.label.toLowerCase()} ${kg(order[item.field])}`).join(", ")}`);
      say("ai", `✅ Đã lưu ${saved.length} đơn:<br>${lines.map(escapeHtml).join("<br>")}`, "ok");
      vc.history.push({ role: "ai", text: `Đã lưu ${saved.length} đơn.` });
      loadSaved();
      reply(`Đã lưu ${saved.length} đơn. Còn khách nào nữa không?`);
    } catch (error) {
      say("ai", escapeHtml(error.message), "err");
      reply("Chưa lưu được. Bạn xem lại giúp tôi.");
    } finally {
      vc.busy = false;
      renderPending();
    }
  }

  // ---------- Đơn đã lưu ----------
  async function loadSaved() {
    const date = $("#vcDate").value;
    $("#vcSavedTitle").textContent = `Ngày ${formatDate(date)}${state.user?.role === "manager" ? " · tất cả người nhập" : " · do bạn nhập"}`;
    if (state.businessUnit !== "mi") {
      $("#vcSaved").innerHTML = '<div class="empty-state">Chỉ dùng cho Xưởng Mì.</div>';
      return;
    }
    try {
      const data = await api("GET", null, `&date=${date}`);
      const orders = data.orders || [];
      const totals = QTY.map((item) => [item, orders.reduce((sum, order) => sum + Number(order[item.field] || 0), 0)]).filter(([, value]) => value);
      $("#vcSaved").innerHTML = orders.length
        ? `<p class="vc-total">${orders.length} đơn · ${totals.map(([item, value]) => `${item.label.toLowerCase()} ${kg(value)}${item.unit ? ` ${item.unit}` : ""}`).join(" · ")}</p>
          ${orders.map((order) => `<div class="vc-saved-row"><strong>${escapeHtml(order.customerName)}</strong>${order.source === "voice" ? ' <span title="Nhập bằng giọng nói">🎤</span>' : ""}
            <small>${[order.truck ? `xe ${order.truck}` : "", order.advance ? `chành ${money.format(order.advance)}` : "", QTY.filter((item) => Number(order[item.field])).map((item) => `${item.label.toLowerCase()} ${kg(order[item.field])}`).join(", ")].filter(Boolean).map(escapeHtml).join(" · ")}</small></div>`).join("")}`
        : '<div class="empty-state">Chưa có đơn nào.</div>';
    } catch (error) {
      $("#vcSaved").innerHTML = /HTTP 404/.test(error.message)
        ? `<div class="empty-state">${OLD_SERVER}</div>`
        : `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
  }
  $("#vcRefresh").addEventListener("click", loadSaved);
  $("#vcDate").addEventListener("change", () => {
    vc.pending.forEach((row) => { row.orderDate = $("#vcDate").value; });
    renderPending();
    loadSaved();
  });
  $("#vcSwitchMi").addEventListener("click", () => switchBusinessUnit("mi"));

  // ---------- Mở màn hình ----------
  function syncUnit() {
    const isMi = state.businessUnit === "mi";
    $("#vcUnitHint").classList.toggle("hidden", isMi);
    ["#vcMic", "#vcSend", "#vcText", "#vcTalk", "#vcBatch"].forEach((selector) => { $(selector).disabled = !isMi; });
    if (!isMi && vc.talking) stopTalk();
  }
  function openView() {
    if (!$("#vcDate").value) $("#vcDate").value = todayInVietnam();
    setMicHint();
    syncUnit();
    greet();
    if (pageBlocksMic()) $("#vcMicHint").innerHTML = OLD_SERVER;
    loadVoiceSettings();
    loadMics(false).catch(() => {});
    renderPending();
    loadSaved();
  }
  $("#vcRate").value = store.get("vcRate", "1");
  $("#vcRate").addEventListener("change", () => {
    store.set("vcRate", $("#vcRate").value);
    speak("Tốc độ đọc như thế này được chưa?");
  });
  new MutationObserver(() => {
    if ($("#voiceView").classList.contains("active")) openView();
    else {
      if (vc.talking) stopTalk();
      if (vc.batchMode) stopBatch();
    }
  }).observe($("#voiceView"), { attributes: true, attributeFilter: ["class"] });

  const previousRenderAll = renderAll;
  renderAll = function renderAllWithVoice(...args) {
    previousRenderAll(...args);
    if ($("#voiceView").classList.contains("active")) {
      syncUnit();
      renderPending();
      loadSaved();
    }
  };
})();
