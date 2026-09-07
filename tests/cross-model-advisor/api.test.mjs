/**
 * API backend contracts: offline validation, sealed credentials, and a
 * real loopback Chat Completions transport. Imports the bundled module.
 */

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const apiModule = path.join(
  repoRoot,
  "plugins",
  "cross-model-advisor",
  "dist",
  "modules",
  "backends",
  "api.mjs"
);

const { validateApi, reviewApi, ApiBackendError } = await import(apiModule);

const KEY_ENV = "CMA_TEST_KEY";
const CONFIGURED_KEY = "configured-loopback-key";
const AMBIENT_KEY = "ambient-openai-secret-key";

function compatibleProvider(baseUrl, modelExtra = {}) {
  return {
    kind: "api",
    provider: "openai-compatible",
    apiKeyEnv: KEY_ENV,
    baseUrl,
    models: {
      "local-model": {
        contextWindow: 8192,
        maxTokens: 2048,
        reasoning: false,
        input: ["text"],
        ...modelExtra
      }
    }
  };
}

const advisor = {
  name: "correctness",
  provider: "local",
  model: "local-model",
  instructions: "Look for observable correctness failures."
};

function makeTools() {
  /** @type {null | { severity: string, note: string, evidence: unknown }} */
  let candidate = null;
  const calls = [];
  return {
    guidance: "Inspect with read, then advise once.",
    get candidate() {
      return candidate;
    },
    async isFresh() {
      return true;
    },
    async call(name, args) {
      calls.push({ name, args });
      if (name === "read") return "1:const unused = 1;\n";
      if (name === "advise") {
        candidate = { severity: args.severity, note: args.note, evidence: args.evidence };
        return "staged";
      }
      throw new Error(`unexpected tool ${name}`);
    },
    calls
  };
}

function chunk({ model = "local-model", toolCalls, text, finish, usage }) {
  const id = "chatcmpl-loopback";
  const created = 1;
  const chunks = [];
  if (toolCalls) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: null,
            tool_calls: toolCalls.map((tc, index) => ({
              index,
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: "" }
            }))
          },
          finish_reason: null
        }
      ]
    });
    for (const [index, tc] of toolCalls.entries()) {
      chunks.push({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index, function: { arguments: tc.arguments } }] },
            finish_reason: null
          }
        ]
      });
    }
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finish ?? "tool_calls" }]
    });
  } else {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text ?? "" },
          finish_reason: null
        }
      ]
    });
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finish ?? "stop" }]
    });
  }
  if (usage !== false) {
    chunks.push({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [],
      usage: usage ?? { prompt_tokens: 16, completion_tokens: 9, total_tokens: 25 }
    });
  }
  return chunks;
}

