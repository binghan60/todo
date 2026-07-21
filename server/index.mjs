import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const port = Number(process.env.API_PORT || process.env.PORT || 8787);
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = join(__dirname, "..", "client", "dist");

const app = express();

app.use(express.json({ limit: "12mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "gemini-screenshot-todo" });
});

app.post("/api/gemini/analyze", async (req, res) => {
  try {
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
                  "你是繁體中文業務待辦整理助理。請閱讀截圖，萃取出一筆可執行的待辦任務，所有欄位均需精簡：\n" +
                  "- title：20字內，以動詞開頭的可執行動作，需包含核心需求或產品關鍵字（例：向XX詢問TYPE-C Connector朝上規格報價）\n" +
                  "- requester / company / contact：直接填名稱或資訊，無則留空字串\n" +
                  "- due_time_guess：若有明確期限填日期，否則留空字串\n" +
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

app.listen(port, () => {
  console.log(`Gemini Screenshot Todo API running at http://localhost:${port}`);

  if (!process.env.GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY is not set. Gemini analysis will fail until it is provided.");
  }
});

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}