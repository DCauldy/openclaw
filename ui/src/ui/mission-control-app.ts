import { LitElement, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ref, createRef } from "lit/directives/ref.js";
import type { GatewayHelloOk } from "./gateway";
import { GatewayBrowserClient } from "./gateway";
import { loadSettings } from "./storage";
import type {
  AgentsListResult,
  BoardTask,
  GatewaySessionRow,
  SessionsListResult,
  TaskPriority,
  TaskStatus,
} from "./types";
import { formatAgo, formatDurationMs } from "./format";
import { extractText } from "./chat/message-extract";
import { generateUUID } from "./uuid";
import { DIRECTORS } from "./controllers/board";

// ---- module-level form state (uncontrolled inputs) ----
let newTaskVisible = false;
let newTaskPriority: TaskPriority = "medium";
let newTaskAgentId = "";

// ---- dispatch helpers ----
function buildDispatchMessage(task: { title: string; description?: string; tags?: string[] }): string {
  let msg = `**Task: ${task.title}**`;
  if (task.description) msg += `\n\n${task.description}`;
  if (task.tags?.length) msg += `\n\nTags: ${task.tags.join(", ")}`;
  return msg;
}

// ---- director status helpers ----
type DirectorStatus = "active" | "idle" | "offline";
const ACTIVE_MS = 30 * 60 * 1000;
const IDLE_MS = 24 * 60 * 60 * 1000;

function directorStatus(agentId: string, sessions: GatewaySessionRow[]): DirectorStatus {
  const matches = sessions.filter((s) => s.key.startsWith(`agent:${agentId}:`));
  if (matches.length === 0) return "offline";
  const mostRecent = Math.max(...matches.map((s) => s.updatedAt ?? 0));
  if (mostRecent === 0) return "offline";
  const age = Date.now() - mostRecent;
  if (age < ACTIVE_MS) return "active";
  if (age < IDLE_MS) return "idle";
  return "offline";
}

function directorLastActivity(agentId: string, sessions: GatewaySessionRow[]): string | null {
  const matches = sessions.filter((s) => s.key.startsWith(`agent:${agentId}:`));
  if (matches.length === 0) return null;
  const best = matches.reduce((a, b) => ((a.updatedAt ?? 0) > (b.updatedAt ?? 0) ? a : b));
  return best.updatedAt ? formatAgo(best.updatedAt) : null;
}

function directorTokens(agentId: string, sessions: GatewaySessionRow[]): number | null {
  const matches = sessions.filter((s) => s.key.startsWith(`agent:${agentId}:`));
  const total = matches.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0);
  return total > 0 ? total : null;
}

function dotClass(s: DirectorStatus) {
  if (s === "active") return "director-dot director-dot--active";
  if (s === "idle") return "director-dot director-dot--idle";
  return "director-dot director-dot--offline";
}

function pillClass(s: DirectorStatus) {
  if (s === "active") return "pill ok";
  if (s === "idle") return "pill warn";
  return "pill";
}

function statusLabel(s: DirectorStatus) {
  if (s === "active") return "ACTIVE";
  if (s === "idle") return "IDLE";
  return "OFFLINE";
}

// ---- kanban helpers ----
const KANBAN_COLUMNS: { status: TaskStatus; label: string; color: string }[] = [
  { status: "backlog", label: "Backlog", color: "#6b7280" },
  { status: "active", label: "Active", color: "#22d3a5" },
  { status: "review", label: "Review", color: "#f59e0b" },
  { status: "done", label: "Done", color: "#8b5cf6" },
];
const STATUS_ORDER: TaskStatus[] = ["backlog", "active", "review", "done"];

function prevStatus(s: TaskStatus): TaskStatus | null {
  const i = STATUS_ORDER.indexOf(s);
  return i > 0 ? STATUS_ORDER[i - 1] : null;
}

function nextStatus(s: TaskStatus): TaskStatus | null {
  const i = STATUS_ORDER.indexOf(s);
  return i < STATUS_ORDER.length - 1 ? STATUS_ORDER[i + 1] : null;
}

function priorityBorderColor(p: TaskPriority): string {
  if (p === "high") return "#ef4444";
  if (p === "medium") return "#f59e0b";
  return "#374151";
}

function emojiForAgent(agentId: string | undefined): string {
  if (!agentId) return "●";
  return DIRECTORS.find((d) => d.id === agentId)?.emoji ?? "●";
}

