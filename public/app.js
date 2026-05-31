// Lưu trạng thái dùng chung của trang.
const state = {
  // Danh sách khách lấy từ tab DanhSachKhach trong Google Sheet.
  customers: [],
  // Token đăng nhập nội bộ, có token mới được gọi API.
  token: localStorage.getItem("nhapLieuAuthToken") || "",
  // Thông tin user đang đăng nhập.
  user: JSON.parse(localStorage.getItem("nhapLieuAuthUser") || "null"),
};

// Lấy panel đăng nhập.
const loginPanel = document.querySelector("#loginPanel");
// Lấy panel app chính.
const appPanel = document.querySelector("#appPanel");
// Lấy form đăng nhập.
const loginForm = document.querySelector("#loginForm");
// Lấy khung báo lỗi đăng nhập.
const loginResult = document.querySelector("#loginResult");
// Lấy dòng trạng thái user đang đăng nhập.
const loginStatus = document.querySelector("#loginStatus");
// Lấy thẻ form nhập liệu chính.
const form = document.querySelector("#orderForm");
// Lấy khung hiện thông báo thành công hoặc lỗi.
const result = document.querySelector("#result");
// Lấy ô nhập mã khách, ví dụ m29.
const customerCode = document.querySelector("#customerCode");
// Lấy khung preview tên khách sau khi nhập mã.
const customerPreview = document.querySelector("#customerPreview");
// Lấy datalist để gợi ý mã khách có sẵn.
const customerCodes = document.querySelector("#customerCodes");
// Lấy ô nhà xe để tự điền nhà xe mặc định.
const nhaXe = document.querySelector("#nhaXe");
// Lấy ô email người nhập.
const userEmail = document.querySelector("#userEmail");
// Ô hidden lưu ngày dạng chuẩn yyyy-mm-dd để gửi backend.
const orderDate = document.querySelector("#orderDate");
// Ô date thật của trình duyệt để bấm hiện lịch.
const orderDatePicker = document.querySelector("#orderDatePicker");
// Dòng chữ ngày ngắn gọn hiển thị cho người dùng.
const orderDateText = document.querySelector("#orderDateText");

// Hiển thị thông báo trong màn hình login.
function showLoginResult(message, type = "ok") {
  loginResult.textContent = message;
  loginResult.className = `result show ${type}`;
}

// Hiển thị thông báo dưới nút Lưu.
function showResult(message, type = "ok") {
  // Đưa nội dung thông báo vào khung result.
  result.textContent = message;
  // Đổi class để CSS biết đây là thông báo thành công hay lỗi.
  result.className = `result show ${type}`;
}

// Header Authorization gửi token lên backend.
function authHeaders(extraHeaders = {}) {
  return {
    ...extraHeaders,
    authorization: `Bearer ${state.token}`,
  };
}

// Hiện đúng màn hình tùy trạng thái đăng nhập.
function renderAuthState() {
  const loggedIn = Boolean(state.token && state.user);
  loginPanel.classList.toggle("hidden", loggedIn);
  appPanel.classList.toggle("hidden", !loggedIn);
  if (loggedIn) {
    loginStatus.textContent = `Đang đăng nhập: ${state.user.displayName || state.user.username}`;
    userEmail.value = state.user.email || state.user.username || "";
  }
}

// Xóa token và quay về màn hình login.
function logout() {
  state.token = "";
  state.user = null;
  localStorage.removeItem("nhapLieuAuthToken");
  localStorage.removeItem("nhapLieuAuthUser");
  renderAuthState();
}

// Chuẩn hóa mã khách để so sánh không bị lệch do viết hoa/khoảng trắng.
function normalizeCode(value) {
  // Nếu value rỗng thì dùng chuỗi rỗng, sau đó trim và viết thường.
  return String(value || "").trim().toLowerCase();
}

// Lấy ngày hôm nay theo định dạng yyyy-mm-dd cho input type="date".
function todayForInput() {
  // Tạo object ngày giờ hiện tại.
  const now = new Date();
  // Bù timezone để toISOString không bị lệch ngày.
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  // Cắt phần ngày, bỏ phần giờ.
  return now.toISOString().slice(0, 10);
}

