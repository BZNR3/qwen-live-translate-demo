import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DEFAULT_MODEL = "qwen3.5-livetranslate-flash-realtime";
const DEFAULT_LOCAL_TRANSLATOR_URL = "http://127.0.0.1:8765";
const MAX_GLOSSARY_ENTRIES = 50;
const MAX_GLOSSARY_TERM_LENGTH = 100;
const MAX_QUEUED_AUDIO_BYTES = 512_000;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function parseDotEnv(text) {
  const parsed = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

export function loadDotEnv(envPath = path.join(ROOT_DIR, ".env")) {
  if (!existsSync(envPath)) return;
  const values = parseDotEnv(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function makeConfig(overrides = {}) {
  return {
    apiKey: overrides.apiKey ?? process.env.DASHSCOPE_API_KEY ?? "",
    workspaceId:
      overrides.workspaceId ?? process.env.QWEN_WORKSPACE_ID ?? "",
    region: overrides.region ?? process.env.QWEN_REGION ?? "singapore",
    model: overrides.model ?? process.env.QWEN_MODEL ?? DEFAULT_MODEL,
    realtimeUrl:
      overrides.realtimeUrl ?? process.env.QWEN_REALTIME_URL ?? "",
    localTranslatorUrl:
      overrides.localTranslatorUrl ??
      process.env.LOCAL_TRANSLATOR_URL ??
      DEFAULT_LOCAL_TRANSLATOR_URL,
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port: Number(overrides.port ?? process.env.PORT ?? 8787),
    publicDir: overrides.publicDir ?? PUBLIC_DIR,
  };
}

export function buildQwenUrl(config) {
  let endpoint = config.realtimeUrl;
  if (!endpoint) {
    if (!config.workspaceId) {
      throw new Error(
        "缺少 QWEN_WORKSPACE_ID（或完整的 QWEN_REALTIME_URL）。",
      );
    }
    const domain =
      config.region === "beijing"
        ? `${config.workspaceId}.cn-beijing.maas.aliyuncs.com`
        : `${config.workspaceId}.ap-southeast-1.maas.aliyuncs.com`;
    endpoint = `wss://${domain}/api-ws/v1/realtime`;
  }
  const url = new URL(endpoint);
  url.searchParams.set("model", config.model);
  return url.toString();
}

export function validateStartMessage(message) {
  if (!message || message.type !== "start") {
    throw new Error("第一条控制消息必须是 start。");
  }
  if (message.provider && !["local", "qwen"].includes(message.provider)) {
    throw new Error("provider 只支持 local 或 qwen。");
  }
  if (![
    "zh",
    "en",
  ].includes(message.sourceLanguage)) {
    throw new Error("sourceLanguage 只支持 zh 或 en。");
  }
  if (![
    "zh",
    "en",
  ].includes(message.targetLanguage)) {
    throw new Error("targetLanguage 只支持 zh 或 en。");
  }
  if (message.sourceLanguage === message.targetLanguage) {
    throw new Error("源语言和目标语言不能相同。");
  }

  const glossary = message.glossary ?? {};
  if (
    typeof glossary !== "object" ||
    Array.isArray(glossary) ||
    glossary === null
  ) {
    throw new Error("glossary 必须是键值对象。");
  }
  const entries = Object.entries(glossary);
  if (entries.length > MAX_GLOSSARY_ENTRIES) {
    throw new Error(`术语表最多 ${MAX_GLOSSARY_ENTRIES} 条。`);
  }
  for (const [source, target] of entries) {
    if (
      !source.trim() ||
      !String(target).trim() ||
      source.length > MAX_GLOSSARY_TERM_LENGTH ||
      String(target).length > MAX_GLOSSARY_TERM_LENGTH
    ) {
      throw new Error(
        `术语不能为空，且每项不得超过 ${MAX_GLOSSARY_TERM_LENGTH} 个字符。`,
      );
    }
  }
  return {
    provider: message.provider === "local" ? "local" : "qwen",
    sourceLanguage: message.sourceLanguage,
    targetLanguage: message.targetLanguage,
    glossary: Object.fromEntries(
      entries.map(([source, target]) => [source.trim(), String(target).trim()]),
    ),
  };
}

export class LocalUtteranceSegmenter {
  constructor({
    sampleRate = 16000,
    rmsThreshold = 420,
    preRollMs = 300,
    silenceMs = 800,
    minSpeechMs = 250,
    maxUtteranceMs = 15_000,
  } = {}) {
    this.sampleRate = sampleRate;
    this.rmsThreshold = rmsThreshold;
    this.preRollMs = preRollMs;
    this.silenceLimitMs = silenceMs;
    this.minSpeechMs = minSpeechMs;
    this.maxUtteranceMs = maxUtteranceMs;
    this.reset();
  }

  reset() {
    this.preRoll = [];
    this.preRollDurationMs = 0;
    this.active = [];
    this.activeDurationMs = 0;
    this.speechDurationMs = 0;
    this.trailingSilenceMs = 0;
  }

  chunkDurationMs(buffer) {
    return (buffer.length / 2 / this.sampleRate) * 1000;
  }

  isSpeech(buffer) {
    if (buffer.length < 2) return false;
    let squareSum = 0;
    const samples = Math.floor(buffer.length / 2);
    for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
      const sample = buffer.readInt16LE(offset);
      squareSum += sample * sample;
    }
    return Math.sqrt(squareSum / samples) >= this.rmsThreshold;
  }

  push(rawBuffer) {
    const buffer = Buffer.from(rawBuffer);
    const durationMs = this.chunkDurationMs(buffer);
    const speech = this.isSpeech(buffer);
    let started = false;

    if (this.active.length === 0) {
      this.preRoll.push(buffer);
      this.preRollDurationMs += durationMs;
      while (this.preRollDurationMs > this.preRollMs && this.preRoll.length > 1) {
        const removed = this.preRoll.shift();
        this.preRollDurationMs -= this.chunkDurationMs(removed);
      }
      if (!speech) return { started: false, utterance: null };

      this.active = this.preRoll;
      this.activeDurationMs = this.preRollDurationMs;
      this.preRoll = [];
      this.preRollDurationMs = 0;
      this.speechDurationMs = durationMs;
      this.trailingSilenceMs = 0;
      started = true;
    } else {
      this.active.push(buffer);
      this.activeDurationMs += durationMs;
      if (speech) {
        this.speechDurationMs += durationMs;
        this.trailingSilenceMs = 0;
      } else {
        this.trailingSilenceMs += durationMs;
      }
    }

    if (
      this.activeDurationMs >= this.maxUtteranceMs ||
      (this.trailingSilenceMs >= this.silenceLimitMs &&
        this.speechDurationMs >= this.minSpeechMs)
    ) {
      return { started, utterance: this.flush() };
    }
    return { started, utterance: null };
  }

  flush() {
    const usable = this.speechDurationMs >= this.minSpeechMs;
    const utterance = usable ? Buffer.concat(this.active) : null;
    this.reset();
    return utterance;
  }
}

export function buildSessionUpdate(startOptions) {
  const translation = { language: startOptions.targetLanguage };
  if (Object.keys(startOptions.glossary).length > 0) {
    translation.corpus = { phrases: startOptions.glossary };
  }
  return {
    event_id: `event_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    type: "session.update",
    session: {
      modalities: ["text"],
      sample_rate: 16000,
      input_audio_format: "pcm",
      output_audio_format: "pcm",
      input_audio_transcription: {
        model: "qwen3-asr-flash-realtime",
        language: startOptions.sourceLanguage,
      },
      translation,
    },
  };
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createQwenProxyConnection(client, config) {
  let upstream = null;
  let state = "idle";
  let queuedAudio = [];
  let queuedAudioBytes = 0;
  let shutdownTimer = null;

  const cleanup = () => {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = null;
    queuedAudio = [];
    queuedAudioBytes = 0;
  };

  const fail = (message) => {
    sendJson(client, { type: "proxy.error", message });
    if (client.readyState === WebSocket.OPEN) client.close(1011, "Proxy error");
    if (upstream?.readyState === WebSocket.OPEN) upstream.close(1011);
    cleanup();
  };

  const sendAudio = (buffer) => {
    if (upstream?.readyState !== WebSocket.OPEN || state !== "ready") return;
    upstream.send(
      JSON.stringify({
        event_id: `event_${Date.now()}`,
        type: "input_audio_buffer.append",
        audio: buffer.toString("base64"),
      }),
    );
  };

  const finish = () => {
    if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
    if (state === "finishing" || state === "finished") return;
    state = "finishing";
    upstream.send(
      JSON.stringify({ event_id: `event_${Date.now()}`, type: "session.finish" }),
    );
    sendJson(client, { type: "proxy.flushing" });
    shutdownTimer = setTimeout(() => {
      sendJson(client, {
        type: "proxy.error",
        message: "等待 Qwen 刷新最后一句超时，连接已关闭。",
      });
      upstream?.close();
      client.close();
    }, 10_000);
  };

  const openUpstream = (rawStart) => {
    if (state !== "idle") throw new Error("翻译会话已经启动。");
    if (!config.apiKey) throw new Error("服务端缺少 DASHSCOPE_API_KEY。");
    const startOptions = validateStartMessage(rawStart);
    const qwenUrl = buildQwenUrl(config);
    state = "connecting";
    upstream = new WebSocket(qwenUrl, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      maxPayload: 2 * 1024 * 1024,
    });

    upstream.on("open", () => {
      upstream.send(JSON.stringify(buildSessionUpdate(startOptions)));
      sendJson(client, { type: "proxy.connected", model: config.model });
    });

    upstream.on("message", (data, isBinary) => {
      if (isBinary) return;
      const text = data.toString();
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        return;
      }

      sendJson(client, event);
      if (event.type === "session.updated") {
        state = "ready";
        sendJson(client, {
          type: "proxy.ready",
          sourceLanguage: startOptions.sourceLanguage,
          targetLanguage: startOptions.targetLanguage,
          model: config.model,
        });
        for (const chunk of queuedAudio) sendAudio(chunk);
        queuedAudio = [];
        queuedAudioBytes = 0;
      } else if (event.type === "session.finished") {
        state = "finished";
        cleanup();
        sendJson(client, { type: "proxy.finished" });
        upstream.close(1000);
        client.close(1000);
      } else if (event.type === "error") {
        fail(event.error?.message || "Qwen 返回未知错误。");
      }
    });

    upstream.on("error", (error) => fail(`Qwen 连接失败：${safeMessage(error)}`));
    upstream.on("close", (code) => {
      if (state !== "finished" && state !== "finishing") {
        fail(`Qwen 连接意外关闭（${code}）。`);
      }
    });
  };

  client.on("message", (data, isBinary) => {
    try {
      if (isBinary) {
        if (!["connecting", "ready"].includes(state)) return;
        const chunk = Buffer.from(data);
        if (state === "ready") {
          sendAudio(chunk);
        } else {
          queuedAudioBytes += chunk.length;
          if (queuedAudioBytes > MAX_QUEUED_AUDIO_BYTES) {
            throw new Error("初始化期间缓存的音频过多，请重新开始。");
          }
          queuedAudio.push(chunk);
        }
        return;
      }

      const message = JSON.parse(data.toString());
      if (message.type === "start") openUpstream(message);
      else if (message.type === "finish") finish();
      else throw new Error(`不支持的控制消息：${message.type ?? "unknown"}`);
    } catch (error) {
      fail(safeMessage(error));
    }
  });

  client.on("close", () => {
    cleanup();
    if (upstream?.readyState === WebSocket.OPEN) upstream.close(1000);
  });

  client.on("error", () => {
    cleanup();
    if (upstream?.readyState === WebSocket.OPEN) upstream.close(1011);
  });
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `本地模型服务返回 HTTP ${response.status}。`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function localEndpoint(baseUrl, pathname) {
  return `${baseUrl.replace(/\/$/, "")}${pathname}`;
}

async function checkLocalTranslator(config, timeoutMs = 1500) {
  try {
    const health = await fetchJsonWithTimeout(
      localEndpoint(config.localTranslatorUrl, "/health"),
      {},
      timeoutMs,
    );
    return { available: Boolean(health.ok), ...health };
  } catch (error) {
    return { available: false, error: safeMessage(error) };
  }
}

function createLocalProxyConnection(client, config) {
  let state = "idle";
  let startOptions = null;
  let segmenter = new LocalUtteranceSegmenter();
  let work = Promise.resolve();
  let failed = false;

  const fail = (message) => {
    if (failed) return;
    failed = true;
    state = "finished";
    sendJson(client, { type: "proxy.error", message });
    if (client.readyState === WebSocket.OPEN) client.close(1011, "Local error");
  };

  const translateUtterance = async (audio) => {
    if (!audio?.length || failed) return;
    sendJson(client, { type: "proxy.processing" });
    const result = await fetchJsonWithTimeout(
      localEndpoint(config.localTranslatorUrl, "/translate"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio: audio.toString("base64"),
          sourceLanguage: startOptions.sourceLanguage,
          targetLanguage: startOptions.targetLanguage,
          glossary: startOptions.glossary,
          sampleRate: 16000,
        }),
      },
      120_000,
    );
    if (!result.transcript?.trim()) return;
    sendJson(client, {
      type: "conversation.item.input_audio_transcription.completed",
      transcript: result.transcript,
      language: startOptions.sourceLanguage,
    });
    sendJson(client, { type: "response.text.done", text: result.translation });
    sendJson(client, {
      type: "response.done",
      response: { usage: {} },
      local: {
        latencyMs: result.latencyMs,
        audioSeconds: result.audioSeconds,
      },
    });
  };

  const enqueue = (audio) => {
    if (!audio?.length) return;
    work = work.then(() => translateUtterance(audio)).catch((error) => {
      fail(`本地识别或翻译失败：${safeMessage(error)}`);
    });
  };

  const start = async (rawStart) => {
    if (state !== "idle") throw new Error("翻译会话已经启动。");
    startOptions = validateStartMessage(rawStart);
    if (startOptions.provider !== "local") {
      throw new Error("本地会话的 provider 必须是 local。");
    }
    state = "connecting";
    sendJson(client, {
      type: "proxy.connected",
      provider: "local",
      model: "MLX Whisper + Qwen3",
    });
    const health = await checkLocalTranslator(config, 3000);
    if (!health.available) {
      throw new Error(
        "本地模型服务未启动。请先运行 npm run local（首次使用先运行 npm run local:setup）。",
      );
    }
    if (failed || client.readyState !== WebSocket.OPEN) return;
    state = "ready";
    sendJson(client, {
      type: "proxy.ready",
      provider: "local",
      sourceLanguage: startOptions.sourceLanguage,
      targetLanguage: startOptions.targetLanguage,
      model: `${health.asrModel || "MLX Whisper"} + ${health.translationModel || "Qwen3"}`,
    });
  };

  const finish = async () => {
    if (!["connecting", "ready"].includes(state)) return;
    state = "finishing";
    enqueue(segmenter.flush());
    sendJson(client, { type: "proxy.flushing" });
    await work;
    if (failed || client.readyState !== WebSocket.OPEN) return;
    state = "finished";
    sendJson(client, { type: "proxy.finished" });
    client.close(1000);
  };

  client.on("message", (data, isBinary) => {
    try {
      if (isBinary) {
        if (state !== "ready") return;
        const { started, utterance } = segmenter.push(Buffer.from(data));
        if (started) {
          sendJson(client, {
            type: "conversation.item.input_audio_transcription.text",
            text: "",
            stash: "正在聆听这句话…",
          });
        }
        enqueue(utterance);
        return;
      }

      const message = JSON.parse(data.toString());
      if (message.type === "start") {
        start(message).catch((error) => fail(safeMessage(error)));
      } else if (message.type === "finish") {
        finish().catch((error) => fail(safeMessage(error)));
      } else {
        throw new Error(`不支持的控制消息：${message.type ?? "unknown"}`);
      }
    } catch (error) {
      fail(safeMessage(error));
    }
  });
}

function createProxyConnection(client, config) {
  let routed = false;
  const routeFirstMessage = (data, isBinary) => {
    if (routed) return;
    if (isBinary) {
      sendJson(client, { type: "proxy.error", message: "请先发送 start 控制消息。" });
      client.close(1008);
      return;
    }
    try {
      const message = JSON.parse(data.toString());
      const provider = message.provider === "local" ? "local" : "qwen";
      routed = true;
      client.off("message", routeFirstMessage);
      if (provider === "local") createLocalProxyConnection(client, config);
      else createQwenProxyConnection(client, config);
      client.emit("message", data, isBinary);
    } catch (error) {
      sendJson(client, { type: "proxy.error", message: safeMessage(error) });
      client.close(1008);
    }
  };
  client.on("message", routeFirstMessage);
}

function jsonResponse(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function serveStatic(request, response, publicDir) {
  const requestUrl = new URL(request.url, "http://localhost");
  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.resolve(publicDir, `.${pathname}`);
  const publicRoot = `${path.resolve(publicDir)}${path.sep}`;
  if (!filePath.startsWith(publicRoot)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) throw new Error("Not a file");
    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

export async function startServer(overrides = {}) {
  const config = makeConfig(overrides);
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/api/health")) {
      const local = await checkLocalTranslator(config);
      const qwenConfigured = Boolean(
        config.apiKey && (config.workspaceId || config.realtimeUrl),
      );
      jsonResponse(response, 200, {
        ok: true,
        configured: qwenConfigured || local.available,
        qwenConfigured,
        local,
        model: config.model,
        region: config.region,
      });
      return;
    }
    await serveStatic(request, response, config.publicDir);
  });

  const websocketServer = new WebSocketServer({
    server,
    path: "/api/live",
    maxPayload: 256 * 1024,
  });
  websocketServer.on("connection", (client) => createProxyConnection(client, config));

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });

  const address = server.address();
  return {
    address,
    config,
    server,
    websocketServer,
    async close() {
      for (const client of websocketServer.clients) client.terminate();
      await new Promise((resolve) => websocketServer.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  loadDotEnv();
  const app = await startServer();
  const displayHost = app.config.host === "0.0.0.0" ? "localhost" : app.config.host;
  console.log(`Qwen 中英实时翻译 Demo：http://${displayHost}:${app.address.port}`);
  const local = await checkLocalTranslator(app.config);
  console.log(
    local.available
      ? "完全本地模式：已就绪（MLX Whisper + Qwen3）"
      : "完全本地模式：未启动（运行 npm run local）",
  );
  if (!app.config.apiKey || !(app.config.workspaceId || app.config.realtimeUrl)) {
    console.warn("百炼云端模式：未配置（可忽略；完全本地模式无需凭据）。");
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
