# 待辦事項桌面應用 — 專案說明（給 Claude Code）

## 專案目標

做一個桌面待辦事項應用，核心特色：

1. 使用者可以貼上/上傳截圖，AI 自動解析出待辦事項（標題、時間、標籤等）
2. 事項到期時間快到時，主動跳出系統通知提醒
3. 狀態管理：待處理 / 進行中 / 結案，其中「進行中」可以再細分多個自訂子階段
4. 使用者不懂程式，介面必須簡單易懂；資料要能一鍵匯出成 Excel 供檢視/備份/列印

## 技術棧決策

- **框架：Tauri**（不是 Electron）。前端用網頁技術（Vue 3 + TypeScript，使用 Composition API），打包成 Windows/Mac 桌面 EXE/App，體積小、啟動快，且能拿到系統層級權限（背景常駐、系統通知、剪貼簿讀取）。
- **內部資料庫：SQLite**（用 Tauri 的 SQL plugin 或 rusqlite），單一檔案，不需要額外安裝伺服器，讀寫穩定不會有檔案鎖定問題。
- **Excel 匯出/匯入**：用 `exceljs`（前端 JS）或 Rust 端的 `rust_xlsxwriter` 產生 .xlsx。**Excel 只作為匯出檢視/備份/匯入工具，不是即時運作的資料來源**，理由已在專案討論中確認：Excel 檔案若被使用者開啟編輯，程式無法寫入，會與截圖自動解析、狀態更新、背景提醒等功能衝突。
- **AI 截圖解析**：呼叫 Claude API（多模態，圖片輸入 + 文字 prompt），要求模型回傳結構化 JSON 陣列（一張截圖可能有多筆待辦）。
- **提醒機制**：Tauri 背景 timer 定期（例如每分鐘）掃描 SQLite 中即將到期的項目，觸發系統原生通知（Tauri notification plugin）。

## 資料模型（SQLite schema 草案）

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