function writeSse(res, chunks) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache"
  });
  for (const item of chunks) {
    res.write(`data: ${JSON.stringify(item)}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function jsonError(res, status, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
}

async function startServer(onRequest) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const pieces = [];
    for await (const piece of req) pieces.push(piece);
    const raw = Buffer.concat(pieces).toString("utf8");
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = raw;
    }
    const record = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(record);
    try {
      await onRequest(record, res, requests);
    } catch (error) {
      if (!res.headersSent) jsonError(res, 500, error instanceof Error ? error.message : String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    requests,
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function lastToolName(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "tool" && typeof msg?.tool_call_id !== "string") continue;
    if (typeof msg.name === "string" && msg.name) return msg.name;
    const id = msg.tool_call_id;
    for (let j = i - 1; j >= 0; j--) {
      const prior = messages[j];
      if (prior?.role !== "assistant" || !Array.isArray(prior.tool_calls)) continue;
      const match = id
        ? prior.tool_calls.find((tc) => tc.id === id)
        : prior.tool_calls[0];
      const name = match?.function?.name ?? match?.name;
      if (name) return name;
    }
    return "tool";
  }
  return null;
}

function codeOf(error) {
  return error instanceof ApiBackendError || (error && typeof error === "object" && "code" in error)
    ? error.code
    : undefined;
}

const savedOpenAiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = AMBIENT_KEY;
after(() => {
  if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedOpenAiKey;
});

test("validateApi rejects unknown builtin models without a provider call", async () => {
  const result = await validateApi({
    provider: { kind: "api", provider: "openai", apiKeyEnv: KEY_ENV },
    advisor: { ...advisor, model: "not-a-real-openai-model" },
    env: { [KEY_ENV]: CONFIGURED_KEY }
  });
  assert.equal(result.available, false);
  assert.equal(result.error?.code, "config");
});

test("validateApi does not probe a closed compatible endpoint", async () => {
  const result = await validateApi({
    provider: compatibleProvider("http://127.0.0.1:1/v1"),
    advisor,
    env: { [KEY_ENV]: CONFIGURED_KEY }
  });
  assert.equal(result.available, true);
  assert.equal(result.error, undefined);
});

test("validateApi is unavailable when the configured key is missing", async () => {
  const result = await validateApi({
    provider: compatibleProvider("http://127.0.0.1:1/v1"),
    advisor,
    env: {}
  });
  assert.equal(result.available, false);
  assert.equal(result.error?.code, "unavailable");
});

test("validateApi accepts a catalog openai model offline", async () => {
  const result = await validateApi({
    provider: { kind: "api", provider: "openai", apiKeyEnv: KEY_ENV },
    advisor: { ...advisor, model: "gpt-4" },
    env: { [KEY_ENV]: CONFIGURED_KEY, OPENAI_API_KEY: AMBIENT_KEY }
  });
  assert.equal(result.available, true);
});

test("reviewApi read then advise over loopback Chat Completions", async (t) => {
  const harness = await startServer(async (record, res) => {
    assert.match(record.url ?? "", /\/chat\/completions$/);
    assert.equal(record.body?.stream, true);
    const tool = lastToolName(record.body);
    if (!tool) {
      writeSse(
        res,
        chunk({
          toolCalls: [
            { id: "call_read", name: "read", arguments: JSON.stringify({ path: "src/app.mjs" }) }
          ]
        })
      );
      return;
    }
    if (tool === "read") {
      writeSse(
        res,
        chunk({
          toolCalls: [
            {
              id: "call_advise",
              name: "advise",
              arguments: JSON.stringify({
                severity: "concern",
                note: "unused is assigned and never read",
                evidence: [{ kind: "file", path: "src/app.mjs", line: 1, detail: "const unused = 1" }]
              })
            }
          ]
        })
      );
      return;
    }
    writeSse(res, chunk({ text: "done" }));
  });
  t.after(() => harness.close());

  const tools = makeTools();
  const result = await reviewApi({
    provider: compatibleProvider(harness.baseUrl),
    advisor,
    observations: [
      {
        eventId: "obs_1",
        phase: "prompt",
        userText: "ship the unused constant",
        toolName: null,
        targets: [],
        command: null,
        outcome: null,
        error: null
      }
    ],
    history: [],
    systemPrompt: "Review independently.",
    tools,
    limits: { maxToolCallsPerReview: 8, maxOutputTokens: 1500 },
    env: { [KEY_ENV]: CONFIGURED_KEY, OPENAI_API_KEY: AMBIENT_KEY }
  });

  assert.equal(tools.calls.map((call) => call.name).join(","), "read,advise");
  assert.equal(tools.candidate?.severity, "concern");
  assert.equal(result.usage.inputTokens > 0, true);
  assert.equal(result.usage.outputTokens > 0, true);
  assert.equal(result.usage.costUsd, "unknown");
  const roles = result.history.map((msg) => msg.role);
  assert.deepEqual(roles, ["user", "assistant", "toolResult", "assistant", "toolResult"]);
  const groups = [];
  let current = [];
  for (const msg of result.history) {
    if (msg.role === "assistant" && current.length) {
      groups.push(current);
      current = [msg];
    } else {
      current.push(msg);
    }
  }
  if (current.length) groups.push(current);
  assert.equal(groups.length, 3);
  assert.equal(groups[1][0].role, "assistant");
  assert.equal(groups[1][1].role, "toolResult");
  assert.equal(groups[2][0].role, "assistant");
  assert.equal(groups[2][1].role, "toolResult");
  for (const record of harness.requests) {
    const auth = record.headers.authorization ?? "";
    assert.equal(auth.includes(CONFIGURED_KEY), true);
    assert.equal(auth.includes(AMBIENT_KEY), false);
    const serialized = JSON.stringify(record.body);
    assert.equal(serialized.includes(AMBIENT_KEY), false);
  }
});

test("reviewApi ignores ambient OPENAI_API_KEY for a different apiKeyEnv", async (t) => {
  const harness = await startServer(async (record, res) => {
    const auth = record.headers.authorization ?? "";
    if (auth.includes(AMBIENT_KEY) || !auth.includes(CONFIGURED_KEY)) {
      jsonError(res, 401, "ambient credential leaked");
      return;
    }
    writeSse(res, chunk({ text: "" }));
  });
  t.after(() => harness.close());
  const tools = makeTools();
  const result = await reviewApi({
    provider: compatibleProvider(harness.baseUrl),
    advisor,
    observations: [{ eventId: "obs_1", phase: "prompt", userText: "ok" }],
    tools,
    env: { [KEY_ENV]: CONFIGURED_KEY, OPENAI_API_KEY: AMBIENT_KEY }
  });
  assert.equal(tools.candidate, null);
  assert.equal(result.history.at(-1)?.role, "assistant");
});

test("rate responses do not stage a finding", async (t) => {
  const harness = await startServer(async (_record, res) => {
    jsonError(res, 429, "rate limit exceeded");
  });
  t.after(() => harness.close());
  const tools = makeTools();
  await assert.rejects(
    () =>
      reviewApi({
        provider: compatibleProvider(harness.baseUrl),
        advisor,
        observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
        tools,
        env: { [KEY_ENV]: CONFIGURED_KEY }
      }),
    (error) => codeOf(error) === "rate" && tools.candidate === null
  );
});

test("auth failures do not stage a finding", async (t) => {
  const harness = await startServer(async (_record, res) => {
    jsonError(res, 401, "invalid api key");
  });
  t.after(() => harness.close());
  const tools = makeTools();
  await assert.rejects(
    () =>
      reviewApi({
        provider: compatibleProvider(harness.baseUrl),
        advisor,
        observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
        tools,
        env: { [KEY_ENV]: CONFIGURED_KEY }
      }),
    (error) => codeOf(error) === "auth" && tools.candidate === null
  );
});

test("cancel aborts without publishing", async (t) => {
  const harness = await startServer(() => new Promise(() => {}));
  t.after(() => harness.close());
  const tools = makeTools();
  const controller = new AbortController();
  queueMicrotask(() => controller.abort());
  await assert.rejects(
    () =>
      reviewApi({
        provider: compatibleProvider(harness.baseUrl),
        advisor,
        observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
        tools,
        signal: controller.signal,
        env: { [KEY_ENV]: CONFIGURED_KEY }
      }),
    (error) => codeOf(error) === "cancel" && tools.candidate === null
  );
});

test("unknown tools abort the review before advise can publish", async (t) => {
  const harness = await startServer(async (_record, res) => {
    writeSse(
      res,
      chunk({
        toolCalls: [{ id: "call_bash", name: "bash", arguments: JSON.stringify({ command: "cat /etc/passwd" }) }]
      })
    );
  });
  t.after(() => harness.close());
  const tools = makeTools();
  await assert.rejects(
    () =>
      reviewApi({
        provider: compatibleProvider(harness.baseUrl),
        advisor,
        observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
        tools,
        env: { [KEY_ENV]: CONFIGURED_KEY }
      }),
    (error) => codeOf(error) === "audit" && tools.candidate === null && tools.calls.length === 0
  );
});

test("oversized required context is a context-limit error without a provider call", async (t) => {
  let called = false;
  const harness = await startServer(async (_record, res) => {
    called = true;
    jsonError(res, 500, "should not be called");
  });
  t.after(() => harness.close());
  const tools = makeTools();
  const huge = "n".repeat(70_000);
  await assert.rejects(
    () =>
      reviewApi({
        provider: compatibleProvider(harness.baseUrl),
        advisor,
        observations: [{ eventId: "obs_1", phase: "prompt", userText: huge }],
        tools,
        env: { [KEY_ENV]: CONFIGURED_KEY }
      }),
    (error) => codeOf(error) === "context-limit" && called === false && tools.candidate === null
  );
});

test("tool-call limit is an audit failure", async (t) => {
  const harness = await startServer(async (record, res) => {
    const n = record.body?.messages?.filter((msg) => msg.role === "tool").length ?? 0;
    writeSse(
      res,
      chunk({
        toolCalls: [
          { id: `call_read_${n}`, name: "read", arguments: JSON.stringify({ path: `src/${n}.mjs` }) }
        ]
      })
    );
  });
  t.after(() => harness.close());
  const tools = makeTools();
  await assert.rejects(
    () =>
      reviewApi({
        provider: compatibleProvider(harness.baseUrl),
        advisor,
        observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
        tools,
        limits: { maxToolCallsPerReview: 2, maxOutputTokens: 1500 },
        env: { [KEY_ENV]: CONFIGURED_KEY }
      }),
    (error) => codeOf(error) === "audit" && tools.candidate === null
  );
});

test("priced compatible models report numeric costUsd", async (t) => {
  const harness = await startServer(async (_record, res) => {
    writeSse(
      res,
      chunk({
        text: "",
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }
      })
    );
  });
  t.after(() => harness.close());
  const tools = makeTools();
  const result = await reviewApi({
    provider: compatibleProvider(harness.baseUrl, {
      pricing: { prompt: 1, completion: 2 }
    }),
    advisor,
    observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
    tools,
    env: { [KEY_ENV]: CONFIGURED_KEY }
  });
  assert.equal(typeof result.usage.costUsd, "number");
  assert.equal(result.usage.costUsd > 0, true);
  assert.equal(tools.candidate, null);
});

test("prompt-only compatible pricing stays unknown", async (t) => {
  const harness = await startServer(async (_record, res) => {
    writeSse(
      res,
      chunk({
        text: "",
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }
      })
    );
  });
  t.after(() => harness.close());
  const tools = makeTools();
  const result = await reviewApi({
    provider: compatibleProvider(harness.baseUrl, { pricing: { prompt: 1 } }),
    advisor,
    observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
    tools,
    env: { [KEY_ENV]: CONFIGURED_KEY }
  });
  assert.equal(result.usage.costUsd, "unknown");
  assert.equal(result.usage.inputTokens > 0, true);
});

test("old history groups that miss the model allowance are evicted", async (t) => {
  const marker = "OLD_HISTORY_SHOULD_NOT_BE_SENT";
  const harness = await startServer(async (record, res) => {
    const serialized = JSON.stringify(record.body);
    assert.equal(serialized.includes(marker), false);
    writeSse(res, chunk({ text: "" }));
  });
  t.after(() => harness.close());
  const tools = makeTools();
  const result = await reviewApi({
    provider: compatibleProvider(harness.baseUrl),
    advisor,
    observations: [{ eventId: "obs_1", phase: "prompt", userText: "tiny" }],
    history: [
      { role: "user", content: `${marker}${"o".repeat(20_000)}`, timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "old" }],
        api: "openai-completions",
        provider: "openai-compatible",
        model: "local-model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: "stop",
        timestamp: 2
      }
    ],
    tools,
    limits: { maxOutputTokens: 1500 },
    env: { [KEY_ENV]: CONFIGURED_KEY }
  });
  assert.equal(result.history.some((msg) => typeof msg.content === "string" && msg.content.includes(marker)), false);
  assert.equal(tools.candidate, null);
});

test("a large tool result cannot overflow the next provider call", async (t) => {
  let calls = 0;
  const harness = await startServer(async (_record, res) => {
    calls += 1;
    writeSse(
      res,
      chunk({
        toolCalls: [{ id: "call_read", name: "read", arguments: JSON.stringify({ path: "src/app.mjs" }) }]
      })
    );
  });
  t.after(() => harness.close());
  const tools = makeTools();
  const original = tools.call.bind(tools);
  tools.call = async (name, args) => {
    if (name === "read") return "x".repeat(64 * 1024);
    return original(name, args);
  };
  await assert.rejects(
    () =>
      reviewApi({
        provider: compatibleProvider(harness.baseUrl),
        advisor,
        observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
        tools,
        env: { [KEY_ENV]: CONFIGURED_KEY }
      }),
    (error) => codeOf(error) === "context-limit" && calls === 1 && tools.candidate === null
  );
});

test("unknown remote models are config errors", async (t) => {
  const harness = await startServer(async (_record, res) => {
    jsonError(res, 404, "model_not_found: no such model");
  });
  t.after(() => harness.close());
  const tools = makeTools();
  await assert.rejects(
    () =>
      reviewApi({
        provider: compatibleProvider(harness.baseUrl),
        advisor,
        observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
        tools,
        env: { [KEY_ENV]: CONFIGURED_KEY }
      }),
    (error) => codeOf(error) === "config" && tools.candidate === null
  );
});

test("abort after staging advise in the same batch does not succeed", async (t) => {
  const harness = await startServer(async (_record, res) => {
    writeSse(
      res,
      chunk({
        toolCalls: [
          {
            id: "call_advise",
            name: "advise",
            arguments: JSON.stringify({
              severity: "concern",
              note: "unused is assigned and never read",
              evidence: [{ kind: "file", path: "src/app.mjs", line: 1, detail: "const unused = 1" }]
            })
          },
          { id: "call_read", name: "read", arguments: JSON.stringify({ path: "src/app.mjs" }) }
        ]
      })
    );
  });
  t.after(() => harness.close());
  const controller = new AbortController();
  const tools = makeTools();
  const original = tools.call.bind(tools);
  tools.call = async (name, args) => {
    if (name === "advise") return original(name, args);
    controller.abort();
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  await assert.rejects(
    () =>
      reviewApi({
        provider: compatibleProvider(harness.baseUrl),
        advisor,
        observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
        tools,
        signal: controller.signal,
        env: { [KEY_ENV]: CONFIGURED_KEY }
      }),
    (error) => codeOf(error) === "cancel"
  );
});

test("unreported usage in one round keeps costUsd unknown", async (t) => {
  let n = 0;
  const harness = await startServer(async (_record, res) => {
    n += 1;
    if (n === 1) {
      writeSse(
        res,
        chunk({
          toolCalls: [{ id: "call_read", name: "read", arguments: JSON.stringify({ path: "src/app.mjs" }) }],
          usage: false
        })
      );
      return;
    }
    writeSse(
      res,
      chunk({
        text: "",
        usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 }
      })
    );
  });
  t.after(() => harness.close());
  const tools = makeTools();
  const result = await reviewApi({
    provider: compatibleProvider(harness.baseUrl, { pricing: { prompt: 1, completion: 2 } }),
    advisor,
    observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
    tools,
    env: { [KEY_ENV]: CONFIGURED_KEY }
  });
  assert.equal(result.usage.costUsd, "unknown");
  assert.equal(result.usage.inputTokens > 0, true);
});

test("failed reviews expose accumulated usage on the error", async (t) => {
  let n = 0;
  const harness = await startServer(async (_record, res) => {
    n += 1;
    if (n === 1) {
      writeSse(
        res,
        chunk({
          toolCalls: [{ id: "call_read", name: "read", arguments: JSON.stringify({ path: "src/app.mjs" }) }]
        })
      );
      return;
    }
    jsonError(res, 429, "rate limit exceeded");
  });
  t.after(() => harness.close());
  const tools = makeTools();
  await assert.rejects(
    () =>
      reviewApi({
        provider: compatibleProvider(harness.baseUrl, { pricing: { prompt: 1, completion: 2 } }),
        advisor,
        observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
        tools,
        env: { [KEY_ENV]: CONFIGURED_KEY }
      }),
    (error) =>
      codeOf(error) === "rate" &&
      error.usage?.inputTokens > 0 &&
      (error.usage.costUsd === "unknown" || typeof error.usage.costUsd === "number")
  );
});

test("old history is evicted before a later call when a small read would overflow", async (t) => {
  const marker = "PRIOR_REVIEW_GROUP_MARKER";
  const seen = [];
  const harness = await startServer(async (record, res) => {
    seen.push(JSON.stringify(record.body).includes(marker));
    if (seen.length === 1) {
      writeSse(
        res,
        chunk({
          toolCalls: [{ id: "call_read", name: "read", arguments: JSON.stringify({ path: "src/app.mjs" }) }]
        })
      );
      return;
    }
    writeSse(res, chunk({ text: "" }));
  });
  t.after(() => harness.close());
  const tools = makeTools();
  const original = tools.call.bind(tools);
  tools.call = async (name, args) => {
    if (name === "read") return "y".repeat(3000);
    return original(name, args);
  };
  const result = await reviewApi({
    provider: compatibleProvider(harness.baseUrl),
    advisor,
    observations: [{ eventId: "obs_1", phase: "prompt", userText: "tiny" }],
    history: [{ role: "user", content: `${marker}${"o".repeat(15_000)}`, timestamp: 1 }],
    tools,
    limits: { maxOutputTokens: 1500 },
    env: { [KEY_ENV]: CONFIGURED_KEY }
  });
  assert.equal(seen.length >= 2, true);
  assert.equal(seen[seen.length - 1], false);
  assert.equal(result.history.some((msg) => typeof msg.content === "string" && msg.content.includes(marker)), false);
});

async function isolatedConfigDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cma-oauth-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test("validateApi accepts new API catalog providers offline", async () => {
  const env = { [KEY_ENV]: CONFIGURED_KEY };
  for (const [provider, model] of [
    ["zai", "glm-5.3"],
    ["xai", "grok-4.6"],
    ["moonshotai", "kimi-k2.5"],
    ["kimi-coding", "kimi-for-coding"]
  ]) {
    const result = await validateApi({
      provider: { kind: "api", provider, apiKeyEnv: KEY_ENV },
      advisor: { ...advisor, model },
      env
    });
    assert.equal(result.available, true, provider);
  }
});

test("oauth validateApi is unavailable without credentials and ignores ambient keys", async (t) => {
  const dir = await isolatedConfigDir(t);
  const leak = "leak-token-value-should-not-appear";
  const result = await validateApi({
    provider: { kind: "oauth", provider: "github-copilot" },
    advisor: { ...advisor, provider: "copilot-slot", model: "claude-haiku-4.5" },
    env: {
      CLAUDE_CONFIG_DIR: dir,
      COPILOT_GITHUB_TOKEN: leak,
      OPENAI_API_KEY: leak
    }
  });
  assert.equal(result.available, false);
  assert.equal(result.error?.code, "unavailable");
  assert.equal(String(result.error?.message).includes(leak), false);
});

test("oauth validateApi rejects unknown models without a provider call", async (t) => {
  const dir = await isolatedConfigDir(t);
  const result = await validateApi({
    provider: { kind: "oauth", provider: "openai-codex" },
    advisor: { ...advisor, provider: "codex-slot", model: "not-a-real-codex-model" },
    env: { CLAUDE_CONFIG_DIR: dir }
  });
  assert.equal(result.available, false);
  assert.equal(result.error?.code, "config");
});

test("oauth validateApi rejects Anthropic OAuth", async (t) => {
  const dir = await isolatedConfigDir(t);
  const result = await validateApi({
    provider: { kind: "oauth", provider: "anthropic" },
    advisor: { ...advisor, provider: "claude-slot", model: "claude-sonnet-4-5" },
    env: { CLAUDE_CONFIG_DIR: dir }
  });
  assert.equal(result.available, false);
  assert.equal(result.error?.code, "config");
});

test("reviewApi oauth missing credentials does not fall back to ambient keys", async (t) => {
  const dir = await isolatedConfigDir(t);
  const leak = "leak-token-value-should-not-appear";
  const tools = makeTools();
  await assert.rejects(
    () =>
      reviewApi({
        provider: { kind: "oauth", provider: "github-copilot" },
        advisor: { ...advisor, provider: "copilot-slot", model: "claude-haiku-4.5" },
        observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
        tools,
        env: {
          CLAUDE_CONFIG_DIR: dir,
          COPILOT_GITHUB_TOKEN: leak,
          OPENAI_API_KEY: leak
        }
      }),
    (error) =>
      codeOf(error) === "unavailable" &&
      tools.candidate === null &&
      !String(error.message).includes(leak)
  );
});

test("validateApi rejects Anthropic subscription OAuth tokens used as API keys", async () => {
  const oat = "sk-ant-oat-not-a-real-subscription-token";
  const result = await validateApi({
    provider: { kind: "api", provider: "anthropic", apiKeyEnv: KEY_ENV },
    advisor: { ...advisor, model: "claude-sonnet-4-5" },
    env: { [KEY_ENV]: oat }
  });
  assert.equal(result.available, false);
  assert.equal(result.error?.code, "auth");
  assert.equal(String(result.error?.message).includes(oat), false);
});

test("reviewApi rejects Anthropic subscription OAuth tokens before a provider call", async () => {
  const oat = "sk-ant-oat-not-a-real-subscription-token";
  const tools = makeTools();
  await assert.rejects(
    () =>
      reviewApi({
        provider: { kind: "api", provider: "anthropic", apiKeyEnv: KEY_ENV },
        advisor: { ...advisor, model: "claude-sonnet-4-5" },
        observations: [{ eventId: "obs_1", phase: "prompt", userText: "x" }],
        tools,
        env: { [KEY_ENV]: oat }
      }),
    (error) => codeOf(error) === "auth" && tools.candidate === null && !String(error.message).includes(oat)
  );
});

test("OAuth refresh revoking the selected model prevents generation and findings", async (t) => {
  const dir = await isolatedConfigDir(t);
  const env = { CLAUDE_CONFIG_DIR: dir };
  const provider = { kind: "oauth", provider: "github-copilot" };
  const selected = { ...advisor, provider: "copilot-slot", model: "claude-haiku-4.5" };
  const { createCredentialStore } = await import(
    path.join(repoRoot, "plugins/cross-model-advisor/dist/modules/auth.mjs")
  );
  const store = createCredentialStore({ env, slot: selected.provider, provider: provider.provider });
  await store.modify(provider.provider, async () => ({
    type: "oauth",
    access: "expired-copilot-access",
    refresh: "synthetic-copilot-refresh",
    expires: 1,
    availableModelIds: [selected.model]
  }));
  const requests = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.pathname);
    if (url.pathname === "/copilot_internal/v2/token") {
      return Response.json({
        token: "synthetic-rotated-copilot-access",
        expires_at: Math.floor(Date.now() / 1000) + 3600
      });
    }
    if (url.pathname === "/models") return Response.json({ data: [] });
    throw new Error("Generation must not run after entitlement revocation");
  };
  assert.equal((await validateApi({ provider, advisor: selected, env })).available, true);
  assert.deepEqual(requests, []);
  const tools = makeTools();
  await assert.rejects(
    reviewApi({
      provider,
      advisor: selected,
      observations: [{ eventId: "obs_1", phase: "prompt", userText: "Review this change." }],
      tools,
      env,
      signal: AbortSignal.timeout(5000)
    }),
    (error) => codeOf(error) === "auth" &&
      !String(error.message).includes("synthetic-copilot")
  );
  assert.deepEqual(requests, ["/copilot_internal/v2/token", "/models"]);
  assert.equal(tools.candidate, null);
  assert.deepEqual((await store.read(provider.provider)).availableModelIds, []);
});

test("bundled Google transport decodes a response using only the configured key", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.hostname, "generativelanguage.googleapis.com");
    assert.equal(request.headers.get("x-goog-api-key") || url.searchParams.get("key"), CONFIGURED_KEY);
    return new Response(`data: ${JSON.stringify({
      candidates: [{
        index: 0,
        content: { role: "model", parts: [{ text: "Checked the current task." }] },
        finishReason: "STOP"
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
    })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
  const result = await reviewApi({
    provider: { kind: "api", provider: "google", apiKeyEnv: KEY_ENV },
    advisor: { ...advisor, model: "gemini-2.5-flash" },
    latestTask: { text: "Check the current task." },
    tools: makeTools(),
    env: { [KEY_ENV]: CONFIGURED_KEY },
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(result.history.at(-1).content[0].text, "Checked the current task.");
});
