# 待辦事項桌面應用 — 專案說明（給 Claude Code）

## 專案目標

做一個桌面待辦事項應用，核心特色：

1. 使用者可以貼上/上傳截圖，AI 自動解析出待辦事項（標題、時間、標籤等）
2. 事項到期時間快到時，主動跳出系統通知提醒
3. 狀態管理：待處理 / 進行中 / 結案，其中「進行中」可以再細分多個自訂子階段
4. 使用者不懂程式，介面必須簡單易懂；資料要能一鍵匯出成 Excel 供檢視/備份/列印

## 技術棧決策（實際現況，非 Tauri 桌面版）

> 這個專案最初規劃是 Tauri 桌面 App + SQLite（見下方「資料模型草案」），但實際開發演變成瀏覽器版網頁 App。以下才是目前真正的架構，之後的開發都應該基於這個現況：

- **前端**：Vue 3 + TypeScript（Composition API）+ Vuetify，單頁應用，見 `client/src/App.vue`。用 Vite 開發/打包。
- **後端**：Express（`server/index.mjs` 及 `server/routes/*.mjs`），同時提供靜態檔案（`client/dist`）與 API，部署方式見 `zbpack.json`（Zeabur 類 buildpack）。
- **資料庫：MongoDB Atlas**（`server/db.mjs`），取代原本的 SQLite 草案。集合：`users`、`todos`、`pushSubscriptions`、`remindersSent`。
- **會員機制：LINE Login（OAuth2/OIDC）**，多人共用帳號。登入後用 httpOnly cookie 存放簽章 JWT（約 90 天，`server/authMiddleware.mjs`），所有 `/api/todos`、`/api/push`、`/api/gemini` 路由都需要登入。
- **AI 截圖解析**：呼叫 **Gemini API**（不是 Claude API），多模態圖片輸入，見 `server/index.mjs` 的 `/api/gemini/analyze`。
- **提醒機制（雙管道）**：待辦事項目前沒有到期時間欄位，`server/reminderJob.mjs` 每 10 分鐘掃描一次，每天台灣時間 08:30 把使用者所有還沒結案的待辦事項統一彙整成一則訊息推播（同一使用者當天只發一次）：
  - **LINE 訊息推播**（`server/linePush.mjs`）：透過與 LINE Login 同一個 Provider 底下的 Messaging API channel 直接推送文字訊息
  - **瀏覽器 Web Push**（`web-push` 套件 + `client/public/sw.js`）：使用者在設定裡開啟「啟用瀏覽器通知」後訂閱
- **Excel 匯出/匯入**：尚未實作（仍是規劃階段，見下方「資料模型草案」與模組拆解，供未來參考）。
- **看板 UI / 自訂階段模板**：尚未實作，目前狀態管理只有 `pending` / `in_progress` / `done` 三種加上一個處理紀錄清單（`progressLogs`），沒有可自訂子階段。

### 環境變數（`.env`，範本見 `.env.example`）

| 變數 | 用途 |
|---|---|
| `GEMINI_API_KEY` | 截圖解析用的 Gemini API 金鑰 |
| `MONGODB_URI` | MongoDB Atlas 連線字串 |
| `JWT_SECRET` | 簽發登入 session cookie 用 |
| `LINE_LOGIN_CHANNEL_ID` / `LINE_LOGIN_CHANNEL_SECRET` / `LINE_LOGIN_CALLBACK_URL` | LINE Login channel 設定 |
| `LINE_MESSAGING_CHANNEL_ACCESS_TOKEN` | 與 Login channel 同 Provider 的 Messaging API channel，用來推播提醒 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push 用的 VAPID 金鑰（`npx web-push generate-vapid-keys` 產生） |

## 資料模型草案（歷史規劃，尚未在目前架構中實作）

以下 SQLite schema 是專案最初的規劃草案，目前並未採用（現況請看上面「技術棧決策」段落的 MongoDB 集合設計），保留在這裡是為了記錄 Excel 匯出/匯入、看板、自訂階段模板等**尚未實作**功能的原始設計意圖，未來要做這些功能時可以參考。

