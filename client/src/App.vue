<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

type TodoStatus = "pending" | "in_progress" | "done";

type Todo = {
  id: string;
  title: string;
  description: string;
  dueDate: string;
  status: TodoStatus;
  createdAt: string;
  sourceImage?: string;
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

type BrowserFileHandle = {
  kind: "file";
  name: string;
  getFile: () => Promise<File>;
};

type BrowserDirectoryHandle = {
  kind: "directory";
  name: string;
  values: () => AsyncIterable<BrowserFileHandle | BrowserDirectoryHandle>;
  queryPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
};

type WindowWithPicker = Window & {
  showDirectoryPicker?: () => Promise<BrowserDirectoryHandle>;
};

const STORAGE_KEY = "todo-pwa.tasks";
const PROCESSED_KEY = "todo-pwa.processed-images";
const MODEL_STORAGE_KEY = "todo-pwa.gemini-model";
const DB_NAME = "todo-pwa.handles";
const DB_STORE = "file-handles";
const DIRECTORY_HANDLE_KEY = "screenshot-directory";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp", "image/gif"]);
const MODEL_OPTIONS = [
  { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
  { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite" },
  { value: "gemini-flash-latest", label: "Gemini Flash Latest" },
];
const FALLBACK_MODELS = MODEL_OPTIONS.map((option) => option.value).filter((model) => model !== "gemini-3.5-flash");

const statusColumns: Array<{ id: TodoStatus; label: string; hint: string }> = [
  { id: "pending", label: "待辦", hint: "等候處理" },
  { id: "in_progress", label: "進行中", hint: "正在追蹤" },
  { id: "done", label: "完成", hint: "已收尾" },
];

const todos = ref<Todo[]>([]);
const processedKeys = ref<Set<string>>(new Set());
const directoryHandle = ref<BrowserDirectoryHandle | null>(null);
const directoryName = ref("尚未選擇資料夾");
const scannerStatus = ref("選擇截圖資料夾後，就能開始掃描新圖片。");
const isScanning = ref(false);
const autoScan = ref(false);
const scanIntervalMs = ref(5000);
const timerId = ref<number | null>(null);
const latestImageUrl = ref("");
const latestImageName = ref("");
const latestDraft = ref<AiTaskDraft | null>(null);
const geminiModel = ref("gemini-3.5-flash");
const newTitle = ref("");
const newDescription = ref("");
const newDueDate = ref("");

const supportsDirectoryPicker = computed(() => Boolean((window as WindowWithPicker).showDirectoryPicker));
const totalCount = computed(() => todos.value.length);
const doneCount = computed(() => countByStatus("done"));
const activeCount = computed(() => totalCount.value - doneCount.value);
const pendingCount = computed(() => countByStatus("pending"));
const latestDraftFields = computed(() => {
  if (!latestDraft.value) return [];

  return [
    ["任務", latestDraft.value.title],
    ["需求者", latestDraft.value.requester || "未判斷"],
    ["公司", latestDraft.value.company || "未判斷"],
    ["聯絡", latestDraft.value.contact || "未判斷"],
    ["下一步", latestDraft.value.next_action || "未判斷"],
    ["信心", latestDraft.value.confidence_note || "未提供"],
  ];
});

onMounted(() => {
  void loadLocalState();
});

onUnmounted(() => {
  stopAutoScan();
  if (latestImageUrl.value) URL.revokeObjectURL(latestImageUrl.value);
});

watch(todos, saveTodos, { deep: true });
watch(processedKeys, saveProcessedKeys, { deep: true });
watch(geminiModel, (value) => localStorage.setItem(MODEL_STORAGE_KEY, value));
watch(autoScan, (enabled) => {
  if (enabled) startAutoScan();
  else stopAutoScan();
});

async function loadLocalState() {
  const storedTodos = localStorage.getItem(STORAGE_KEY);
  const storedProcessed = localStorage.getItem(PROCESSED_KEY);
  const storedModel = localStorage.getItem(MODEL_STORAGE_KEY);

  if (storedTodos) todos.value = JSON.parse(storedTodos) as Todo[];
  if (storedProcessed) processedKeys.value = new Set(JSON.parse(storedProcessed) as string[]);
  if (storedModel) geminiModel.value = storedModel;

  const storedDirectory = await getStoredDirectoryHandle();
  if (!storedDirectory) return;

  directoryHandle.value = storedDirectory;
  directoryName.value = storedDirectory.name;

  const hasPermission = await ensureDirectoryPermission(storedDirectory, false);
  scannerStatus.value = hasPermission
    ? "已載入上次的截圖資料夾，可以直接掃描。"
    : "已記住上次的資料夾，掃描時可能需要重新允許權限。";
}

function saveTodos() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos.value));
}