// Đổi ngày yyyy-mm-dd thành dạng ngắn d/m/yy để hiển thị.
function formatDateForDisplay(isoDate) {
  // Nếu không đúng dạng yyyy-mm-dd thì trả lại nguyên văn.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return isoDate || "";
  }
  // Tách năm, tháng, ngày.
  const [year, month, day] = isoDate.split("-");
  // Trả về dạng 30/5/26.
  return `${Number(day)}/${Number(month)}/${year.slice(-2)}`;
}

// Cập nhật ngày cho cả ô gửi backend, ô lịch, và dòng chữ hiển thị.
function setOrderDate(isoDate) {
  // Gán ngày chuẩn để lúc submit gửi lên backend.
  orderDate.value = isoDate;
  // Gán ngày cho input lịch của trình duyệt.
  orderDatePicker.value = isoDate;
  // Gán ngày ngắn cho giao diện để không bị tràn màn hình điện thoại.
  orderDateText.textContent = formatDateForDisplay(isoDate);
}

// Tìm khách đang được nhập trong danh sách đã tải.
function activeCustomer() {
  // Lấy mã khách hiện tại từ ô input.
  const code = normalizeCode(customerCode.value);
  // Tìm khách có MaKH trùng mã vừa nhập.
  return state.customers.find((customer) => normalizeCode(customer.MaKH) === code);
}

// Cập nhật dòng preview bên dưới mã khách.
function renderCustomerPreview() {
  // Lấy khách hiện tại dựa trên mã khách.
  const customer = activeCustomer();
  // Nếu chưa tìm thấy khách thì báo cho người dùng.
  if (!customer) {
    customerPreview.textContent = "Chưa tìm thấy mã khách trong DanhSachKhach.";
    return;
  }

  // Chỉ hiện tên khách, không hiện giá để tránh lộ thông tin.
  customerPreview.textContent = customer.TenKH;
  // Nếu ô nhà xe đang trống và khách có nhà xe mặc định thì tự điền.
  if (!nhaXe.value && customer.NhaXeMacDinh) {
    nhaXe.value = customer.NhaXeMacDinh;
  }
}

// Tải danh sách khách từ backend.
async function loadCustomers() {
  // Đổi trạng thái phía trên form để biết đang tải.
  document.querySelector("#sheetStatus").textContent = "Đang tải danh sách khách...";
  // Gọi API /api/customers, API này đọc tab DanhSachKhach.
  const response = await fetch("/api/customers", {
    headers: authHeaders(),
  });
  // Chuyển kết quả API thành object JavaScript.
  const data = await response.json();

  // Nếu API lỗi thì ném lỗi để phần catch hiện ra màn hình.
  if (!response.ok) {
    if (response.status === 401) {
      logout();
    }
    throw new Error(data.error || "Không tải được danh sách khách.");
  }

  // Lưu danh sách khách vào state.
  state.customers = data.customers || [];
  // Tạo danh sách gợi ý mã khách cho ô input.
  customerCodes.innerHTML = state.customers
    .map((customer) => `<option value="${customer.MaKH}">${customer.TenKH}</option>`)
    .join("");
  // Cập nhật số lượng khách đã tải.
  document.querySelector("#sheetStatus").textContent = `Đã tải ${state.customers.length} khách.`;
  // Render lại preview nếu ô mã khách đang có sẵn dữ liệu.
  renderCustomerPreview();
}

// Lấy toàn bộ dữ liệu trong form thành object để gửi backend.
function payloadFromForm() {
  // FormData tự gom tất cả input có name trong form.
  const formData = new FormData(form);
  // Đổi FormData thành object bình thường.
  return Object.fromEntries(formData.entries());
}

