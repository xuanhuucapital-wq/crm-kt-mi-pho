const { jsonResponse } = require("./_sheets");

const APP_VERSION = "2026-06-21-google-sheet-diagnostics";

exports.handler = async () => jsonResponse(200, {
  ok: true,
  appVersion: APP_VERSION,
  googleSheetExport: {
    createsNewSpreadsheet: true,
    diagnosticErrors: true,
  },
});
