/**
 * ACP server entry point — `oh acp`.
 *
 * Loads the optional `@agentclientprotocol/sdk` package, wires stdin/stdout
 * via its ndJsonStream to the bridge in `agent.ts`, and runs until the
 * client disconnects.
 *
 * Dies cleanly with an install hint if the SDK isn't available — unlike
 * sandbox-runtime where missing-dep is a silent no-op, here the user
 * explicitly invoked `oh acp` so a clear error is the right UX.
 */

import { Readable, Writable } from "node:stream";
import { type AcpAgentConfig, createAcpAgent } from "./agent.js";

export async function runAcpServer(config: AcpAgentConfig): Promise<void> {
  let acp: typeof import("@agentclientprotocol/sdk");
  try {
    acp = await import("@agentclientprotocol/sdk");
  } catch (err) {
    process.stderr.write(
      "ACP server requires @agentclientprotocol/sdk. Install with:\n  npm install -g @agentclientprotocol/sdk\nor reinstall openHarness — the package ships as an optionalDependency.\n",
    );
    process.stderr.write(`Original error: ${(err as Error).message}\n`);
    process.exit(1);
  }

  // ACP wire framing: NDJSON over stdio. The SDK gives us a ready-made stream
  // adapter; we just hand it our process pipes.
  // ndJsonStream(input, output) — input is the AGENT's input (= stdin), output
  // is the AGENT's output (= stdout). Names are direction-from-the-stream's
  // perspective, which inverts the Node convention (stdin/stdout are named
  // from the process's perspective). That's why this looks backwards.
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);

  // The SDK constructs the connection and wires our handlers. We wrap our
  // bridge in a factory because the SDK passes the connection into it; we
  // need the connection to send sessionUpdate notifications back. The
  // returned object retains the wiring internally — we don't need to keep
  // a reference, but we still construct it so the side effects happen.
  void new acp.AgentSideConnection((conn) => createAcpAgent(conn, config), stream);

  // Block until stdin closes (client disconnected). Without this the process
  // would exit immediately after wiring.
  await new Promise<void>((resolve) => {
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
  });
}
