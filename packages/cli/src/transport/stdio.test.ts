import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { sendBridgeRequest, streamBridgeRequest } from "./stdio.js";

const mockBridgePath = path.resolve("src/transport/mock-bridge.test-helper.mjs");

test("sendBridgeRequest parses a result envelope", async () => {
  const response = await sendBridgeRequest(
    {
      id: "echo-1",
      method: "echo",
      params: { value: "hello" },
    },
    {
      command: "node",
      args: [mockBridgePath],
    },
  );

  assert.equal(response.event, "result");
  assert.equal(response.data?.value, "hello");
});

test("streamBridgeRequest supports interactive follow-up messages", async () => {
  const events: string[] = [];

  await streamBridgeRequest(
    {
      id: "interactive-1",
      method: "interactive",
    },
    async (event) => {
      events.push(event.event);
      if (event.event === "permission_request") {
        return {
          method: "permission.response",
          params: {
            allow: true,
          },
        };
      }
      return undefined;
    },
    {
      command: "node",
      args: [mockBridgePath],
    },
  );

  assert.deepEqual(events, ["session_start", "permission_request", "turn_complete"]);
});