function saveProcessedKeys() {
  localStorage.setItem(PROCESSED_KEY, JSON.stringify([...processedKeys.value]));
}

async function pickDirectory() {
  const picker = (window as WindowWithPicker).showDirectoryPicker;
  if (!picker) {
    scannerStatus.value = "目前瀏覽器不支援資料夾授權，請使用 Chrome 或 Edge。";
    return;
  }

  directoryHandle.value = await picker();
  directoryName.value = directoryHandle.value.name;
  await storeDirectoryHandle(directoryHandle.value);
  scannerStatus.value = "資料夾已授權並記住。放入新截圖後即可掃描。";
}

async function scanLatestImage() {
  if (!directoryHandle.value || isScanning.value) {
    scannerStatus.value = directoryHandle.value ? scannerStatus.value : "請先選擇截圖資料夾。";
    return;
  }

  if (!(await ensureDirectoryPermission(directoryHandle.value))) {
    scannerStatus.value = "資料夾權限尚未允許，請重新授權。";
    return;
  }

  isScanning.value = true;
  scannerStatus.value = "正在掃描新圖片...";

  try {
    const images = await listImages(directoryHandle.value);
    const nextImage = images
      .filter((item) => !processedKeys.value.has(item.key))
      .sort((a, b) => b.file.lastModified - a.file.lastModified)[0];

    if (!nextImage) {
      scannerStatus.value = `沒有新圖片，上次掃描 ${new Date().toLocaleTimeString()}`;
      return;
    }

    await analyzeImageFile(nextImage.file, nextImage.key);
  } catch (error) {
    scannerStatus.value = error instanceof Error ? error.message : "掃描失敗";
  } finally {
    isScanning.value = false;
  }
}

async function listImages(handle: BrowserDirectoryHandle) {
  const images: Array<{ file: File; key: string }> = [];

  for await (const entry of handle.values()) {
    if (entry.kind !== "file") continue;

    const file = await entry.getFile();
    if (isImageFile(file)) images.push({ file, key: createImageKey(file) });
  }

  return images;
}

async function analyzeImageFile(file: File, imageKey: string) {
  if (latestImageUrl.value) URL.revokeObjectURL(latestImageUrl.value);

  latestImageUrl.value = URL.createObjectURL(file);
  latestImageName.value = file.name;
  latestDraft.value = null;
  scannerStatus.value = `正在交給 Gemini 分析：${file.name}`;

  const imagePayload = await fileToBase64Payload(file);
  const result = await callGeminiWithFallback(imagePayload.base64, imagePayload.mimeType);
  const draft = result.draft;

  latestDraft.value = draft;
  processedKeys.value = new Set([...processedKeys.value, imageKey]);
  createTodoFromDraft(draft, file.name);
  scannerStatus.value = `已建立任務：${draft.title}（${result.model}）`;
}

