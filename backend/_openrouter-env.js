// Đọc / ghi khóa OpenRouter trong file .env phía máy chủ.
// Khóa KHÔNG bao giờ được trả về trình duyệt: API chỉ báo "đã cấu hình" hay chưa.
const fs = require("fs");
const path = require("path");

const KEY_NAME = "OPENROUTER_API_KEY";
const MODEL_NAME = "OPENROUTER_MODEL";
const DEFAULT_MODEL = "google/gemini-3.8-flash";
const VOICE_MODEL_NAME = "OPENROUTER_VOICE_MODEL";
const LISTEN_MODEL_NAME = "OPENROUTER_LISTEN_MODEL";
// Mô hình nghe âm thanh mặc định: Gemini 2.5 Flash (Hữu dùng ở trang ghi âm, nghe tiếng Việt chính xác).
const DEFAULT_LISTEN_MODEL = "google/gemini-2.5-flash";

function envFilePath() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(__dirname, "..", ".env"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[1];
}

// Đọc file .env mỗi lần gọi để sửa tay file .env cũng có hiệu lực ngay, không cần khởi động lại.
function readEnvFileValue(name) {
  try {
    const lines = fs.readFileSync(envFilePath(), "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.trim().startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index === -1 || line.slice(0, index).trim() !== name) continue;
      let value = line.slice(index + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        try { value = JSON.parse(value); } catch { value = value.slice(1, -1); }
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }
      return value;
    }
  } catch {
    // Không có file .env thì dùng biến môi trường do hosting cấp.
  }
  return "";
}

function openRouterApiKey() {
  return readEnvFileValue(KEY_NAME) || String(process.env[KEY_NAME] || "").trim();
}

function openRouterModel() {
  return readEnvFileValue(MODEL_NAME) || String(process.env[MODEL_NAME] || "").trim() || DEFAULT_MODEL;
}

// Model riêng cho nhập bằng giọng nói (cần nhanh, nghe được âm thanh); chưa đặt thì dùng model chung.
function openRouterVoiceModel() {
  return readEnvFileValue(VOICE_MODEL_NAME) || String(process.env[VOICE_MODEL_NAME] || "").trim() || openRouterModel();
}

function openRouterListenModel() {
  return readEnvFileValue(LISTEN_MODEL_NAME) || String(process.env[LISTEN_MODEL_NAME] || "").trim() || DEFAULT_LISTEN_MODEL;
}

