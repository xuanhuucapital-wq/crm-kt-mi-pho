// Chép thư viện trình duyệt cài bằng npm vào public/vendor (thư mục được phục vụ tĩnh).
const fs = require("fs");
const path = require("path");

const files = [
  ["node_modules/html2canvas/dist/html2canvas.min.js", "public/vendor/html2canvas.min.js"],
];

const root = path.join(__dirname, "..");
files.forEach(([source, target]) => {
  const from = path.join(root, source);
  const to = path.join(root, target);
  if (!fs.existsSync(from)) {
    if (fs.existsSync(to)) return;
    console.error(`Thiếu ${source}. Hãy chạy npm install.`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`Đã chép ${source} → ${target}`);
});
