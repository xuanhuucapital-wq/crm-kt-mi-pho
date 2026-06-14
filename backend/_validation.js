function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function parseJsonBody(event) {
  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    throw validationError("Dữ liệu JSON không hợp lệ.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw validationError("Dữ liệu gửi lên phải là một object JSON.");
  }
  return payload;
}

function boundedString(value, field, maximum, options = {}) {
  const text = String(value ?? "").trim();
  if (options.required && !text) throw validationError(`Vui lòng nhập ${field}.`);
  if (text.length > maximum) throw validationError(`${field} không được vượt quá ${maximum} ký tự.`);
  return text;
}

function finiteNumber(value, field, options = {}) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) throw validationError(`${field} không hợp lệ.`);
  if (options.minimum !== undefined && number < options.minimum) {
    throw validationError(`${field} phải từ ${options.minimum} trở lên.`);
  }
  if (options.maximum !== undefined && number > options.maximum) {
    throw validationError(`${field} không được vượt quá ${options.maximum}.`);
  }
  return number;
}

module.exports = {
  boundedString,
  finiteNumber,
  parseJsonBody,
  validationError,
};
