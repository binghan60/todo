<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

type TodoStatus = "pending" | "in_progress" | "done";

type ProgressLog = {
  id: string;
  content: string;
  createdAt: string;
};

type Todo = {
  id: string;
  title: string;
  status: TodoStatus;
  createdAt: string;
  progressLogs: ProgressLog[];
  closedAt?: string;
  sourceImage?: string;
  requester?: string;
  company?: string;
  contact?: string;
};

type AiTaskDraft = {
  title: string;
  requester: string;
  company: string;
  contact: string;
  due_time_guess: string;
  confidence_note: string;
};

type DraftItem = {
  id: string;
  title: string;
  requester: string;
  company: string;
  contact: string;
  sourceImage: string;
  imageUrl: string;
  confidenceNote: string;
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

type StoredTodo = Omit<Todo, "status" | "progressLogs"> & {
  status?: TodoStatus | "follow_up";
  progressLogs?: ProgressLog[];
};

type WindowWithPicker = Window & {
  showDirectoryPicker?: () => Promise<BrowserDirectoryHandle>;
};

const STORAGE_KEY = "todo-pwa.tasks";
const PROCESSED_KEY = "todo-pwa.processed-images";
const DB_NAME = "todo-pwa.handles";
const DB_STORE = "file-handles";
const DIRECTORY_HANDLE_KEY = "screenshot-directory";
const COLUMN_WIDTHS_KEY = "todo-pwa.column-widths";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp", "image/gif"]);

type ColumnKey = "title" | "requester" | "company" | "contact" | "created" | "status" | "action";

const defaultColumnWidths: Record<ColumnKey, number> = {
  title: 260,
  requester: 100,
  company: 120,
  contact: 130,
  created: 150,
  status: 140,
  action: 120,
};

const statusColumns: Array<{ id: TodoStatus; label: string; hint: string; icon: string }> = [
  { id: "pending", label: "待辦", hint: "尚未開始處理", icon: "mdi-clock-outline" },
  { id: "in_progress", label: "處理中", hint: "已有處理進度", icon: "mdi-progress-pencil" },
  { id: "done", label: "結案", hint: "已完成並結案", icon: "mdi-archive-check-outline" },
];

const todos = ref<Todo[]>([]);
const processedKeys = ref<Set<string>>(new Set());
const directoryHandle = ref<BrowserDirectoryHandle | null>(null);
const directoryName = ref("尚未選擇資料夾");
const scannerStatus = ref("拖曳截圖、貼上（Ctrl+V）或選擇資料夾，AI 會自動幫你整理成待辦。");
const isScanning = ref(false);
const autoScan = ref(false);
const scanIntervalMs = ref(5000);
const timerId = ref<number | null>(null);
const geminiModel = ref("gemini-3.5-flash");

const fileInput = ref<HTMLInputElement | null>(null);

// Dialog controls
const showSettingsDialog = ref(false);
const showAddTaskDialog = ref(false);
const showDeleteConfirmDialog = ref(false);
const showProgressDialog = ref(false);
const todoIdToDelete = ref<string | null>(null);
const todoIdForProgress = ref<string | null>(null);

// Manual add todo form fields
const newTitle = ref("");
const progressText = ref("");
const selectedProgressTodo = computed(() => todos.value.find((item) => item.id === todoIdForProgress.value) ?? null);

const searchQuery = ref("");
const statusFilter = ref<TodoStatus | "all">("all");
const analyzingItems = ref<Array<{ id: string; name: string }>>([]);
const draftQueue = ref<DraftItem[]>([]);
const previewImageUrl = ref<string | null>(null);
const columnWidths = ref<Record<ColumnKey, number>>({ ...defaultColumnWidths });
const resizingColumn = ref<ColumnKey | null>(null);
let resizeStartX = 0;
let resizeStartWidth = 0;


const totalCount = computed(() => todos.value.length);
const doneCount = computed(() => countByStatus("done"));
const inProgressCount = computed(() => countByStatus("in_progress"));
const pendingCount = computed(() => countByStatus("pending"));

onMounted(() => {
  void loadLocalState();
  window.addEventListener("paste", onWindowPaste);
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
});

onUnmounted(() => {
  stopAutoScan();
  window.removeEventListener("paste", onWindowPaste);
  window.removeEventListener("dragover", onDragOver);
  window.removeEventListener("drop", onDrop);
  window.removeEventListener("mousemove", onColumnResizeMove);
  window.removeEventListener("mouseup", stopColumnResize);
  draftQueue.value.forEach((draft) => URL.revokeObjectURL(draft.imageUrl));
});

watch(todos, saveTodos, { deep: true });
watch(processedKeys, saveProcessedKeys, { deep: true });
watch(autoScan, (enabled) => {
  if (enabled) startAutoScan();
  else stopAutoScan();
});

function normalizeTodo(todo: StoredTodo): Todo {
  const progressLogs = Array.isArray(todo.progressLogs) ? todo.progressLogs : [];
  const status = resolveTodoStatus(todo.status, progressLogs);

  return {
    ...todo,
    status,
    progressLogs,
  };
}

function resolveTodoStatus(status: StoredTodo["status"], progressLogs: ProgressLog[]): TodoStatus {
  if (status === "done") return "done";
  if (status === "in_progress" || status === "follow_up" || progressLogs.length > 0) return "in_progress";
  return "pending";
}

async function loadLocalState() {
  const storedTodos = localStorage.getItem(STORAGE_KEY);
  const storedProcessed = localStorage.getItem(PROCESSED_KEY);

  if (storedTodos) todos.value = (JSON.parse(storedTodos) as StoredTodo[]).map(normalizeTodo);
  if (storedProcessed) processedKeys.value = new Set(JSON.parse(storedProcessed) as string[]);

  const storedColumnWidths = localStorage.getItem(COLUMN_WIDTHS_KEY);
  if (storedColumnWidths) {
    try {
      columnWidths.value = { ...defaultColumnWidths, ...JSON.parse(storedColumnWidths) };
    } catch {
      columnWidths.value = { ...defaultColumnWidths };
    }
  }

  const storedDirectory = await getStoredDirectoryHandle();
  if (!storedDirectory) return;

  directoryHandle.value = storedDirectory;
  directoryName.value = storedDirectory.name;

  const hasPermission = await ensureDirectoryPermission(storedDirectory, false);
  scannerStatus.value = hasPermission
    ? "已載入上次的截圖資料夾，可以直接掃描。"
    : "已記住上次的資料夾，掃描時可能需要重新允許權限。";
}

// Ensure database handles are initialized properly
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

function saveTodos() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos.value));
}

