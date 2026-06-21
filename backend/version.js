const { jsonResponse } = require("./_sheets");

const APP_VERSION = "2026-06-21-google-sheet-diagnostics";

exports.handler = async () => jsonResponse(200, {
  ok: true,
  appVersion: APP_VERSION,
  googleSheetExport: {
    createsNewSpreadsheet: true,
    diagnosticErrors: true,
    hasServiceAccountEmail: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
    hasPrivateKey: Boolean(process.env.GOOGLE_PRIVATE_KEY),
    hasExportShareEmails: Boolean(process.env.GOOGLE_EXPORT_SHARE_EMAILS || process.env.GOOGLE_EXPORT_SHARE_EMAIL),
    hasExportFolderId: Boolean(process.env.GOOGLE_EXPORT_FOLDER_ID),
    sheetsConnected: process.env.GOOGLE_SHEETS_CONNECTED !== "false",
  },
});
