const {
  appendAudit,
  normalizeText,
  updateDatabase,
} = require("../netlify/functions/_database");

const codeByName = {
  "Đan Phượng Q11": "danphuong-q11",
  "Kim Vân": "kimvan",
  "Ngô Gia Tự": "ngogiatu",
  "Đan Phượng Q4": "danphuong-q4",
  "Đan Phượng Q5": "danphuong-q5",
  "Đan Phượng Q. Tân Bình": "danphuong-tanbinh",
  "Phở Thịnh Cao Lãnh": "phothinhcaolanh",
  "Thảo Phở": "thaopho",
  "Triều Nguyên Cha": "trieunguyencha",
  "Triều Nguyên Con": "trieunguyencon",
  "Phở Hồng Phát": "phohongphat",
  "Phở Hà Nội": "phohanoi",
  "Đan Phượng Q10 - Hoà Hưng": "danphuong-q10-hoahung",
  "Đan Phượng Q. Bình Thạnh": "danphuong-binhthanh",
  "Đan Phượng Thủ Đức, 23 Einstein": "danphuong-thuduc-23einstein",
  "Hoa Hồi": "hoahoi",
};

async function main() {
  const changed = await updateDatabase((database) => {
    const updates = [];
    (database.crm.customers || []).forEach((customer) => {
      if (customer.businessUnit !== "pho") return;
      const nextCode = codeByName[customer.TenKH];
      if (!nextCode || normalizeText(customer.MaKH) === normalizeText(nextCode)) return;
      const oldCode = customer.MaKH;
      customer.MaKH = nextCode;
      (database.productionInfo?.entries || []).forEach((entry) => {
        if (entry.businessUnit === "pho" && normalizeText(entry.customerCode) === normalizeText(oldCode)) {
          entry.customerCode = nextCode;
        }
      });
      (database.payments || []).forEach((payment) => {
        if (payment.businessUnit === "pho" && normalizeText(payment.customerCode) === normalizeText(oldCode)) {
          payment.customerCode = nextCode;
        }
      });
      updates.push({ oldCode, newCode: nextCode, customer: customer.TenKH });
    });
    appendAudit(database, {
      action: "pho-customer-codes-updated",
      actorName: "Hệ thống",
      actorEmail: "",
      businessUnit: "pho",
      summary: `Đổi ${updates.length} mã khách Phở sang tên viết liền không dấu.`,
      details: { updates },
    });
    return updates;
  });
  console.log(JSON.stringify({ updated: changed.length, customers: changed }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
