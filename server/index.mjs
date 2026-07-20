import express from "express";
const port = Number(process.env.API_PORT || process.env.PORT || 8787);

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
                  "你是繁體中文業務助理。請閱讀這張 email 或訊息截圖，整理成一筆待辦任務。不要捏造不存在的期限或聯絡資訊。任務標題要是可執行的動作，description 保留客戶需求、產品、規格、報價、附件等上下文，next_action 寫下一步該做什麼。",
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
              description: { type: "string" },
              next_action: { type: "string" },
              due_time_guess: { type: "string" },
              confidence_note: { type: "string" },
            },
            required: ["title", "requester", "company", "contact", "description", "next_action", "due_time_guess", "confidence_note"],
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