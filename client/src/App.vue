<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

type TodoStatus = "pending" | "in_progress" | "done";

type Todo = {
  id: string;
  title: string;
  dueDate: string;
  status: TodoStatus;
  createdAt: string;
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
  dueDate: string;
  sourceImage: string;
  imageUrl: string;
  confidenceNote: string;
  selected: boolean;
};

type DueTone = "overdue" | "soon" | "normal";

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
const DB_NAME = "todo-pwa.handles";
const DB_STORE = "file-handles";
const DIRECTORY_HANDLE_KEY = "screenshot-directory";
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp", "image/gif"]);

const statusColumns: Array<{ id: TodoStatus; label: string; hint: string; icon: string }> = [
  { id: "pending", label: "待辦", hint: "等候處理", icon: "mdi-clock-outline" },
  { id: "in_progress", label: "進行中", hint: "正在追蹤", icon: "mdi-rocket-launch" },
  { id: "done", label: "完成", hint: "已收尾", icon: "mdi-check-circle" },
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
const todoIdToDelete = ref<string | null>(null);

// Manual add todo form fields
const newTitle = ref("");
const newDueDate = ref("");

const searchQuery = ref("");
const statusFilter = ref<TodoStatus | "all">("all");
const analyzingItems = ref<Array<{ id: string; name: string }>>([]);
const draftQueue = ref<DraftItem[]>([]);


const totalCount = computed(() => todos.value.length);
const doneCount = computed(() => countByStatus("done"));
const inProgressCount = computed(() => countByStatus("in_progress"));
const pendingCount = computed(() => countByStatus("pending"));
const overdueCount = computed(
  () => todos.value.filter((todo) => todo.status !== "done" && dueBadge(todo)?.tone === "overdue").length,
);
const selectedDraftCount = computed(() => draftQueue.value.filter((draft) => draft.selected).length);
const allDraftsSelected = computed({
  get: () => draftQueue.value.length > 0 && draftQueue.value.every((draft) => draft.selected),
  set: (value: boolean) => {
    draftQueue.value.forEach((draft) => (draft.selected = value));
  },
});

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
  draftQueue.value.forEach((draft) => URL.revokeObjectURL(draft.imageUrl));
});

watch(todos, saveTodos, { deep: true });
watch(processedKeys, saveProcessedKeys, { deep: true });
watch(autoScan, (enabled) => {
  if (enabled) startAutoScan();
  else stopAutoScan();
});

async function loadLocalState() {
  const storedTodos = localStorage.getItem(STORAGE_KEY);
  const storedProcessed = localStorage.getItem(PROCESSED_KEY);

  if (storedTodos) todos.value = JSON.parse(storedTodos) as Todo[];
  if (storedProcessed) processedKeys.value = new Set(JSON.parse(storedProcessed) as string[]);

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
    dueDate: "",
    sourceImage,
    imageUrl,
    confidenceNote: [draft.due_time_guess ? `期限猜測：${draft.due_time_guess}` : "", draft.confidence_note]
      .filter(Boolean)
      .join("　"),
    selected: true,
  };
}

function confirmSelectedDrafts() {
  const toAdd = draftQueue.value.filter((draft) => draft.selected);
  if (toAdd.length === 0) return;

  toAdd.forEach((draft) => {
    todos.value.unshift({
      id: draft.id,
      title: draft.title.trim() || "未命名任務",
      dueDate: draft.dueDate,
      status: "pending",
      createdAt: new Date().toISOString(),
      sourceImage: draft.sourceImage,
      requester: draft.requester || undefined,
      company: draft.company || undefined,
      contact: draft.contact || undefined,
    });
    URL.revokeObjectURL(draft.imageUrl);
  });

  draftQueue.value = draftQueue.value.filter((draft) => !draft.selected);
}

function discardDraft(id: string) {
  const index = draftQueue.value.findIndex((draft) => draft.id === id);
  if (index === -1) return;

  URL.revokeObjectURL(draftQueue.value[index].imageUrl);
  draftQueue.value = draftQueue.value.filter((draft) => draft.id !== id);
}

function discardAllDrafts() {
  draftQueue.value.forEach((draft) => URL.revokeObjectURL(draft.imageUrl));
  draftQueue.value = [];
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

  createTodo(title, newDueDate.value);
  newTitle.value = "";
  newDueDate.value = "";
  showAddTaskDialog.value = false;
}

function createTodo(title: string, dueDate = "", sourceImage = "") {
  todos.value.unshift({
    id: crypto.randomUUID(),
    title,
    dueDate,
    status: "pending",
    createdAt: new Date().toISOString(),
    sourceImage,
  });
}

