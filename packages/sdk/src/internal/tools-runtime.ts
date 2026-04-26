/**
 * Runtime glue for user-defined TypeScript tools (and, in v0.4, the
 * permission callback). Spins up the in-process MCP server, writes an
 * ephemeral `.oh/config.yaml` to a temp dir, and returns a handle the
 * caller passes as the spawned subprocess's `cwd`.
 *
 * Mirrors `python/openharness/_tools_runtime.py`. The temp dir is removed
 * on `close()`. Existing top-level config from `baseCwd/.oh/config.yaml`
 * is preserved except for `mcpServers` and `hooks` (which the SDK owns
 * for the lifetime of the runtime).
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { PermissionCallback } from "../permissions.js";
import type { ToolDefinition } from "../tools.js";
import { InProcessMcpServer } from "./mcp-server.js";
import { InProcessPermissionServer } from "./permission-server.js";

export interface ToolsRuntimeOptions {
  tools?: ToolDefinition[];
  canUseTool?: PermissionCallback;
  baseCwd?: string;
  serverName?: string;
}

export class ToolsRuntime {
  constructor(
    private readonly mcpServer: InProcessMcpServer | null,
    private readonly permissionServer: InProcessPermissionServer | null,
    private readonly tempDir: string,
  ) {}

  /** Working directory the spawned `oh` subprocess should run in. */
  get cwd(): string {
    return this.tempDir;
  }

  /** Stop any servers and remove the temp dir. Idempotent. */
  async close(): Promise<void> {
    if (this.mcpServer) {
      await this.mcpServer.close();
    }
    if (this.permissionServer) {
      await this.permissionServer.close();
    }
    await rm(this.tempDir, { recursive: true, force: true });
  }
}

function readBaseConfig(baseCwd: string | undefined): Record<string, unknown> {
  if (!baseCwd) return {};
  const src = path.join(baseCwd, ".oh", "config.yaml");
  if (!existsSync(src)) return {};
  try {
    const parsed = parse(readFileSync(src, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Treat unparseable user config as empty — we still write our own.
  }
  return {};
}

export async function prepareToolsRuntime(options: ToolsRuntimeOptions): Promise<ToolsRuntime> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "oh-ts-tools-"));
  let mcpServer: InProcessMcpServer | null = null;
  let permissionServer: InProcessPermissionServer | null = null;

  try {
    if (options.tools && options.tools.length > 0) {
      mcpServer = new InProcessMcpServer(options.tools, { name: options.serverName });
      await mcpServer.start();
    }
    if (options.canUseTool) {
      permissionServer = new InProcessPermissionServer(options.canUseTool);
      await permissionServer.start();
    }

    const base = readBaseConfig(options.baseCwd);
    // Drop SDK-owned blocks; preserve everything else (model, provider, permissionMode, …).
    const { mcpServers: _drop1, hooks: _drop2, ...preserved } = base;
    void _drop1;
    void _drop2;

    const merged: Record<string, unknown> = { ...preserved };
    if (mcpServer) {
      merged.mcpServers = [
        {
          name: mcpServer.name,
          type: "http",
          url: mcpServer.url,
        },
      ];
    }
    if (permissionServer) {
      merged.hooks = {
        permissionRequest: [{ http: permissionServer.url }],
      };
    }

    const ohDir = path.join(tempDir, ".oh");
    await mkdir(ohDir, { recursive: true });
    await writeFile(path.join(ohDir, "config.yaml"), stringify(merged), "utf8");
  } catch (err) {
    if (mcpServer) await mcpServer.close().catch(() => {});
    if (permissionServer) await permissionServer.close().catch(() => {});
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  return new ToolsRuntime(mcpServer, permissionServer, tempDir);
}