async function callGeminiWithFallback(imageBase64: string, mimeType: string) {
  const preferredModel = geminiModel.value.trim() || "gemini-3.5-flash";
  const models = [preferredModel, ...FALLBACK_MODELS.filter((model) => model !== preferredModel)];
  const errors: string[] = [];

  for (const model of models) {
    try {
      scannerStatus.value = `正在使用 ${model} 分析圖片...`;
      return { model, draft: await callGeminiModel(model, imageBase64, mimeType) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${model}: ${message}`);
      if (!isRetryableGeminiError(message)) break;
    }
  }

  throw new Error(errors.join("\n"));
}

function isRetryableGeminiError(message: string) {
  return /high demand|try again later|temporar|unavailable|overloaded|not found|model not found|503|429|404/i.test(message);
}

async function callGeminiModel(model: string, imageBase64: string, mimeType: string) {
  const response = await fetch("/api/gemini/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, imageBase64, mimeType }),
  });

  const rawBody = await response.text();
  const body = rawBody ? safeJsonParse(rawBody) : null;

  if (!response.ok) {
    throw new Error(body?.error ?? (rawBody || `Gemini API 回傳錯誤：HTTP ${response.status}`));
  }

  if (!body) throw new Error("本機 API 回應不是有效 JSON");
  return body as AiTaskDraft;
}

function safeJsonParse(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createTodoFromDraft(draft: AiTaskDraft, sourceImage: string) {
  const description = [
    draft.description,
    draft.next_action ? `下一步：${draft.next_action}` : "",
    draft.requester ? `需求者：${draft.requester}` : "",
    draft.company ? `公司：${draft.company}` : "",
    draft.contact ? `聯絡方式：${draft.contact}` : "",
    draft.due_time_guess ? `期限判斷：${draft.due_time_guess}` : "",
    draft.confidence_note ? `AI 備註：${draft.confidence_note}` : "",
    `來源圖片：${sourceImage}`,
  ]
    .filter(Boolean)
    .join("\n");

  createTodo(draft.title || draft.next_action || "Gemini 整理任務", description, "", sourceImage);
}

function addTodo() {
  const title = newTitle.value.trim();
  if (!title) return;

  createTodo(title, newDescription.value.trim(), newDueDate.value);
  newTitle.value = "";
  newDescription.value = "";
  newDueDate.value = "";
}

function createTodo(title: string, description = "", dueDate = "", sourceImage = "") {
  todos.value.unshift({
    id: crypto.randomUUID(),
    title,
    description,
    dueDate,
    status: "pending",
    createdAt: new Date().toISOString(),
    sourceImage,
  });
}

function moveTodo(todoId: string, status: TodoStatus) {
  const todo = todos.value.find((item) => item.id === todoId);
  if (todo) todo.status = status;
}

function removeTodo(todoId: string) {
  todos.value = todos.value.filter((todo) => todo.id !== todoId);
}

function countByStatus(status: TodoStatus) {
  return todos.value.filter((todo) => todo.status === status).length;
}

function todosByStatus(status: TodoStatus) {
  return todos.value.filter((todo) => todo.status === status);
}

async function ensureDirectoryPermission(handle: BrowserDirectoryHandle, request = true) {
  const descriptor = { mode: "read" as const };

  if (handle.queryPermission && (await handle.queryPermission(descriptor)) === "granted") return true;
  if (request && handle.requestPermission) return (await handle.requestPermission(descriptor)) === "granted";
  return false;
}

function openHandleDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 開啟失敗"));
  });
}

async function storeDirectoryHandle(handle: BrowserDirectoryHandle) {
  const db = await openHandleDb();

  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(handle, DIRECTORY_HANDLE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("資料夾記憶失敗"));
  });

  db.close();
}

async function getStoredDirectoryHandle() {
  const db = await openHandleDb();

  const handle = await new Promise<BrowserDirectoryHandle | null>((resolve, reject) => {
    const transaction = db.transaction(DB_STORE, "readonly");
    const request = transaction.objectStore(DB_STORE).get(DIRECTORY_HANDLE_KEY);
    request.onsuccess = () => resolve((request.result as BrowserDirectoryHandle | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("資料夾讀取失敗"));
  });

  db.close();
  return handle;
}

function startAutoScan() {
  stopAutoScan();
  void scanLatestImage();
  timerId.value = window.setInterval(() => void scanLatestImage(), scanIntervalMs.value);
}

function stopAutoScan() {
  if (timerId.value) {
    window.clearInterval(timerId.value);
    timerId.value = null;
  }
}

function isImageFile(file: File) {
  return IMAGE_TYPES.has(file.type) || /\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name);
}

function createImageKey(file: File) {
  return `${file.name}:${file.lastModified}:${file.size}`;
}

function fileToBase64Payload(file: File) {
  return new Promise<{ mimeType: string; base64: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      resolve({ mimeType: file.type || "image/png", base64: dataUrl.split(",")[1] ?? dataUrl });
    };
    reader.onerror = () => reject(new Error("圖片讀取失敗"));
    reader.readAsDataURL(file);
  });
}
</script>

<template>
  <main class="app-shell">
    <section class="topbar" aria-labelledby="app-title">
      <div>
        <p class="eyebrow">Gemini Screenshot Todo</p>
        <h1 id="app-title">截圖任務中控台</h1>
      </div>

      <div class="metrics" aria-label="任務統計">
        <div><span>{{ pendingCount }}</span><small>待辦</small></div>
        <div><span>{{ activeCount }}</span><small>未完成</small></div>
        <div><span>{{ doneCount }}</span><small>完成</small></div>
      </div>
    </section>

    <section class="scanner-hero" aria-labelledby="scanner-title">
      <div class="scanner-main">
        <header class="scanner-header">
          <div>
            <p class="eyebrow">Primary Flow</p>
            <h2 id="scanner-title">監看截圖資料夾，自動整理待辦</h2>
          </div>
          <strong :class="['scan-pill', { active: autoScan }]">{{ autoScan ? '自動掃描中' : '手動掃描' }}</strong>
        </header>

        <p v-if="!supportsDirectoryPicker" class="warning">目前瀏覽器不支援資料夾授權，請使用 Chrome 或 Edge。</p>

        <div class="control-grid">
          <button type="button" class="primary-action" @click="pickDirectory">選擇截圖資料夾</button>
          <label>
            <span>模型</span>
            <select v-model="geminiModel">
              <option v-for="option in MODEL_OPTIONS" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </label>
        </div>

        <div class="folder-status">
          <span>目前資料夾</span>
          <strong>{{ directoryName }}</strong>
          <p>{{ scannerStatus }}</p>
        </div>

        <div class="scan-actions">
          <button type="button" :disabled="!directoryHandle || isScanning" @click="scanLatestImage">
            {{ isScanning ? '掃描中...' : '掃描新圖片' }}
          </button>
          <label class="toggle-row">
            <input v-model="autoScan" type="checkbox" />
            <span>每 {{ scanIntervalMs / 1000 }} 秒自動掃描</span>
          </label>
        </div>
      </div>

      <aside class="latest-panel" aria-label="最新辨識結果">
        <div class="preview-box">
          <img v-if="latestImageUrl" :src="latestImageUrl" alt="最新分析圖片" />
          <p v-else>截圖存入授權資料夾後，這裡會顯示最新被分析的圖片。</p>
        </div>

        <dl v-if="latestDraft" class="ai-preview">
          <div v-for="field in latestDraftFields" :key="field[0]">
            <dt>{{ field[0] }}</dt>
            <dd>{{ field[1] }}</dd>
          </div>
        </dl>
      </aside>
    </section>

    <details class="manual-fallback">
      <summary>
        <span>手動新增任務</span>
        <small>圖片辨識不出來時再使用</small>
      </summary>

      <form class="manual-form" @submit.prevent="addTodo">
        <label>
          <span>任務名稱</span>
          <input v-model="newTitle" autocomplete="off" placeholder="例如：向供應商確認 Type-C 規格與報價" />
        </label>
        <label>
          <span>期限</span>
          <input v-model="newDueDate" type="datetime-local" />
        </label>
        <label class="wide-field">
          <span>備註</span>
          <textarea v-model="newDescription" rows="4" placeholder="補充細節、來源筆記或下一個動作"></textarea>
        </label>
        <button type="submit">新增任務</button>
      </form>
    </details>

    <section class="board" aria-label="任務看板">
      <article v-for="column in statusColumns" :key="column.id" class="column">
        <header class="column-header">
          <div>
            <h2>{{ column.label }}</h2>
            <p>{{ column.hint }}</p>
          </div>
          <strong>{{ countByStatus(column.id) }}</strong>
        </header>

        <div class="task-list">
          <article v-for="todo in todosByStatus(column.id)" :key="todo.id" class="task-card">
            <div>
              <h3>{{ todo.title }}</h3>
              <p v-if="todo.description">{{ todo.description }}</p>
              <time v-if="todo.dueDate">{{ todo.dueDate.replace('T', ' ') }}</time>
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
button, input, textarea, select { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: 0.55; }

.app-shell { min-height: 100vh; padding: 28px; }
.topbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 20px; }
.eyebrow { margin: 0 0 6px; color: #667085; font-size: 0.78rem; font-weight: 800; letter-spacing: 0; text-transform: uppercase; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 0; font-size: clamp(2rem, 4vw, 3.3rem); line-height: 1; }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(86px, 1fr)); gap: 10px; }
.metrics div { min-height: 72px; padding: 12px 14px; border: 1px solid #d9e1e7; border-radius: 8px; background: #ffffff; }
.metrics span { display: block; font-size: 1.45rem; font-weight: 900; }
.metrics small { color: #667085; }

.scanner-hero { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(360px, 0.95fr); gap: 16px; margin-bottom: 16px; }
.scanner-main, .latest-panel, .manual-fallback { border: 1px solid #d9e1e7; border-radius: 8px; background: #ffffff; }
.scanner-main { display: grid; gap: 16px; padding: 18px; }
.scanner-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.scanner-header h2 { margin-bottom: 0; font-size: 1.35rem; }
.scan-pill { flex: 0 0 auto; padding: 7px 10px; border-radius: 999px; color: #694315; background: #fff4d6; font-size: 0.86rem; }
.scan-pill.active { color: #1c4b38; background: #d6f4df; }
.control-grid { display: grid; grid-template-columns: minmax(180px, 220px) minmax(220px, 1fr); gap: 14px; align-items: end; }
label { display: grid; gap: 7px; color: #475467; font-size: 0.9rem; font-weight: 800; }
input, textarea, select { width: 100%; border: 1px solid #cfd8df; border-radius: 8px; padding: 10px 12px; color: #1d2433; background: #fbfcfd; outline: none; }
textarea { resize: vertical; }
input:focus, textarea:focus, select:focus { border-color: #2671d9; box-shadow: 0 0 0 3px rgba(38, 113, 217, 0.14); }
button { border: 1px solid transparent; border-radius: 8px; padding: 10px 13px; color: #ffffff; background: #2671d9; font-weight: 900; }
.primary-action { min-height: 44px; }
.warning { margin: 0; padding: 10px 12px; border-radius: 8px; color: #9f1f1f; background: #fff1f1; }
.folder-status { display: grid; gap: 5px; padding: 13px; border: 1px solid #d9e1e7; border-radius: 8px; background: #f8fafb; }
.folder-status span { color: #667085; font-size: 0.84rem; font-weight: 800; }
.folder-status strong { font-size: 1.05rem; }
.folder-status p { margin-bottom: 0; color: #667085; line-height: 1.5; }
.scan-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.toggle-row { display: flex; align-items: center; gap: 8px; }
.toggle-row input { width: auto; }
.latest-panel { display: grid; gap: 14px; padding: 14px; }
.preview-box { display: grid; place-items: center; min-height: 260px; overflow: hidden; border: 1px dashed #c5d0d8; border-radius: 8px; background: #f7fafc; }
.preview-box img { display: block; width: 100%; max-height: 420px; object-fit: contain; }
.preview-box p { margin: 0; padding: 18px; color: #667085; text-align: center; }
.ai-preview { display: grid; gap: 8px; margin: 0; }
.ai-preview div { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 10px; padding: 8px 0; border-top: 1px solid #e4eaef; }
.ai-preview dt { color: #667085; font-weight: 900; }
.ai-preview dd { margin: 0; line-height: 1.45; }

.manual-fallback { margin-bottom: 16px; padding: 0; }
.manual-fallback summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; cursor: pointer; font-weight: 900; }
.manual-fallback summary small { color: #667085; font-weight: 700; }
.manual-form { display: grid; grid-template-columns: minmax(0, 1fr) 240px auto; gap: 14px; align-items: end; padding: 0 16px 16px; }
.wide-field { grid-column: 1 / -1; }

.board { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.column { min-width: 0; border: 1px solid #d9e1e7; border-radius: 8px; background: #eef3f6; }
.column-header { display: flex; justify-content: space-between; gap: 12px; padding: 16px; border-bottom: 1px solid #d9e1e7; }
.column-header h2 { margin-bottom: 2px; font-size: 1.05rem; }
.column-header p { margin-bottom: 0; color: #667085; font-size: 0.86rem; }
.column-header strong { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 999px; color: #1c4b38; background: #d6f4df; }
.task-list { display: grid; gap: 12px; padding: 12px; }
.task-card { display: grid; gap: 14px; min-height: 144px; padding: 14px; border: 1px solid #d7dee5; border-radius: 8px; background: #ffffff; }
.task-card h3 { margin-bottom: 6px; font-size: 1rem; line-height: 1.35; }
.task-card p { margin-bottom: 10px; color: #5c6675; line-height: 1.55; white-space: pre-line; }
time { color: #8a4b18; font-size: 0.85rem; font-weight: 800; }
.task-actions { display: flex; flex-wrap: wrap; gap: 8px; align-self: end; }
.task-actions button { min-height: 36px; padding: 7px 10px; color: #344054; background: #f3f6f8; border-color: #d9e1e7; }
.task-actions button.active { color: #ffffff; background: #1c4b38; border-color: #1c4b38; }
.task-actions button.danger { color: #9f1f1f; background: #fff1f1; border-color: #ffd2d2; }
.empty-state { margin: 0; padding: 22px 12px; border: 1px dashed #c5d0d8; border-radius: 8px; color: #667085; text-align: center; }

@media (max-width: 1100px) {
  .scanner-hero, .board, .control-grid, .manual-form { grid-template-columns: 1fr; }
}

@media (max-width: 720px) {
  .app-shell { padding: 18px; }
  .topbar, .scanner-header, .scan-actions, .manual-fallback summary { align-items: stretch; flex-direction: column; }
  .metrics { grid-template-columns: 1fr; }
}
</style>