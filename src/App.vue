<script setup lang="ts">
import { computed, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

type TodoStatus = "pending" | "in_progress" | "done";

type Todo = {
  id: string;
  title: string;
  description: string;
  dueDate: string;
  status: TodoStatus;
  createdAt: string;
};

type OcrLog = {
  status?: string;
  progress?: number;
};

type OcrWorker = {
  recognize: (image: File | Blob | string) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<unknown>;
};

type AiTaskDraft = {
  title: string;
  requester: string;
  company: string;
  contact: string;
  description: string;
  next_action: string;
  due_time_guess: string;
  confidence_note: string;
};

type TesseractModule = {
  createWorker?: (
    langs?: string | string[],
    oem?: unknown,
    options?: { logger?: (message: OcrLog) => void },
  ) => Promise<OcrWorker>;
  default?: {
    createWorker?: TesseractModule["createWorker"];
  };
};

const statusColumns: Array<{ id: TodoStatus; label: string; hint: string }> = [
  { id: "pending", label: "待辦", hint: "尚未開始" },
  { id: "in_progress", label: "進行中", hint: "正在推進" },
  { id: "done", label: "完成", hint: "已經收尾" },
];

const todos = ref<Todo[]>([
  {
    id: crypto.randomUUID(),
    title: "協助尋找 TYPE-C Connect 朝上規格",
    description: "範例：請供應商提供規格書與報價，整理後回覆客戶確認。",
    dueDate: "",
    status: "pending",
    createdAt: new Date().toISOString(),
  },
]);

const newTitle = ref("");
const newDescription = ref("");
const newDueDate = ref("");
const imageFile = ref<File | null>(null);
const imagePreviewUrl = ref("");
const recognizedText = ref("");
const ocrStatus = ref("尚未選擇圖片");
const ocrProgress = ref(0);
const isRecognizing = ref(false);
const geminiApiKey = ref("");
const geminiModel = ref("gemini-2.5-flash");
const aiDraft = ref<AiTaskDraft | null>(null);
const aiStatus = ref("可直接讓 Gemini 看圖片整理任務，OCR 文字會當輔助");
const isAnalyzing = ref(false);

const totalCount = computed(() => todos.value.length);
const doneCount = computed(() => countByStatus("done"));
const activeCount = computed(() => totalCount.value - doneCount.value);
const recognizedLines = computed(() =>
  recognizedText.value
    .split(/\r?\n/)
    .map((line) => normalizeTodoLine(line))
    .filter((line) => line.length > 0),
);

function countByStatus(status: TodoStatus) {
  return todos.value.filter((todo) => todo.status === status).length;
}

function todosByStatus(status: TodoStatus) {
  return todos.value.filter((todo) => todo.status === status);
}

function addTodo() {
  const title = newTitle.value.trim();

  if (!title) {
    return;
  }

  createTodo(title, newDescription.value.trim(), newDueDate.value);
  newTitle.value = "";
  newDescription.value = "";
  newDueDate.value = "";
}

function createTodo(title: string, description = "", dueDate = "") {
  todos.value.unshift({
    id: crypto.randomUUID(),
    title,
    description,
    dueDate,
    status: "pending",
    createdAt: new Date().toISOString(),
  });
}

function moveTodo(todoId: string, status: TodoStatus) {
  const todo = todos.value.find((item) => item.id === todoId);

  if (todo) {
    todo.status = status;
  }
}

function removeTodo(todoId: string) {
  todos.value = todos.value.filter((todo) => todo.id !== todoId);
}

function handleImageInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];

  if (file) {
    setImageFile(file);
  }
}

function handlePaste(event: ClipboardEvent) {
  const file = Array.from(event.clipboardData?.files ?? []).find((item) => item.type.startsWith("image/"));

  if (file) {
    event.preventDefault();
    setImageFile(file);
  }
}

function setImageFile(file: File) {
  if (!file.type.startsWith("image/")) {
    ocrStatus.value = "請選擇圖片檔";
    return;
  }

  if (imagePreviewUrl.value) {
    URL.revokeObjectURL(imagePreviewUrl.value);
  }

  imageFile.value = file;
  imagePreviewUrl.value = URL.createObjectURL(file);
  recognizedText.value = "";
  aiDraft.value = null;
  ocrProgress.value = 0;
  ocrStatus.value = "圖片已載入，可 OCR 或直接交給 Gemini";
}

