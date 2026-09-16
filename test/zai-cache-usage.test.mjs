import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import {
  ZaiCacheUsageCompatTransform,
  zaiCacheUsageTransform,
} from "../src/zai-cache-usage.mjs";

async function transformed(chunks) {
  const stream = Readable.from(chunks).pipe(new ZaiCacheUsageCompatTransform());
  const output = [];
  for await (const chunk of stream) output.push(chunk);
  return Buffer.concat(output).toString("utf8");
}

test("Z.ai cache usage compatibility survives split SSE chunks and explicit zero", async () => {
  const prefix = 'data: {"usage":{"prompt_tokens":12,"prompt_tokens_details":{"cached_tokens":';
  const output = await transformed([prefix, '0}}}\r\n', 'data: [DONE]\r\n']);
  const usageLine = output.split(/\r?\n/).find((line) => line.includes('"usage"'));
  const payload = JSON.parse(usageLine.slice(5).trim());
  assert.equal(payload.usage.prompt_tokens_details.cached_tokens, 0);
  assert.equal(payload.usage.prompt_cache_hit_tokens, 0);
});

test("Z.ai cache compatibility never overwrites a provider-supplied compatibility count", async () => {
  const line = 'data: {"usage":{"prompt_tokens_details":{"cached_tokens":800},"prompt_cache_hit_tokens":700}}\n';
  assert.equal(await transformed([line]), line);
});

test("cache compatibility is installed only for Z.ai event streams", () => {
  assert.ok(zaiCacheUsageTransform("zai-coding", "text/event-stream"));
  assert.ok(zaiCacheUsageTransform("zai-api", "text/event-stream; charset=utf-8"));
  assert.equal(zaiCacheUsageTransform("zai-coding", "application/json"), undefined);
  assert.equal(zaiCacheUsageTransform("deepseek", "text/event-stream"), undefined);
  // opencode Go's chat endpoint uses the same choice-bearing terminal usage
  // shape (litellm#36168), so the compat transform covers it too.
  assert.ok(zaiCacheUsageTransform("opencode-go", "text/event-stream"));
  assert.equal(zaiCacheUsageTransform("opencode-go-messages", "text/event-stream"), undefined);
});

test("non-usage and malformed SSE lines pass through byte-for-byte", async () => {
  const input = 'event: message\r\ndata: {not-json}\r\ndata: [DONE]\r\n';
  assert.equal(await transformed([input]), input);
});

test("an empty usage object is malformed and passes through byte-for-byte", async () => {
  const input = 'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{}}\n';
  assert.equal(await transformed([input]), input);
});


test("Z.ai choice-bearing terminal usage is normalized to a usage-only chunk", async () => {
  const terminal = {
    id: "chatcmpl-cache",
    model: "glm-5.3",
    choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 8,
      total_tokens: 1208,
      prompt_tokens_details: { cached_tokens: 800 },
    },
  };
  const output = await transformed([
    `data: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`,
  ]);
  const payloads = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: {") && line.includes('"id"'))
    .map((line) => JSON.parse(line.slice(5).trim()));

  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0].choices, terminal.choices);
  assert.equal(payloads[0].usage, undefined);
  assert.deepEqual(payloads[1].choices, []);
  assert.equal(payloads[1].usage.prompt_tokens, 1200);
  assert.equal(payloads[1].usage.completion_tokens, 8);
  assert.equal(payloads[1].usage.prompt_tokens_details.cached_tokens, 800);
  assert.equal(payloads[1].usage.prompt_cache_hit_tokens, 800);
});