// Sau khi nhập xong thì bỏ focus input và kéo lên đầu để nhìn tổng quan.
function restoreViewportAfterInput() {
  // Nếu đang focus một ô input thì blur để điện thoại đóng bàn phím.
  if (document.activeElement && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  // Kéo trang lên đầu nhẹ nhàng.
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// Lấy email đã lưu trong máy người dùng để khỏi nhập lại.
userEmail.value = localStorage.getItem("nhapLieuUserEmail") || "";
// Mỗi khi đổi email thì lưu lại vào trình duyệt.
userEmail.addEventListener("change", () => {
  localStorage.setItem("nhapLieuUserEmail", userEmail.value.trim());
});

// Xử lý submit form đăng nhập.
loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button[type='submit']");
  button.disabled = true;
  showLoginResult("Đang đăng nhập...", "ok");

  try {
    const formData = new FormData(loginForm);
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(formData.entries())),
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Đăng nhập thất bại.");
    }

    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("nhapLieuAuthToken", data.token);
    localStorage.setItem("nhapLieuAuthUser", JSON.stringify(data.user));
    showLoginResult("", "ok");
    loginForm.reset();
    renderAuthState();
    await loadCustomers();
  } catch (error) {
    showLoginResult(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

// Nút đăng xuất xóa phiên đăng nhập.
document.querySelector("#logoutButton").addEventListener("click", logout);

// Gán ngày mặc định là hôm nay khi mở trang.
setOrderDate(todayForInput());
// Khi người dùng chọn ngày từ lịch thì cập nhật ngày hiển thị và ngày gửi backend.
orderDatePicker.addEventListener("change", () => {
  // Chỉ cập nhật nếu trình duyệt trả về ngày hợp lệ.
  if (orderDatePicker.value) {
    setOrderDate(orderDatePicker.value);
  }
});
// Khi gõ mã khách thì cập nhật preview tên khách ngay.
customerCode.addEventListener("input", renderCustomerPreview);
// Khi bấm nút Tải khách thì gọi lại API danh sách khách.
document.querySelector("#reloadCustomers").addEventListener("click", async () => {
  try {
    // Tải lại khách từ Google Sheet.
    await loadCustomers();
  } catch (error) {
    // Nếu lỗi thì hiện thông báo đỏ.
    showResult(error.message, "error");
  }
});

// Khi bấm nút Lưu trong form.
form.addEventListener("submit", async (event) => {
  // Chặn trình duyệt reload trang mặc định.
  event.preventDefault();
  // Lấy nút submit hiện tại.
  const button = form.querySelector("button[type='submit']");
  // Khóa nút để tránh bấm lưu nhiều lần liên tiếp.
  button.disabled = true;
  // Báo cho người dùng biết đang lưu.
  showResult("Đang lưu...", "ok");

  try {
    // Lưu email vào trình duyệt trước khi gửi.
    localStorage.setItem("nhapLieuUserEmail", userEmail.value.trim());
    // Gửi dữ liệu form lên backend /api/orders.
    const response = await fetch("/api/orders", {
      // POST nghĩa là gửi dữ liệu để tạo/cập nhật bản ghi.
      method: "POST",
      // Báo backend biết body là JSON.
      headers: authHeaders({ "content-type": "application/json" }),
      // Chuyển object dữ liệu form thành chuỗi JSON.
      body: JSON.stringify(payloadFromForm()),
    });
    // Đọc phản hồi từ backend.
    const data = await response.json();

    // Nếu backend báo lỗi thì hiện lỗi.
    if (!response.ok) {
      if (response.status === 401) {
        logout();
      }
      throw new Error(data.error || "Lưu thất bại.");
    }

    // Nếu thành công thì báo dòng đã ghi trong Google Sheet.
    showResult(`Đã ghi nhận dòng ${data.rowNumber} cho ${data.customerName}.`, "ok");
  } catch (error) {
    // Mọi lỗi đều hiện ở khung thông báo đỏ.
    showResult(error.message, "error");
  } finally {
    // Mở lại nút Lưu dù thành công hay lỗi.
    button.disabled = false;
    // Đóng bàn phím và kéo lên đầu sau khi xử lý xong.
    restoreViewportAfterInput();
  }
});

// Khi trang vừa mở, tự tải danh sách khách một lần.
renderAuthState();
if (state.token) {
  loadCustomers().catch((error) => showResult(error.message, "error"));
}
