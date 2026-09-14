import { randomUUID } from "node:crypto";
import { Router } from "express";
import { ObjectId } from "mongodb";
import { todos } from "../db.mjs";

export const todosRouter = Router();

const EDITABLE_FIELDS = ["title", "status", "closedAt", "requester", "company", "contact", "isImportant"];

todosRouter.get("/", async (req, res) => {
  const items = await todos()
    .find({ userId: req.userId })
    .sort({ createdAt: -1 })
    .toArray();

  res.json(items.map(toClientTodo));
});

todosRouter.post("/", async (req, res) => {
  const { title, sourceImage, requester, company, contact, isImportant = false } = req.body ?? {};
  const trimmedTitle = typeof title === "string" ? title.trim() : "";

  if (!trimmedTitle) {
    res.status(400).json({ error: "任務名稱為必填" });
    return;
  }

  if (typeof isImportant !== "boolean") {
    res.status(400).json({ error: "重要標記必須為布林值" });
    return;
  }

  const now = new Date().toISOString();
  const doc = {
    userId: req.userId,
    title: trimmedTitle,
    status: "pending",
    isImportant,
    createdAt: now,
    progressLogs: [],
    sourceImage: sourceImage || "",
    requester: requester || undefined,
    company: company || undefined,
    contact: contact || undefined,
  };

  const result = await todos().insertOne(doc);
  res.status(201).json(toClientTodo({ ...doc, _id: result.insertedId }));
});

todosRouter.patch("/:id", async (req, res) => {
  const filter = await findOwnedTodo(req);
  if (!filter) {
    res.status(404).json({ error: "找不到這筆待辦" });
    return;
  }

  if ("isImportant" in (req.body ?? {}) && typeof req.body.isImportant !== "boolean") {
    res.status(400).json({ error: "重要標記必須為布林值" });
    return;
  }

  const update = {};
  for (const field of EDITABLE_FIELDS) {
    if (field in (req.body ?? {})) update[field] = req.body[field];
  }

  const push = {};
  if (typeof req.body?.progressLogContent === "string" && req.body.progressLogContent.trim()) {
    push.progressLogs = {
      id: randomUUID(),
      content: req.body.progressLogContent.trim(),
      createdAt: new Date().toISOString(),
    };
    if (update.status === undefined) update.status = "in_progress";
  }

  const operations = {};
  if (Object.keys(update).length) operations.$set = update;
  if (Object.keys(push).length) operations.$push = push;

  if (!Object.keys(operations).length) {
    res.status(400).json({ error: "沒有可更新的欄位" });
    return;
  }

  await todos().updateOne(filter, operations);
  const updated = await todos().findOne(filter);
  res.json(toClientTodo(updated));
});

todosRouter.delete("/:id", async (req, res) => {
  const filter = await findOwnedTodo(req);
  if (!filter) {
    res.status(404).json({ error: "找不到這筆待辦" });
    return;
  }

  await todos().deleteOne(filter);
  res.json({ ok: true });
});

async function findOwnedTodo(req) {
  if (!ObjectId.isValid(req.params.id)) return null;

  const filter = { _id: new ObjectId(req.params.id), userId: req.userId };
  const exists = await todos().findOne(filter);
  return exists ? filter : null;
}

function toClientTodo(doc) {
  return {
    id: doc._id.toString(),
    title: doc.title,
    status: doc.status,
    isImportant: doc.isImportant === true,
    createdAt: doc.createdAt,
    closedAt: doc.closedAt || undefined,
    sourceImage: doc.sourceImage || undefined,
    requester: doc.requester || undefined,
    company: doc.company || undefined,
    contact: doc.contact || undefined,
    progressLogs: doc.progressLogs ?? [],
  };
}