function saveProcessedKeys() {
  localStorage.setItem(PROCESSED_KEY, JSON.stringify([...processedKeys.value]));
}

function saveColumnWidths() {
  localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(columnWidths.value));
}

function resetColumnWidths() {
  columnWidths.value = { ...defaultColumnWidths };
  saveColumnWidths();
}

function startColumnResize(column: ColumnKey, event: MouseEvent) {
  resizingColumn.value = column;
  resizeStartX = event.clientX;
  resizeStartWidth = columnWidths.value[column];
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onColumnResizeMove);
  window.addEventListener("mouseup", stopColumnResize);
  event.preventDefault();
}

function onColumnResizeMove(event: MouseEvent) {
  if (!resizingColumn.value) return;
  const delta = event.clientX - resizeStartX;
  const nextWidth = Math.max(60, resizeStartWidth + delta);
  columnWidths.value = { ...columnWidths.value, [resizingColumn.value]: nextWidth };
}

function stopColumnResize() {
  if (!resizingColumn.value) return;
  resizingColumn.value = null;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  window.removeEventListener("mousemove", onColumnResizeMove);
  window.removeEventListener("mouseup", stopColumnResize);
  saveColumnWidths();
}

async function pickDirectory() {
  const picker = (window as WindowWithPicker).showDirectoryPicker;
  if (!picker) {
    scannerStatus.value = "目前瀏覽器不支援資料夾授權，請使用 Chrome 或 Edge。";
    return;
  }

  try {
    directoryHandle.value = await picker();
    directoryName.value = directoryHandle.value.name;
    await storeDirectoryHandle(directoryHandle.value);
    scannerStatus.value = "資料夾已授權並記住。放入新截圖後即可掃描。";
  } catch (err) {
    console.error("選擇資料夾時出錯:", err);
  }
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

    await analyzeFolderImage(nextImage.file, nextImage.key);
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

function onWindowPaste(event: ClipboardEvent) {
  const items = event.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) void analyzeUploadedFile(file);
    }
  }
}

function triggerFileUpload() {
  fileInput.value?.click();
}

function onFileUploaded(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file) {
    void analyzeUploadedFile(file);
  }
  target.value = "";
}

function onDragOver(event: DragEvent) {
  event.preventDefault();
}

function onDrop(event: DragEvent) {
  event.preventDefault();
  const files = event.dataTransfer?.files;
  if (files && files.length > 0) {
    const file = files[0];
    if (isImageFile(file)) {
      void analyzeUploadedFile(file);
    }
  }
}

async function analyzeFolderImage(file: File, imageKey: string) {
  const trackingId = crypto.randomUUID();
  analyzingItems.value = [...analyzingItems.value, { id: trackingId, name: file.name }];
  scannerStatus.value = `正在交給 AI 分析：${file.name}`;

  try {
    const { model, draft } = await analyzeFile(file);
    processedKeys.value = new Set([...processedKeys.value, imageKey]);
    queueDraft(draft, file);
    scannerStatus.value = `已加入待確認清單：${draft.title}（${model}）`;
  } catch (error) {
    scannerStatus.value = error instanceof Error ? error.message : "分析失敗";
  } finally {
    analyzingItems.value = analyzingItems.value.filter((item) => item.id !== trackingId);
  }
}

async function analyzeUploadedFile(file: File) {
  if (!isImageFile(file)) {
    scannerStatus.value = "這個檔案不是圖片，請重新選擇截圖。";
    return;
  }

  const trackingId = crypto.randomUUID();
  analyzingItems.value = [...analyzingItems.value, { id: trackingId, name: file.name }];
  scannerStatus.value = `正在交給 AI 分析：${file.name}`;

  try {
    const { model, draft } = await analyzeFile(file);
    queueDraft(draft, file);
    scannerStatus.value = `已加入待確認清單：${draft.title}（${model}）`;
  } catch (error) {
    scannerStatus.value = error instanceof Error ? error.message : "分析失敗";
  } finally {
    analyzingItems.value = analyzingItems.value.filter((item) => item.id !== trackingId);
  }
}

async function analyzeFile(file: File) {
  const payload = await fileToBase64Payload(file);
  return callGeminiWithFallback(payload.base64, payload.mimeType);
}

function queueDraft(draft: AiTaskDraft, file: File) {
  const imageUrl = URL.createObjectURL(file);
  draftQueue.value = [...draftQueue.value, buildDraftItem(draft, file.name, imageUrl)];
}

function buildDraftItem(draft: AiTaskDraft, sourceImage: string, imageUrl: string): DraftItem {
  return {
    id: crypto.randomUUID(),
    title: draft.title || "AI 整理任務",
    requester: draft.requester,
    company: draft.company,
    contact: draft.contact,
    sourceImage,
    imageUrl,
    confidenceNote: sanitizeConfidenceNote(draft.confidence_note),
  };
}

function sanitizeConfidenceNote(note: string) {
  const normalized = note.trim();
  if (!normalized || /無明確期限|沒有明確期限|未提及期限|期限不明/.test(normalized)) return "";
  return normalized;
}

function confirmDraft(id: string) {
  const draft = draftQueue.value.find((item) => item.id === id);
  if (!draft) return;

  todos.value.unshift({
    id: draft.id,
    title: draft.title.trim() || "未命名任務",
    status: "pending",
    createdAt: new Date().toISOString(),
    progressLogs: [],
    sourceImage: draft.sourceImage,
    requester: draft.requester || undefined,
    company: draft.company || undefined,
    contact: draft.contact || undefined,
  });

  URL.revokeObjectURL(draft.imageUrl);
  draftQueue.value = draftQueue.value.filter((item) => item.id !== id);
}

function confirmAllDrafts() {
  [...draftQueue.value].forEach((draft) => confirmDraft(draft.id));
}

