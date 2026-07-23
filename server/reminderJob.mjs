import webpush from "web-push";
import { ObjectId } from "mongodb";
import { todos, users, pushSubscriptions, remindersSent } from "./db.mjs";
import { sendLineMessage } from "./linePush.mjs";

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分鐘掃描一次
const CHECK_WINDOW_MS = 15 * 60 * 1000; // 視窗要比掃描間隔寬，避免漏掃

const REMINDER_RULES = [
  { type: "1_day_before", thresholdMs: 24 * 60 * 60 * 1000 },
  { type: "1_hour_before", thresholdMs: 60 * 60 * 1000 },
];

let vapidConfigured = false;

export function startReminderJob() {
  configureVapid();
  void runOnce();
  setInterval(() => void runOnce(), POLL_INTERVAL_MS);
  console.log("Reminder job started");
}

function configureVapid() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    console.warn("VAPID 金鑰未設定，將略過瀏覽器 Web Push");
    return;
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
}

async function runOnce() {
  const now = Date.now();
  const pendingTodos = await todos()
    .find({ status: { $ne: "done" }, dueTime: { $exists: true, $ne: "" } })
    .toArray();

  for (const todo of pendingTodos) {
    const dueTime = new Date(todo.dueTime).getTime();
    if (Number.isNaN(dueTime)) continue;

    const msUntilDue = dueTime - now;

    for (const rule of REMINDER_RULES) {
      const isWithinWindow = msUntilDue <= rule.thresholdMs && msUntilDue > rule.thresholdMs - CHECK_WINDOW_MS;
      if (!isWithinWindow) continue;

      await maybeSendReminder(todo, rule.type);
    }
  }
}

async function maybeSendReminder(todo, reminderType) {
  const alreadySent = await remindersSent().findOne({ todoId: todo._id.toString(), reminderType });
  if (alreadySent) return;

  try {
    await remindersSent().insertOne({
      todoId: todo._id.toString(),
      userId: todo.userId,
      reminderType,
      sentAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error?.code === 11000) return; // 已有其他排程跑過，避免重複通知
    throw error;
  }

  const message = `提醒：「${todo.title}」將於 ${formatDueTime(todo.dueTime)} 到期`;
  await Promise.allSettled([sendLinePushIfLinked(todo.userId, message), sendWebPushIfSubscribed(todo.userId, todo.title, message)]);
}

async function sendLinePushIfLinked(userId, message) {
  const user = await users().findOne({ _id: new ObjectId(userId) });
  if (!user?.lineUserId) return;

  try {
    await sendLineMessage(user.lineUserId, message);
  } catch (error) {
    console.error("LINE 推播失敗:", error);
  }
}

async function sendWebPushIfSubscribed(userId, title, message) {
  if (!vapidConfigured) return;

  const subscriptions = await pushSubscriptions().find({ userId, type: "webpush" }).toArray();
  const payload = JSON.stringify({ title: "待辦提醒", body: message });

  for (const record of subscriptions) {
    try {
      await webpush.sendNotification(record.subscription, payload);
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await pushSubscriptions().deleteOne({ _id: record._id });
      } else {
        console.error("Web Push 推播失敗:", error);
      }
    }
  }
}

function formatDueTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  return date.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
