import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTodoDigestText, buildTodoFlexMessage } from "./lineFlex.mjs";
import { sendLineMessage } from "./linePush.mjs";

const task = (title, extra = {}) => ({ title, status: "pending", createdAt: "2026-09-15T00:00:00Z", ...extra });
const todoRows = (message) => (message.contents.body?.contents ?? []).filter((row) => row.type === "box");
const cardText = (message) =>
  message.contents.header.contents[0].text + "\n" + todoRows(message).map((row) => `‧${row.contents[1].text}`).join("\n");
const chipLabel = (row) => row.contents[2]?.contents[0].text;

function setEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function clearAppUrl(t) {
  setEnv(t, "APP_BASE_URL", undefined);
  setEnv(t, "LINE_LOGIN_CALLBACK_URL", undefined);
}

test("Flex keeps the digest wording, lists important tasks first and excludes completed tasks", () => {
  const input = [task("一般"), task("重要舊", { isImportant: true, createdAt: "2026-09-10" }),
    task("已結案", { isImportant: true, status: "done" }), task("重要新", { isImportant: true, status: "in_progress" })];
  const before = structuredClone(input);
  const result = buildTodoFlexMessage(input);
  const expected = "早安！你有 3 筆還沒結案的待辦事項：\n‧重要舊\n‧重要新\n‧一般";
  assert.equal(cardText(result), expected);
  assert.equal(buildTodoDigestText(input), expected);
  assert.equal(result.altText, expected);
  assert.deepEqual(input, before);
});

test("rows show a star for important tasks and a status chip", () => {
  const rows = todoRows(buildTodoFlexMessage([
    task("重要處理中", { isImportant: true, status: "in_progress" }),
    task("一般待辦"),
    task("怪狀態", { status: "archived" }),
  ]));
  assert.equal(rows[0].contents[0].text, "★");
  assert.equal(rows[0].contents[1].color, "#d0342c");
  assert.equal(chipLabel(rows[0]), "處理中");
  assert.equal(rows[1].contents[0].text, "・");
  assert.notEqual(rows[1].contents[1].color, "#d0342c");
  assert.equal(chipLabel(rows[1]), "待辦");
  assert.equal(rows[2].contents.length, 2);
});

test("long titles are preserved and big lists stay under the Flex size limit", () => {
  const input = Array.from({ length: 20 }, (_, i) => task(`${i + 1}. ${"😀".repeat(100)}`));
  const result = buildTodoFlexMessage(input);
  assert.equal(cardText(result), buildTodoDigestText(input));
  assert.equal(todoRows(result).length, 20);
  assert.ok(result.altText.length <= 400);
  assert.equal(todoRows(result)[19].contents[1].maxLines, undefined);

  const huge = buildTodoFlexMessage(Array.from({ length: 100 }, (_, i) => task(`${i + 1}. ${"😀".repeat(100)}`)));
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) < 50000);
});

test("more than 40 tasks renders 40 rows plus a remaining-count line", (t) => {
  setEnv(t, "APP_BASE_URL", "https://todo.example.com");
  const result = buildTodoFlexMessage(Array.from({ length: 41 }, (_, i) => task(`任務 ${i + 1}`)));
  const body = result.contents.body.contents;
  assert.equal(todoRows(result).length, 40);
  assert.equal(body.at(-1).text, "…還有 1 筆，點下方按鈕查看");
});

test("empty cards retain the original zero-task summary", () => {
  const empty = buildTodoFlexMessage([]);
  assert.equal(cardText(empty), "早安！你有 0 筆還沒結案的待辦事項：\n");
  assert.doesNotMatch(JSON.stringify(empty), /測試|推播設定成功/);
  assert.equal(empty.contents.body, undefined);
});

test("card adds no company, requester, date or slogan", (t) => {
  clearAppUrl(t);
  const result = buildTodoFlexMessage([task("寄送報價", { company: "不應出現的公司", requester: "不應出現的人", status: "in_progress", isImportant: true })]);
  assert.equal(cardText(result), "早安！你有 1 筆還沒結案的待辦事項：\n‧寄送報價");
  assert.doesNotMatch(JSON.stringify(result), /不應出現的公司|不應出現的人|2026|從容|測試|每日待辦提醒/);
});

test("footer button links to APP_BASE_URL, falls back to the login callback origin, or is omitted", (t) => {
  clearAppUrl(t);
  assert.equal(buildTodoFlexMessage([task("範例")]).contents.footer, undefined);

  process.env.LINE_LOGIN_CALLBACK_URL = "https://todo.example.com/api/auth/line/callback";
  const fromCallback = buildTodoFlexMessage([task("範例")]).contents.footer.contents[0];
  assert.equal(fromCallback.action.uri, "https://todo.example.com");
  assert.equal(fromCallback.action.label, "打開待辦清單");

  process.env.APP_BASE_URL = "https://app.example.com/";
  assert.equal(buildTodoFlexMessage([task("範例")]).contents.footer.contents[0].action.uri, "https://app.example.com/");
});

test("task wording including newlines and punctuation is unchanged", () => {
  const input = [task('確認 "Type-C" 規格\n回覆客戶：可行'), task(" A & B < C ")];
  assert.equal(cardText(buildTodoFlexMessage(input)), buildTodoDigestText(input));
});

test("LINE sender sends Flex objects and keeps existing text callers supported", async (t) => {
  setEnv(t, "LINE_MESSAGING_CHANNEL_ACCESS_TOKEN", "test-token");
  const sent = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://api.line.me/v2/bot/message/push");
    sent.push(JSON.parse(init.body));
    return { ok: true };
  });
  const flex = buildTodoFlexMessage([task("範例")]);
  assert.equal(await sendLineMessage("test-user", flex), true);
  assert.deepEqual(sent[0], { to: "test-user", messages: [flex] });
  await sendLineMessage("test-user", "純文字");
  assert.deepEqual(sent[1].messages, [{ type: "text", text: "純文字" }]);
});

test("missing token reports not sent; LINE failures remain visible to caller", async (t) => {
  setEnv(t, "LINE_MESSAGING_CHANNEL_ACCESS_TOKEN", "");
  t.mock.method(console, "warn", () => {});
  const request = t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 400, text: async () => "invalid message" }));
  assert.equal(await sendLineMessage("test-user", "test"), false);
  assert.equal(request.mock.callCount(), 0);
  process.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN = "test-token";
  await assert.rejects(sendLineMessage("test-user", "test"), /HTTP 400/);
});