function discardDraft(id: string) {
  const index = draftQueue.value.findIndex((draft) => draft.id === id);
  if (index === -1) return;

  if (previewImageUrl.value === draftQueue.value[index].imageUrl) previewImageUrl.value = null;
  URL.revokeObjectURL(draftQueue.value[index].imageUrl);
  draftQueue.value = draftQueue.value.filter((draft) => draft.id !== id);
}

function discardAllDrafts() {
  draftQueue.value.forEach((draft) => URL.revokeObjectURL(draft.imageUrl));
  draftQueue.value = [];
  previewImageUrl.value = null;
}

async function callGeminiWithFallback(imageBase64: string, mimeType: string) {
  const preferredModel = geminiModel.value.trim() || "gemini-3.5-flash";
  const FALLBACK_MODELS = ["gemini-3.1-flash-lite", "gemini-flash-latest"];
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

function submitManualTodo() {
  const title = newTitle.value.trim();
  if (!title) return;

  createTodo(title);
  newTitle.value = "";
  showAddTaskDialog.value = false;
}

function createTodo(title: string, sourceImage = "") {
  todos.value.unshift({
    id: crypto.randomUUID(),
    title,
    status: "pending",
    createdAt: new Date().toISOString(),
    progressLogs: [],
    sourceImage,
  });
}

function openProgressDialog(todoId: string) {
  const todo = todos.value.find((item) => item.id === todoId);
  if (!todo || todo.status === "done") return;

  todoIdForProgress.value = todoId;
  progressText.value = "";
  showProgressDialog.value = true;
}

function submitProgressUpdate() {
  const content = progressText.value.trim();
  const todo = todos.value.find((item) => item.id === todoIdForProgress.value);
  if (!content || !todo || todo.status === "done") return;

  todo.progressLogs = [
    ...(todo.progressLogs ?? []),
    { id: crypto.randomUUID(), content, createdAt: new Date().toISOString() },
  ];
  todo.status = "in_progress";
  progressText.value = "";
  todoIdForProgress.value = null;
  showProgressDialog.value = false;
}

function closeTodo(todoId: string) {
  const todo = todos.value.find((item) => item.id === todoId);
  if (!todo) return;

  todo.status = "done";
  todo.closedAt = new Date().toISOString();
}

function latestProgress(todo: Todo) {
  const logs = todo.progressLogs ?? [];
  return logs.length ? logs[logs.length - 1] : null;
}

function removeTodo(todoId: string) {
  todoIdToDelete.value = todoId;
  showDeleteConfirmDialog.value = true;
}

function confirmDeleteTodo() {
  if (todoIdToDelete.value) {
    todos.value = todos.value.filter((todo) => todo.id !== todoIdToDelete.value);
    todoIdToDelete.value = null;
  }
  showDeleteConfirmDialog.value = false;
}

function countByStatus(status: TodoStatus) {
  return todos.value.filter((todo) => todo.status === status).length;
}

const sortedTodos = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();

  return todos.value
    .filter((todo) => statusFilter.value === "all" || todo.status === statusFilter.value)
    .filter((todo) => !query || todo.title.toLowerCase().includes(query))
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
});

