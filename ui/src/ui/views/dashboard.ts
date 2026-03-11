import { html, nothing } from "lit";
import type { GatewayHelloOk } from "../gateway";
import type {
  AgentsListResult,
  BoardTask,
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  CronJob,
  CronStatus,
  GatewaySessionRow,
  N8nFailureSummary,
  PresenceEntry,
  SessionsListResult,
  TaskPriority,
  TaskStatus,
} from "../types";
import { formatAgo, formatDurationMs } from "../format";
import { formatCronSchedule } from "../presenter";
import { DIRECTORS } from "../controllers/board";

// Module-level form state (uncontrolled inputs — no re-render needed on keystrokes)
let boardNewTaskVisible = false;
let boardNewTaskPriority: TaskPriority = "medium";
let boardNewTaskAgentId = "";

export type DashboardProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  presenceEntries: PresenceEntry[];
  sessionsResult: SessionsListResult | null;
  agentsList: AgentsListResult | null;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  costToday: number | null;
  n8nFailures: N8nFailureSummary | null;
  lastRefresh: number | null;
  boardTasks: BoardTask[] | null;
  boardTasksLoading: boolean;
  onRefresh: () => void;
  onTaskCreate: (params: {
    title: string;
    status?: TaskStatus;
    assignedAgentId?: string;
    priority?: TaskPriority;
  }) => void;
  onTaskUpdate: (id: string, patch: Partial<Omit<BoardTask, "id" | "createdAt">>) => void;
  onTaskDelete: (id: string) => void;
  onInitDirectors: () => void;
  onBoardStateChange: () => void;
};

// ---- helpers ----

function formatCost(cost: number | null): string {
  if (cost === null) return "n/a";
  if (cost === 0) return "$0.00";
  if (cost < 0.0001) return `<$0.0001`;
  return `$${cost.toFixed(4)}`;
}

function channelStatusClass(account: ChannelAccountSnapshot | undefined): string {
  if (!account) return "warn";
  if (account.lastError) return "danger";
  if (account.linked === true || account.connected === true) return "ok";
  if (account.configured === true) return "warn";
  return "warn";
}

function channelStatusLabel(account: ChannelAccountSnapshot | undefined): string {
  if (!account) return "Not configured";
  if (account.lastError) return "Error";
  if (account.linked === true) return "Linked";
  if (account.connected === true) return "Connected";
  if (account.configured === true) return "Configured";
  return "Not configured";
}

function resolutionClass(resolution: string): string {
  switch (resolution) {
    case "auto-fixed":
    case "retried-success":
    case "auto-retried":
    case "manual-fix":
      return "ok";
    case "pending":
    case "escalated":
      return "warn";
    case "retried-failed":
      return "danger";
    default:
      return "";
  }
}

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
  const mostRecent = matches.reduce((best, s) =>
    (s.updatedAt ?? 0) > (best.updatedAt ?? 0) ? s : best,
  );
  if (!mostRecent.updatedAt) return null;
  return formatAgo(mostRecent.updatedAt);
}

function directorTokens(agentId: string, sessions: GatewaySessionRow[]): number | null {
  const matches = sessions.filter((s) => s.key.startsWith(`agent:${agentId}:`));
  if (matches.length === 0) return null;
  const total = matches.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0);
  return total > 0 ? total : null;
}

function statusDotClass(status: DirectorStatus): string {
  if (status === "active") return "director-dot director-dot--active";
  if (status === "idle") return "director-dot director-dot--idle";
  return "director-dot director-dot--offline";
}

function statusLabel(status: DirectorStatus): string {
  if (status === "active") return "ACTIVE";
  if (status === "idle") return "IDLE";
  return "OFFLINE";
}

function statusPillClass(status: DirectorStatus): string {
  if (status === "active") return "pill ok";
  if (status === "idle") return "pill warn";
  return "pill";
}

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

function priorityBorderColor(priority: TaskPriority): string {
  if (priority === "high") return "#ef4444";
  if (priority === "medium") return "#f59e0b";
  return "#374151";
}

function emojiForAgent(agentId: string | undefined): string {
  if (!agentId) return "●";
  const d = DIRECTORS.find((x) => x.id === agentId);
  return d?.emoji ?? "●";
}

// ---- render sections ----