async function recognizeScreenshot() {
  if (!imageFile.value || isRecognizing.value) {
    return;
  }

  isRecognizing.value = true;
  ocrProgress.value = 0;
  ocrStatus.value = "正在準備 OCR";

  const tesseractModule = (await import("tesseract.js")) as TesseractModule;
  const createWorker = tesseractModule.createWorker ?? tesseractModule.default?.createWorker;

  if (!createWorker) {
    ocrStatus.value = "OCR 模組載入失敗";
    isRecognizing.value = false;
    return;
  }

  const worker = await createWorker(["chi_tra", "eng"], undefined, {
    logger: (message) => {
      if (typeof message.progress === "number") {
        ocrProgress.value = Math.round(message.progress * 100);
      }

      if (message.status) {
        ocrStatus.value = message.status;
      }
    },
  });

  try {
    const result = await worker.recognize(imageFile.value);
    recognizedText.value = result.data.text.trim();
    ocrStatus.value = recognizedText.value ? "OCR 辨識完成" : "OCR 完成，但沒有讀到文字";
    ocrProgress.value = 100;
  } catch (error) {
    ocrStatus.value = error instanceof Error ? error.message : "OCR 辨識失敗";
  } finally {
    await worker.terminate();
    isRecognizing.value = false;
  }
}

function createTodosFromOcr() {
  const uniqueLines = [...new Set(recognizedLines.value)];

  uniqueLines.reverse().forEach((line) => {
    createTodo(line, "由 OCR 截圖辨識建立");
  });
}

async function analyzeWithGemini() {
  const text = recognizedText.value.trim();

  if ((!imageFile.value && !text) || isAnalyzing.value) {
    return;
  }

  isAnalyzing.value = true;
  aiDraft.value = null;
  aiStatus.value = "Gemini 正在閱讀圖片並整理任務";

  try {
    const imagePayload = imageFile.value ? await fileToBase64Payload(imageFile.value) : null;

    aiDraft.value = await invoke<AiTaskDraft>("analyze_task_with_gemini", {
      request: {
        api_key: geminiApiKey.value.trim(),
        model: geminiModel.value.trim(),
        text,
        image_mime_type: imagePayload?.mimeType ?? "",
        image_base64: imagePayload?.base64 ?? "",
      },
    });
    aiStatus.value = "Gemini 整理完成，請確認後新增";
  } catch (error) {
    aiStatus.value = typeof error === "string" ? error : "Gemini 整理失敗";
  } finally {
    isAnalyzing.value = false;
  }
}

