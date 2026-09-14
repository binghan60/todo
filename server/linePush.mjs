const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";

export async function sendLineMessage(lineUserId, message) {
  const accessToken = process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN;
  if (!accessToken) {
    console.warn("LINE_MESSAGING_CHANNEL_ACCESS_TOKEN 未設定，略過 LINE 推播");
    return false;
  }

  const response = await fetch(LINE_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [typeof message === "string" ? { type: "text", text: message } : message],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE push failed: HTTP ${response.status} ${body}`);
  }
  return true;
}
