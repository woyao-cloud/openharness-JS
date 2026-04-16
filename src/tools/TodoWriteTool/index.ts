import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { Tool, ToolResult } from "../../Tool.js";

const todoSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]).default("pending"),
  priority: z.enum(["high", "medium", "low"]).optional(),
});

const inputSchema = z.object({
  todos: z.array(todoSchema).describe("List of todo items to write. Existing items with matching IDs are updated."),
});

type TodoItem = {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "high" | "medium" | "low";
  createdAt?: number;
  updatedAt?: number;
};

export const TodoWriteTool: Tool<typeof inputSchema> = {
  name: "TodoWrite",
  description: "Write or update todo items. Creates new items or updates existing ones by ID.",
  inputSchema,
  riskLevel: "low",

  isReadOnly() {
    return false;
  },

  isConcurrencySafe() {
    return false;
  },

  async call(input, context): Promise<ToolResult> {
    const dir = path.join(context.workingDir, ".oh");
    const filePath = path.join(dir, "todos.json");

    try {
      await fs.mkdir(dir, { recursive: true });

      let existing: TodoItem[] = [];
      try {
        const content = await fs.readFile(filePath, "utf-8");
        existing = JSON.parse(content);
      } catch {
        // File doesn't exist yet
      }

      const existingMap = new Map(existing.map((t) => [t.id, t]));
      const now = Date.now();
      let created = 0;
      let updated = 0;

      for (const item of input.todos) {
        const prev = existingMap.get(item.id);
        if (prev) {
          existingMap.set(item.id, { ...prev, ...item, updatedAt: now });
          updated++;
        } else {
          existingMap.set(item.id, { ...item, createdAt: now, updatedAt: now });
          created++;
        }
      }

      const todos = [...existingMap.values()];
      await fs.writeFile(filePath, JSON.stringify(todos, null, 2), "utf-8");

      const parts: string[] = [];
      if (created > 0) parts.push(`${created} created`);
      if (updated > 0) parts.push(`${updated} updated`);
      const total = todos.filter((t) => t.status !== "completed").length;

      return {
        output: `Todos: ${parts.join(", ")}. ${total} remaining (${todos.length} total).`,
        isError: false,
      };
    } catch (err: any) {
      return { output: `Error writing todos: ${err.message}`, isError: true };
    }
  },

  prompt() {
    return `Write or update todo items in .oh/todos.json. Each item has:
- id (string, required): Unique identifier for the todo.
- content (string, required): Description of what needs to be done.
- status ("pending" | "in_progress" | "completed"): Current status. Default: "pending".
- priority ("high" | "medium" | "low", optional): Priority level.
Items with matching IDs are updated; new IDs create new items.`;
  },
};
