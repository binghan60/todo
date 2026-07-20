<script setup lang="ts">
import { computed, ref } from "vue";

type TodoStatus = "pending" | "in_progress" | "done";

type Todo = {
  id: string;
  title: string;
  description: string;
  dueDate: string;
  status: TodoStatus;
  createdAt: string;
};

const statusColumns: Array<{ id: TodoStatus; label: string; hint: string }> = [
  { id: "pending", label: "待辦", hint: "尚未開始" },
  { id: "in_progress", label: "進行中", hint: "正在推進" },
  { id: "done", label: "完成", hint: "已經收尾" },
];

const todos = ref<Todo[]>([
  {
    id: crypto.randomUUID(),
    title: "整理第一版任務資料模型",
    description: "確認 title、description、due_time、status 先能完整跑通。",
    dueDate: "",
    status: "in_progress",
    createdAt: new Date().toISOString(),
  },
  {
    id: crypto.randomUUID(),
    title: "規劃 SQLite CRUD",
    description: "下一步把前端狀態接到 Tauri command 和本機資料庫。",
    dueDate: "",
    status: "pending",
    createdAt: new Date().toISOString(),
  },
]);

const newTitle = ref("");
const newDescription = ref("");
const newDueDate = ref("");

const totalCount = computed(() => todos.value.length);
const doneCount = computed(() => countByStatus("done"));
const activeCount = computed(() => totalCount.value - doneCount.value);

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

  todos.value.unshift({
    id: crypto.randomUUID(),
    title,
    description: newDescription.value.trim(),
    dueDate: newDueDate.value,
    status: "pending",
    createdAt: new Date().toISOString(),
  });

  newTitle.value = "";
  newDescription.value = "";
  newDueDate.value = "";
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
</script>

<template>
  <main class="app-shell">
    <section class="topbar" aria-labelledby="app-title">
      <div>
        <p class="eyebrow">Desktop Todo</p>
        <h1 id="app-title">任務工作台</h1>
      </div>

      <div class="metrics" aria-label="任務統計">
        <div>
          <span>{{ totalCount }}</span>
          <small>全部</small>
        </div>
        <div>
          <span>{{ activeCount }}</span>
          <small>未完成</small>
        </div>
        <div>
          <span>{{ doneCount }}</span>
          <small>完成</small>
        </div>
      </div>
    </section>

    <form class="composer" @submit.prevent="addTodo">
      <div class="input-grid">
        <label>
          <span>任務名稱</span>
          <input v-model="newTitle" autocomplete="off" placeholder="例如：準備明天會議資料" />
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
        <p>先把任務收進來，下一階段再接 SQLite 做永久保存。</p>
        <button type="submit">新增任務</button>
      </div>
    </form>

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

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}

button,
input,
textarea {
  font: inherit;
}

button {
  cursor: pointer;
}

.app-shell {
  min-height: 100vh;
  padding: 32px;
}

.topbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 24px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #667085;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1,
h2,
h3,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 0;
  font-size: clamp(2rem, 4vw, 3.6rem);
  line-height: 1;
}

.metrics {
  display: grid;
  grid-template-columns: repeat(3, minmax(86px, 1fr));
  gap: 10px;
}

.metrics div {
  min-height: 72px;
  padding: 12px 14px;
  border: 1px solid #d9e1e7;
  border-radius: 8px;
  background: #ffffff;
}

.metrics span {
  display: block;
  font-size: 1.45rem;
  font-weight: 800;
}

.metrics small {
  color: #667085;
}

.composer {
  display: grid;
  gap: 14px;
  margin-bottom: 26px;
  padding: 18px;
  border: 1px solid #d9e1e7;
  border-radius: 8px;
  background: #ffffff;
}

.input-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 14px;
}

label {
  display: grid;
  gap: 7px;
  color: #475467;
  font-size: 0.9rem;
  font-weight: 700;
}

input,
textarea {
  width: 100%;
  border: 1px solid #cfd8df;
  border-radius: 8px;
  padding: 10px 12px;
  color: #1d2433;
  background: #fbfcfd;
  outline: none;
}

textarea {
  resize: vertical;
}

input:focus,
textarea:focus {
  border-color: #2671d9;
  box-shadow: 0 0 0 3px rgba(38, 113, 217, 0.14);
}

.composer-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.composer-actions p {
  margin-bottom: 0;
  color: #667085;
  font-size: 0.9rem;
}

.composer-actions button,
.task-actions button {
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 9px 12px;
  color: #ffffff;
  background: #2671d9;
  font-weight: 800;
}

.board {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.column {
  min-width: 0;
  border: 1px solid #d9e1e7;
  border-radius: 8px;
  background: #eef3f6;
}

.column-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 16px;
  border-bottom: 1px solid #d9e1e7;
}

.column-header h2 {
  margin-bottom: 2px;
  font-size: 1.05rem;
}

.column-header p {
  margin-bottom: 0;
  color: #667085;
  font-size: 0.86rem;
}

.column-header strong {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  color: #1c4b38;
  background: #d6f4df;
}

.task-list {
  display: grid;
  gap: 12px;
  padding: 12px;
}

.task-card {
  display: grid;
  gap: 14px;
  min-height: 144px;
  padding: 14px;
  border: 1px solid #d7dee5;
  border-radius: 8px;
  background: #ffffff;
}

.task-card h3 {
  margin-bottom: 6px;
  color: #1d2433;
  font-size: 1rem;
  line-height: 1.35;
}

.task-card p {
  margin-bottom: 10px;
  color: #5c6675;
  line-height: 1.55;
}

time {
  color: #8a4b18;
  font-size: 0.85rem;
  font-weight: 700;
}

.task-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-self: end;
}

.task-actions button {
  min-height: 36px;
  padding: 7px 10px;
  color: #344054;
  background: #f3f6f8;
  border-color: #d9e1e7;
}

.task-actions button.active {
  color: #ffffff;
  background: #1c4b38;
  border-color: #1c4b38;
}

.task-actions button.danger {
  color: #9f1f1f;
  background: #fff1f1;
  border-color: #ffd2d2;
}

.empty-state {
  margin: 0;
  padding: 22px 12px;
  border: 1px dashed #c5d0d8;
  border-radius: 8px;
  color: #667085;
  text-align: center;
}

@media (max-width: 920px) {
  .app-shell {
    padding: 22px;
  }

  .topbar,
  .composer-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .metrics,
  .board,
  .input-grid {
    grid-template-columns: 1fr;
  }
}
</style>
