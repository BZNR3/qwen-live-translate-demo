import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  buildQwenUrl,
  buildSessionUpdate,
  LocalUtteranceSegmenter,
  parseDotEnv,
  startServer,
  validateStartMessage,
} from "../server.mjs";

test("parseDotEnv parses comments and quoted values", () => {
  assert.deepEqual(parseDotEnv("# comment\nA=1\nB='two words'\n"), {
    A: "1",
    B: "two words",
  });
});

test("buildQwenUrl selects the Singapore workspace endpoint", () => {
  const url = buildQwenUrl({
    workspaceId: "workspace-123",
    region: "singapore",
    model: "qwen-model",
    realtimeUrl: "",
  });
  assert.equal(
    url,
    "wss://workspace-123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-model",
  );
});

test("session update is constrained to Chinese-English text translation", () => {
  const options = validateStartMessage({
    type: "start",
    sourceLanguage: "zh",
    targetLanguage: "en",
    glossary: { 百炼: "Model Studio" },
  });
  const update = buildSessionUpdate(options);
  assert.deepEqual(update.session.modalities, ["text"]);
  assert.equal(update.session.sample_rate, 16000);
  assert.equal(update.session.input_audio_transcription.language, "zh");
  assert.equal(update.session.translation.language, "en");
  assert.deepEqual(update.session.translation.corpus.phrases, {
    百炼: "Model Studio",
  });
  assert.throws(
    () =>
      validateStartMessage({
        type: "start",
        sourceLanguage: "fr",
        targetLanguage: "en",
      }),
    /must be zh or en/,
  );
});

test("local segmenter emits an utterance after speech followed by silence", () => {
  const segmenter = new LocalUtteranceSegmenter();
  const silence = Buffer.alloc(3200);
  const speech = Buffer.alloc(3200);
  for (let offset = 0; offset < speech.length; offset += 2) {
    speech.writeInt16LE(5000, offset);
  }

  segmenter.push(silence);
  segmenter.push(silence);
  segmenter.push(speech);
  segmenter.push(speech);
  segmenter.push(speech);
  let utterance = null;
  for (let index = 0; index < 8; index += 1) {
    utterance = segmenter.push(silence).utterance || utterance;
  }
  assert.ok(utterance);
  assert.equal(utterance.length, 13 * 3200);
});

test("browser proxy sends segmented audio to the free local model service", async (t) => {
  const requests = [];
  const localServer = await import("node:http").then(({ createServer }) =>
    createServer(async (request, response) => {
      if (request.url === "/health") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            ok: true,
            asrModel: "fake-whisper",
            translationModel: "fake-qwen",
          }),
        );
        return;
      }
      if (request.url === "/translate" && request.method === "POST") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(body);
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            ok: true,
            transcript: "Good morning",
            translation: "早上好",
            audioSeconds: 1.3,
            latencyMs: 42,
          }),
        );
        return;
      }
      response.writeHead(404).end();
    }).listen(0, "127.0.0.1"),
  );
  await once(localServer, "listening");
  const localPort = localServer.address().port;
  const app = await startServer({
    localTranslatorUrl: `http://127.0.0.1:${localPort}`,
    host: "127.0.0.1",
    port: 0,
  });
  t.after(async () => {
    await app.close();
    await new Promise((resolve) => localServer.close(resolve));
  });

  const health = await fetch(`http://127.0.0.1:${app.address.port}/api/health`).then(
    (response) => response.json(),
  );
  assert.equal(health.local.available, true);

  const browser = new WebSocket(`ws://127.0.0.1:${app.address.port}/api/live`);
  await once(browser, "open");
  const events = [];
  browser.on("message", (data) => events.push(JSON.parse(data.toString())));
  browser.send(
    JSON.stringify({
      type: "start",
      provider: "local",
      sourceLanguage: "en",
      targetLanguage: "zh",
      glossary: { Codex: "编程助手" },
    }),
  );
  await waitFor(() => events.some((event) => event.type === "proxy.ready"));

  const silence = Buffer.alloc(3200);
  const speech = Buffer.alloc(3200);
  for (let offset = 0; offset < speech.length; offset += 2) {
    speech.writeInt16LE(5000, offset);
  }
  for (const chunk of [
    silence,
    silence,
    speech,
    speech,
    speech,
    ...Array(8).fill(silence),
  ]) {
    browser.send(chunk);
  }

  await waitFor(() => events.some((event) => event.type === "response.text.done"));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].sourceLanguage, "en");
  assert.equal(requests[0].targetLanguage, "zh");
  assert.equal(requests[0].glossary.Codex, "编程助手");
  assert.ok(Buffer.from(requests[0].audio, "base64").length > 0);
  assert.ok(
    events.some(
      (event) =>
        event.type === "conversation.item.input_audio_transcription.completed" &&
        event.transcript === "Good morning",
    ),
  );
  assert.ok(
    events.some(
      (event) => event.type === "response.text.done" && event.text === "早上好",
    ),
  );

  const browserClosed = once(browser, "close");
  browser.send(JSON.stringify({ type: "finish" }));
  await browserClosed;
});