```sql
CREATE TABLE todos (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  due_time TEXT,              -- ISO 8601 絕對時間
  status TEXT NOT NULL,       -- 'pending' | 'in_progress' | 'done'
  stage_id TEXT,              -- 對應 stages 表，僅 status='in_progress' 時有意義
  source_note TEXT,           -- 解析來源摘要（例如截圖檔名或原文片段）
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE stage_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL          -- 例如「一般專案」「合約流程」
);

CREATE TABLE stages (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  name TEXT NOT NULL,         -- 例如「設計中」「開發中」「測試中」
  sort_order INTEGER NOT NULL,
  FOREIGN KEY (template_id) REFERENCES stage_templates(id)
);

CREATE TABLE stage_history (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL,
  stage_id TEXT,
  changed_at TEXT NOT NULL,
  FOREIGN KEY (todo_id) REFERENCES todos(id)
);

CREATE TABLE reminders_sent (
  id TEXT PRIMARY KEY,
  todo_id TEXT NOT NULL,
  reminder_type TEXT NOT NULL, -- 例如 '1_day_before' | '1_hour_before'
  sent_at TEXT NOT NULL,
  FOREIGN KEY (todo_id) REFERENCES todos(id)
);
```

## 功能模組拆解

### 1. 截圖解析

- 使用者可貼上剪貼簿截圖，或選擇圖片檔上傳
- 呼叫 Claude API，prompt 要求：
  - 回傳結構化 JSON 陣列，每筆包含 `title`, `due_time_guess`, `tags`, `confidence_note`
  - 明確告知目前日期，讓模型正確換算相對時間（例如「明天下午三點」）
  - 一張截圖可能解析出多筆待辦
- **不要自動寫入資料庫**：解析完先顯示「確認清單」畫面，使用者勾選要新增的項目、可修改欄位後才存入 SQLite

### 2. 狀態管理

- 大狀態：`pending` / `in_progress` / `done`
- `in_progress` 底下的子階段是**可自訂模板**，不要寫死列舉；使用者可以建立多組階段模板（例如「一般任務」「合約流程」），新建待辦時選擇要套用哪個模板
- 每次階段變更寫入 `stage_history`，方便日後查看時間軸
- UI 建議做看板（Kanban）樣式：pending / in_progress / done 三欄，in_progress 欄內用小標籤顯示目前子階段，點擊可快速切換

### 3. 提醒引擎

- 背景 timer 定期掃描 `due_time` 即將到期且未在 `reminders_sent` 記錄過的項目
- 提醒時機可設定（例如到期前 1 天、前 1 小時），避免重複通知
- 使用 Tauri 系統通知 API 跳出原生提醒

### 4. Excel 匯出/匯入

- 「匯出成 Excel」：一鍵將目前所有待辦事項（含狀態、階段、到期時間）匯出成 .xlsx，供使用者檢視、列印、分享
- 「匯入 Excel」：使用者可下載範本、離線編輯後匯入，程式讀取並驗證格式（欄位缺漏、日期格式錯誤要有清楚錯誤提示，不要直接當掉）
- 匯入/匯出都是**明確觸發的動作**，不是即時同步，避免檔案鎖定問題

## UI/UX 原則（使用者不懂程式）

- 介面盡量表格化、看板化，操作靠點擊而非輸入指令
- 所有錯誤訊息用白話文，避免技術術語（例如不要顯示 SQL error，要顯示「這個時間格式看不懂，請用 2026/07/20 這種格式」）
- 截圖解析後一定要有「確認/編輯」步驟，不直接寫入，降低 AI 判斷錯誤造成的困擾

## 開發順序建議（給 Claude Code 的執行順序）

1. 建立 Tauri + Vue 3 專案骨架，跑起基本視窗
2. 建立 SQLite schema，做基本的 CRUD（新增/編輯/刪除待辦）＋看板 UI
3. 加入狀態機與自訂階段模板功能
4. 加入 Excel 匯出功能（先做匯出，比匯入單純）
5. 加入 Excel 匯入功能（含格式驗證與錯誤提示）
6. 串接 Claude API 做截圖解析（含確認畫面）
7. 加入背景提醒 timer 與系統通知
8. 打包成安裝檔，實機測試背景提醒是否在應用關閉/最小化時仍正常運作
