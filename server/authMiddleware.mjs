import jwt from "jsonwebtoken";

export const SESSION_COOKIE = "todo_session";
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 天，符合「持久化登入」

export function issueSessionCookie(res, user) {
  const secret = requireJwtSecret();
  const token = jwt.sign({ sub: user._id.toString() }, secret, { expiresIn: "90d" });

  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE);
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: "尚未登入" });
    return;
  }

  try {
    const payload = jwt.verify(token, requireJwtSecret());
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "登入已過期，請重新登入" });
  }
}

export function readUserId(req) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;

  try {
    return jwt.verify(token, requireJwtSecret()).sub;
  } catch {
    return null;
  }
}

function requireJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return secret;
}