function renderKpiRow(props: DashboardProps) {
  const snapshot = props.hello?.snapshot as { uptimeMs?: number } | undefined;
  const uptime = snapshot?.uptimeMs ? formatDurationMs(snapshot.uptimeMs) : "n/a";
  const sessionsCount = props.sessionsResult?.count ?? null;
  const instancesCount = props.presenceEntries.length;

  return html`
    <section class="kpi-row">
      <div class="kpi-card kpi-card--dramatic card">
        <div class="kpi-card__glow ${props.connected ? "kpi-card__glow--ok" : "kpi-card__glow--danger"}"></div>
        <div class="stat-label">Gateway</div>
        <div class="stat-value ${props.connected ? "ok" : "danger"}">
          ${props.connected ? "● Online" : "● Offline"}
        </div>
        <div class="muted" style="margin-top: 4px; font-size: 12px;">
          ${props.connected ? "WebSocket connected" : "Disconnected"}
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
        <div class="stat-label">Instances</div>
        <div class="stat-value">${instancesCount}</div>
        <div class="muted" style="margin-top: 4px; font-size: 12px;">Presence beacons (5m)</div>
      </div>
      <div class="kpi-card kpi-card--dramatic card">
        <div class="kpi-card__glow"></div>
        <div class="stat-label">Cost Today</div>
        <div class="stat-value">${formatCost(props.costToday)}</div>
        <div class="muted" style="margin-top: 4px; font-size: 12px;">AI usage (last 24h)</div>
      </div>
    </section>
  `;
}

