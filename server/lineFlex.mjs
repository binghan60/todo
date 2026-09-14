// 文字版（Web Push 內文、Flex altText）維持原本文案；Flex 卡片則每筆一列，加上重要星號與狀態標籤。
const MAX_ROWS = 40; // Flex 整包 JSON 上限 50KB，超過的筆數改用一列「還有 N 筆」帶過

const IMPORTANT_COLOR = "#d0342c"; // 重要待辦的星號與標題用紅字

const STATUS_CHIPS = {
  pending: { label: "待辦", backgroundColor: "#f2ebe4", color: "#8a7a6d" },
  in_progress: { label: "處理中", backgroundColor: "#f8eed8", color: "#b89059" },
};

// 重要優先，其餘維持呼叫端傳進來的順序；filter 會產生新陣列，不會動到呼叫端的 items。
function sortOpenTodos(items) {
  return items
    .filter((todo) => todo.status !== "done")
    .sort((a, b) => Number(b.isImportant === true) - Number(a.isImportant === true));
}

export function buildTodoDigestText(items) {
  const openTodos = sortOpenTodos(items);
  const titles = openTodos.map((todo) => `‧${todo.title}`).join("\n");
  return `早安！你有 ${openTodos.length} 筆還沒結案的待辦事項：\n${titles}`;
}

export function buildTodoFlexMessage(items) {
  const openTodos = sortOpenTodos(items);
  const message = buildTodoDigestText(items);
  const summary = message.slice(0, message.indexOf("\n"));
  const preview = Array.from(message);
  const appUrl = resolveAppUrl();

  const rows = openTodos.slice(0, MAX_ROWS).map(todoRow);
  const hiddenCount = openTodos.length - MAX_ROWS;
  if (hiddenCount > 0) {
    rows.push({
      type: "text",
      text: `…還有 ${hiddenCount} 筆${appUrl ? "，點下方按鈕查看" : ""}`,
      size: "xs",
      color: "#9a8a7c",
      wrap: true,
    });
  }

  return {
    type: "flex",
    altText: preview.length > 200 ? preview.slice(0, 199).join("") + "…" : message,
    contents: {
      type: "bubble",
      size: "mega",
      styles: {
        header: { backgroundColor: "#fff8ef" },
        ...(rows.length ? { body: { backgroundColor: "#fffdf9", separator: true, separatorColor: "#ead8c5" } } : {}),
        ...(appUrl ? { footer: { backgroundColor: "#fffdf9" } } : {}),
      },
      header: {
        type: "box",
        layout: "vertical",
        paddingAll: "20px",
        contents: [{ type: "text", text: summary, size: "md", weight: "bold", color: "#85543d", wrap: true }],
      },
      ...(rows.length ? {
        body: { type: "box", layout: "vertical", paddingAll: "20px", spacing: "md", contents: rows },
      } : {}),
      ...(appUrl ? {
        footer: {
          type: "box",
          layout: "vertical",
          paddingAll: "16px",
          paddingTop: "0px",
          contents: [{
            type: "button",
            style: "primary",
            height: "sm",
            color: "#b7795c",
            action: { type: "uri", label: "打開待辦清單", uri: appUrl },
          }],
        },
      } : {}),
    },
  };
}

function todoRow(todo) {
  const important = todo.isImportant === true;
  const chip = statusChip(todo.status);
  return {
    type: "box",
    layout: "horizontal",
    spacing: "sm",
    alignItems: "flex-start",
    contents: [
      // 非重要用淡色「・」佔位，讓每列標題左緣對齊
      { type: "text", text: important ? "★" : "・", flex: 0, size: "sm", color: important ? IMPORTANT_COLOR : "#cbb8a6" },
      { type: "text", text: todo.title, flex: 1, size: "sm", color: important ? IMPORTANT_COLOR : "#5f4d40", wrap: true },
      ...(chip ? [chip] : []),
    ],
  };
}

function statusChip(status) {
  const chip = STATUS_CHIPS[status];
  if (!chip) return null;
  return {
    type: "box",
    layout: "vertical",
    flex: 0,
    cornerRadius: "md",
    backgroundColor: chip.backgroundColor,
    paddingTop: "2px",
    paddingBottom: "2px",
    paddingStart: "8px",
    paddingEnd: "8px",
    contents: [{ type: "text", text: chip.label, size: "xxs", color: chip.color }],
  };
}

function resolveAppUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  try {
    return new URL(process.env.LINE_LOGIN_CALLBACK_URL).origin;
  } catch {
    return null;
  }
}
