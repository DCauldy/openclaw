import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

export type TaskStatus = "backlog" | "active" | "review" | "done";
export type TaskPriority = "low" | "medium" | "high";

export type BoardTask = {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  assignedAgentId?: string;
  priority: TaskPriority;
  createdAt: number;
  updatedAt: number;
  tags?: string[];
};

const TASKS_FILE = path.join(os.homedir(), ".openclaw", "board-tasks.json");

let tasksCache: BoardTask[] | null = null;

function loadTasksFromDisk(): BoardTask[] {
  if (tasksCache !== null) return tasksCache;
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const raw = fs.readFileSync(TASKS_FILE, "utf-8");
      tasksCache = JSON.parse(raw) as BoardTask[];
    } else {
      tasksCache = [];
    }
  } catch {
    tasksCache = [];
  }
  return tasksCache;
}

function saveTasksToDisk(tasks: BoardTask[]): void {
  tasksCache = tasks;
  try {
    const dir = path.dirname(TASKS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), "utf-8");
  } catch {
    // best-effort persistence
  }
}

const VALID_STATUSES: TaskStatus[] = ["backlog", "active", "review", "done"];
const VALID_PRIORITIES: TaskPriority[] = ["low", "medium", "high"];

export const tasksHandlers: GatewayRequestHandlers = {
  "tasks.list": ({ respond }) => {
    const tasks = loadTasksFromDisk();
    respond(true, { tasks }, undefined);
  },

  "tasks.create": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (typeof p["title"] !== "string" || !String(p["title"]).trim()) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "title (string) required"));
      return;
    }
    const tasks = loadTasksFromDisk();
    const now = Date.now();
    const status = VALID_STATUSES.includes(p["status"] as TaskStatus)
      ? (p["status"] as TaskStatus)
      : "backlog";
    const priority = VALID_PRIORITIES.includes(p["priority"] as TaskPriority)
      ? (p["priority"] as TaskPriority)
      : "medium";
    const task: BoardTask = {
      id: randomUUID(),
      title: String(p["title"]).trim(),
      description: typeof p["description"] === "string" ? p["description"] : undefined,
      status,
      assignedAgentId: typeof p["assignedAgentId"] === "string" ? p["assignedAgentId"] : undefined,
      priority,
      createdAt: now,
      updatedAt: now,
      tags: Array.isArray(p["tags"]) ? (p["tags"] as string[]) : undefined,
    };
    tasks.push(task);
    saveTasksToDisk(tasks);
    respond(true, task, undefined);
  },

  "tasks.update": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (typeof p["id"] !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id (string) required"));
      return;
    }
    const tasks = loadTasksFromDisk();
    const idx = tasks.findIndex((t) => t.id === p["id"]);
    if (idx === -1) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${p["id"]}`),
      );
      return;
    }
    const existing = tasks[idx];
    const updated: BoardTask = { ...existing, updatedAt: Date.now() };
    if (typeof p["title"] === "string" && p["title"].trim()) {
      updated.title = p["title"].trim();
    }
    if (typeof p["description"] === "string") {
      updated.description = p["description"];
    }
    if (VALID_STATUSES.includes(p["status"] as TaskStatus)) {
      updated.status = p["status"] as TaskStatus;
    }
    if (typeof p["assignedAgentId"] === "string") {
      updated.assignedAgentId = p["assignedAgentId"] || undefined;
    }
    if (VALID_PRIORITIES.includes(p["priority"] as TaskPriority)) {
      updated.priority = p["priority"] as TaskPriority;
    }
    if (Array.isArray(p["tags"])) {
      updated.tags = p["tags"] as string[];
    }
    tasks[idx] = updated;
    saveTasksToDisk(tasks);
    respond(true, updated, undefined);
  },

  "tasks.delete": ({ params, respond }) => {
    const p = params as Record<string, unknown>;
    if (typeof p["id"] !== "string") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id (string) required"));
      return;
    }
    const tasks = loadTasksFromDisk();
    const idx = tasks.findIndex((t) => t.id === p["id"]);
    if (idx === -1) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${p["id"]}`),
      );
      return;
    }
    tasks.splice(idx, 1);
    saveTasksToDisk(tasks);
    respond(true, { ok: true }, undefined);
  },
};
