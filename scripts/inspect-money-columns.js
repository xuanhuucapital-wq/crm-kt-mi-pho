const { getValues } = require("../netlify/functions/_sheets");

async function main() {
  const sheetName = process.env.MAIN_SHEET_NAME || "Tiền Khách Nợ";
  const values = await getValues(sheetName, "A1:AZ5000");
  const headerIndex = values.findIndex((row) => row.includes("Ngày Đặt") && row.includes("Tên KH"));
  const header = values[headerIndex] || [];
  const rows = values
    .map((row, index) => ({ row, rowNumber: index + 1 }))
    .filter(({ row }) => row.some((value) => String(value || "").includes("A Hảo - Long Xuyên")))
    .slice(-3);
  console.log(JSON.stringify({
    headerRow: headerIndex + 1,
    header: header.map((value, index) => ({ column: index + 1, value })),
    rows: rows.map(({ row, rowNumber }) => ({
      rowNumber,
      values: row.map((value, index) => ({ column: index + 1, header: header[index] || "", value })),
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
