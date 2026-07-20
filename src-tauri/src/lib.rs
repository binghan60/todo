use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Deserialize)]
struct AnalyzeTaskRequest {
    api_key: String,
    model: Option<String>,
    text: Option<String>,
    image_mime_type: Option<String>,
    image_base64: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct AiTaskDraft {
    title: String,
    requester: String,
    company: String,
    contact: String,
    description: String,
    next_action: String,
    due_time_guess: String,
    confidence_note: String,
}

#[tauri::command]
async fn analyze_task_with_gemini(request: AnalyzeTaskRequest) -> Result<AiTaskDraft, String> {
    let api_key = request.api_key.trim();
    let text = request.text.unwrap_or_default();
    let text = text.trim();
    let image_base64 = request.image_base64.unwrap_or_default();
    let image_base64 = image_base64.trim();
    let image_mime_type = request
        .image_mime_type
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("image/png");

    if api_key.is_empty() {
        return Err("請先輸入 Gemini API Key".to_string());
    }

    if text.is_empty() && image_base64.is_empty() {
        return Err("請先選擇截圖或提供 OCR 文字".to_string());
    }

    let model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("gemini-2.5-flash");

    let mut parts = Vec::new();

    if !image_base64.is_empty() {
        parts.push(json!({
            "inline_data": {
                "mime_type": image_mime_type,
                "data": image_base64
            }
        }));
    }

    parts.push(json!({
        "text": format!(
            "你是繁體中文業務助理。請從 email 截圖、OCR 文字或雜亂訊息中整理出一筆待辦任務。\n\n規則：\n1. 不要捏造不存在的期限、聯絡人或公司。\n2. 任務標題要是可執行的動作。\n3. description 保留客戶需求、產品、規格、報價、附件等上下文。\n4. next_action 寫下一步該做什麼。\n5. 若圖片和 OCR 文字衝突，以圖片內容為主。\n\nOCR 文字如下：\n{}",
            if text.is_empty() { "（未提供 OCR 文字，請直接依圖片判斷）" } else { text }
        )
    }));

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model
    );

    let client = reqwest::Client::new();
    let response = client
        .post(url)
        .header("x-goog-api-key", api_key)
        .json(&json!({
            "contents": [
                {
                    "role": "user",
                    "parts": parts
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "可執行的待辦任務標題" },
                        "requester": { "type": "string", "description": "需求提出者姓名，沒有則空字串" },
                        "company": { "type": "string", "description": "需求方公司，沒有則空字串" },
                        "contact": { "type": "string", "description": "email 或其他聯絡方式，沒有則空字串" },
                        "description": { "type": "string", "description": "任務背景與重要細節" },
                        "next_action": { "type": "string", "description": "下一步要做的事" },
                        "due_time_guess": { "type": "string", "description": "期限判斷，沒有明確期限則空字串" },
                        "confidence_note": { "type": "string", "description": "判斷信心與不確定處" }
                    },
                    "required": [
                        "title",
                        "requester",
                        "company",
                        "contact",
                        "description",
                        "next_action",
                        "due_time_guess",
                        "confidence_note"
                    ]
                }
            }
        }))
        .send()
        .await
        .map_err(|error| format!("Gemini 連線失敗：{}", error))?;

    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("Gemini 回應不是有效 JSON：{}", error))?;

    if !status.is_success() {
        let message = body
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or("Gemini API 回傳錯誤");
        return Err(format!("{} ({})", message, status));
    }

    let output_text = extract_gemini_text(&body).ok_or_else(|| "Gemini 回應沒有文字內容".to_string())?;

    serde_json::from_str::<AiTaskDraft>(&output_text)
        .map_err(|error| format!("Gemini 回傳格式無法解析：{}", error))
}

fn extract_gemini_text(body: &Value) -> Option<String> {
    body.get("candidates")?
        .as_array()?
        .iter()
        .flat_map(|candidate| {
            candidate
                .pointer("/content/parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .find_map(|part| part.get("text").and_then(Value::as_str).map(ToString::to_string))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![analyze_task_with_gemini])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}