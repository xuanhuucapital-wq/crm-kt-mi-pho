// Import các hàm dùng chung để đọc Sheet và trả JSON.
const {
  // Tìm dòng tiêu đề trong tab DanhSachKhach.
  findHeader,
  // Đọc dữ liệu từ Google Sheet.
  getValues,
  // Trả response JSON cho frontend.
  jsonResponse,
  // Chuẩn hóa text để so sánh trạng thái active/inactive.
  normalizeText,
} = require("./_sheets");
// Import auth để chặn người chưa đăng nhập đọc danh sách khách.
const { authErrorResponse, requireAuth } = require("./_auth");

// Những cột cần lấy từ tab DanhSachKhach.
const CUSTOMER_COLUMNS = ["MaKH", "TenKH", "GiaMi", "GiaCao", "GiaHoanh", "NhaXeMacDinh", "TrangThai"];

// Handler của Netlify Function /api/customers.
exports.handler = async (event) => {
  try {
    // Nếu chưa đăng nhập hoặc token sai thì dừng ngay.
    requireAuth(event);
    // Lấy tên tab danh sách khách từ env, nếu không có thì dùng mặc định.
    const sheetName = process.env.CUSTOMERS_SHEET_NAME || "DanhSachKhach";
    // Đọc vùng A1:G2000 của tab DanhSachKhach.
    const values = await getValues(sheetName, "A1:G2000");
    // Tìm dòng header có ít nhất MaKH và TenKH.
    const { headerRowIndex, header } = findHeader(values, ["MaKH", "TenKH"]);

    // Chuyển từng dòng trong Sheet thành object customer.
    const customers = values
      // Bỏ qua dòng header, chỉ lấy dữ liệu bên dưới.
      .slice(headerRowIndex + 1)
      // Map từng dòng array thành object có key rõ ràng.
      .map((row) => {
        // Tạo object khách rỗng.
        const customer = {};
        // Duyệt các cột cần lấy.
        CUSTOMER_COLUMNS.forEach((column) => {
          // Tìm index cột theo tên header.
          const index = header[normalizeText(column)];
          // Nếu thiếu cột thì để rỗng, có cột thì lấy giá trị.
          customer[column] = index === undefined ? "" : row[index] || "";
        });
        // Trả object khách cho bước filter tiếp theo.
        return customer;
      })
      // Chỉ giữ dòng có mã khách và tên khách.
      .filter((customer) => customer.MaKH && customer.TenKH)
      // Bỏ qua khách bị đánh dấu inactive.
      .filter((customer) => normalizeText(customer.TrangThai || "active") !== "inactive");

    // Trả danh sách khách về frontend.
    return jsonResponse(200, { customers });
  } catch (error) {
    // Lỗi auth trả 401 để frontend hiểu là phải đăng nhập lại.
    if (error.message.includes("đăng nhập") || error.message.includes("Phiên đăng nhập")) {
      return authErrorResponse(error);
    }
    // Nếu có lỗi đọc Sheet thì trả lỗi 500.
    return jsonResponse(500, { error: error.message });
  }
};