function createTodoFromAi() {
  if (!aiDraft.value) {
    return;
  }

  const draft = aiDraft.value;
  const details = [
    draft.description,
    draft.next_action ? `下一步：${draft.next_action}` : "",
    draft.requester ? `需求者：${draft.requester}` : "",
    draft.company ? `公司：${draft.company}` : "",
    draft.contact ? `聯絡方式：${draft.contact}` : "",
    draft.due_time_guess ? `期限判斷：${draft.due_time_guess}` : "",
    draft.confidence_note ? `AI 備註：${draft.confidence_note}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  createTodo(draft.title || draft.next_action || "Gemini 整理任務", details);
}

function normalizeTodoLine(line: string) {
  return line
    .replace(/^[-*•□☐✓✔\d.、)\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fileToBase64Payload(file: File) {
  return new Promise<{ mimeType: string; base64: string }>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
      resolve({ mimeType: file.type || "image/png", base64 });
    };

    reader.onerror = () => reject(new Error("圖片讀取失敗"));
    reader.readAsDataURL(file);
  });
}
</script>

<template>
  <main class="app-shell" @paste="handlePaste">
    <section class="topbar" aria-labelledby="app-title">
      <div>
        <p class="eyebrow">Desktop Todo</p>
        <h1 id="app-title">任務工作台</h1>
      </div>

      <div class="metrics" aria-label="任務統計">
        <div><span>{{ totalCount }}</span><small>全部</small></div>
        <div><span>{{ activeCount }}</span><small>未完成</small></div>
        <div><span>{{ doneCount }}</span><small>完成</small></div>
      </div>
    </section>

    <section class="workspace-grid">
      <form class="composer" @submit.prevent="addTodo">
        <div class="input-grid">
          <label>
            <span>任務名稱</span>
            <input v-model="newTitle" autocomplete="off" placeholder="例如：向供應商確認 Type-C 規格與報價" />
          </label>

          <label>
            <span>期限</span>
            <input v-model="newDueDate" type="datetime-local" />
          </label>
        </div>

        <label>
          <span>備註</span>
          <textarea v-model="newDescription" rows="3" placeholder="補充細節、來源筆記或下一個動作"></textarea>
        </label>

        <div class="composer-actions">
          <p>手動新增任務，或從右側截圖整理後新增。</p>
          <button type="submit">新增任務</button>
        </div>
      </form>

      <section class="ocr-panel" aria-labelledby="ocr-title">
        <header>
          <div>
            <p class="eyebrow">Gemini Vision</p>
            <h2 id="ocr-title">截圖整理</h2>
          </div>
          <label class="file-button">
            選圖片
            <input type="file" accept="image/*" @change="handleImageInput" />
          </label>
        </header>

        <div class="ocr-body">
          <div class="preview-box">
            <img v-if="imagePreviewUrl" :src="imagePreviewUrl" alt="待整理截圖預覽" />
            <p v-else>可選圖片，或直接在視窗內貼上截圖</p>
          </div>

          <div class="ocr-controls">
            <button type="button" :disabled="!imageFile || isRecognizing" @click="recognizeScreenshot">
              {{ isRecognizing ? "辨識中" : "OCR 辨識" }}
            </button>
            <div class="progress-track" aria-label="OCR 進度"><span :style="{ width: `${ocrProgress}%` }"></span></div>
            <small>{{ ocrStatus }}</small>
          </div>

          <label>
            <span>OCR 文字</span>
            <textarea v-model="recognizedText" rows="4" placeholder="可先 OCR，也可留空直接讓 Gemini 看圖片"></textarea>
          </label>

          <div class="ai-box">
            <div class="input-grid ai-inputs">
              <label>
                <span>Gemini API Key</span>
                <input v-model="geminiApiKey" type="password" autocomplete="off" placeholder="AIza..." />
              </label>

              <label>
                <span>模型</span>
                <input v-model="geminiModel" autocomplete="off" placeholder="gemini-2.5-flash" />
              </label>
            </div>

            <div class="composer-actions">
              <p>{{ aiStatus }}</p>
              <button type="button" :disabled="(!imageFile && !recognizedText.trim()) || isAnalyzing" @click="analyzeWithGemini">
                {{ isAnalyzing ? "整理中" : "Gemini 整理" }}
              </button>
            </div>

            <dl v-if="aiDraft" class="ai-preview">
              <div><dt>任務</dt><dd>{{ aiDraft.title }}</dd></div>
              <div><dt>需求者</dt><dd>{{ aiDraft.requester || "未判斷" }}</dd></div>
              <div><dt>公司</dt><dd>{{ aiDraft.company || "未判斷" }}</dd></div>
              <div><dt>下一步</dt><dd>{{ aiDraft.next_action || "未判斷" }}</dd></div>
              <div><dt>信心</dt><dd>{{ aiDraft.confidence_note || "未提供" }}</dd></div>
            </dl>
          </div>

          <div class="composer-actions">
            <p>{{ recognizedLines.length }} 行 OCR 文字可逐行建立</p>
            <div class="split-actions">
              <button type="button" :disabled="recognizedLines.length === 0" @click="createTodosFromOcr">逐行轉任務</button>
              <button type="button" :disabled="!aiDraft" @click="createTodoFromAi">用 Gemini 結果新增</button>
            </div>
          </div>
        </div>
      </section>
    </section>

    <section class="board" aria-label="任務看板">
      <article v-for="column in statusColumns" :key="column.id" class="column">
        <header class="column-header">
          <div><h2>{{ column.label }}</h2><p>{{ column.hint }}</p></div>
          <strong>{{ countByStatus(column.id) }}</strong>
        </header>

        <div class="task-list">
          <article v-for="todo in todosByStatus(column.id)" :key="todo.id" class="task-card">
            <div>
              <h3>{{ todo.title }}</h3>
              <p v-if="todo.description">{{ todo.description }}</p>
              <time v-if="todo.dueDate">{{ todo.dueDate.replace("T", " ") }}</time>
            </div>

            <div class="task-actions">
              <button
                v-for="target in statusColumns"
                :key="target.id"
                type="button"
                :class="{ active: todo.status === target.id }"
                @click="moveTodo(todo.id, target.id)"
              >
                {{ target.label }}
              </button>
              <button type="button" class="danger" @click="removeTodo(todo.id)">刪除</button>
            </div>
          </article>

          <p v-if="todosByStatus(column.id).length === 0" class="empty-state">目前沒有任務</p>
        </div>
      </article>
    </section>
  </main>
</template>

<style>
:root {
  font-family: Inter, "Microsoft JhengHei", "PingFang TC", system-ui, sans-serif;
  color: #1d2433;
  background: #f3f6f8;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-text-size-adjust: 100%;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; min-height: 100vh; }
button, input, textarea { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.55; }

.app-shell { min-height: 100vh; padding: 32px; }
.topbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
.eyebrow { margin: 0 0 6px; color: #667085; font-size: 0.78rem; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 0; font-size: clamp(2rem, 4vw, 3.6rem); line-height: 1; }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(86px, 1fr)); gap: 10px; }
.metrics div, .composer, .ocr-panel { border: 1px solid #d9e1e7; border-radius: 8px; background: #ffffff; }
.metrics div { min-height: 72px; padding: 12px 14px; }
.metrics span { display: block; font-size: 1.45rem; font-weight: 800; }
.metrics small, .ocr-controls small { color: #667085; }
.workspace-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, 480px); gap: 16px; margin-bottom: 26px; }
.composer, .ocr-panel { display: grid; gap: 14px; padding: 18px; }
.ocr-panel header { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.ocr-panel h2 { margin-bottom: 0; font-size: 1.25rem; }
.ocr-body { display: grid; gap: 14px; }
.input-grid { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 14px; }
label { display: grid; gap: 7px; color: #475467; font-size: 0.9rem; font-weight: 700; }
input, textarea { width: 100%; border: 1px solid #cfd8df; border-radius: 8px; padding: 10px 12px; color: #1d2433; background: #fbfcfd; outline: none; }
textarea { resize: vertical; }
input:focus, textarea:focus { border-color: #2671d9; box-shadow: 0 0 0 3px rgba(38, 113, 217, 0.14); }
.file-button, .composer-actions button, .ocr-controls button, .task-actions button { border: 1px solid transparent; border-radius: 8px; padding: 9px 12px; color: #ffffff; background: #2671d9; font-weight: 800; }
.file-button { display: inline-grid; place-items: center; min-height: 40px; }
.file-button input { display: none; }
.composer-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.composer-actions p { margin-bottom: 0; color: #667085; font-size: 0.9rem; }
.preview-box { display: grid; place-items: center; min-height: 170px; overflow: hidden; border: 1px dashed #c5d0d8; border-radius: 8px; background: #f7fafc; }
.preview-box img { display: block; width: 100%; max-height: 260px; object-fit: contain; }
.preview-box p { margin: 0; padding: 18px; color: #667085; text-align: center; }
.ocr-controls { display: grid; grid-template-columns: auto minmax(120px, 1fr) auto; align-items: center; gap: 10px; }
.progress-track { height: 10px; overflow: hidden; border-radius: 999px; background: #e3e9ee; }
.progress-track span { display: block; height: 100%; border-radius: inherit; background: #1c4b38; transition: width 0.2s ease; }
.ai-box { display: grid; gap: 12px; padding: 12px; border: 1px solid #d9e1e7; border-radius: 8px; background: #f8fafb; }
.ai-inputs { grid-template-columns: minmax(0, 1fr) 150px; }
.ai-preview { display: grid; gap: 8px; margin: 0; }
.ai-preview div { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 10px; padding: 8px 0; border-top: 1px solid #e4eaef; }
.ai-preview dt { color: #667085; font-weight: 800; }
.ai-preview dd { margin: 0; color: #1d2433; line-height: 1.45; }
.split-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.column { min-width: 0; border: 1px solid #d9e1e7; border-radius: 8px; background: #eef3f6; }
.column-header { display: flex; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid #d9e1e7; }
.column-header h2 { margin-bottom: 2px; font-size: 1.05rem; }
.column-header p { margin-bottom: 0; color: #667085; font-size: 0.86rem; }
.column-header strong { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 999px; color: #1c4b38; background: #d6f4df; }
.task-list { display: grid; gap: 12px; padding: 12px; }
.task-card { display: grid; gap: 14px; min-height: 144px; padding: 14px; border: 1px solid #d7dee5; border-radius: 8px; background: #ffffff; }
.task-card h3 { margin-bottom: 6px; color: #1d2433; font-size: 1rem; line-height: 1.35; }
.task-card p { margin-bottom: 10px; color: #5c6675; line-height: 1.55; white-space: pre-line; }
time { color: #8a4b18; font-size: 0.85rem; font-weight: 700; }
.task-actions { display: flex; flex-wrap: wrap; gap: 8px; align-self: end; }
.task-actions button { min-height: 36px; padding: 7px 10px; color: #344054; background: #f3f6f8; border-color: #d9e1e7; }
.task-actions button.active { color: #ffffff; background: #1c4b38; border-color: #1c4b38; }
.task-actions button.danger { color: #9f1f1f; background: #fff1f1; border-color: #ffd2d2; }
.empty-state { margin: 0; padding: 22px 12px; border: 1px dashed #c5d0d8; border-radius: 8px; color: #667085; text-align: center; }

@media (max-width: 1060px) {
  .workspace-grid, .board, .input-grid { grid-template-columns: 1fr; }
}

@media (max-width: 720px) {
  .app-shell { padding: 22px; }
  .topbar, .composer-actions, .ocr-panel header { align-items: stretch; flex-direction: column; }
  .metrics, .ocr-controls, .ai-inputs { grid-template-columns: 1fr; }
}
</style>