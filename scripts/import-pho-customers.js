const fs = require("fs");
const path = require("path");
const {
  appendAudit,
  normalizeText,
  updateDatabase,
} = require("../backend/_database");

const databasePath = process.env.CRM_DATABASE_PATH
  || path.join(process.cwd(), "data", "crm-database.json");

const customersToImport = [
  {
    MaKH: "danphuong-q11",
    TenKH: "Đan Phượng Q11",
    ThongTinLienHe: "Phở Vĩnh",
    DiaChi: "125 Xóm Đất, Phường 8, Quận 11",
  },
  {
    MaKH: "kimvan",
    TenKH: "Kim Vân",
    BanDo: "https://share.google/3NhrHVuwQAA2IkTxq",
  },
  {
    MaKH: "ngogiatu",
    TenKH: "Ngô Gia Tự",
    ThongTinLienHe: "Hẻm 520 Ngô Gia Tự, Phường 9, Quận 5, Thành phố Hồ Chí Minh",
    BanDo: "https://share.google/XAnrZFQQSPb6z3Rb0",
  },
  {
    MaKH: "danphuong-q4",
    TenKH: "Đan Phượng Q4",
    BanDo: "https://share.google/qBeNo1YYr12pBM5y4",
  },
  {
    MaKH: "danphuong-q5",
    TenKH: "Đan Phượng Q5",
    DiaChi: "119/26 Nguyễn Văn Cừ, Phường 2, Quận 5, Thành phố Hồ Chí Minh, Việt Nam",
  },
  {
    MaKH: "danphuong-tanbinh",
    TenKH: "Đan Phượng Q. Tân Bình",
    DiaChi: "22 Đường C18, Phường 12, Tân Bình, Thành phố Hồ Chí Minh, Việt Nam",
  },
  {
    MaKH: "phothinhcaolanh",
    TenKH: "Phở Thịnh Cao Lãnh",
    BanDo: "https://share.google/nEzphzmqYLrrGVkC6",
  },
  {
    MaKH: "thaopho",
    TenKH: "Thảo Phở",
    BanDo: "https://share.google/q4BfloIFJ5ExiJOdw",
  },
  {
    MaKH: "trieunguyencha",
    TenKH: "Triều Nguyên Cha",
    BanDo: "https://share.google/JQKCCKJpYhFRQduZP",
  },
  {
    MaKH: "trieunguyencon",
    TenKH: "Triều Nguyên Con",
    BanDo: "https://share.google/JQKCCKJpYhFRQduZP",
  },
  {
    MaKH: "phohongphat",
    TenKH: "Phở Hồng Phát",
    DiaChi: "37 Huỳnh Văn Một, Phường Phú Thạnh, Hồ Chí Minh",
  },
  {
    MaKH: "phohanoi",
    TenKH: "Phở Hà Nội",
    DiaChi: "37 Huỳnh Văn Một, Phường Phú Thạnh, Hồ Chí Minh",
  },
  {
    MaKH: "danphuong-q10-hoahung",
    TenKH: "Đan Phượng Q10 - Hoà Hưng",
    BanDo: "https://share.google/V2MZI3nugWLx56Z8a",
  },
  {
    MaKH: "danphuong-binhthanh",
    TenKH: "Đan Phượng Q. Bình Thạnh",
    BanDo: "https://share.google/S8uZnzXQ00Ni6QGuB",
  },
  {
    MaKH: "danphuong-thuduc-23einstein",
    TenKH: "Đan Phượng Thủ Đức, 23 Einstein",
    BanDo: "https://maps.app.goo.gl/eaGsmrGK9qzefak8m6",
  },
  {
    MaKH: "hoahoi",
    TenKH: "Hoa Hồi",
    BanDo: "https://share.google/GzA3LnLjbYDkixPY9",
  },
];

async function main() {
  if (!fs.existsSync(databasePath)) {
    throw new Error(`Không tìm thấy database: ${databasePath}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${databasePath}.before-pho-customer-import-${timestamp}.bak`;
  fs.copyFileSync(databasePath, backupPath);

  const result = await updateDatabase((database) => {
    const customers = database.crm.customers || (database.crm.customers = []);
    const imported = [];
    const skipped = [];

    customersToImport.forEach((source) => {
      const duplicate = customers.find((customer) => (
        customer.businessUnit === "pho"
        && (
          normalizeText(customer.MaKH) === normalizeText(source.MaKH)
          || normalizeText(customer.TenKH) === normalizeText(source.TenKH)
        )
      ));
      if (duplicate) {
        skipped.push(source.TenKH);
        return;
      }
      const customer = {
        ...source,
        businessUnit: "pho",
        GiaPhoSoi: 0,
        GiaPhoCuon: 0,
        NhaXeMacDinh: "",
        ChinhSachThue: "linh-hoat",
        ThueSuat: 0,
        TrangThai: "active",
      };
      customers.push(customer);
      imported.push(customer);
    });

    appendAudit(database, {
      action: "pho-customers-imported",
      actorName: "Hệ thống",
      actorEmail: "",
      businessUnit: "pho",
      summary: `Nhập ${imported.length} khách hàng ban đầu cho Xưởng Phở.`,
      details: {
        imported: imported.map((customer) => ({
          MaKH: customer.MaKH,
          TenKH: customer.TenKH,
        })),
        skipped,
      },
    });

    return { imported, skipped };
  });

  console.log(JSON.stringify({
    backupPath,
    imported: result.imported.length,
    skipped: result.skipped,
    customers: result.imported.map((customer) => ({
      MaKH: customer.MaKH,
      TenKH: customer.TenKH,
    })),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
