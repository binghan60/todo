import express from "express";
import cookieParser from "cookie-parser";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectDb } from "./db.mjs";
import { requireAuth } from "./authMiddleware.mjs";
import { authRouter } from "./routes/auth.mjs";
import { todosRouter } from "./routes/todos.mjs";
import { pushRouter } from "./routes/push.mjs";
import { startReminderJob } from "./reminderJob.mjs";

const port = Number(process.env.API_PORT || process.env.PORT || 8787);
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = join(__dirname, "..", "client", "dist");

const app = express();

app.use(express.json({ limit: "12mb" }));
app.use(cookieParser());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "gemini-screenshot-todo" });
});

app.use("/api/auth", authRouter);
app.use("/api/todos", requireAuth, todosRouter);
app.use("/api/push", requireAuth, pushRouter);

const GEMINI_RATE_LIMIT_MAX = 15;
const GEMINI_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const geminiCallLog = new Map();

function checkGeminiRateLimit(userId) {
  const now = Date.now();
  const recentCalls = (geminiCallLog.get(userId) ?? []).filter((t) => now - t < GEMINI_RATE_LIMIT_WINDOW_MS);

  if (recentCalls.length >= GEMINI_RATE_LIMIT_MAX) return false;

  recentCalls.push(now);
  geminiCallLog.set(userId, recentCalls);
  return true;
}

app.post("/api/gemini/analyze", requireAuth, async (req, res) => {
  try {
    if (!checkGeminiRateLimit(req.userId)) {
      res.status(429).json({ error: "短時間內辨識次數過多，請稍後再試（如果不是自己操作造成，請通知開發者檢查是否有異常迴圈）" });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      res.status(400).json({ error: "GEMINI_API_KEY is not set" });
      return;
    }

    const { model, imageBase64, mimeType } = req.body ?? {};

    if (!model || !imageBase64 || !mimeType) {
      res.status(400).json({ error: "Missing model, imageBase64, or mimeType" });
      return;
    }

    if (!mimeType.startsWith("image/") || imageBase64.length < 100) {
      res.status(400).json({ error: "沒有偵測到照片，請重新選擇截圖" });
      return;
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                inline_data: {
                  mime_type: mimeType,
                  data: imageBase64,
                },
              },
              {
                text:
                  `你是繁體中文業務待辦整理助理。今天的日期是 ${new Date().toISOString().slice(0, 10)}。請閱讀截圖，萃取出一筆可執行的待辦任務，所有欄位均需精簡：\n` +
                  "- title：20字內，以動詞開頭的可執行動作，需包含核心需求或產品關鍵字（例：向XX詢問TYPE-C Connector朝上規格報價）\n" +
                  "- requester / company / contact：直接填名稱或資訊，無則留空字串\n" +
                  "- due_time_guess：若有明確或可推算的期限，請依照今天日期換算成完整的 ISO 8601 格式（例如 2026-07-24T15:00:00），否則留空字串\n" +
                  "- confidence_note：10字內，標注不確定的推斷；不要寫期限相關提示，否則留空字串\n" +
                  "嚴禁捏造資訊。所有欄位禁止寫成完整長句，只留關鍵詞或短語。",
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              title: { type: "string" },
              requester: { type: "string" },
              company: { type: "string" },
              contact: { type: "string" },
              due_time_guess: { type: "string" },
              confidence_note: { type: "string" },
            },
            required: ["title", "requester", "company", "contact", "due_time_guess", "confidence_note"],
          },
        },
      }),
    });

    const rawBody = await response.text();
    const body = parseJson(rawBody);

    if (!response.ok) {
      res.status(response.status).json({
        error: body?.error?.message ?? (rawBody || `Gemini API error: HTTP ${response.status}`),
      });
      return;
    }

    if (!body) {
      res.status(502).json({ error: "Gemini response is not valid JSON" });
      return;
    }

    const text = body.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text;

    if (!text) {
      res.status(502).json({ error: "Gemini response has no text" });
      return;
    }

    const draft = parseJson(text);

    if (!draft) {
      res.status(502).json({ error: "Gemini task JSON cannot be parsed" });
      return;
    }

    res.json(draft);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error instanceof Error ? error.message : "Server error" });
  }
});

app.use(express.static(clientDist));
app.get(/.*/, (_req, res) => {
  res.sendFile(join(clientDist, "index.html"));
});

async function start() {
  await connectDb();
  startReminderJob();

  app.listen(port, () => {
    console.log(`Gemini Screenshot Todo API running at http://localhost:${port}`);

    if (!process.env.GEMINI_API_KEY) {
      console.warn("GEMINI_API_KEY is not set. Gemini analysis will fail until it is provided.");
    }
  });
}

start().catch((error) => {
  console.error("Server failed to start:", error);
  process.exit(1);
});

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}