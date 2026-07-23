import { MongoClient } from "mongodb";

let client;
let db;

export async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  client = new MongoClient(uri);
  await client.connect();
  db = client.db();

  await db.collection("users").createIndex({ lineUserId: 1 }, { unique: true });
  await db.collection("todos").createIndex({ userId: 1, status: 1 });
  await db.collection("pushSubscriptions").createIndex({ userId: 1 });
  await db.collection("remindersSent").createIndex({ todoId: 1, reminderType: 1 }, { unique: true });

  console.log("Connected to MongoDB");
  return db;
}

export function getDb() {
  if (!db) throw new Error("MongoDB is not connected yet");
  return db;
}

export function users() {
  return getDb().collection("users");
}

export function todos() {
  return getDb().collection("todos");
}

export function pushSubscriptions() {
  return getDb().collection("pushSubscriptions");
}

export function remindersSent() {
  return getDb().collection("remindersSent");
}