function formatCost(cost: number | null): string {
  if (cost === null) return "n/a";
  if (cost === 0) return "$0.00";
  if (cost < 0.0001) return "<$0.0001";
  return `$${cost.toFixed(4)}`;
}

@customElement("mission-control-app")
export class MissionControlApp extends LitElement {
  // no shadow DOM — inherit global styles
  override createRenderRoot() {
    return this;
  }

  @state() private connected = false;
  @state() private hello: GatewayHelloOk | null = null;
  @state() private agentsList: AgentsListResult | null = null;
  @state() private sessionsResult: SessionsListResult | null = null;
  @state() private boardTasks: BoardTask[] | null = null;
  @state() private boardTasksLoading = false;
  @state() private costToday: number | null = null;
  @state() private lastError: string | null = null;
  @state() private loading = true;
  @state() private dispatchingTaskIds = new Set<string>();
  @state() private dispatchedTaskIds = new Set<string>();

  // ---- embedded chat ----
  @state() private selectedDirectorId: string | null = null;
  @state() private directorMessages: unknown[] = [];
  @state() private directorChatLoading = false;
  @state() private directorChatSending = false;
  @state() private directorChatDraft = "";
  @state() private directorChatError: string | null = null;

  private chatScrollRef = createRef<HTMLDivElement>();

  private client: GatewayBrowserClient | null = null;

  override connectedCallback() {
    super.connectedCallback();
    const settings = loadSettings();
    this.client = new GatewayBrowserClient({
      url: settings.gatewayUrl,
      token: settings.token || undefined,
      clientName: "openclaw-control-ui",
      mode: "webchat",
      onHello: (hello) => {
        this.hello = hello;
        this.connected = true;
        this.lastError = null;
        void this.loadAll();
      },
      onClose: (info) => {
        this.connected = false;
        if (info.code !== 1000 && info.code !== 4008) {
          this.lastError = `Disconnected (${info.code})`;
        }
      },
    });
    this.client.start();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.client?.stop();
    this.client = null;
  }

  private async loadAll() {
    this.loading = true;
    try {
      await Promise.all([this.loadAgents(), this.loadSessions(), this.loadTasks(), this.loadCost()]);
    } finally {
      this.loading = false;
    }
  }

  private async loadAgents() {
    if (!this.client) return;
    try {
      const res = await this.client.request<AgentsListResult>("agents.list", {});
      if (res) this.agentsList = res;
    } catch {
      // keep existing
    }
  }

  private async loadSessions() {
    if (!this.client) return;
    try {
      const res = await this.client.request<SessionsListResult>("sessions.list", {
        includeGlobal: false,
        includeUnknown: false,
      });
      if (res) this.sessionsResult = res;
    } catch {
      // keep existing
    }
  }

  private async loadTasks() {
    if (!this.client) return;
    this.boardTasksLoading = true;
    try {
      const res = await this.client.request<{ tasks: BoardTask[] }>("tasks.list", {});
      this.boardTasks = res?.tasks ?? [];
    } catch {
      // keep existing
    } finally {
      this.boardTasksLoading = false;
    }
  }

  private async loadCost() {
    if (!this.client) return;
    try {
      const res = await this.client.request<{ totals?: { totalCost?: number } }>("usage.cost", {
        days: 1,
      });
      this.costToday = res?.totals?.totalCost ?? null;
    } catch {
      // keep existing
    }
  }

  private async taskCreate(params: {
    title: string;
    status?: TaskStatus;
    assignedAgentId?: string;
    priority?: TaskPriority;
  }) {
    if (!this.client) return;
    try {
      const task = await this.client.request<BoardTask>("tasks.create", params);
      if (task) {
        this.boardTasks = [...(this.boardTasks ?? []), task];
      }
    } catch (err) {
      this.lastError = String(err);
    }
  }

  private async taskUpdate(id: string, patch: Partial<Omit<BoardTask, "id" | "createdAt">>) {
    if (!this.client) return;
    try {
      const updated = await this.client.request<BoardTask>("tasks.update", { id, ...patch });
      if (updated && this.boardTasks) {
        this.boardTasks = this.boardTasks.map((t) => (t.id === id ? updated : t));
      }
    } catch (err) {
      this.lastError = String(err);
    }
  }

  private async taskDelete(id: string) {
    if (!this.client) return;
    try {
      await this.client.request("tasks.delete", { id });
      if (this.boardTasks) {
        this.boardTasks = this.boardTasks.filter((t) => t.id !== id);
      }
    } catch (err) {
      this.lastError = String(err);
    }
  }

