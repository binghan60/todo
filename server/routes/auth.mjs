import { randomBytes } from "node:crypto";
import { Router } from "express";
import jwt from "jsonwebtoken";
import { ObjectId } from "mongodb";
import { users } from "../db.mjs";
import { clearSessionCookie, issueSessionCookie, readUserId } from "../authMiddleware.mjs";

const STATE_COOKIE = "line_oauth_state";
const LINE_AUTHORIZE_URL = "https://access.line.me/oauth2/v2.1/authorize";
const LINE_TOKEN_URL = "https://api.line.me/oauth2/v2.1/token";

export const authRouter = Router();

authRouter.get("/line/login", (req, res) => {
  const { channelId, callbackUrl } = requireLoginConfig();
  const state = randomBytes(16).toString("hex");

  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
  });

  const authorizeUrl = new URL(LINE_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", channelId);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("scope", "profile openid");
  authorizeUrl.searchParams.set("bot_prompt", "normal");

  res.redirect(authorizeUrl.toString());
});

authRouter.get("/line/callback", async (req, res) => {
  const { channelId, channelSecret, callbackUrl } = requireLoginConfig();
  const { code, state } = req.query;
  const expectedState = req.cookies?.[STATE_COOKIE];
  clearCookieState(res);

  if (!code || !state || !expectedState || state !== expectedState) {
    res.status(400).send("登入驗證失敗，請重新登入一次。");
    return;
  }

  try {
    const tokenResponse = await fetch(LINE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: callbackUrl,
        client_id: channelId,
        client_secret: channelSecret,
      }),
    });

    const tokenBody = await tokenResponse.json();
    if (!tokenResponse.ok) {
      console.error("LINE token exchange failed:", tokenBody);
      res.status(502).send("向 LINE 換取登入憑證失敗，請稍後再試。");
      return;
    }

    const profile = jwt.verify(tokenBody.id_token, channelSecret, {
      algorithms: ["HS256"],
      audience: channelId,
      issuer: "https://access.line.me",
    });

    const now = new Date().toISOString();
    const collection = users();
    const existing = await collection.findOne({ lineUserId: profile.sub });

    let userId;
    if (existing) {
      userId = existing._id;
      await collection.updateOne(
        { _id: userId },
        { $set: { displayName: profile.name ?? existing.displayName, pictureUrl: profile.picture ?? existing.pictureUrl, updatedAt: now } }
      );
    } else {
      const result = await collection.insertOne({
        lineUserId: profile.sub,
        displayName: profile.name ?? "LINE 使用者",
        pictureUrl: profile.picture ?? "",
        createdAt: now,
        updatedAt: now,
      });
      userId = result.insertedId;
    }

    issueSessionCookie(res, { _id: userId });
    res.redirect("/");
  } catch (error) {
    console.error("LINE login callback error:", error);
    res.status(500).send("登入時發生錯誤，請稍後再試。");
  }
});

authRouter.get("/me", async (req, res) => {
  const userId = readUserId(req);
  if (!userId) {
    res.status(401).json({ error: "尚未登入" });
    return;
  }

  const user = await users().findOne({ _id: new ObjectId(userId) });
  if (!user) {
    res.status(401).json({ error: "找不到使用者" });
    return;
  }

  res.json({
    id: user._id.toString(),
    displayName: user.displayName,
    pictureUrl: user.pictureUrl,
  });
});

authRouter.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

function clearCookieState(res) {
  res.clearCookie(STATE_COOKIE);
}

function requireLoginConfig() {
  const channelId = process.env.LINE_LOGIN_CHANNEL_ID;
  const channelSecret = process.env.LINE_LOGIN_CHANNEL_SECRET;
  const callbackUrl = process.env.LINE_LOGIN_CALLBACK_URL;

  if (!channelId || !channelSecret || !callbackUrl) {
    throw new Error("LINE_LOGIN_CHANNEL_ID, LINE_LOGIN_CHANNEL_SECRET, LINE_LOGIN_CALLBACK_URL 需要設定");
  }

  return { channelId, channelSecret, callbackUrl };
}
