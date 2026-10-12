import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import app from "./app.mjs";
import { connectDb } from "./db.mjs";
import { startReminderJob } from "./reminderJob.mjs";

const port = Number(process.env.API_PORT || process.env.PORT || 8787);
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = join(__dirname, "..", "client", "dist");

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
