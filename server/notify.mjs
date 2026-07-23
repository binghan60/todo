import webpush from "web-push";
import { ObjectId } from "mongodb";
import { users, pushSubscriptions } from "./db.mjs";
import { sendLineMessage } from "./linePush.mjs";

let vapidConfigured = false;

export function configureVapid() {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    console.warn("VAPID 金鑰未設定，將略過瀏覽器 Web Push");
    return;
  }

  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  vapidConfigured = true;
}

export async function notifyUser(userId, title, message) {
  const [lineSent, webPushCount] = await Promise.all([
    sendLinePushIfLinked(userId, message),
    sendWebPushIfSubscribed(userId, title, message),
  ]);

  return { lineSent, webPushCount };
}

async function sendLinePushIfLinked(userId, message) {
  const user = await users().findOne({ _id: new ObjectId(userId) });
  if (!user?.lineUserId) return false;

  try {
    await sendLineMessage(user.lineUserId, message);
    return true;
  } catch (error) {
    console.error("LINE 推播失敗:", error);
    return false;
  }
}

async function sendWebPushIfSubscribed(userId, title, message) {
  if (!vapidConfigured) return 0;

  const subscriptions = await pushSubscriptions().find({ userId, type: "webpush" }).toArray();
  const payload = JSON.stringify({ title, body: message });
  let sentCount = 0;

  for (const record of subscriptions) {
    try {
      await webpush.sendNotification(record.subscription, payload);
      sentCount += 1;
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await pushSubscriptions().deleteOne({ _id: record._id });
      } else {
        console.error("Web Push 推播失敗:", error);
      }
    }
  }

  return sentCount;
}
