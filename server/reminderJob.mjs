import webpush from "web-push";
import { ObjectId } from "mongodb";
import { todos, users, pushSubscriptions, remindersSent } from "./db.mjs";
import { sendLineMessage } from "./linePush.mjs";

const POLL_INTERVAL_MS = 10 * 60 * 1000; // 每 10 分鐘掃描一次
const CHECK_WINDOW_MS = 15 * 60 * 1000; // 視窗要比掃描間隔寬，避免漏掃
const TIMEZONE = "Asia/Taipei";

// 每天固定在這個時間，把使用者還沒結案的待辦事項統一彙整提醒一次
const DAILY_DIGEST_MINUTES_SINCE_MIDNIGHT = 8 * 60 + 30; // 08:30

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
  const { dateStr, minutesSinceMidnight } = getTaipeiParts();
  const isWithinWindow =
    minutesSinceMidnight >= DAILY_DIGEST_MINUTES_SINCE_MIDNIGHT &&
    minutesSinceMidnight < DAILY_DIGEST_MINUTES_SINCE_MIDNIGHT + CHECK_WINDOW_MS / 60000;
  if (!isWithinWindow) return;

  const pendingTodos = await todos()
    .find({ status: { $ne: "done" } })
    .toArray();

  const todosByUser = new Map();
  for (const todo of pendingTodos) {
    if (!todosByUser.has(todo.userId)) todosByUser.set(todo.userId, []);
    todosByUser.get(todo.userId).push(todo);
  }

  for (const [userId, userTodos] of todosByUser) {
    await maybeSendDigestForUser(userId, userTodos, dateStr);
  }
}

async function maybeSendDigestForUser(userId, userTodos, dateStr) {
  const digestId = `digest:${userId}:${dateStr}`;
  const alreadySent = await remindersSent().findOne({ todoId: digestId, reminderType: "daily_digest" });
  if (alreadySent) return;

  try {
    await remindersSent().insertOne({
      todoId: digestId,
      userId,
      reminderType: "daily_digest",
      sentAt: new Date().toISOString(),
    });
  } catch (error) {
    if (error?.code === 11000) return; // 已有其他排程跑過，避免重複通知
    throw error;
  }

  const titles = userTodos.map((todo) => `‧${todo.title}`).join("\n");
  const message = `早安！你有 ${userTodos.length} 筆還沒結案的待辦事項：\n${titles}`;
  await Promise.allSettled([sendLinePushIfLinked(userId, message), sendWebPushIfSubscribed(userId, "待辦提醒", message)]);
}

function getTaipeiParts() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  const minutesSinceMidnight = Number(get("hour")) * 60 + Number(get("minute"));

  return { dateStr, minutesSinceMidnight };
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
  const payload = JSON.stringify({ title, body: message });

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
