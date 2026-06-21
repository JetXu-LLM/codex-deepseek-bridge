import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeConfig } from "../src/config.mjs";
import { startServer } from "../src/server.mjs";

async function startMockDeepSeek(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

test("serves non-streaming Responses requests", async (t) => {
  let upstreamBody;
  const mock = await startMockDeepSeek(async (req, res) => {
    assert.equal(req.url, "/chat/completions");
    upstreamBody = JSON.parse(await readBody(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { reasoning_content: "think", content: "bridge-ok" } }],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
        prompt_cache_hit_tokens: 10,
        prompt_cache_miss_tokens: 2,
      },
    }));
  });
  t.after(() => mock.server.close());

  const config = buildRuntimeConfig({}, {
    host: "127.0.0.1",
    port: 0,
    deepseekBaseUrl: mock.baseUrl,
    apiKey: "test-key",
    logDir: "",
    quiet: true,
  });
  const bridge = await startServer(config);
  t.after(() => bridge.close());
  const port = bridge.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-pro",
      input: "hello",
      stream: false,
      reasoning: { effort: "high" },
    }),
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(upstreamBody.model, "deepseek-v4-pro");
  assert.deepEqual(upstreamBody.thinking, { type: "enabled" });
  assert.equal(upstreamBody.reasoning_effort, "high");
  assert.equal(upstreamBody.messages[0].content, "hello");
  assert.equal(json.output_text, "bridge-ok");
  assert.equal(json.usage.input_tokens_details.prompt_cache_hit_tokens, 10);

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  const healthJson = await health.json();
  assert.equal(healthJson.ok, true);
  assert.equal(typeof healthJson.version, "string");

  const models = await fetch(`http://127.0.0.1:${port}/v1/models`);
  const modelsJson = await models.json();
  assert.deepEqual(modelsJson.data.map((entry) => entry.id), ["deepseek-pro", "deepseek-flash"]);

  const report = await fetch(`http://127.0.0.1:${port}/report`);
  assert.equal(report.status, 200);
  assert.match(await report.text(), /Codex DeepSeek Bridge Report/);
});

test("uses Codex bearer token as DeepSeek key when process key is absent", async (t) => {
  let upstreamAuth = "";
  const mock = await startMockDeepSeek(async (req, res) => {
    upstreamAuth = req.headers.authorization || "";
    await readBody(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: "bearer-ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  t.after(() => mock.server.close());

  const config = buildRuntimeConfig({}, {
    host: "127.0.0.1",
    port: 0,
    deepseekBaseUrl: mock.baseUrl,
    apiKey: "",
    logDir: "",
    quiet: true,
  });
  const bridge = await startServer(config);
  t.after(() => bridge.close());
  const port = bridge.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-deepseek-key" },
    body: JSON.stringify({ model: "deepseek-pro", input: "hello", stream: false }),
  });
  const json = await response.json();

  assert.equal(response.status, 200);
  assert.equal(upstreamAuth, "Bearer test-deepseek-key");
  assert.equal(json.output_text, "bearer-ok");
});

test("serves streaming Responses events", async (t) => {
  const mock = await startMockDeepSeek(async (req, res) => {
    await readBody(req);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    res.write("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"think\"}}]}\n\n");
    res.write("data: {\"choices\":[{\"delta\":{\"content\":\"bridge\"}}]}\n\n");
    res.write("data: {\"choices\":[{\"delta\":{\"content\":\"-ok\"}}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2,\"total_tokens\":3}}\n\n");
    res.write("data: [DONE]\n\n");
    res.end();
  });
  t.after(() => mock.server.close());

  const config = buildRuntimeConfig({}, {
    host: "127.0.0.1",
    port: 0,
    deepseekBaseUrl: mock.baseUrl,
    apiKey: "test-key",
    logDir: "",
    quiet: true,
  });
  const bridge = await startServer(config);
  t.after(() => bridge.close());
  const port = bridge.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek-pro",
      input: "hello",
      stream: true,
    }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /response\.created/);
  assert.match(text, /response\.output_text\.delta/);
  assert.match(text, /bridge-ok/);
  assert.match(text, /response\.completed/);
});

test("maps none effort to disabled thinking and xhigh to max in the upstream body", async (t) => {
  const bodies = [];
  const mock = await startMockDeepSeek(async (req, res) => {
    bodies.push(JSON.parse(await readBody(req)));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  t.after(() => mock.server.close());

  const config = buildRuntimeConfig({}, {
    host: "127.0.0.1",
    port: 0,
    deepseekBaseUrl: mock.baseUrl,
    apiKey: "test-key",
    logDir: "",
    quiet: true,
  });
  const bridge = await startServer(config);
  t.after(() => bridge.close());
  const port = bridge.address().port;

  await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-pro", input: "x", stream: false, reasoning: { effort: "none" } }),
  });
  await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek-flash", input: "x", stream: false, reasoning: { effort: "xhigh" } }),
  });

  assert.deepEqual(bodies[0].thinking, { type: "disabled" });
  assert.equal(bodies[0].reasoning_effort, undefined);
  assert.equal(bodies[1].model, "deepseek-v4-flash");
  assert.deepEqual(bodies[1].thinking, { type: "enabled" });
  assert.equal(bodies[1].reasoning_effort, "max");
});