function moveTodo(todoId: string, status: unknown) {
  const todo = todos.value.find((item) => item.id === todoId);
  if (todo && (status === "pending" || status === "in_progress" || status === "done")) {
    todo.status = status;
  }
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

function dueBadge(todo: Todo): { label: string; tone: DueTone } | null {
  if (!todo.dueDate) return null;

  const due = new Date(todo.dueDate).getTime();
  if (Number.isNaN(due)) return null;

  const diffHours = (due - Date.now()) / 36e5;
  if (diffHours < 0) return { label: "已逾期", tone: "overdue" };
  if (diffHours <= 24) return { label: "24 小時內", tone: "soon" };
  return { label: "", tone: "normal" };
}

function getDueChipColor(todo: Todo) {
  const badge = dueBadge(todo);
  if (!badge) return "grey";
  if (badge.tone === "overdue") return "error";
  if (badge.tone === "soon") return "warning";
  return "grey-darken-1";
}

function getStatusIcon(status: TodoStatus) {
  if (status === "pending") return "mdi-clock-outline";
  if (status === "in_progress") return "mdi-rocket-launch";
  if (status === "done") return "mdi-check-circle";
  return "";
}

function formatDue(dueDate: string) {
  return dueDate.replace("T", " ");
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
  <v-app class="bg-slate-50">
    <!-- Navbar / AppBar -->
    <v-app-bar flat border color="white" class="px-md-6 border-b px-2">
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

      <v-btn
        icon="mdi-cog-outline"
        variant="outlined"
        color="grey-darken-1"
        class="rounded-lg"
        @click="showSettingsDialog = true"
        title="系統設定"
      ></v-btn>
    </v-app-bar>

    <v-main class="bg-grey-lighten-4">
      <v-container fluid class="pa-4 pa-md-6 max-width-wrapper">
        <!-- Stats Dashboard -->
        <div class="stats-grid mb-6">
          <!-- Stat Cards -->
          <v-card class="rounded-lg border-0 elevation-0" border flat>
            <v-card-text class="d-flex align-center pa-4">
              <v-avatar color="grey-lighten-4" size="48" rounded="lg" class="mr-4">
                <v-icon icon="mdi-clock-outline" color="grey-darken-1" size="24"></v-icon>
              </v-avatar>
              <div>
                <div class="text-caption text-grey font-weight-bold">待辦任務</div>
                <div class="text-h5 font-weight-black text-grey-darken-3 mt-1" style="line-height: 1;">{{ pendingCount }}</div>
              </div>
            </v-card-text>
          </v-card>

          <v-card class="rounded-lg border-0 elevation-0" border flat>
            <v-card-text class="d-flex align-center pa-4">
              <v-avatar color="blue-lighten-5" size="48" rounded="lg" class="mr-4">
                <v-icon icon="mdi-rocket-launch" color="blue" size="24"></v-icon>
              </v-avatar>
              <div>
                <div class="text-caption text-grey font-weight-bold">進行中</div>
                <div class="text-h5 font-weight-black text-blue mt-1" style="line-height: 1;">{{ inProgressCount }}</div>
              </div>
            </v-card-text>
          </v-card>

          <v-card class="rounded-lg border-0 elevation-0" border flat>
            <v-card-text class="d-flex align-center pa-4">
              <v-avatar color="success-lighten-5" size="48" rounded="lg" class="mr-4">
                <v-icon icon="mdi-check-circle" color="success" size="24"></v-icon>
              </v-avatar>
              <div>
                <div class="text-caption text-grey font-weight-bold">已完成</div>
                <div class="text-h5 font-weight-black text-success mt-1" style="line-height: 1;">{{ doneCount }}</div>
              </div>
            </v-card-text>
          </v-card>

          <v-card class="rounded-lg border-0 elevation-0" border flat :color="overdueCount > 0 ? 'red-lighten-5' : undefined">
            <v-card-text class="d-flex align-center pa-4">
              <v-avatar :color="overdueCount > 0 ? 'red-lighten-4' : 'grey-lighten-4'" size="48" rounded="lg" class="mr-4">
                <v-icon icon="mdi-alert-circle" :color="overdueCount > 0 ? 'error' : 'grey-darken-1'" size="24"></v-icon>
              </v-avatar>
              <div>
                <div class="text-caption text-grey font-weight-bold">已逾期</div>
                <div class="text-h5 font-weight-black mt-1" :class="overdueCount > 0 ? 'text-error' : 'text-grey-darken-3'" style="line-height: 1;">{{ overdueCount }}</div>
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
                  <v-btn 
                    size="x-small" 
                    variant="text" 
                    icon="mdi-pencil-outline" 
                    color="primary" 
                    class="ml-1" 
                    @click="pickDirectory" 
                    title="重新選擇資料夾"
                  ></v-btn>
                  <v-btn 
                    v-if="directoryHandle"
                    size="x-small" 
                    variant="text" 
                    icon="mdi-sync" 
                    color="primary" 
                    class="ml-1" 
                    :loading="isScanning"
                    @click="scanLatestImage" 
                    title="手動掃描資料夾新圖片"
                  ></v-btn>
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
            <v-icon icon="mdi-information-outline" class="mr-1" size="16"></v-icon>
            <span>狀態：{{ scannerStatus }}</span>
            <v-spacer></v-spacer>
            <span class="d-none d-sm-inline d-flex align-center">
              <v-icon icon="mdi-lightbulb-on-outline" size="16" class="mr-1"></v-icon>
              支援 Ctrl+V 貼上截圖 / 拖曳圖片至網頁
            </span>
          </v-card-text>
        </v-card>

        <!-- AI Draft Queue (Unconfirmed Tasks) -->
        <v-card v-if="draftQueue.length" class="mb-6 rounded-lg elevation-0 border-blue-lighten-2" border flat color="blue-lighten-5">
          <v-card-title class="d-flex justify-space-between align-center flex-wrap py-3 px-4 bg-blue-lighten-4 rounded-t-lg">
            <div>
              <div class="text-subtitle-1 font-weight-black text-blue-darken-4">
                <v-icon icon="mdi-auto-fix" class="mr-1"></v-icon>
                AI 辨識結果 — 請確認後再加入待辦
              </div>
              <div class="text-caption text-blue-darken-3">勾選要加入的任務，可先修改標題與期限，避免 AI 判斷錯誤</div>
            </div>
            <div class="d-flex align-center flex-wrap gap-2 mt-2 mt-sm-0">
              <v-checkbox 
                v-model="allDraftsSelected" 
                label="全選" 
                hide-details 
                density="compact" 
                color="blue-darken-4" 
                class="mr-2"
              ></v-checkbox>
              <v-btn color="error" variant="text" size="small" class="font-weight-bold" @click="discardAllDrafts">全部捨棄</v-btn>
              <v-btn color="blue-darken-3" :disabled="selectedDraftCount === 0" variant="flat" size="small" class="font-weight-bold rounded-lg" @click="confirmSelectedDrafts">
                批次加入 ({{ selectedDraftCount }} 筆)
              </v-btn>
            </div>
          </v-card-title>
          
          <v-card-text class="pa-4">
            <v-row>
              <v-col v-for="draft in draftQueue" :key="draft.id" cols="12" md="6" lg="4">
                <v-card class="rounded-lg fill-height d-flex flex-column border-0 elevation-0" flat>
                  <v-img :src="draft.imageUrl" height="160" cover class="bg-grey-lighten-2 border-b rounded-t-lg">
                    <template v-slot:placeholder>
                      <div class="d-flex align-center justify-center fill-height bg-grey-lighten-3">
                        <v-progress-circular color="primary" indeterminate></v-progress-circular>
                      </div>
                    </template>
                  </v-img>

                  <v-card-text class="pa-4 flex-grow-1 d-flex flex-column gap-3">
                    <v-checkbox 
                      v-model="draft.selected" 
                      label="確認加入這筆待辦" 
                      hide-details 
                      density="compact" 
                      color="primary" 
                      class="font-weight-bold mb-1"
                    ></v-checkbox>

                    <v-text-field 
                      v-model="draft.title" 
                      label="任務標題" 
                      variant="outlined" 
                      density="comfortable" 
                      hide-details
                    ></v-text-field>

                    <v-text-field 
                      v-model="draft.dueDate" 
                      label="指定期限（選填）" 
                      type="datetime-local" 
                      variant="outlined" 
                      density="comfortable" 
                      hide-details
                    ></v-text-field>

                    <v-text-field
                      v-if="draft.requester"
                      v-model="draft.requester"
                      label="需求者"
                      variant="outlined"
                      density="comfortable"
                      prepend-inner-icon="mdi-account-outline"
                      hide-details
                    ></v-text-field>

                    <v-text-field
                      v-if="draft.company"
                      v-model="draft.company"
                      label="公司"
                      variant="outlined"
                      density="comfortable"
                      prepend-inner-icon="mdi-office-building-outline"
                      hide-details
                    ></v-text-field>

                    <v-text-field
                      v-if="draft.contact"
                      v-model="draft.contact"
                      label="聯絡方式"
                      variant="outlined"
                      density="comfortable"
                      prepend-inner-icon="mdi-phone-outline"
                      hide-details
                    ></v-text-field>

                    <v-alert 
                      v-if="draft.confidenceNote" 
                      type="info" 
                      variant="tonal" 
                      density="compact" 
                      class="text-caption py-1 px-3 mt-1 border-0 rounded-lg text-blue-darken-3 bg-blue-lighten-5" 
                      icon="mdi-lightbulb-on-outline"
                    >
                      {{ draft.confidenceNote }}
                    </v-alert>
                  </v-card-text>

                  <v-divider></v-divider>
                  <v-card-actions class="pa-3 bg-grey-lighten-5 justify-end rounded-b-lg">
                    <v-btn color="error" variant="text" size="small" class="font-weight-bold" prepend-icon="mdi-trash-can-outline" @click="discardDraft(draft.id)">
                      捨棄此筆
                    </v-btn>
                  </v-card-actions>
                </v-card>
              </v-col>
            </v-row>
          </v-card-text>
        </v-card>

        <!-- Main Task List Card -->
        <v-card class="rounded-lg border-0 elevation-0" border flat>
          <!-- Toolbar with tabs and search -->
          <v-card-text class="d-flex flex-wrap align-center justify-space-between gap-4 border-b py-3 px-4">
            <v-tabs v-model="statusFilter" color="primary" density="comfortable" class="custom-tabs">
              <v-tab value="all">
                全部 ({{ totalCount }})
              </v-tab>
              <v-tab v-for="column in statusColumns" :key="column.id" :value="column.id">
                <v-icon :icon="column.icon" class="mr-1" size="small"></v-icon>
                {{ column.label }} ({{ countByStatus(column.id) }})
              </v-tab>
            </v-tabs>

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
          </v-card-text>

          <!-- Responsive Tasks Table -->
          <v-table class="todo-table w-100">
            <thead>
              <tr>
                <th class="font-weight-bold" style="width: 140px;">狀態</th>
                <th class="font-weight-bold">任務名稱</th>
                <th class="font-weight-bold" style="width: 180px;">期限</th>
                <th class="font-weight-bold" style="width: 100px;">需求者</th>
                <th class="font-weight-bold" style="width: 120px;">公司</th>
                <th class="font-weight-bold" style="width: 130px;">聯絡方式</th>
                <th class="font-weight-bold" style="width: 160px;">來源</th>
                <th class="font-weight-bold" style="width: 150px;">新增時間</th>
                <th style="width: 60px;"></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="todo in sortedTodos"
                :key="todo.id"
                :class="{ 'row-done bg-grey-lighten-5': todo.status === 'done' }"
              >
                <!-- Status column with beautiful custom selection -->
                <td class="align-center">
                  <v-select
                    :model-value="todo.status"
                    :items="statusColumns"
                    item-title="label"
                    item-value="id"
                    variant="outlined"
                    density="compact"
                    hide-details
                    class="status-select-component"
                    @update:model-value="moveTodo(todo.id, $event)"
                  >
                    <template v-slot:selection="{ item }">
                      <span class="text-body-2 font-weight-medium d-flex align-center">
                        <v-icon :icon="getStatusIcon((item as any).value)" class="mr-1" size="small"></v-icon>
                        {{ (item as any).title }}
                      </span>
                    </template>
                    <template v-slot:item="{ item, props }">
                      <v-list-item v-bind="props">
                        <template v-slot:title>
                          <span class="d-flex align-center">
                            <v-icon :icon="getStatusIcon((item as any).value)" class="mr-1" size="small"></v-icon>
                            {{ (item as any).title }}
                          </span>
                        </template>
                      </v-list-item>
                    </template>
                  </v-select>
                </td>

                <!-- Title column -->
                <td class="font-weight-bold text-body-2 align-center">
                  <span :class="{ 'text-decoration-line-through text-grey-darken-1': todo.status === 'done' }">
                    {{ todo.title }}
                  </span>
                </td>

                <!-- Due date column -->
                <td class="align-center">
                  <template v-if="todo.dueDate">
                    <v-chip
                      :color="getDueChipColor(todo)"
                      size="small"
                      class="font-weight-bold text-white"
                      prepend-icon="mdi-clock-outline"
                      variant="flat"
                    >
                      {{ formatDue(todo.dueDate) }}
                      <span v-if="dueBadge(todo)?.label" class="ml-1">· {{ dueBadge(todo)?.label }}</span>
                    </v-chip>
                  </template>
                  <span v-else class="text-grey-lighten-1">—</span>
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

                <!-- Source column -->
                <td class="align-center">
                  <template v-if="todo.sourceImage">
                    <v-chip size="small" variant="tonal" color="blue-grey" prepend-icon="mdi-file-image-outline" class="font-weight-medium text-truncate max-width-source" :title="todo.sourceImage">
                      {{ todo.sourceImage }}
                    </v-chip>
                  </template>
                  <span v-else class="text-grey-lighten-1">—</span>
                </td>

                <!-- Created Date -->
                <td class="text-caption text-grey align-center">
                  {{ formatCreated(todo.createdAt) }}
                </td>

                <!-- Action column -->
                <td class="text-center align-center">
                  <v-btn
                    icon="mdi-delete-outline"
                    variant="text"
                    color="grey-darken-1"
                    size="small"
                    class="rounded-lg hover-danger"
                    @click="removeTodo(todo.id)"
                    title="刪除任務"
                  ></v-btn>
                </td>
              </tr>

              <tr v-if="sortedTodos.length === 0">
                <td colspan="9" class="text-center py-10 text-grey-darken-1">
                  <v-icon icon="mdi-playlist-remove" size="48" color="grey" class="mb-2"></v-icon>
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
          <v-btn icon="mdi-close" variant="text" size="small" @click="showSettingsDialog = false"></v-btn>
        </v-card-title>
        
        <v-card-text class="pa-5 d-flex flex-column gap-4">
          <!-- Folder configuration -->
          <div>
            <div class="text-subtitle-2 font-weight-bold mb-2 text-grey-darken-3">目前監看的截圖資料夾</div>
            <v-card variant="flat" color="grey-lighten-4" class="pa-3 rounded-lg mb-3 border">
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
            本機將使用 <strong class="text-primary-darken-2">Gemini 3.5 Flash</strong> 進行視覺與文件智慧解析。此功能由本機 API 提供，無需在前端配置 API 金鑰。
          </v-alert>
        </v-card-text>
        
        <v-divider></v-divider>
        <v-card-actions class="pa-4 bg-grey-lighten-5 rounded-b-lg">
          <v-spacer></v-spacer>
          <v-btn color="grey-darken-1" variant="text" class="font-weight-bold text-none" @click="showSettingsDialog = false">關閉</v-btn>
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
          <v-btn icon="mdi-close" variant="text" size="small" @click="showAddTaskDialog = false"></v-btn>
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

            <v-text-field
              v-model="newDueDate"
              label="到期時間 (選填)"
              type="datetime-local"
              variant="outlined"
              density="comfortable"
            ></v-text-field>
          </v-card-text>
          
          <v-divider></v-divider>
          <v-card-actions class="pa-4 bg-grey-lighten-5 rounded-b-lg">
            <v-spacer></v-spacer>
            <v-btn color="grey-darken-1" variant="text" class="font-weight-bold text-none" @click="showAddTaskDialog = false">取消</v-btn>
            <v-btn color="primary" variant="flat" class="font-weight-bold rounded-lg px-6 text-none" type="submit" :disabled="!newTitle.trim()">
              確定新增
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
          <v-btn icon="mdi-close" variant="text" size="small" @click="showDeleteConfirmDialog = false"></v-btn>
        </v-card-title>
        <v-card-text class="pa-5 text-body-1">
          確定要刪除此待辦任務嗎？此動作將無法復原。
        </v-card-text>
        <v-divider></v-divider>
        <v-card-actions class="pa-4 bg-grey-lighten-5 rounded-b-lg">
          <v-spacer></v-spacer>
          <v-btn color="grey-darken-1" variant="text" class="font-weight-bold text-none" @click="showDeleteConfirmDialog = false">取消</v-btn>
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

.max-width-source {
  max-width: 140px;
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

.status-select-component {
  max-width: 150px;
  background: white;
}

.todo-table th {
  background-color: #f8fafc !important;
  color: #64748b !important;
  font-size: 0.8rem !important;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.todo-table td {
  border-bottom: 1px solid #f1f5f9 !important;
}

.todo-table tbody tr {
  transition: background-color 0.2s ease;
}

.todo-table tbody tr:hover {
  background-color: #f8fafc;
}

.row-done {
  opacity: 0.75;
}

/* Scrollbar tweaks */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: #f1f5f9;
}
::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: #94a3b8;
}

/* Custom Overrides for Premium Looks */
.custom-switch .v-selection-control {
  min-height: auto !important;
}

.hover-danger:hover {
  color: #ef4444 !important;
  background-color: #fef2f2 !important;
}

.border-b {
  border-bottom: 1px solid #e2e8f0 !important;
}

.bg-slate-50 {
  background-color: #f8fafc !important;
}
</style>
