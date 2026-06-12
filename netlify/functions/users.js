const { authErrorResponse, publicUser, requireRole } = require("./_auth");
const { appendAudit, updateDatabase, readDatabase } = require("./_database");
const { jsonResponse } = require("./_sheets");

const allowedRoles = ["delivery", "manager"];
const allowedStatuses = ["pending", "active", "disabled"];
const allowedBusinessUnits = ["mi", "pho"];

exports.handler = async (event) => {
  try {
    const manager = await requireRole(event, "manager");
    if (event.httpMethod === "GET") {
      const users = ((await readDatabase()).users || [])
        .map(publicUser)
        .sort((first, second) => String(second.createdAt).localeCompare(String(first.createdAt)));
      return jsonResponse(200, { users });
    }
    if (event.httpMethod !== "PUT") return jsonResponse(405, { error: "Method not allowed" });
    const payload = JSON.parse(event.body || "{}");
    const user = await updateDatabase((database) => {
      const current = (database.users || []).find((item) => Number(item.id) === Number(payload.id));
      if (!current) throw new Error("Không tìm thấy người dùng.");
      const role = String(payload.role || current.role);
      const status = String(payload.status || current.status);
      const businessUnits = Array.isArray(payload.businessUnits)
        ? [...new Set(payload.businessUnits.filter((item) => allowedBusinessUnits.includes(item)))]
        : current.businessUnits || allowedBusinessUnits;
      if (!allowedRoles.includes(role) || !allowedStatuses.includes(status)) {
        throw new Error("Vai trò hoặc trạng thái không hợp lệ.");
      }
      if (!businessUnits.length) throw new Error("Người dùng phải được cấp ít nhất một phân hệ.");
      if (Number(current.id) === Number(manager.id) && (status !== "active" || role !== "manager")) {
        throw new Error("Bạn không thể tự khóa hoặc hạ quyền tài khoản đang đăng nhập.");
      }
      const removesActiveManager = current.role === "manager"
        && current.status === "active"
        && (role !== "manager" || status !== "active");
      const otherActiveManagers = (database.users || []).filter((item) => (
        Number(item.id) !== Number(current.id)
        && item.role === "manager"
        && item.status === "active"
      )).length;
      if (removesActiveManager && otherActiveManagers === 0) {
        throw new Error("Hệ thống phải còn ít nhất một tài khoản quản lý đang hoạt động.");
      }
      const before = { role: current.role, status: current.status, businessUnits: current.businessUnits };
      current.role = role;
      current.status = status;
      current.businessUnits = businessUnits;
      current.tokenVersion = Number(current.tokenVersion || 0) + 1;
      if (status === "active") {
        current.approvedAt = new Date().toISOString();
        current.approvedBy = manager.email;
      }
      appendAudit(database, {
        action: "user-permission-updated",
        actorUserId: manager.id,
        actorEmail: manager.email,
        actorName: manager.displayName,
        targetUserId: current.id,
        summary: `${manager.displayName} cập nhật quyền của ${current.displayName}.`,
        details: { targetEmail: current.email, before, after: { role, status, businessUnits } },
      });
      return current;
    });
    return jsonResponse(200, { ok: true, user: publicUser(user) });
  } catch (error) {
    if (error.statusCode) return authErrorResponse(error);
    return jsonResponse(400, { error: error.message });
  }
};
