import { Router } from "express";
import { pushSubscriptions } from "../db.mjs";
import { notifyUser } from "../notify.mjs";

export const pushRouter = Router();

pushRouter.get("/vapid-public-key", (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || "" });
});

pushRouter.post("/test", async (req, res) => {
  const result = await notifyUser(req.userId, "測試通知", "這是一則測試推播，如果你收到這則訊息，代表推播設定成功！");
  res.json(result);
});

pushRouter.post("/webpush/subscribe", async (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint) {
    res.status(400).json({ error: "缺少訂閱資訊" });
    return;
  }

  await pushSubscriptions().updateOne(
    { userId: req.userId, "subscription.endpoint": subscription.endpoint },
    { $set: { userId: req.userId, type: "webpush", subscription, createdAt: new Date().toISOString() } },
    { upsert: true }
  );

  res.json({ ok: true });
});

pushRouter.post("/webpush/unsubscribe", async (req, res) => {
  const { endpoint } = req.body ?? {};
  if (!endpoint) {
    res.status(400).json({ error: "缺少訂閱資訊" });
    return;
  }

  await pushSubscriptions().deleteOne({ userId: req.userId, "subscription.endpoint": endpoint });
  res.json({ ok: true });
});
