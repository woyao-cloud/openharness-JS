import readline from "node:readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

let started = false;

rl.on("line", (line) => {
  const message = JSON.parse(line);

  if (!started) {
    started = true;

    if (message.method === "echo") {
      process.stdout.write(`${JSON.stringify({
        id: message.id,
        event: "result",
        data: { value: message.params?.value ?? null },
      })}\n`);
      rl.close();
      return;
    }

    if (message.method === "interactive") {
      process.stdout.write(`${JSON.stringify({
        id: message.id,
        event: "session_start",
        data: { session_id: "test-session", provider: "test", model: "mock", permission_mode: "ask" },
      })}\n`);
      process.stdout.write(`${JSON.stringify({
        id: message.id,
        event: "permission_request",
        data: { tool_name: "Write", description: "Write: demo.txt", arguments: { file_path: "demo.txt" } },
      })}\n`);
      return;
    }
  }

  if (message.method === "permission.response") {
    process.stdout.write(`${JSON.stringify({
      id: "interactive-1",
      event: "turn_complete",
      data: { reason: message.params?.allow ? "approved" : "denied", session_id: "test-session" },
    })}\n`);
    rl.close();
  }
});

rl.on("close", () => {
  process.exit(0);
});
