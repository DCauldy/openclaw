import type { GatewayBrowserClient } from "../gateway";
import type { N8nFailureSummary } from "../types";

export type DashboardState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  basePath: string;
  dashboardCostToday: number | null;
  dashboardN8nFailures: N8nFailureSummary | null;
  dashboardLastRefresh: number | null;
};

export async function loadDashboardData(state: DashboardState) {
  if (!state.client || !state.connected) return;

  // Fetch today's AI cost via usage.cost with days=1
  try {
    const cost = await state.client.request<{
      totals?: { totalCost?: number };
    }>("usage.cost", { days: 1 });
    state.dashboardCostToday = cost?.totals?.totalCost ?? null;
  } catch {
    // keep existing value on error
  }

  // Fetch n8n failures from the gateway Airtable proxy endpoint
  try {
    const url = state.basePath
      ? `${state.basePath}/api/dashboard/n8n-failures`
      : `/api/dashboard/n8n-failures`;
    const res = await fetch(url);
    if (res.ok) {
      state.dashboardN8nFailures = (await res.json()) as N8nFailureSummary;
    }
  } catch {
    // keep existing value on error
  }

  state.dashboardLastRefresh = Date.now();
}
