import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const testDir = mkdtempSync(join(tmpdir(), "codex-proxy-test-"));
const thinkingLog = join(testDir, "thinking.log");
const rawEventLog = join(testDir, "events.ndjson");
const requestLog = join(testDir, "requests.ndjson");
const apiJsonLog = join(testDir, "api-json.ndjson");

process.env.CODEX_PROXY_THINKING_LOG_FILE = thinkingLog;
process.env.CODEX_PROXY_RAW_EVENT_LOG_FILE = rawEventLog;
process.env.CODEX_PROXY_REQUEST_LOG_FILE = requestLog;
process.env.CODEX_PROXY_API_JSON_LOG_FILE = apiJsonLog;

const { __test } = await import("./server");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonBody(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function decodeJsonBody(body: ArrayBuffer | Uint8Array | undefined): Record<string, any> {
  expect(body).toBeDefined();
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body!);
  return JSON.parse(decoder.decode(bytes));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  return chunks.map((chunk) => decoder.decode(chunk)).join("");
}

function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

beforeAll(() => {
  rmSync(thinkingLog, { force: true });
  rmSync(rawEventLog, { force: true });
  rmSync(requestLog, { force: true });
  rmSync(apiJsonLog, { force: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("request preparation", () => {
  test("normalizes Responses API JSON for the ChatGPT Codex backend", () => {
    const body = jsonBody({
      model: "gpt-5.5",
      input: "hello",
      stream: true,
      session_id: "session-123",
      reasoning: { effort: "high", summary: "none" },
      include: ["reasoning.encrypted_content"],
    });
    const headers = new Headers({
      "content-type": "application/json",
      "accept": "text/event-stream",
    });

    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses?session_id=session-123", headers, body);
    const parsed = decodeJsonBody(prepared.body);

    expect(prepared.sessionId).toBe("session-123");
    expect(parsed.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
    expect(parsed.instructions).toBeString();
    expect(parsed.store).toBe(false);
    expect(parsed.reasoning).toEqual({ effort: "high", summary: "detailed" });
    expect(parsed.include).toEqual(["reasoning.encrypted_content"]);
    expect(parsed.session_id).toBeUndefined();
  });

  test("does not inject Responses-create fields into compact requests", () => {
    const body = jsonBody({
      model: "gpt-5.5",
      input: [{ role: "user", content: [{ type: "input_text", text: "compact" }] }],
      session_id: "session-compact",
    });
    const headers = new Headers({
      "content-type": "application/json",
    });

    const prepared = __test.prepareRequest("http://127.0.0.1:3462/v1/responses/compact", headers, body);
    const parsed = decodeJsonBody(prepared.body);

    expect(prepared.sessionId).toBe("session-compact");
    expect(parsed.session_id).toBeUndefined();
    expect(parsed.store).toBeUndefined();
    expect(parsed.instructions).toBeUndefined();
    expect(parsed.reasoning).toBeUndefined();
  });

  test("maps OpenAI-style paths onto the ChatGPT Codex backend path", () => {
    expect(__test.normalizeUpstreamPath("/v1/responses")).toBe("/backend-api/codex/responses");
    expect(__test.normalizeUpstreamPath("/responses")).toBe("/backend-api/codex/responses");
    expect(__test.normalizeUpstreamPath("/backend-api/codex/responses")).toBe("/backend-api/codex/responses");
    expect(__test.buildUpstreamUrl("http://127.0.0.1:3462/v1/responses?session_id=s&foo=bar", "s"))
      .toBe("https://chatgpt.com/backend-api/codex/responses?foo=bar");
  });

  test("strips decompressed response headers", () => {
    const headers = __test.stripResponseHeaders(new Headers({
      "content-encoding": "gzip",
      "content-length": "123",
      "content-type": "text/event-stream",
      "session_id": "session-456",
    }));

    expect(headers.has("content-encoding")).toBe(false);
    expect(headers.has("content-length")).toBe(false);
    expect(headers.get("content-type")).toBe("text/event-stream");
    expect(headers.get("x-codex-session-id")).toBe("session-456");
  });
});

describe("SSE interception", () => {
  test("passes SSE through while logging raw reasoning_text deltas when upstream emits them", async () => {
    rmSync(thinkingLog, { force: true });
    rmSync(rawEventLog, { force: true });
    rmSync(apiJsonLog, { force: true });
    const raw = [
      sse("response.created", { response: { model: "gpt-oss-120b", usage: { input_tokens: 5 } } }),
      sse("response.reasoning_text.delta", { item_id: "rs_1", output_index: 0, content_index: 0, delta: "raw " }),
      sse("response.reasoning_text.delta", { item_id: "rs_1", output_index: 0, content_index: 0, delta: "thought" }),
      sse("response.output_text.delta", { item_id: "msg_1", output_index: 1, content_index: 0, delta: "answer" }),
      sse("response.completed", { response: { model: "gpt-oss-120b", status: "completed", usage: { output_tokens: 8 } } }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });

    const relayed = await collect(__test.interceptStream(stream, "gpt-oss-120b"));
    const log = readFileSync(thinkingLog, "utf8");

    expect(relayed).toBe(raw);
    expect(log).toContain("[reasoning]\nraw thought");
    expect(log).toContain("[text]\nanswer");
    expect(log).toContain("done | out=8 | stop=completed");

    const rawEvents = readFileSync(rawEventLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rawEvents).toHaveLength(5);
    expect(rawEvents[1].type).toBe("response.reasoning_text.delta");

    const apiEvents = readFileSync(apiJsonLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(apiEvents).toHaveLength(5);
    expect(apiEvents[0].phase).toBe("response.sse_event");
    expect(apiEvents[1].requestId).toBe("-");
    expect(apiEvents[1].type).toBe("response.reasoning_text.delta");
  });

  test("logs reasoning summaries without duplicating done events after deltas", async () => {
    rmSync(thinkingLog, { force: true });
    const raw = [
      sse("response.reasoning_summary_text.delta", { item_id: "rs_2", output_index: 0, summary_index: 0, delta: "summary" }),
      sse("response.reasoning_summary_text.done", { item_id: "rs_2", output_index: 0, summary_index: 0, text: "summary" }),
      sse("response.completed", { response: { model: "gpt-5.5", status: "completed", usage: { output_tokens: 3 } } }),
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });

    await collect(__test.interceptStream(stream, "gpt-5.5"));
    const log = readFileSync(thinkingLog, "utf8");

    expect(log.match(/summary/g)?.length).toBe(1);
  });

  test("does not create a thinking log for streams with no captured text", async () => {
    rmSync(thinkingLog, { force: true });
    const raw = sse("response.completed", { response: { model: "gpt-5.5", status: "completed", usage: { output_tokens: 1 } } });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });

    await collect(__test.interceptStream(stream, "gpt-5.5"));

    expect(existsSync(thinkingLog)).toBe(false);
  });

  test("builds a categorized transcript from raw wire events", () => {
    const transcript = __test.buildTranscript([
      { at: "t1", requestId: "r1", event: { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "hi" } },
      { at: "t2", requestId: "r1", event: { type: "response.reasoning_summary_text.delta", item_id: "rs", output_index: 0, summary_index: 0, delta: "summary" } },
      { at: "t3", requestId: "r1", event: { type: "response.output_item.added", item: { id: "fc_1", type: "function_call", name: "lookup", call_id: "call_1", arguments: "" } } },
      { at: "t4", requestId: "r1", event: { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: "{\"q\"" } },
      { at: "t5", requestId: "r1", event: { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: ":\"x\"}" } },
      { at: "t6", requestId: "r1", event: { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: "{\"q\":\"x\"}" } },
      { at: "t7", requestId: "r1", event: { type: "response.output_item.done", item: { id: "fc_1", type: "function_call", name: "lookup", call_id: "call_1", status: "completed", arguments: "{\"q\":\"x\"}" } } },
      { at: "t8", requestId: "r1", event: { type: "response.output_item.added", item: { id: "ctc_1", type: "custom_tool_call", name: "apply_patch", call_id: "call_2", input: "" } } },
      { at: "t9", requestId: "r1", event: { type: "response.custom_tool_call_input.delta", item_id: "ctc_1", output_index: 2, delta: "*** Begin" } },
      { at: "t10", requestId: "r1", event: { type: "response.custom_tool_call_input.delta", item_id: "ctc_1", output_index: 2, delta: " Patch" } },
      { at: "t11", requestId: "r1", event: { type: "response.custom_tool_call_input.done", item_id: "ctc_1", output_index: 2, input: "*** Begin Patch" } },
      { at: "t12", requestId: "r2", event: { type: "response.output_text.delta", item_id: "msg2", output_index: 0, content_index: 0, delta: "bye" } },
      { at: "t13", requestId: "r2", event: { type: "response.completed", response: { status: "completed", model: "gpt-5.5", usage: { output_tokens: 1 }, output: [] } } },
    ]);

    expect(transcript.channels.commentary).toBe("hibye");
    expect(transcript.channels.analysis).toBe("summary");
    expect(transcript.assistantText).toBe("hibye");
    expect(transcript.reasoningText).toBe("summary");
    expect(transcript.toolEvents[0].item.name).toBe("lookup");
    expect(transcript.toolCalls[0].name).toBe("lookup");
    expect(transcript.toolCalls[0].arguments).toBe("{\"q\":\"x\"}");
    expect(transcript.toolCalls[1].name).toBe("apply_patch");
    expect(transcript.toolCalls[1].input).toBe("*** Begin Patch");
    expect(transcript.requests.map((request) => request.requestId)).toEqual(["r1", "r2"]);
    expect(transcript.requests[0].assistantText).toBe("hi");
    expect(transcript.requests[0].toolCalls).toHaveLength(2);
    expect(transcript.requests[1].assistantText).toBe("bye");
    expect(transcript.eventTypes["response.completed"]).toBe(1);
  });
});