function formatCreated(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  return date.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function getStatusIcon(status: TodoStatus) {
  if (status === "pending") return "mdi-clock-outline";
  if (status === "in_progress") return "mdi-progress-pencil";
  if (status === "done") return "mdi-archive-check-outline";
  return "";
}

function getStatusColor(status: TodoStatus) {
  if (status === "pending") return "secondary";
  if (status === "in_progress") return "warning";
  if (status === "done") return "success";
  return "muted";
}

async function ensureDirectoryPermission(handle: BrowserDirectoryHandle, request = true) {
  const descriptor = { mode: "read" as const };

  if (handle.queryPermission && (await handle.queryPermission(descriptor)) === "granted") return true;
  if (request && handle.requestPermission) return (await handle.requestPermission(descriptor)) === "granted";
  return false;
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

function restartAutoScanIfRunning() {
  if (autoScan.value) {
    startAutoScan();
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
  <v-app class="bg-warm-50">
    <!-- Navbar / AppBar -->
    <v-app-bar flat border color="surface" class="px-md-6 border-b px-2 warm-app-bar">
      <div class="d-flex align-center">
        <v-avatar color="primary-lighten-5" rounded="lg" size="40" class="mr-3">
          <v-icon icon="mdi-checkbox-marked-circle-auto-outline" color="primary" size="24"></v-icon>
        </v-avatar>
        <div>
          <div class="text-caption text-grey-darken-1 font-weight-bold" style="line-height: 1.1;">AI 截圖助理</div>
          <div class="text-h6 font-weight-black text-slate-800" style="line-height: 1.2;">任務中控台</div>
        </div>
      </div>

      <v-spacer></v-spacer>

      <!-- Action buttons collapsed -->
      <v-btn
        variant="flat"
        color="primary"
        prepend-icon="mdi-plus"
        class="font-weight-bold rounded-lg mr-2 mr-sm-3 text-none"
        @click="showAddTaskDialog = true"
      >
        手動新增
      </v-btn>

      <v-tooltip text="系統設定" location="bottom">
        <template v-slot:activator="{ props }">
          <v-btn
            v-bind="props"
            icon="mdi-cog-outline"
            variant="outlined"
            color="muted"
            class="rounded-lg"
            @click="showSettingsDialog = true"
          ></v-btn>
        </template>
      </v-tooltip>
    </v-app-bar>

    <v-main class="bg-warm-page">
      <v-container fluid class="pa-4 pa-md-6 max-width-wrapper">
        <!-- Stats Dashboard -->
        <div class="stats-grid mb-6">
          <!-- Stat Cards -->
          <v-card class="rounded-lg border-0 elevation-0" border flat>
            <v-card-text class="d-flex align-center pa-4">
              <v-avatar color="muted-lighten-5" size="48" rounded="lg" class="mr-4">
                <v-icon icon="mdi-clock-outline" color="muted" size="24"></v-icon>
              </v-avatar>
              <div>
                <div class="text-caption text-grey font-weight-bold">待辦任務</div>
                <div class="text-h5 font-weight-black text-grey-darken-3 mt-1" style="line-height: 1;">{{ pendingCount }}</div>
              </div>
            </v-card-text>
          </v-card>

          <v-card class="rounded-lg border-0 elevation-0" border flat>
            <v-card-text class="d-flex align-center pa-4">
              <v-avatar color="warning-lighten-5" size="48" rounded="lg" class="mr-4">
                <v-icon icon="mdi-progress-pencil" color="warning" size="24"></v-icon>
              </v-avatar>
              <div>
                <div class="text-caption text-grey font-weight-bold">處理中</div>
                <div class="text-h5 font-weight-black text-warning mt-1" style="line-height: 1;">{{ inProgressCount }}</div>
              </div>
            </v-card-text>
          </v-card>

          <v-card class="rounded-lg border-0 elevation-0" border flat>
            <v-card-text class="d-flex align-center pa-4">
              <v-avatar color="success-lighten-5" size="48" rounded="lg" class="mr-4">
                <v-icon icon="mdi-archive-check-outline" color="success" size="24"></v-icon>
              </v-avatar>
              <div>
                <div class="text-caption text-grey font-weight-bold">結案件數</div>
                <div class="text-h5 font-weight-black text-success mt-1" style="line-height: 1;">{{ doneCount }}</div>
              </div>
            </v-card-text>
          </v-card>

          <v-card class="rounded-lg border-0 elevation-0" border flat>
            <v-card-text class="d-flex align-center pa-4">
              <v-avatar color="primary-lighten-5" size="48" rounded="lg" class="mr-4">
                <v-icon icon="mdi-format-list-bulleted" color="primary" size="24"></v-icon>
              </v-avatar>
              <div>
                <div class="text-caption text-grey font-weight-bold">總計</div>
                <div class="text-h5 font-weight-black text-primary mt-1" style="line-height: 1;">{{ totalCount }}</div>
              </div>
            </v-card-text>
          </v-card>
        </div>

        <!-- Screenshot Monitoring Control Bar (Clean Panel) -->
        <v-card class="mb-6 rounded-lg border-0 elevation-0" border flat>
          <v-card-text class="pa-4 d-flex align-center flex-wrap justify-space-between gap-4">
            
            <!-- Folder status -->
            <div class="d-flex align-center min-width-folder">
              <v-avatar color="primary-lighten-5" size="40" rounded class="mr-3">
                <v-icon icon="mdi-folder-eye" color="primary" size="24"></v-icon>
              </v-avatar>
              <div>
                <div class="text-caption text-grey font-weight-bold">目前截圖資料夾</div>
                <div class="d-flex align-center">
                  <div class="text-body-2 font-weight-bold text-grey-darken-3 text-truncate max-width-filename" :title="directoryName">
                    {{ directoryName }}
                  </div>
                  <v-tooltip text="重新選擇資料夾" location="top">
                    <template v-slot:activator="{ props }">
                      <v-btn 
                        v-bind="props"
                        size="x-small" 
                        variant="text" 
                        icon="mdi-pencil-outline" 
                        color="primary" 
                        class="ml-1" 
                        @click="pickDirectory"
                      ></v-btn>
                    </template>
                  </v-tooltip>
                  <v-tooltip v-if="directoryHandle" text="手動掃描資料夾新圖片" location="top">
                    <template v-slot:activator="{ props }">
                      <v-btn 
                        v-bind="props"
                        size="x-small" 
                        variant="text" 
                        icon="mdi-sync" 
                        color="primary" 
                        class="ml-1" 
                        :loading="isScanning"
                        @click="scanLatestImage"
                      ></v-btn>
                    </template>
                  </v-tooltip>
                </div>
              </div>
            </div>

            <!-- Auto/Manual Scanning Controls -->
            <div class="d-flex align-center flex-wrap gap-4">
              <input
                type="file"
                ref="fileInput"
                accept="image/*"
                style="display: none"
                @change="onFileUploaded"
              />

              <v-switch
                v-model="autoScan"
                color="primary"
                hide-details
                density="compact"
                class="mr-2 custom-switch"
                label="自動掃描"
              ></v-switch>

              <v-btn
                color="primary"
                variant="flat"
                height="40"
                prepend-icon="mdi-upload"
                class="font-weight-bold rounded-lg text-none"
                @click="triggerFileUpload"
              >
                手動上傳圖片
              </v-btn>
            </div>
          </v-card-text>

          <!-- Loading details -->
          <v-progress-linear
            v-if="isScanning || analyzingItems.length > 0"
            indeterminate
            color="primary"
            height="4"
          ></v-progress-linear>

          <v-alert
            v-if="analyzingItems.length"
            type="info"
            variant="tonal"
            density="compact"
            class="ma-3 text-caption rounded-lg border-0 font-weight-bold"
            icon="mdi-sync mdi-spin"
          >
            <div v-for="item in analyzingItems" :key="item.id" class="d-inline-block mr-4">
              正在分析圖片：{{ item.name }}
            </div>
          </v-alert>

          <!-- Instructions & Status -->
          <v-divider></v-divider>
          <v-card-text class="py-2 px-4 bg-grey-lighten-5 text-caption text-grey-darken-1 d-flex align-center">
            <v-icon icon="mdi-information-outline" class="mr-1 text-muted-icon" size="16"></v-icon>
            <span>狀態：{{ scannerStatus }}</span>
            <v-spacer></v-spacer>
            <span class="d-none d-sm-inline d-flex align-center">
              <v-icon icon="mdi-lightbulb-on-outline" size="16" class="mr-1"></v-icon>
              支援 Ctrl+V 貼上截圖 / 拖曳圖片至網頁
            </span>
          </v-card-text>
        </v-card>

        <!-- Main Task List Card -->
        <v-card class="rounded-lg border-0 elevation-0" border flat>
          <!-- AI Draft banner -->
          <v-card-text
            v-if="draftQueue.length"
            class="d-flex flex-wrap align-center justify-space-between gap-2 py-2 px-4 bg-peach-50 border-b"
          >
            <div class="d-flex align-center text-warm-primary">
              <v-icon icon="mdi-auto-fix" class="mr-2 text-muted-icon"></v-icon>
              <span class="text-body-2 font-weight-bold">
                AI 辨識結果 — {{ draftQueue.length }} 筆待確認，請在下方表格中確認或編輯後加入
              </span>
            </div>
            <div class="d-flex align-center flex-wrap gap-2">
              <v-btn color="error" variant="text" size="small" class="font-weight-bold" @click="discardAllDrafts">全部捨棄</v-btn>
              <v-btn color="primary" variant="flat" size="small" class="font-weight-bold rounded-lg" @click="confirmAllDrafts">
                全部確認加入
              </v-btn>
            </div>
          </v-card-text>

          <!-- Toolbar with tabs and search -->
          <v-card-text class="d-flex flex-wrap align-center justify-space-between gap-4 border-b py-3 px-4">
            <v-tabs v-model="statusFilter" color="primary" density="comfortable" class="custom-tabs">
              <v-tab value="all">
                全部 ({{ totalCount }})
              </v-tab>
              <v-tab v-for="column in statusColumns" :key="column.id" :value="column.id">
                <v-icon :icon="column.icon" class="mr-1 text-muted-icon" size="small"></v-icon>
                {{ column.label }} ({{ countByStatus(column.id) }})
              </v-tab>
            </v-tabs>

            <div class="d-flex align-center gap-2">
              <v-tooltip text="將表格每一欄的寬度回復成預設值" location="top">
                <template v-slot:activator="{ props }">
                  <v-btn
                    v-bind="props"
                    variant="outlined"
                    color="muted"
                    size="small"
                    density="comfortable"
                    prepend-icon="mdi-table-column-width"
                    class="font-weight-bold rounded-lg text-none"
                    @click="resetColumnWidths"
                  >
                    回復預設欄寬
                  </v-btn>
                </template>
              </v-tooltip>

              <v-text-field
                v-model="searchQuery"
                prepend-inner-icon="mdi-magnify"
                placeholder="搜尋任務名稱..."
                variant="outlined"
                density="compact"
                hide-details
                style="max-width: 300px; width: 100%;"
                clearable
              ></v-text-field>
            </div>
          </v-card-text>

          <!-- Responsive Tasks Table -->
          <v-table class="todo-table w-100">
            <colgroup>
              <col :style="{ width: columnWidths.title + 'px' }" />
              <col :style="{ width: columnWidths.requester + 'px' }" />
              <col :style="{ width: columnWidths.company + 'px' }" />
              <col :style="{ width: columnWidths.contact + 'px' }" />
              <col :style="{ width: columnWidths.created + 'px' }" />
              <col :style="{ width: columnWidths.status + 'px' }" />
              <col :style="{ width: columnWidths.action + 'px' }" />
            </colgroup>
            <thead>
              <tr>
                <th class="font-weight-bold resizable-th">
                  任務名稱
                  <span class="col-resize-handle" @mousedown="startColumnResize('title', $event)"></span>
                </th>
                <th class="font-weight-bold resizable-th">
                  需求者
                  <span class="col-resize-handle" @mousedown="startColumnResize('requester', $event)"></span>
                </th>
                <th class="font-weight-bold resizable-th">
                  公司
                  <span class="col-resize-handle" @mousedown="startColumnResize('company', $event)"></span>
                </th>
                <th class="font-weight-bold resizable-th">
                  聯絡方式
                  <span class="col-resize-handle" @mousedown="startColumnResize('contact', $event)"></span>
                </th>
                <th class="font-weight-bold resizable-th">
                  新增時間
                  <span class="col-resize-handle" @mousedown="startColumnResize('created', $event)"></span>
                </th>
                <th class="font-weight-bold resizable-th">
                  狀態
                  <span class="col-resize-handle" @mousedown="startColumnResize('status', $event)"></span>
                </th>
                <th class="font-weight-bold resizable-th text-center">
                  功能
                  <span class="col-resize-handle" @mousedown="startColumnResize('action', $event)"></span>
                </th>
              </tr>
            </thead>
            <tbody>
              <!-- AI draft rows awaiting confirmation -->
              <tr v-for="draft in draftQueue" :key="draft.id" class="draft-row">
                <td class="align-center">
                  <div class="draft-input-wrap">
                    <input v-model="draft.title" class="draft-input draft-input-strong" placeholder="任務標題" />
                    <v-tooltip v-if="draft.confidenceNote" :text="draft.confidenceNote" location="top">
                      <template v-slot:activator="{ props }">
                        <v-icon v-bind="props" icon="mdi-lightbulb-on-outline" color="warning" size="18" class="draft-hint-icon"></v-icon>
                      </template>
                    </v-tooltip>
                  </div>
                </td>

                <td class="align-center">
                  <input v-model="draft.requester" class="draft-input" placeholder="需求者" />
                </td>

                <td class="align-center">
                  <input v-model="draft.company" class="draft-input" placeholder="公司" />
                </td>

                <td class="align-center">
                  <input v-model="draft.contact" class="draft-input" placeholder="聯絡方式" />
                </td>

                <td class="text-caption text-grey align-center">AI 剛辨識</td>

                <td class="align-center">
                  <v-chip color="warning" size="small" variant="flat" class="font-weight-bold text-warm-chip" prepend-icon="mdi-help-circle-outline">
                    待確認
                  </v-chip>
                </td>

                <td class="text-center align-center">
                  <div class="d-flex align-center justify-center gap-1">
                    <v-tooltip text="確認加入這筆待辦" location="top">
                      <template v-slot:activator="{ props }">
                        <v-btn
                          v-bind="props"
                          icon="mdi-check-circle-outline"
                          variant="text"
                          color="success"
                          size="small"
                          class="rounded-lg"
                          @click="confirmDraft(draft.id)"
                        ></v-btn>
                      </template>
                    </v-tooltip>
                    <v-tooltip text="捨棄此筆" location="top">
                      <template v-slot:activator="{ props }">
                        <v-btn
                          v-bind="props"
                          icon="mdi-trash-can-outline"
                          variant="text"
                          color="muted"
                          size="small"
                          class="rounded-lg hover-danger"
                          @click="discardDraft(draft.id)"
                        ></v-btn>
                      </template>
                    </v-tooltip>
                  </div>
                </td>
              </tr>

              <tr
                v-for="todo in sortedTodos"
                :key="todo.id"
                :class="{ 'row-done bg-sage-50': todo.status === 'done' }"
              >
                <!-- Title column -->
                <td class="font-weight-bold text-body-2 align-center">
                  <span :class="{ 'text-decoration-line-through text-grey-darken-1': todo.status === 'done' }">
                    {{ todo.title }}
                  </span>
                  <div v-if="latestProgress(todo)" class="latest-progress mt-1">
                    <v-icon icon="mdi-text-box-check-outline" size="14" class="mr-1 text-muted-icon"></v-icon>
                    <span class="text-truncate">{{ latestProgress(todo)?.content }}</span>
                    <span class="progress-time ml-1">{{ formatCreated(latestProgress(todo)?.createdAt || '') }}</span>
                  </div>
                </td>

                <!-- Requester column -->
                <td class="text-body-2 align-center">
                  <span v-if="todo.requester" class="text-grey-darken-2">{{ todo.requester }}</span>
                  <span v-else class="text-grey-lighten-1">—</span>
                </td>

                <!-- Company column -->
                <td class="text-body-2 align-center">
                  <span v-if="todo.company" class="text-grey-darken-2">{{ todo.company }}</span>
                  <span v-else class="text-grey-lighten-1">—</span>
                </td>

                <!-- Contact column -->
                <td class="text-body-2 align-center">
                  <span v-if="todo.contact" class="text-grey-darken-2">{{ todo.contact }}</span>
                  <span v-else class="text-grey-lighten-1">—</span>
                </td>

                <!-- Created Date -->
                <td class="text-caption text-grey align-center">
                  {{ formatCreated(todo.createdAt) }}
                </td>

                <!-- Status column: plain badge display -->
                <td class="align-center">
                  <v-chip
                    :color="getStatusColor(todo.status)"
                    size="small"
                    variant="flat"
                    class="font-weight-bold text-warm-chip"
                    :prepend-icon="getStatusIcon(todo.status)"
                  >
                    {{ statusColumns.find((column) => column.id === todo.status)?.label }}
                  </v-chip>
                </td>

                <!-- Action column -->
                <td class="text-center align-center">
                  <div class="d-flex align-center justify-center gap-1">
                    <v-tooltip text="新增處理進度" location="top">
                      <template v-slot:activator="{ props }">
                        <v-btn
                          v-bind="props"
                          icon="mdi-note-plus-outline"
                          variant="text"
                          color="primary"
                          size="small"
                          class="rounded-lg"
                          :disabled="todo.status === 'done'"
                          @click="openProgressDialog(todo.id)"
                        ></v-btn>
                      </template>
                    </v-tooltip>

                    <v-tooltip text="結案" location="top">
                      <template v-slot:activator="{ props }">
                        <v-btn
                          v-bind="props"
                          icon="mdi-archive-check-outline"
                          variant="text"
                          color="success"
                          size="small"
                          class="rounded-lg"
                          :disabled="todo.status === 'done'"
                          @click="closeTodo(todo.id)"
                        ></v-btn>
                      </template>
                    </v-tooltip>

                    <v-tooltip text="刪除任務" location="top">
                      <template v-slot:activator="{ props }">
                        <v-btn
                          v-bind="props"
                          icon="mdi-delete-outline"
                          variant="text"
                          color="muted"
                          size="small"
                          class="rounded-lg hover-danger"
                          @click="removeTodo(todo.id)"
                        ></v-btn>
                      </template>
                    </v-tooltip>
                  </div>
                </td>
              </tr>

              <tr v-if="sortedTodos.length === 0 && draftQueue.length === 0">
                <td colspan="7" class="text-center py-10 text-grey-darken-1">
                  <v-icon icon="mdi-playlist-remove" size="48" color="muted" class="mb-2"></v-icon>
                  <div class="text-subtitle-1 font-weight-bold">目前沒有任何任務</div>
                  <div class="text-caption text-grey">試試看點選右上角的「手動新增」或截圖貼上吧！</div>
                </td>
              </tr>
            </tbody>
          </v-table>
        </v-card>
      </v-container>
    </v-main>

    <!-- Dialog: Settings (設定) -->
    <v-dialog v-model="showSettingsDialog" max-width="500">
      <v-card class="rounded-lg">
        <v-card-title class="d-flex align-center justify-space-between pa-4 bg-white border-b text-slate-800">
          <span class="font-weight-black d-flex align-center">
            <v-icon icon="mdi-cog-outline" class="mr-2" color="primary"></v-icon>
            系統偵測與設定
          </span>
          <v-tooltip text="關閉" location="top">
            <template v-slot:activator="{ props }">
              <v-btn v-bind="props" icon="mdi-close" variant="text" size="small" @click="showSettingsDialog = false"></v-btn>
            </template>
          </v-tooltip>
        </v-card-title>
        
        <v-card-text class="pa-5 d-flex flex-column gap-4">
          <!-- Folder configuration -->
          <div>
            <div class="text-subtitle-2 font-weight-bold mb-2 text-grey-darken-3">目前監看的截圖資料夾</div>
            <v-card variant="flat" color="muted-lighten-5" class="pa-3 rounded-lg mb-3 border">
              <div class="text-caption text-grey-darken-1 word-break-all font-weight-medium">
                {{ directoryName }}
              </div>
            </v-card>
            <v-btn 
              block 
              color="primary" 
              variant="flat" 
              prepend-icon="mdi-folder-open" 
              class="font-weight-bold rounded-lg text-none"
              @click="pickDirectory"
            >
              選擇截圖資料夾
            </v-btn>
          </div>

          <v-divider class="my-2"></v-divider>

          <!-- Auto scan interval -->
          <div>
            <div class="text-subtitle-2 font-weight-bold mb-2 text-grey-darken-3">自動掃描頻率</div>
            <v-select
              v-model="scanIntervalMs"
              :items="[
                { title: '3 秒', value: 3000 },
                { title: '5 秒', value: 5000 },
                { title: '10 秒', value: 10000 },
                { title: '30 秒', value: 30000 }
              ]"
              item-title="title"
              item-value="value"
              label="選擇掃描間隔時間"
              variant="outlined"
              density="comfortable"
              hide-details
              @update:model-value="restartAutoScanIfRunning"
            ></v-select>
          </div>

          <v-divider class="my-2"></v-divider>

          <!-- System note -->
          <v-alert
            type="info"
            variant="tonal"
            color="primary"
            density="compact"
            class="text-caption rounded-lg border-0 pa-3 mt-1"
            icon="mdi-information-outline"
          >
            本機將使用 <strong class="text-primary-darken-2">Gemini 3.5 Flash</strong> 進行視覺與文件智慧解析。
          </v-alert>
        </v-card-text>
        
        <v-divider></v-divider>
        <v-card-actions class="pa-4 bg-grey-lighten-5 rounded-b-lg">
          <v-spacer></v-spacer>
          <v-btn color="muted" variant="text" class="font-weight-bold text-none" @click="showSettingsDialog = false">關閉</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- Dialog: Add Task (手動新增任務) -->
    <v-dialog v-model="showAddTaskDialog" max-width="600">
      <v-card class="rounded-lg">
        <v-card-title class="d-flex align-center justify-space-between pa-4 bg-white border-b text-slate-800">
          <span class="font-weight-black d-flex align-center">
            <v-icon icon="mdi-plus" class="mr-2" color="primary"></v-icon>
            手動新增任務
          </span>
          <v-tooltip text="關閉" location="top">
            <template v-slot:activator="{ props }">
              <v-btn v-bind="props" icon="mdi-close" variant="text" size="small" @click="showAddTaskDialog = false"></v-btn>
            </template>
          </v-tooltip>
        </v-card-title>
        
        <v-form @submit.prevent="submitManualTodo">
          <v-card-text class="pa-5 d-flex flex-column gap-4">
            <v-text-field
              v-model="newTitle"
              label="任務名稱 (必填) *"
              placeholder="例如：向供應商確認 Type-C 規格與報價"
              variant="outlined"
              density="comfortable"
              required
              autofocus
              :rules="[v => !!v || '任務名稱為必填']"
            ></v-text-field>
          </v-card-text>
          
          <v-divider></v-divider>
          <v-card-actions class="pa-4 bg-grey-lighten-5 rounded-b-lg">
            <v-spacer></v-spacer>
            <v-btn color="muted" variant="text" class="font-weight-bold text-none" @click="showAddTaskDialog = false">取消</v-btn>
            <v-btn color="primary" variant="flat" class="font-weight-bold rounded-lg px-6 text-none" type="submit" :disabled="!newTitle.trim()">
              確定新增
            </v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>

    <!-- Dialog: Screenshot Preview -->
    <v-dialog :model-value="!!previewImageUrl" max-width="720" @update:model-value="(v) => { if (!v) previewImageUrl = null; }">
      <v-card class="rounded-lg">
        <v-card-title class="d-flex align-center justify-space-between pa-4 bg-white border-b text-slate-800">
          <span class="font-weight-black d-flex align-center">
            <v-icon icon="mdi-image-outline" class="mr-2" color="primary"></v-icon>
            截圖預覽
          </span>
          <v-tooltip text="關閉" location="top">
            <template v-slot:activator="{ props }">
              <v-btn v-bind="props" icon="mdi-close" variant="text" size="small" @click="previewImageUrl = null"></v-btn>
            </template>
          </v-tooltip>
        </v-card-title>
        <v-card-text class="pa-0 bg-warm-page">
          <v-img v-if="previewImageUrl" :src="previewImageUrl" max-height="70vh" contain></v-img>
        </v-card-text>
      </v-card>
    </v-dialog>

    <!-- Dialog: Progress Update -->
    <v-dialog v-model="showProgressDialog" max-width="560">
      <v-card class="rounded-lg">
        <v-card-title class="d-flex align-center justify-space-between pa-4 bg-white border-b text-slate-800">
          <span class="font-weight-black d-flex align-center">
            <v-icon icon="mdi-note-plus-outline" class="mr-2" color="primary"></v-icon>
            新增處理進度
          </span>
          <v-tooltip text="關閉" location="top">
            <template v-slot:activator="{ props }">
              <v-btn v-bind="props" icon="mdi-close" variant="text" size="small" @click="showProgressDialog = false"></v-btn>
            </template>
          </v-tooltip>
        </v-card-title>

        <v-form @submit.prevent="submitProgressUpdate">
          <v-card-text class="pa-5">
            <div v-if="selectedProgressTodo?.progressLogs.length" class="progress-history mb-4">
              <div class="text-caption font-weight-bold text-grey mb-2">處理紀錄</div>
              <div v-for="log in selectedProgressTodo.progressLogs" :key="log.id" class="progress-history-item">
                <div class="progress-time mb-1">{{ formatCreated(log.createdAt) }}</div>
                <div>{{ log.content }}</div>
              </div>
            </div>
            <v-textarea
              v-model="progressText"
              label="處理進度"
              placeholder="例如：已回覆客戶，等待對方確認規格。"
              variant="outlined"
              rows="4"
              auto-grow
              autofocus
              hide-details
            ></v-textarea>
          </v-card-text>

          <v-divider></v-divider>
          <v-card-actions class="pa-4 bg-grey-lighten-5 rounded-b-lg">
            <v-spacer></v-spacer>
            <v-btn color="muted" variant="text" class="font-weight-bold text-none" @click="showProgressDialog = false">取消</v-btn>
            <v-btn color="primary" variant="flat" class="font-weight-bold rounded-lg px-6 text-none" type="submit" :disabled="!progressText.trim()">
              儲存進度
            </v-btn>
          </v-card-actions>
        </v-form>
      </v-card>
    </v-dialog>
    <!-- Dialog: Delete Confirm -->
    <v-dialog v-model="showDeleteConfirmDialog" max-width="400">
      <v-card class="rounded-lg">
        <v-card-title class="d-flex align-center justify-space-between pa-4 bg-white border-b text-slate-800">
          <span class="font-weight-black d-flex align-center">
            <v-icon icon="mdi-alert-circle-outline" class="mr-2" color="error"></v-icon>
            確認刪除任務
          </span>
          <v-tooltip text="關閉" location="top">
            <template v-slot:activator="{ props }">
              <v-btn v-bind="props" icon="mdi-close" variant="text" size="small" @click="showDeleteConfirmDialog = false"></v-btn>
            </template>
          </v-tooltip>
        </v-card-title>
        <v-card-text class="pa-5 text-body-1">
          確定要刪除此待辦任務嗎？此動作將無法復原。
        </v-card-text>
        <v-divider></v-divider>
        <v-card-actions class="pa-4 bg-grey-lighten-5 rounded-b-lg">
          <v-spacer></v-spacer>
          <v-btn color="muted" variant="text" class="font-weight-bold text-none" @click="showDeleteConfirmDialog = false">取消</v-btn>
          <v-btn color="error" variant="flat" class="font-weight-bold rounded-lg px-6 text-none" @click="confirmDeleteTodo">
            確認刪除
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-app>
</template>

<style>
/* Base typography and aesthetics override */
body {
  font-family: "Outfit", "Inter", "Microsoft JhengHei", "PingFang TC", system-ui, sans-serif !important;
}

.max-width-wrapper {
  max-width: 1400px;
  margin: 0 auto;
}

/* Statistics flex grid */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 16px;
}

.min-width-folder {
  min-width: 250px;
  max-width: 450px;
}

.max-width-filename {
  max-width: 240px;
  display: inline-block;
}


.word-break-all {
  word-break: break-all;
}

.gap-2 {
  gap: 8px;
}
.gap-3 {
  gap: 12px;
}
.gap-4 {
  gap: 16px;
}

.todo-table {
  table-layout: fixed;
}

.todo-table th {
  background-color: #fff8ef !important;
  color: #8f6f56 !important;
  font-size: 0.8rem !important;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.todo-table td {
  border-bottom: 1px solid #f1dfcf !important;
  overflow: hidden;
}

.resizable-th {
  position: relative;
  overflow: hidden;
  white-space: nowrap;
}

.col-resize-handle {
  position: absolute;
  top: 0;
  right: 0;
  width: 8px;
  height: 100%;
  cursor: col-resize;
  user-select: none;
  touch-action: none;
  z-index: 1;
}

.col-resize-handle::after {
  content: "";
  position: absolute;
  top: 20%;
  right: 3px;
  width: 2px;
  height: 60%;
  border-radius: 1px;
  background-color: #d8bda3;
}

.col-resize-handle:hover,
.col-resize-handle:active {
  background-color: rgba(200, 121, 74, 0.22);
}

.col-resize-handle:hover::after,
.col-resize-handle:active::after {
  background-color: #c8794a;
}

.todo-table tbody tr {
  transition: background-color 0.2s ease;
}

.todo-table tbody tr:hover {
  background-color: #fff8ef;
}

.row-done {
  opacity: 0.75;
}


.draft-input-wrap {
  align-items: center;
  display: flex;
  gap: 6px;
  min-width: 0;
}

.draft-input {
  background: rgba(255, 253, 249, 0.72);
  border: 1px solid transparent;
  border-bottom-color: #d8bda3;
  border-radius: 6px;
  color: #5f4d40;
  font: inherit;
  font-size: 0.86rem;
  font-weight: 600;
  min-height: 34px;
  min-width: 0;
  outline: none;
  padding: 6px 8px;
  transition: background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease;
  width: 100%;
}

.draft-input::placeholder {
  color: #b3a395;
  font-weight: 500;
}

.draft-input:hover {
  background: #fffaf4;
  border-color: #ead8c5;
}

.draft-input:focus {
  background: #fffdf9;
  border-color: #caa584;
  box-shadow: 0 0 0 3px rgba(183, 121, 92, 0.14);
}

.draft-input-strong {
  color: #4f3f34;
  font-weight: 800;
}

.draft-hint-icon {
  flex: 0 0 auto;
  opacity: 0.82;
}
.draft-row {
  background-color: #fff1e8;
  box-shadow: inset 3px 0 0 #d49a45;
}

.draft-row:hover {
  background-color: #ffe7d7 !important;
}

.draft-row td {
  padding-top: 8px !important;
  padding-bottom: 8px !important;
}

/* Scrollbar tweaks */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: #f4e7d8;
}
::-webkit-scrollbar-thumb {
  background: #d8bda3;
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: #b98967;
}

/* Custom Overrides for Premium Looks */
.custom-switch .v-selection-control {
  min-height: auto !important;
}

.hover-danger:hover {
  color: #c96f5c !important;
  background-color: #fff0e8 !important;
}

.border-b {
  border-bottom: 1px solid #ead8c5 !important;
}

.bg-warm-50 {
  background-color: #fff8ef !important;
}

.bg-warm-page {
  background: linear-gradient(180deg, #fff8ef 0%, #f8eddf 100%) !important;
}

.bg-peach-50 {
  background-color: #fff1e8 !important;
}

.bg-sage-50 {
  background-color: #f2f5ec !important;
}

.text-warm-primary {
  color: #8f492d !important;
}

.warm-app-bar {
  background-color: rgba(255, 253, 249, 0.92) !important;
  backdrop-filter: blur(10px);
}

.v-card {
  border-color: #ead8c5 !important;
}



.progress-history {
  max-height: 220px;
  overflow: auto;
}

.progress-history-item {
  background-color: #fff8ef;
  border-left: 3px solid #d8bda3;
  border-radius: 6px;
  color: #6f5e51;
  font-size: 0.86rem;
  line-height: 1.5;
  margin-bottom: 8px;
  padding: 9px 11px;
}
.latest-progress {
  align-items: center;
  color: #8a7a6d;
  display: flex;
  font-size: 0.78rem;
  font-weight: 600;
  min-width: 0;
}

.progress-time {
  color: #b3a395;
  flex: 0 0 auto;
  font-size: 0.72rem;
  font-weight: 500;
}
.text-muted-icon {
  color: #9a8a7c !important;
}

.text-warm-chip {
  color: #fffaf4 !important;
}

.v-btn.v-btn--icon .v-icon,
.v-chip .v-icon {
  opacity: 0.86;
}
</style>
