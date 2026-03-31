import { spawn } from "node:child_process";
import type { BridgeEnvelope, RequestEnvelope, ResponseEnvelope } from "../protocol.js";

export async function sendBridgeRequest(
  request: RequestEnvelope,
): Promise<ResponseEnvelope> {
  const child = spawn("py", ["-3", "-m", "oh.bridge"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

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
  onEvent: (event: BridgeEnvelope) => void,
): Promise<void> {
  const child = spawn("py", ["-3", "-m", "oh.bridge"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();

    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      onEvent(JSON.parse(trimmed) as BridgeEnvelope);
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => {
      if (stdout.trim()) {
        onEvent(JSON.parse(stdout.trim()) as BridgeEnvelope);
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
