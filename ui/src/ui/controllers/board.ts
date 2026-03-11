import type { GatewayBrowserClient } from "../gateway";
import type { BoardTask, TaskPriority, TaskStatus } from "../types";

export type BoardState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  boardTasks: BoardTask[] | null;
  boardTasksLoading: boolean;
  lastError: string | null;
};

const DIRECTORS = [
  { id: "ops", name: "Ops Director", emoji: "🔧" },
  { id: "research", name: "Research Director", emoji: "🔍" },
  { id: "sales", name: "Sales & CRM Director", emoji: "💼" },
  { id: "comms", name: "Comms Director", emoji: "📡" },
  { id: "health", name: "Health & Fitness Director", emoji: "💪" },
  { id: "finance", name: "Finance Director", emoji: "💰" },
  { id: "home", name: "Home Director", emoji: "🏠" },
  { id: "advisor", name: "Strategic Advisor", emoji: "🎯" },
] as const;

export { DIRECTORS };

export async function loadBoardTasks(state: BoardState): Promise<void> {
  if (!state.client || !state.connected) return;
  state.boardTasksLoading = true;
  try {
    const res = await state.client.request<{ tasks: BoardTask[] }>("tasks.list", {});
    state.boardTasks = res?.tasks ?? [];
  } catch {
    // keep existing value on error
  } finally {
    state.boardTasksLoading = false;
  }
}

export async function createBoardTask(
  state: BoardState,
  params: {
    title: string;
    description?: string;
    status?: TaskStatus;
    assignedAgentId?: string;
    priority?: TaskPriority;
    tags?: string[];
  },
): Promise<void> {
  if (!state.client || !state.connected) return;
  try {
    const task = await state.client.request<BoardTask>("tasks.create", params);
    if (task && state.boardTasks !== null) {
      state.boardTasks = [...state.boardTasks, task];
    } else if (task) {
      state.boardTasks = [task];
    }
  } catch (err) {
    state.lastError = String(err);
  }
}

export async function updateBoardTask(
  state: BoardState,
  id: string,
  patch: Partial<Omit<BoardTask, "id" | "createdAt">>,
): Promise<void> {
  if (!state.client || !state.connected) return;
  try {
    const updated = await state.client.request<BoardTask>("tasks.update", { id, ...patch });
    if (updated && state.boardTasks !== null) {
      state.boardTasks = state.boardTasks.map((t) => (t.id === id ? updated : t));
    }
  } catch (err) {
    state.lastError = String(err);
  }
}

export async function deleteBoardTask(state: BoardState, id: string): Promise<void> {
  if (!state.client || !state.connected) return;
  try {
    await state.client.request("tasks.delete", { id });
    if (state.boardTasks !== null) {
      state.boardTasks = state.boardTasks.filter((t) => t.id !== id);
    }
  } catch (err) {
    state.lastError = String(err);
  }
}

export async function initializeDirectors(state: BoardState): Promise<void> {
  if (!state.client || !state.connected) return;
  try {
    // Get current config snapshot (includes hash for optimistic locking)
    const snapshot = await state.client.request<{
      hash?: string | null;
      config?: Record<string, unknown> | null;
    }>("config.get", {});

    const currentList = (snapshot?.config as Record<string, unknown> | null | undefined)
      ?.agents as { list?: Array<{ id: string }> } | undefined;
    const existingIds = new Set((currentList?.list ?? []).map((a) => a.id));

    const missingDirectors = DIRECTORS.filter((d) => !existingIds.has(d.id));
    if (missingDirectors.length === 0) return;

    // Build the merged agent list: keep existing + add missing directors
    const existingAgents = currentList?.list ?? [];
    const newEntries = missingDirectors.map((d) => ({
      id: d.id,
      name: d.name,
      identity: { name: d.name, emoji: d.emoji },
    }));
    const mergedList = [...existingAgents, ...newEntries];

    const patch = { agents: { list: mergedList } };
    await state.client.request("config.patch", {
      baseHash: snapshot?.hash ?? null,
      raw: JSON.stringify(patch),
    });
  } catch (err) {
    state.lastError = `Failed to initialize directors: ${String(err)}`;
  }
}
