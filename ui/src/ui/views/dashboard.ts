import { html, nothing } from "lit";
import type { GatewayHelloOk } from "../gateway";
import type {
  ChannelAccountSnapshot,
  ChannelsStatusSnapshot,
  CronJob,
  CronStatus,
  N8nFailureSummary,
  PresenceEntry,
  SessionsListResult,
} from "../types";
import { formatAgo, formatDurationMs } from "../format";
import { formatCronSchedule } from "../presenter";

export type DashboardProps = {
  connected: boolean;
  hello: GatewayHelloOk | null;
  presenceEntries: PresenceEntry[];
  sessionsResult: SessionsListResult | null;
  channelsSnapshot: ChannelsStatusSnapshot | null;
  cronJobs: CronJob[];
  cronStatus: CronStatus | null;
  costToday: number | null;
  n8nFailures: N8nFailureSummary | null;
  lastRefresh: number | null;
  onRefresh: () => void;
};

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

function renderKpiRow(props: DashboardProps) {
  const snapshot = props.hello?.snapshot as { uptimeMs?: number } | undefined;
  const uptime = snapshot?.uptimeMs ? formatDurationMs(snapshot.uptimeMs) : "n/a";
  const sessionsCount = props.sessionsResult?.count ?? null;
  const instancesCount = props.presenceEntries.length;

  return html`
    <section class="kpi-row">
      <div class="kpi-card card">
        <div class="stat-label">Gateway</div>
        <div class="stat-value ${props.connected ? "ok" : "danger"}">
          ${props.connected ? "● Online" : "● Offline"}
        </div>
        <div class="muted" style="margin-top: 4px; font-size: 12px;">
          ${props.connected ? "WebSocket connected" : "Disconnected"}
        </div>
      </div>
      <div class="kpi-card card">
        <div class="stat-label">Uptime</div>
        <div class="stat-value">${uptime}</div>
        <div class="muted" style="margin-top: 4px; font-size: 12px;">Since last restart</div>
      </div>
      <div class="kpi-card card">
        <div class="stat-label">Sessions</div>
        <div class="stat-value">${sessionsCount !== null ? sessionsCount : "—"}</div>
        <div class="muted" style="margin-top: 4px; font-size: 12px;">Active session keys</div>
      </div>
      <div class="kpi-card card">
        <div class="stat-label">Instances</div>
        <div class="stat-value">${instancesCount}</div>
        <div class="muted" style="margin-top: 4px; font-size: 12px;">Presence beacons (5m)</div>
      </div>
      <div class="kpi-card card">
        <div class="stat-label">Cost Today</div>
        <div class="stat-value">${formatCost(props.costToday)}</div>
        <div class="muted" style="margin-top: 4px; font-size: 12px;">AI usage (last 24h)</div>
      </div>
    </section>
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
          const statusLabel = channelStatusLabel(primary);
          const lastActive = primary?.lastInboundAt ?? primary?.lastConnectedAt ?? null;

          return html`
            <div class="channel-card">
              <div class="channel-card__header">
                <span class="channel-card__name">${label}</span>
                <span class="pill pill--sm ${statusClass}">${statusLabel}</span>
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