test("browser proxy configures Qwen, forwards PCM and flushes the session", async (t) => {
  const fakeHttpServer = await import("node:http").then(({ createServer }) =>
    createServer().listen(0, "127.0.0.1"),
  );
  await once(fakeHttpServer, "listening");
  const fakeQwen = new WebSocketServer({ server: fakeHttpServer });
  const fakePort = fakeHttpServer.address().port;
  const receivedByQwen = [];
  let authorizationHeader = "";

  fakeQwen.on("connection", (socket, request) => {
    authorizationHeader = request.headers.authorization;
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      receivedByQwen.push(event);
      if (event.type === "session.update") {
        socket.send(JSON.stringify({ type: "session.updated", session: {} }));
        socket.send(
          JSON.stringify({
            type: "conversation.item.input_audio_transcription.completed",
            transcript: "Hello",
            language: "en",
          }),
        );
        socket.send(JSON.stringify({ type: "response.text.done", text: "你好" }));
      }
      if (event.type === "session.finish") {
        socket.send(JSON.stringify({ type: "session.finished" }));
      }
    });
  });

  const app = await startServer({
    apiKey: "test-secret",
    realtimeUrl: `ws://127.0.0.1:${fakePort}/realtime`,
    model: "test-qwen",
    host: "127.0.0.1",
    port: 0,
  });
  t.after(async () => {
    await app.close();
    for (const socket of fakeQwen.clients) socket.terminate();
    await new Promise((resolve) => fakeQwen.close(resolve));
    await new Promise((resolve) => fakeHttpServer.close(resolve));
  });

  const health = await fetch(`http://127.0.0.1:${app.address.port}/api/health`).then(
    (response) => response.json(),
  );
  assert.equal(health.configured, true);

  const browser = new WebSocket(`ws://127.0.0.1:${app.address.port}/api/live`);
  await once(browser, "open");
  const browserEvents = [];
  browser.on("message", (data) => browserEvents.push(JSON.parse(data.toString())));
  browser.send(
    JSON.stringify({
      type: "start",
      sourceLanguage: "en",
      targetLanguage: "zh",
      glossary: {},
    }),
  );

  await waitFor(() => browserEvents.some((event) => event.type === "proxy.ready"));
  browser.send(Buffer.from([1, 2, 3, 4]));
  await waitFor(() =>
    receivedByQwen.some((event) => event.type === "input_audio_buffer.append"),
  );
  assert.equal(authorizationHeader, "Bearer test-secret");
  assert.equal(
    receivedByQwen.find((event) => event.type === "input_audio_buffer.append").audio,
    "AQIDBA==",
  );
  assert.ok(
    browserEvents.some(
      (event) =>
        event.type === "conversation.item.input_audio_transcription.completed" &&
        event.transcript === "Hello",
    ),
  );
  assert.ok(
    browserEvents.some(
      (event) => event.type === "response.text.done" && event.text === "你好",
    ),
  );

  const browserClosed = once(browser, "close");
  browser.send(JSON.stringify({ type: "finish" }));
  await waitFor(() => receivedByQwen.some((event) => event.type === "session.finish"));
  await browserClosed;
});

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