  private async taskDispatch(task: BoardTask) {
    if (!this.client || !task.assignedAgentId) return;
    const sessionKey = `agent:${task.assignedAgentId}:main`;
    const message = buildDispatchMessage(task);
    const idempotencyKey = `dispatch-${task.id}-${Date.now()}`;
    this.dispatchingTaskIds = new Set([...this.dispatchingTaskIds, task.id]);
    try {
      await this.client.request("chat.send", {
        sessionKey,
        message,
        idempotencyKey,
        deliver: true,
      });
      // Move task to active if it's in backlog
      if (task.status === "backlog") {
        await this.taskUpdate(task.id, { status: "active" });
      }
      this.dispatchedTaskIds = new Set([...this.dispatchedTaskIds, task.id]);
      // Clear "dispatched" indicator after 3s
      setTimeout(() => {
        this.dispatchedTaskIds = new Set([...this.dispatchedTaskIds].filter((id) => id !== task.id));
      }, 3000);
    } catch (err) {
      this.lastError = `Dispatch failed: ${String(err)}`;
    } finally {
      this.dispatchingTaskIds = new Set([...this.dispatchingTaskIds].filter((id) => id !== task.id));
    }
  }

  private async initDirectors() {
    if (!this.client) return;
    try {
      const snapshot = await this.client.request<{
        hash?: string | null;
        config?: Record<string, unknown> | null;
      }>("config.get", {});
      const agentsConfig = (snapshot?.config as Record<string, unknown> | null | undefined)
        ?.agents as { list?: Array<{ id: string }> } | undefined;
      const existingIds = new Set((agentsConfig?.list ?? []).map((a) => a.id));
      const missing = DIRECTORS.filter((d) => !existingIds.has(d.id));
      if (missing.length === 0) return;
      const merged = [
        ...(agentsConfig?.list ?? []),
        ...missing.map((d) => ({ id: d.id, name: d.name, identity: { name: d.name, emoji: d.emoji } })),
      ];
      await this.client.request("config.patch", {
        baseHash: snapshot?.hash ?? null,
        raw: JSON.stringify({ agents: { list: merged } }),
      });
      await this.loadAgents();
    } catch (err) {
      this.lastError = `Failed to initialize directors: ${String(err)}`;
    }
  }

  // ---- embedded chat ----

  private async selectDirector(id: string) {
    if (this.selectedDirectorId === id) {
      // Deselect on second click
      this.selectedDirectorId = null;
      this.directorMessages = [];
      return;
    }
    this.selectedDirectorId = id;
    this.directorMessages = [];
    this.directorChatDraft = "";
    this.directorChatError = null;
    await this.loadDirectorHistory(id);
  }