function envFileWritable() {
  if (process.env.VERCEL) return false;
  const file = envFilePath();
  try {
    if (fs.existsSync(file)) {
      fs.accessSync(file, fs.constants.W_OK);
    } else {
      fs.accessSync(path.dirname(file), fs.constants.W_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function settingsStatus() {
  const key = openRouterApiKey();
  return {
    configured: Boolean(key),
    model: openRouterModel(),
    voiceModel: openRouterVoiceModel(),
    listenModel: openRouterListenModel(),
    defaultModel: DEFAULT_MODEL,
    canWriteEnvFile: envFileWritable(),
  };
}

function validationError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function cleanKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  if (key.length < 20 || key.length > 300 || !/^[A-Za-z0-9._\-]+$/.test(key)) {
    throw validationError("Khóa API không đúng định dạng (thường bắt đầu bằng sk-or-).");
  }
  return key;
}

function cleanModel(value) {
  const model = String(value || "").trim();
  if (!model) return "";
  if (model.length > 120 || !/^[A-Za-z0-9._\-]+\/[A-Za-z0-9._:\-]+$/.test(model)) {
    throw validationError("Tên model không hợp lệ, ví dụ: google/gemini-2.5-flash");
  }
  return model;
}

function upsertLines(lines, name, value) {
  const index = lines.findIndex((line) => {
    const at = line.indexOf("=");
    return at > -1 && !line.trim().startsWith("#") && line.slice(0, at).trim() === name;
  });
  const next = `${name}=${value}`;
  if (index >= 0) lines[index] = next;
  else {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(next);
  }
}

function saveSettings({ apiKey, model, voiceModel, listenModel }) {
  const key = cleanKey(apiKey);
  const nextModel = cleanModel(model);
  const nextVoice = cleanModel(voiceModel);
  const nextListen = cleanModel(listenModel);
  if (!key && !nextModel && !nextVoice && !nextListen) throw validationError("Chưa nhập khóa API hoặc model để lưu.");
  if (!envFileWritable()) {
    const error = new Error(process.env.VERCEL
      ? "Bản chạy trên Vercel không ghi được file .env. Hãy đặt OPENROUTER_API_KEY trong Settings → Environment Variables của Vercel."
      : "Máy chủ không có quyền ghi file .env.");
    error.statusCode = 409;
    throw error;
  }
  const file = envFilePath();
  const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = content.split(/\r?\n/);
  if (key) upsertLines(lines, KEY_NAME, key);
  if (nextModel) upsertLines(lines, MODEL_NAME, nextModel);
  if (nextVoice) upsertLines(lines, VOICE_MODEL_NAME, nextVoice);
  if (nextListen) upsertLines(lines, LISTEN_MODEL_NAME, nextListen);
  const tempFile = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tempFile, `${lines.join("\n").replace(/\n*$/, "")}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, file);
  try { fs.chmodSync(file, 0o600); } catch { /* bỏ qua trên hệ thống không hỗ trợ chmod */ }
  if (key) process.env[KEY_NAME] = key;
  if (nextModel) process.env[MODEL_NAME] = nextModel;
  if (nextVoice) process.env[VOICE_MODEL_NAME] = nextVoice;
  if (nextListen) process.env[LISTEN_MODEL_NAME] = nextListen;
  return settingsStatus();
}

// Danh sách model công khai của OpenRouter (không cần khóa), chỉ lấy model đọc được ảnh.
// Lưu vào data/openrouter-models.json để lúc mất mạng vẫn chọn được; tự cập nhật khi file cũ quá 24 giờ.
const MODELS_URL = "https://openrouter.ai/api/v1/models";
const MODELS_FILE = path.join(__dirname, "..", "data", "openrouter-models.json");
const MODEL_REFRESH_MS = 24 * 60 * 60 * 1000;

// Gợi ý cho chữ viết tay (bảng xếp hạng nhận dạng chữ viết tay 2026: GPT, Claude Opus, Gemini đứng đầu).
// Thứ tự = thứ tự ưu tiên; model nào OpenRouter không còn bán thì tự bị ẩn.
const RECOMMENDED = [
  { pattern: /^google\/gemini-[\d.]+-flash$/, note: "Rẻ, nhanh, đọc chữ tay tiếng Việt tốt — dùng hằng ngày" },
  { pattern: /^google\/gemini-[\d.]+-pro/, note: "Gemini bản Pro — chắc tay hơn Flash" },
  { pattern: /^anthropic\/claude-opus-/, note: "Rất chính xác với chữ tay, giá cao hơn" },
  { pattern: /^anthropic\/claude-fable-/, note: "Claude hàng đầu, đắt" },
  { pattern: /^openai\/gpt-[\w.-]*(astra|sol)/, note: "GPT hàng đầu về nhận dạng chữ tay, giá cao" },
  { pattern: /^qwen\/qwen[\d.]+-max/, note: "Qwen Max — mạnh chữ châu Á, giá vừa" },
];

const PROVIDER_NAMES = {
  google: "Google Gemini", openai: "OpenAI GPT", anthropic: "Anthropic Claude", qwen: "Qwen (Alibaba)",
  "x-ai": "xAI Grok", deepseek: "DeepSeek", meta: "Meta", "z-ai": "Zhipu GLM", mistralai: "Mistral",
};

function recommendation(id) {
  const index = RECOMMENDED.findIndex((item) => item.pattern.test(id));
  return index < 0 ? null : { rank: index, note: RECOMMENDED[index].note };
}

// Gợi ý cho nhập bằng giọng nói: cần nhanh, rẻ, hiểu tiếng Việt, tốt nhất nghe được âm thanh trực tiếp.
const VOICE_RECOMMENDED = [
  { pattern: /^google\/gemini-2\.5-flash$/, note: "Gemini 2.5 Flash — nghe tiếng Việt chính xác, rẻ (đang dùng ở trang ghi âm)" },
  { pattern: /^google\/gemini-2\.5-pro$/, note: "Gemini 2.5 Pro — nghe kỹ hơn, chậm và đắt hơn" },
  { pattern: /^google\/gemini-[\d.]+-flash$/, note: "Gemini Flash bản mới — nhanh, rẻ" },
  { pattern: /^google\/gemini-[\d.]+-flash-lite$/, note: "Rẻ nhất, nhanh nhất, hiểu kém hơn một chút" },
  { pattern: /^google\/gemini-[\d.]+-pro/, note: "Hiểu chắc hơn, chậm và đắt hơn" },
  { pattern: /^openai\/gpt-[\w.-]*(luna|terra)/, note: "GPT nhanh, giá vừa" },
];

function voiceRecommendation(id) {
  const index = VOICE_RECOMMENDED.findIndex((item) => item.pattern.test(id));
  return index < 0 ? null : { voiceRank: index, voiceNote: VOICE_RECOMMENDED[index].note };
}

function decorate(model) {
  const voice = voiceRecommendation(model.id);
  const rec = recommendation(model.id);
  const provider = String(model.id).replace(/^~/, "").split("/")[0];
  return {
    ...model,
    provider,
    providerName: PROVIDER_NAMES[provider] || provider,
    recommended: Boolean(rec),
    rank: rec ? rec.rank : 99,
    note: rec ? rec.note : "",
    audio: Array.isArray(model.inputs) ? model.inputs.includes("audio") : null,
    voiceRank: voice ? voice.voiceRank : 99,
    voiceNote: voice ? voice.voiceNote : "",
  };
}

function readModelsFile() {
  try {
    const saved = JSON.parse(fs.readFileSync(MODELS_FILE, "utf8"));
    return { updatedAt: saved.updatedAt || "", models: (saved.models || []).map(decorate) };
  } catch {
    return { updatedAt: "", models: [] };
  }
}

// Mỗi nhóm gợi ý chỉ gắn sao cho bản mới nhất, bản cũ xếp vào nhóm thường.
function sortModels(models) {
  const byNewest = [...models].sort((a, b) => b.created - a.created);
  const starred = new Set();
  byNewest.forEach((model) => {
    if (!model.recommended) return;
    if (starred.has(model.rank)) {
      model.recommended = false;
      model.rank = 99;
      model.note = "";
    } else starred.add(model.rank);
  });
  return models.sort((a, b) => a.rank - b.rank || b.created - a.created || a.id.localeCompare(b.id));
}

async function fetchVisionModels() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(MODELS_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const perMillion = (value) => Math.round(Number(value || 0) * 1e6 * 100) / 100;
    return (data.data || [])
      .filter((model) => (model.architecture?.input_modalities || []).includes("image"))
      .filter((model) => !/:batch$/.test(String(model.id)))
      .map((model) => ({
        id: String(model.id),
        name: String(model.name || model.id).slice(0, 120),
        promptPrice: perMillion(model.pricing?.prompt),
        completionPrice: perMillion(model.pricing?.completion),
        created: Number(model.created || 0),
        inputs: model.architecture?.input_modalities || [],
      }));
  } finally {
    clearTimeout(timer);
  }
}

async function listVisionModels({ force = false } = {}) {
  const saved = readModelsFile();
  const age = saved.updatedAt ? Date.now() - new Date(saved.updatedAt).getTime() : Infinity;
  const hasInputs = saved.models.some((model) => model.audio !== null);
  if (!force && saved.models.length && hasInputs && age < MODEL_REFRESH_MS) {
    return { models: sortModels(saved.models), updatedAt: saved.updatedAt, source: "file" };
  }
  try {
    const fresh = await fetchVisionModels();
    if (!fresh.length) throw new Error("rỗng");
    const updatedAt = new Date().toISOString();
    try {
      fs.mkdirSync(path.dirname(MODELS_FILE), { recursive: true });
      fs.writeFileSync(MODELS_FILE, `${JSON.stringify({ updatedAt, models: fresh }, null, 2)}\n`);
    } catch {
      // Hosting chỉ đọc (Vercel) thì bỏ qua bước lưu file.
    }
    return { models: sortModels(fresh.map(decorate)), updatedAt, source: "openrouter" };
  } catch (error) {
    if (saved.models.length) {
      return {
        models: sortModels(saved.models),
        updatedAt: saved.updatedAt,
        source: "file",
        warning: "Không kết nối được OpenRouter, đang dùng danh sách đã lưu.",
      };
    }
    const failure = new Error("Không tải được danh sách model từ OpenRouter. Vẫn có thể gõ tay tên model.");
    failure.statusCode = 502;
    throw failure;
  }
}

module.exports = {
  DEFAULT_MODEL,
  cleanModel,
  listVisionModels,
  openRouterApiKey,
  openRouterModel,
  openRouterVoiceModel,
  openRouterListenModel,
  saveSettings,
  settingsStatus,
};