function renderBoardOfDirectors(props: DashboardProps) {
  const sessions = props.sessionsResult?.sessions ?? [];
  const agentIds = new Set((props.agentsList?.agents ?? []).map((a) => a.id));
  const missingCount = DIRECTORS.filter((d) => !agentIds.has(d.id)).length;

  return html`
    <div class="card" style="margin-top: 18px;">
      <div class="card-header-row">
        <div>
          <div class="card-title">Board of Directors</div>
          <div class="card-sub">Your named AI agents and their current status.</div>
        </div>
        ${
          missingCount > 0
            ? html`
                <button
                  class="btn btn--sm primary"
                  @click=${() => props.onInitDirectors()}
                  title="Add ${missingCount} missing director agent${missingCount !== 1 ? "s" : ""} to config"
                >
                  Initialize Board (${missingCount} missing)
                </button>
              `
            : nothing
        }
      </div>
      <div class="director-grid">
        ${DIRECTORS.map((d) => {
          const present = agentIds.has(d.id);
          const status: DirectorStatus = present ? directorStatus(d.id, sessions) : "offline";
          const lastActive = present ? directorLastActivity(d.id, sessions) : null;
          const tokens = present ? directorTokens(d.id, sessions) : null;

          return html`
            <div class="director-card ${!present ? "director-card--missing" : ""}">
              <div class="director-card__emoji">${d.emoji}</div>
              <div class="director-card__info">
                <div class="director-card__name">${d.name}</div>
                <div class="director-card__status">
                  <span class="${statusDotClass(status)}"></span>
                  <span class="${statusPillClass(status)}" style="font-size: 10px; padding: 1px 6px;">${statusLabel(status)}</span>
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
  `;
}

function renderKanban(props: DashboardProps) {
  const tasks = props.boardTasks ?? [];

  const submitNewTask = (e: Event) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    const input = form.querySelector("input[name='title']") as HTMLInputElement;
    const title = input?.value?.trim() ?? "";
    if (!title) return;
    props.onTaskCreate({
      title,
      status: "backlog",
      priority: boardNewTaskPriority,
      assignedAgentId: boardNewTaskAgentId || undefined,
    });
    boardNewTaskVisible = false;
    boardNewTaskPriority = "medium";
    boardNewTaskAgentId = "";
    props.onBoardStateChange();
  };

  return html`
    <div class="card" style="margin-top: 18px;">
      <div class="card-title">Task Board</div>
      <div class="card-sub">Track work across your AI directors. ${props.boardTasksLoading ? "Loading…" : ""}</div>
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
              ${
                col.status === "backlog"
                  ? html`
                      ${
                        boardNewTaskVisible
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
                                      boardNewTaskPriority = (e.target as HTMLSelectElement)
                                        .value as TaskPriority;
                                    }}
                                  >
                                    <option value="low">Low</option>
                                    <option value="medium" selected>Medium</option>
                                    <option value="high">High</option>
                                  </select>
                                  <select
                                    class="kanban-new-task-form__select"
                                    @change=${(e: Event) => {
                                      boardNewTaskAgentId = (e.target as HTMLSelectElement).value;
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
                                      boardNewTaskVisible = false;
                                      props.onBoardStateChange();
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
                                  boardNewTaskVisible = true;
                                  props.onBoardStateChange();
                                }}
                              >
                                + Add task
                              </button>
                            `
                      }
                    `
                  : nothing
              }
              <div class="kanban-col__tasks">
                ${colTasks.map((task) => {
                  const prev = prevStatus(task.status);
                  const next = nextStatus(task.status);
                  return html`
                    <div
                      class="kanban-task"
                      style="border-left-color: ${priorityBorderColor(task.priority)};"
                    >
                      <div class="kanban-task__title">${task.title}</div>
                      ${
                        task.assignedAgentId
                          ? html`<div class="kanban-task__assignee">
                              ${emojiForAgent(task.assignedAgentId)}
                            </div>`
                          : nothing
                      }
                      <div class="kanban-task__actions">
                        ${
                          prev
                            ? html`<button
                                class="kanban-move-btn"
                                title="Move to ${prev}"
                                @click=${() => props.onTaskUpdate(task.id, { status: prev })}
                              >
                                ←
                              </button>`
                            : nothing
                        }
                        ${
                          next
                            ? html`<button
                                class="kanban-move-btn"
                                title="Move to ${next}"
                                @click=${() => props.onTaskUpdate(task.id, { status: next })}
                              >
                                →
                              </button>`
                            : nothing
                        }
                        <button
                          class="kanban-delete-btn"
                          title="Delete task"
                          @click=${() => props.onTaskDelete(task.id)}
                        >
                          ×
                        </button>
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

function renderChannelGrid(props: DashboardProps) {
  const snapshot = props.channelsSnapshot;
  if (!snapshot) {
    return html`
      <div class="card">
        <div class="card-title">Channels</div>
        <div class="card-sub">No channel data — connect to gateway to load.</div>
      </div>
    `;
  }

  const channelIds =
    snapshot.channelMeta?.length
      ? snapshot.channelMeta.map((m) => m.id)
      : snapshot.channelOrder;

  return html`
    <div class="card">
      <div class="card-title">Channels</div>
      <div class="card-sub">Status of configured messaging channels.</div>
      <div class="channel-grid" style="margin-top: 14px;">
        ${channelIds.map((id) => {
          const label = snapshot.channelLabels[id] ?? id;
          const accounts = snapshot.channelAccounts[id] ?? [];
          const primary = accounts[0];
          const statusClass = channelStatusClass(primary);
          const statusLabel2 = channelStatusLabel(primary);
          const lastActive = primary?.lastInboundAt ?? primary?.lastConnectedAt ?? null;

          return html`
            <div class="channel-card">
              <div class="channel-card__header">
                <span class="channel-card__name">${label}</span>
                <span class="pill pill--sm ${statusClass}">${statusLabel2}</span>
              </div>
              ${
                primary?.name
                  ? html`<div class="channel-card__id">${primary.name}</div>`
                  : nothing
              }
              ${
                lastActive
                  ? html`<div class="channel-card__age muted">Last: ${formatAgo(lastActive)}</div>`
                  : nothing
              }
              ${
                primary?.lastError
                  ? html`<div class="channel-card__error">${primary.lastError}</div>`
                  : nothing
              }
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function renderAgentFeed(props: DashboardProps) {
  const sessions = props.sessionsResult?.sessions?.slice(0, 8) ?? [];

  return html`
    <div class="card activity-feed">
      <div class="card-title">Recent Sessions</div>
      <div class="card-sub">Latest active session keys.</div>
      ${
        sessions.length === 0
          ? html`<div class="muted" style="margin-top: 12px; font-size: 13px;">
              No sessions — connect and run an agent task to see activity here.
            </div>`
          : html`
              <div class="activity-list" style="margin-top: 12px;">
                ${sessions.map((s) => {
                  const ago = s.updatedAt ? formatAgo(s.updatedAt) : "n/a";
                  const label = s.displayName ?? s.label ?? s.key;
                  const surface = s.surface ?? s.kind;
                  const tokens = s.totalTokens != null ? `${s.totalTokens} tok` : null;

                  return html`
                    <div class="activity-item">
                      <div class="activity-item__main">
                        <span class="activity-item__key mono">${label}</span>
                        ${surface ? html`<span class="pill pill--sm">${surface}</span>` : nothing}
                      </div>
                      <div class="activity-item__meta">
                        <span class="muted">${ago}</span>
                        ${tokens ? html`<span class="muted">${tokens}</span>` : nothing}
                      </div>
                    </div>
                  `;
                })}
              </div>
            `
      }
    </div>
  `;
}

function renderN8nWidget(props: DashboardProps) {
  const failures = props.n8nFailures;

  return html`
    <div class="card n8n-widget">
      <div class="card-title">n8n Failures</div>
      <div class="card-sub">Recent workflow failures tracked in Airtable.</div>
      ${
        failures === null
          ? html`<div class="muted" style="margin-top: 12px; font-size: 13px;">
              Loading… (requires AIRTABLE_API_KEY on gateway)
            </div>`
          : html`
              <div class="n8n-summary" style="margin-top: 12px; display: flex; gap: 16px;">
                <div class="stat-label">
                  Total: <strong>${failures.count}</strong>
                </div>
                <div class="stat-label">
                  Unresolved:
                  <strong class="${failures.unresolved > 0 ? "warn" : ""}"
                    >${failures.unresolved}</strong
                  >
                </div>
              </div>
              ${
                failures.recent.length === 0
                  ? html`<div class="muted" style="margin-top: 8px; font-size: 13px;">
                      No recent failures.
                    </div>`
                  : html`
                      <div class="n8n-list" style="margin-top: 10px;">
                        ${failures.recent.slice(0, 5).map(
                          (f) => html`
                            <div class="n8n-item">
                              <div class="n8n-item__header">
                                <span class="n8n-item__name">${f.name}</span>
                                <span class="pill pill--sm ${resolutionClass(f.resolution)}"
                                  >${f.resolution}</span
                                >
                              </div>
                              ${
                                f.rootCause
                                  ? html`<div class="n8n-item__cause muted">${f.rootCause}</div>`
                                  : nothing
                              }
                              <div class="n8n-item__time muted">
                                ${f.createdAt ? formatAgo(new Date(f.createdAt).getTime()) : "n/a"}
                              </div>
                            </div>
                          `,
                        )}
                      </div>
                    `
              }
            `
      }
    </div>
  `;
}

function renderCronSection(props: DashboardProps) {
  const jobs = props.cronJobs;
  const status = props.cronStatus;

  return html`
    <div class="card">
      <div class="card-title">Cron Jobs</div>
      <div class="card-sub">
        ${status ? html`${status.jobs} job${status.jobs !== 1 ? "s" : ""} · ${status.enabled ? "Scheduler enabled" : "Scheduler disabled"}` : "Scheduled tasks and their next run times."}
      </div>
      ${
        jobs.length === 0
          ? html`<div class="muted" style="margin-top: 12px; font-size: 13px;">
              No cron jobs configured. Visit the Cron tab to add one.
            </div>`
          : html`
              <div class="cron-list" style="margin-top: 12px;">
                ${jobs.map((job) => {
                  const nextMs = job.state?.nextRunAtMs ?? null;
                  const lastStatus = job.state?.lastStatus ?? null;
                  const schedule = formatCronSchedule(job);
                  const nextAgo = nextMs ? formatAgo(nextMs) : "n/a";

                  return html`
                    <div class="cron-item">
                      <div class="cron-item__header">
                        <span class="cron-item__name">${job.name}</span>
                        <div class="cron-item__badges">
                          ${job.enabled ? nothing : html`<span class="pill pill--sm warn">disabled</span>`}
                          ${
                            lastStatus
                              ? html`<span
                                  class="pill pill--sm ${lastStatus === "ok" ? "ok" : lastStatus === "error" ? "danger" : ""}"
                                  >${lastStatus}</span
                                >`
                              : nothing
                          }
                        </div>
                      </div>
                      <div class="cron-item__meta muted">
                        <span>${schedule}</span>
                        ${nextMs ? html`<span>· next ${nextAgo}</span>` : nothing}
                      </div>
                    </div>
                  `;
                })}
              </div>
            `
      }
    </div>
  `;
}

export function renderDashboard(props: DashboardProps) {
  return html`
    ${renderKpiRow(props)}
    ${renderBoardOfDirectors(props)}
    ${renderKanban(props)}

    <section style="margin-top: 18px;">${renderChannelGrid(props)}</section>

    <section class="dashboard-split" style="margin-top: 18px;">
      ${renderAgentFeed(props)} ${renderN8nWidget(props)}
    </section>

    <section style="margin-top: 18px;">${renderCronSection(props)}</section>

    <div class="row" style="margin-top: 16px; justify-content: flex-end; align-items: center; gap: 12px;">
      ${
        props.lastRefresh
          ? html`<span class="muted" style="font-size: 12px;"
              >Last refresh: ${formatAgo(props.lastRefresh)}</span
            >`
          : nothing
      }
      <button class="btn btn--sm" @click=${() => props.onRefresh()}>Refresh</button>
    </div>
  `;
}