  private async loadDirectorHistory(id: string) {
    if (!this.client) return;
    this.directorChatLoading = true;
    try {
      const res = await this.client.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey: `agent:${id}:main`,
        limit: 100,
      });
      this.directorMessages = Array.isArray(res?.messages) ? res.messages : [];
      this.scrollChatToBottom();
    } catch (err) {
      this.directorChatError = String(err);
    } finally {
      this.directorChatLoading = false;
    }
  }

  private scrollChatToBottom() {
    // Schedule after render
    void Promise.resolve().then(() => {
      const el = this.chatScrollRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  private async sendDirectorMessage() {
    const id = this.selectedDirectorId;
    if (!id || !this.client || !this.directorChatDraft.trim()) return;
    const message = this.directorChatDraft.trim();
    this.directorChatDraft = "";
    // Optimistically add user message
    this.directorMessages = [
      ...this.directorMessages,
      { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() },
    ];
    this.scrollChatToBottom();
    this.directorChatSending = true;
    this.directorChatError = null;
    try {
      await this.client.request("chat.send", {
        sessionKey: `agent:${id}:main`,
        message,
        idempotencyKey: generateUUID(),
        deliver: true,
      });
      // Reload history to get the assistant response
      await this.loadDirectorHistory(id);
    } catch (err) {
      this.directorChatError = `Send failed: ${String(err)}`;
    } finally {
      this.directorChatSending = false;
    }
  }

  // ---- rendering ----

  private renderKpiRow() {
    const snapshot = this.hello?.snapshot as { uptimeMs?: number } | undefined;
    const uptime = snapshot?.uptimeMs ? formatDurationMs(snapshot.uptimeMs) : "n/a";
    const sessionsCount = this.sessionsResult?.count ?? null;

    return html`
      <section class="kpi-row">
        <div class="kpi-card kpi-card--dramatic card">
          <div class="kpi-card__glow ${this.connected ? "kpi-card__glow--ok" : "kpi-card__glow--danger"}"></div>
          <div class="stat-label">Gateway</div>
          <div class="stat-value ${this.connected ? "ok" : "danger"}">
            ${this.connected ? "● Online" : "● Offline"}
          </div>
          <div class="muted" style="margin-top: 4px; font-size: 12px;">
            ${this.connected ? "WebSocket connected" : "Disconnected"}
          </div>
        </div>
        <div class="kpi-card kpi-card--dramatic card">
          <div class="kpi-card__glow"></div>
          <div class="stat-label">Uptime</div>
          <div class="stat-value">${uptime}</div>
          <div class="muted" style="margin-top: 4px; font-size: 12px;">Since last restart</div>
        </div>
        <div class="kpi-card kpi-card--dramatic card">
          <div class="kpi-card__glow"></div>
          <div class="stat-label">Sessions</div>
          <div class="stat-value">${sessionsCount !== null ? sessionsCount : "—"}</div>
          <div class="muted" style="margin-top: 4px; font-size: 12px;">Active session keys</div>
        </div>
        <div class="kpi-card kpi-card--dramatic card">
          <div class="kpi-card__glow"></div>
          <div class="stat-label">Cost Today</div>
          <div class="stat-value">${formatCost(this.costToday)}</div>
          <div class="muted" style="margin-top: 4px; font-size: 12px;">AI usage (last 24h)</div>
        </div>
      </section>
    `;
  }

  private renderDirectors() {
    const sessions = this.sessionsResult?.sessions ?? [];
    const agentIds = new Set((this.agentsList?.agents ?? []).map((a) => a.id));
    const missingCount = DIRECTORS.filter((d) => !agentIds.has(d.id)).length;
    const selectedDir = this.selectedDirectorId
      ? DIRECTORS.find((d) => d.id === this.selectedDirectorId)
      : null;

    return html`
      <div class="card director-section ${this.selectedDirectorId ? "director-section--split" : ""}" style="margin-top: 18px;">
        <div class="director-section__left">
          <div class="card-header-row">
            <div>
              <div class="card-title">Board of Directors</div>
              <div class="card-sub">Click a director to chat.</div>
            </div>
            ${
              missingCount > 0
                ? html`<button
                    class="btn btn--sm primary"
                    @click=${() => void this.initDirectors()}
                  >Initialize (${missingCount} missing)</button>`
                : nothing
            }
          </div>
          <div class="director-grid">
            ${DIRECTORS.map((d) => {
              const present = agentIds.has(d.id);
              const status: DirectorStatus = present ? directorStatus(d.id, sessions) : "offline";
              const lastActive = present ? directorLastActivity(d.id, sessions) : null;
              const tokens = present ? directorTokens(d.id, sessions) : null;
              const isSelected = this.selectedDirectorId === d.id;
              return html`
                <div
                  class="director-card ${!present ? "director-card--missing" : ""} ${isSelected ? "director-card--selected" : ""}"
                  role="button"
                  tabindex="0"
                  @click=${() => void this.selectDirector(d.id)}
                  @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") void this.selectDirector(d.id); }}
                >
                  <div class="director-card__emoji">${d.emoji}</div>
                  <div class="director-card__info">
                    <div class="director-card__name">${d.name}</div>
                    <div class="director-card__status">
                      <span class="${dotClass(status)}"></span>
                      <span class="${pillClass(status)}" style="font-size: 10px; padding: 1px 6px;">${statusLabel(status)}</span>
                    </div>
                  </div>
                  <div class="director-card__meta">
                    ${lastActive ? html`<div class="muted" style="font-size: 10px;">Last: ${lastActive}</div>` : nothing}
                    ${tokens ? html`<div class="muted" style="font-size: 10px;">${tokens.toLocaleString()} tok</div>` : nothing}
                    ${!present ? html`<div class="muted" style="font-size: 10px; color: var(--danger);">Not configured</div>` : nothing}
                  </div>
                </div>
              `;
            })}
          </div>
        </div>

        ${selectedDir
          ? html`
              <div class="director-chat-panel">
                <div class="director-chat-panel__header">
                  <span class="director-chat-panel__emoji">${selectedDir.emoji}</span>
                  <div>
                    <div class="director-chat-panel__name">${selectedDir.name}</div>
                    <div class="muted" style="font-size: 10px;">agent:${selectedDir.id}:main</div>
                  </div>
                  <button
                    class="btn btn--sm"
                    @click=${() => void this.loadDirectorHistory(selectedDir.id)}
                    title="Refresh chat history"
                    style="margin-left: auto;"
                  >↻</button>
                  <button
                    class="director-chat-panel__close"
                    @click=${() => { this.selectedDirectorId = null; this.directorMessages = []; }}
                    title="Close"
                  >×</button>
                </div>

                <div class="director-chat-messages" ${ref(this.chatScrollRef)}>
                  ${this.directorChatLoading
                    ? html`<div class="director-chat-empty">Loading…</div>`
                    : this.directorMessages.length === 0
                      ? html`<div class="director-chat-empty">No messages yet. Say hello!</div>`
                      : this.renderChatMessages()}
                </div>

                ${this.directorChatError
                  ? html`<div class="director-chat-error">${this.directorChatError}</div>`
                  : nothing}

                <form
                  class="director-chat-input-row"
                  @submit=${(e: Event) => { e.preventDefault(); void this.sendDirectorMessage(); }}
                >
                  <textarea
                    class="director-chat-textarea"
                    placeholder="Message ${selectedDir.name}…"
                    .value=${this.directorChatDraft}
                    ?disabled=${this.directorChatSending}
                    rows="2"
                    @input=${(e: Event) => { this.directorChatDraft = (e.target as HTMLTextAreaElement).value; }}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void this.sendDirectorMessage();
                      }
                    }}
                  ></textarea>
                  <button
                    type="submit"
                    class="btn primary director-chat-send-btn"
                    ?disabled=${this.directorChatSending || !this.directorChatDraft.trim()}
                  >${this.directorChatSending ? "…" : "Send"}</button>
                </form>
              </div>
            `
          : nothing}
      </div>
    `;
  }

  private renderChatMessages() {
    // Filter to user+assistant only, skip tool messages
    const visible = (this.directorMessages as Array<{ role?: string }>).filter(
      (m) => m.role === "user" || m.role === "assistant",
    );
    return visible.map((msg) => {
      const role = (msg as { role?: string }).role ?? "";
      const text = extractText(msg) ?? "";
      if (!text) return nothing;
      return html`
        <div class="director-chat-msg director-chat-msg--${role}">
          <div class="director-chat-msg__bubble">${text}</div>
        </div>
      `;
    });
  }

  private renderKanban() {
    const tasks = this.boardTasks ?? [];

    const submitNewTask = (e: Event) => {
      e.preventDefault();
      const form = e.currentTarget as HTMLFormElement;
      const input = form.querySelector("input[name='title']") as HTMLInputElement;
      const title = input?.value?.trim() ?? "";
      if (!title) return;
      void this.taskCreate({
        title,
        status: "backlog",
        priority: newTaskPriority,
        assignedAgentId: newTaskAgentId || undefined,
      });
      newTaskVisible = false;
      newTaskPriority = "medium";
      newTaskAgentId = "";
      this.boardTasks = this.boardTasks ? [...this.boardTasks] : [];
    };

    return html`
      <div class="card" style="margin-top: 18px;">
        <div class="card-title">Task Board</div>
        <div class="card-sub">
          Track work across your AI directors.
          ${this.boardTasksLoading ? "Loading…" : ""}
        </div>
        <div class="kanban-board" style="margin-top: 14px;">
          ${KANBAN_COLUMNS.map((col) => {
            const colTasks = tasks.filter((t) => t.status === col.status);
            return html`
              <div class="kanban-col">
                <div class="kanban-col__header">
                  <span class="kanban-col__dot" style="background: ${col.color};"></span>
                  <span class="kanban-col__label">${col.label}</span>
                  <span class="kanban-col__count">${colTasks.length}</span>
                </div>
                ${col.status === "backlog"
                  ? html`
                      ${newTaskVisible
                        ? html`
                            <form class="kanban-new-task-form" @submit=${submitNewTask}>
                              <input
                                name="title"
                                class="kanban-new-task-form__input"
                                placeholder="Task title…"
                                autocomplete="off"
                                autofocus
                              />
                              <div class="kanban-new-task-form__row">
                                <select
                                  class="kanban-new-task-form__select"
                                  @change=${(e: Event) => {
                                    newTaskPriority = (e.target as HTMLSelectElement).value as TaskPriority;
                                  }}
                                >
                                  <option value="low">Low</option>
                                  <option value="medium" selected>Medium</option>
                                  <option value="high">High</option>
                                </select>
                                <select
                                  class="kanban-new-task-form__select"
                                  @change=${(e: Event) => {
                                    newTaskAgentId = (e.target as HTMLSelectElement).value;
                                  }}
                                >
                                  <option value="">No assignee</option>
                                  ${DIRECTORS.map(
                                    (d) =>
                                      html`<option value="${d.id}">${d.emoji} ${d.name}</option>`,
                                  )}
                                </select>
                              </div>
                              <div class="kanban-new-task-form__actions">
                                <button type="submit" class="btn btn--sm primary">Add</button>
                                <button
                                  type="button"
                                  class="btn btn--sm"
                                  @click=${() => {
                                    newTaskVisible = false;
                                    this.boardTasks = this.boardTasks ? [...this.boardTasks] : [];
                                  }}
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          `
                        : html`
                            <button
                              class="kanban-add-btn"
                              @click=${() => {
                                newTaskVisible = true;
                                this.boardTasks = this.boardTasks ? [...this.boardTasks] : [];
                              }}
                            >
                              + Add task
                            </button>
                          `}
                    `
                  : nothing}
                <div class="kanban-col__tasks">
                  ${colTasks.map((task) => {
                    const prev = prevStatus(task.status);
                    const next = nextStatus(task.status);
                    const isDispatching = this.dispatchingTaskIds.has(task.id);
                    const wasDispatched = this.dispatchedTaskIds.has(task.id);
                    return html`
                      <div
                        class="kanban-task"
                        style="border-left-color: ${priorityBorderColor(task.priority)};"
                      >
                        <div class="kanban-task__header">
                          <div class="kanban-task__title">${task.title}</div>
                          ${task.assignedAgentId
                            ? html`<div class="kanban-task__assignee" title="${DIRECTORS.find((d) => d.id === task.assignedAgentId)?.name ?? task.assignedAgentId}">${emojiForAgent(task.assignedAgentId)}</div>`
                            : nothing}
                        </div>
                        <div class="kanban-task__actions">
                          ${task.assignedAgentId && task.status !== "done"
                            ? html`<button
                                class="kanban-dispatch-btn ${wasDispatched ? "kanban-dispatch-btn--sent" : ""}"
                                title="Dispatch to ${DIRECTORS.find((d) => d.id === task.assignedAgentId)?.name ?? task.assignedAgentId}"
                                ?disabled=${isDispatching}
                                @click=${() => void this.taskDispatch(task)}
                              >${isDispatching ? "…" : wasDispatched ? "✓ Sent" : "▶ Run"}</button>`
                            : nothing}
                          ${prev
                            ? html`<button
                                class="kanban-move-btn"
                                title="Move to ${prev}"
                                @click=${() => void this.taskUpdate(task.id, { status: prev })}
                              >←</button>`
                            : nothing}
                          ${next
                            ? html`<button
                                class="kanban-move-btn"
                                title="Move to ${next}"
                                @click=${() => void this.taskUpdate(task.id, { status: next })}
                              >→</button>`
                            : nothing}
                          <button
                            class="kanban-delete-btn"
                            title="Delete task"
                            @click=${() => void this.taskDelete(task.id)}
                          >×</button>
                        </div>
                      </div>
                    `;
                  })}
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }

  override render() {
    return html`
      <div class="mc-standalone">
        <header class="mc-standalone__header">
          <div class="mc-standalone__brand">
            <span class="mc-standalone__title">Mission Control</span>
            <span class="mc-standalone__sub">Your AI board of directors and task command center.</span>
          </div>
          <div class="mc-standalone__nav">
            ${this.connected
              ? html`<span class="pill ok" style="font-size: 11px;">● Connected</span>`
              : html`<span class="pill danger" style="font-size: 11px;">● Disconnected</span>`}
            <button
              class="btn btn--sm"
              @click=${() => void this.loadAll()}
              title="Refresh data"
            >
              ↻ Refresh
            </button>
            <a href="./" class="btn btn--sm">← Gateway Dashboard</a>
          </div>
        </header>

        <div class="mc-standalone__body">
          ${this.lastError
            ? html`<div class="pill danger" style="margin: 0 0 12px 0;">${this.lastError}</div>`
            : nothing}
          ${!this.connected && this.loading
            ? html`<div class="muted" style="padding: 32px 0; text-align: center;">Connecting to gateway…</div>`
            : html`
                ${this.renderKpiRow()}
                ${this.renderDirectors()}
                ${this.renderKanban()}
              `}
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mission-control-app": MissionControlApp;
  }
}
