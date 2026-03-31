import { spawn } from "node:child_process";
import type { BridgeEnvelope, InputEnvelope, RequestEnvelope, ResponseEnvelope } from "../protocol.js";

type SpawnOptions = {
  command?: string;
  args?: string[];
};

const DEFAULT_COMMAND = "py";
const DEFAULT_ARGS = ["-3", "-m", "oh.bridge"];

function spawnBridge(options?: SpawnOptions) {
  return spawn(options?.command ?? DEFAULT_COMMAND, options?.args ?? DEFAULT_ARGS, {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export async function sendBridgeRequest(
  request: RequestEnvelope,
  options?: SpawnOptions,
): Promise<ResponseEnvelope> {
  const child = spawnBridge(options);

  let stdout = "";
  let stderr = "";

  child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `Bridge exited with code ${code}`));
    });
    child.on("error", reject);
  });

  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);

  if (!line) {
    throw new Error("Bridge returned no output.");
  }

  return JSON.parse(line) as ResponseEnvelope;
}

export async function streamBridgeRequest(
  request: RequestEnvelope,
  onEvent: (event: BridgeEnvelope) => void | InputEnvelope | Promise<void | InputEnvelope>,
  options?: SpawnOptions,
): Promise<void> {
  const child = spawnBridge(options);

  let stdout = "";
  let stderr = "";
  let processing = Promise.resolve();

  child.stdin.write(`${JSON.stringify(request)}\n`);

  const processLine = async (line: string): Promise<void> => {
    const event = JSON.parse(line) as BridgeEnvelope;
    const response = await onEvent(event);
    if (response) {
      child.stdin.write(`${JSON.stringify(response)}\n`);
    }
  };

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();

    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      processing = processing.then(() => processLine(trimmed));
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    child.on("exit", async (code) => {
      try {
        if (stdout.trim()) {
          await processLine(stdout.trim());
        }
        await processing;
      } catch (error) {
        reject(error);
        return;
      }

      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `Bridge exited with code ${code}`));
    });
    child.on("error", reject);
  });
}
