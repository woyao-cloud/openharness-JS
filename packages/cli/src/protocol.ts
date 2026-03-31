export type RequestEnvelope = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

export type ResultEnvelope = {
  id: string;
  event: "result";
  data?: Record<string, unknown>;
};

export type ErrorEnvelope = {
  id: string;
  event: "error";
  data: {
    code: string;
    message: string;
    [key: string]: unknown;
  };
};

export type StreamEnvelope = {
  id: string;
  event:
    | "session_start"
    | "text_delta"
    | "tool_call_start"
    | "tool_call_end"
    | "turn_complete";
  data?: Record<string, unknown>;
};

export type ResponseEnvelope = ResultEnvelope | ErrorEnvelope;
export type BridgeEnvelope = ResponseEnvelope | StreamEnvelope;
