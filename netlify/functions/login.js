// Import danh sách user và hàm tạo token.
const {
  USERS,
  createSessionToken,
  hashPassword,
} = require("./_auth");
// Import helper trả JSON.
const { jsonResponse, normalizeText } = require("./_sheets");

// API /api/login dùng để đăng nhập username/password nội bộ.
exports.handler = async (event) => {
  // Chỉ cho phép POST.
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  try {
    // Đọc username/password từ frontend.
    const payload = JSON.parse(event.body || "{}");
    const username = normalizeText(payload.username);
    const password = String(payload.password || "");

    // Tìm tài khoản theo username.
    const user = USERS.find((item) => normalizeText(item.username) === username);
    // Nếu sai username hoặc password thì báo chung một câu.
    if (!user || user.passwordHash !== hashPassword(password)) {
      return jsonResponse(401, { error: "Sai tài khoản hoặc mật khẩu." });
    }

    // Tạo token đăng nhập.
    const token = createSessionToken(user);
    // Trả token và thông tin hiển thị về frontend.
    return jsonResponse(200, {
      token,
      user: {
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        email: user.email,
      },
    });
  } catch (error) {
    // Nếu JSON lỗi hoặc lỗi khác thì trả 400.
    return jsonResponse(400, { error: error.message });
  }
};
