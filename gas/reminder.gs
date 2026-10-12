// Google Apps Script：每天定時呼叫待辦 App 的提醒 API
// 設定步驟：
// 1. 到 script.google.com 建立新專案，貼上這段程式
// 2. 左側「專案設定」→「指令碼屬性」新增：
//    APP_URL     = https://你的網域（結尾不要加斜線）
//    CRON_SECRET = 與 Vercel 環境變數 CRON_SECRET 相同的字串
// 3. 左側「觸發條件」→ 新增觸發條件：函式 triggerReminder、時間驅動、日計時器、上午 8 點到 9 點
//    （GAS 會在該小時內隨機時間執行，後端同一天只會發送一次，不會重複）
function triggerReminder() {
  const props = PropertiesService.getScriptProperties();
  const response = UrlFetchApp.fetch(props.getProperty("APP_URL") + "/api/cron/reminder", {
    method: "get",
    headers: { Authorization: "Bearer " + props.getProperty("CRON_SECRET") },
    muteHttpExceptions: true,
  });
  console.log(response.getResponseCode() + " " + response.getContentText());
}
