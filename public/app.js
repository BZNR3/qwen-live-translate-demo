const elements = {
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  clearButton: document.querySelector("#clearButton"),
  glossary: document.querySelector("#glossary"),
  status: document.querySelector("#status"),
  statusText: document.querySelector("#statusText"),
  displayHint: document.querySelector("#displayHint"),
  errorBox: document.querySelector("#errorBox"),
  sourceHistory: document.querySelector("#sourceHistory"),
  sourceLive: document.querySelector("#sourceLive"),
  targetHistory: document.querySelector("#targetHistory"),
  targetLive: document.querySelector("#targetLive"),
  sourceLabel: document.querySelector("#sourceLabel"),
  targetLabel: document.querySelector("#targetLabel"),
  usage: document.querySelector("#usage"),
  modelPill: document.querySelector("#modelPill"),
  providerDescription: document.querySelector("#providerDescription"),
  privacyText: document.querySelector("#privacyText"),
};

let socket = null;
let mediaStream = null;
let audioContext = null;
let audioSource = null;
let workletNode = null;
let silentSink = null;
let healthState = null;
let configured = false;
let sessionState = "idle";
let activeProvider = "local";
let totalInputAudioTokens = 0;
let totalOutputTextTokens = 0;

function selectedValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function direction() {
  return selectedValue("direction") === "zh-en"
    ? { sourceLanguage: "zh", targetLanguage: "en" }
    : { sourceLanguage: "en", targetLanguage: "zh" };
}

function provider() {
  return selectedValue("provider") || "local";
}

function providerAvailable(value = provider()) {
  if (!healthState) return false;
  return value === "local"
    ? Boolean(healthState.local?.available)
    : Boolean(healthState.qwenConfigured);
}

function setStatus(text, tone = "idle") {
  elements.statusText.textContent = text;
  elements.status.dataset.tone = tone;
}

function setError(message = "") {
  elements.errorBox.hidden = !message;
  elements.errorBox.textContent = message;
  if (message) setStatus("出现错误", "error");
}

function setControls(running) {
  configured = providerAvailable();
  elements.startButton.disabled = running || !configured;
  elements.stopButton.disabled = !running;
  document.querySelectorAll('input[name="provider"], input[name="direction"], input[name="source"]').forEach((input) => {
    input.disabled = running;
  });
  elements.glossary.disabled = running;
}

function updateProviderUI() {
  const current = provider();
  const available = providerAvailable(current);
  configured = available;
  setError();
  if (current === "local") {
    elements.modelPill.lastChild.textContent = " 本地 MLX + Qwen3";
    elements.modelPill.title = "本地运行，不需要 API Key";
    elements.providerDescription.textContent =
      "MLX Whisper 识别 + Qwen3 1.7B 翻译，音频不离开电脑；按停顿出字幕。";
    elements.privacyText.textContent =
      "本地模式只在这台 Mac 上处理你主动选择的音频，不上传、不保存音频或字幕。";
    if (available) {
      setStatus("本地模式就绪", "ready");
    } else {
      setError("请在终端运行 npm run local；首次使用先运行 npm run local:setup。");
      setStatus("本地模型未启动", "error");
    }
  } else {
    elements.modelPill.lastChild.textContent = " Qwen3.5 LiveTranslate";
    elements.modelPill.title = "云端仅返回文本，节省免费额度";
    elements.providerDescription.textContent =
      "Qwen3.5 LiveTranslate 云端流式翻译，延迟更低；需要百炼免费额度和 API Key。";
    elements.privacyText.textContent =
      "云端模式会把你主动选择的音频经本机代理发送给阿里云百炼；本 Demo 不保存音频或字幕。";
    if (available) {
      setStatus("云端模式就绪", "ready");
    } else {
      setError("请在服务端 .env 中配置 DASHSCOPE_API_KEY 和 QWEN_WORKSPACE_ID，然后重启服务。");
      setStatus("缺少百炼配置", "error");
    }
  }
  setControls(sessionState !== "idle");
}

function parseGlossary(text) {
  const glossary = {};
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 50) throw new Error("术语表最多 50 行。");
  for (const [index, line] of lines.entries()) {
    const separator = line.indexOf("=");
    if (separator < 1 || separator === line.length - 1) {
      throw new Error(`术语表第 ${index + 1} 行格式不正确，应为“原词=译词”。`);
    }
    const source = line.slice(0, separator).trim();
    const target = line.slice(separator + 1).trim();
    glossary[source] = target;
  }
  return glossary;
}

function updateLanguageLabels() {
  const current = direction();
  elements.sourceLabel.textContent =
    current.sourceLanguage === "zh" ? "中文 · 原文" : "English · 原文";
  elements.targetLabel.textContent =
    current.targetLanguage === "zh" ? "中文 · 译文" : "English · 译文";
}

function updateSourceHint() {
  elements.displayHint.hidden = selectedValue("source") !== "display";
}

function resetLiveLines() {
  elements.sourceLive.textContent = "原文会显示在这里";
  elements.sourceLive.classList.add("muted");
  elements.targetLive.textContent = "译文会显示在这里";
  elements.targetLive.classList.add("muted");
}

function clearTranscripts() {
  elements.sourceHistory.replaceChildren();
  elements.targetHistory.replaceChildren();
  resetLiveLines();
  totalInputAudioTokens = 0;
  totalOutputTextTokens = 0;
  elements.usage.textContent = "等待音频";
}

function setLive(element, text, fallback) {
  element.textContent = text || fallback;
  element.classList.toggle("muted", !text);
}

function appendFinal(history, text) {
  if (!text?.trim()) return;
  const paragraph = document.createElement("p");
  paragraph.textContent = text.trim();
  history.append(paragraph);
  history.parentElement.scrollTop = history.parentElement.scrollHeight;
}

function updateUsage(event) {
  if (event.local) {
    const seconds = Number(event.local.audioSeconds || 0).toFixed(1);
    const latency = (Number(event.local.latencyMs || 0) / 1000).toFixed(1);
    elements.usage.textContent = `本句 ${seconds} 秒音频 · 本机处理 ${latency} 秒 · ¥0`;
    return;
  }
  const usage = event.response?.usage;
  if (!usage) return;
  totalInputAudioTokens += usage.input_tokens_details?.audio_tokens || 0;
  totalOutputTextTokens += usage.output_tokens_details?.text_tokens || 0;
  elements.usage.textContent =
    `音频输入 ${totalInputAudioTokens.toLocaleString()} tokens · ` +
    `文本输出 ${totalOutputTextTokens.toLocaleString()} tokens`;
}

function handleServerEvent(event) {
  switch (event.type) {
    case "proxy.connected":
      activeProvider = event.provider || "qwen";
      setStatus(
        activeProvider === "local" ? "正在连接本地模型" : "正在配置 Qwen",
        "working",
      );
      break;
    case "proxy.ready":
      setStatus("正在聆听", "working");
      beginAudioPipeline().catch((error) => abortSession(error.message));
      break;
    case "proxy.processing":
      setStatus("正在本机识别并翻译", "working");
      setLive(elements.sourceLive, "", "正在识别…");
      setLive(elements.targetLive, "", "正在翻译…");
      break;
    case "proxy.flushing":
      setStatus("正在刷新最后一句", "working");
      break;
    case "proxy.finished":
      completeSession();
      break;
    case "proxy.error":
      abortSession(event.message || "翻译服务返回错误。");
      break;
    case "conversation.item.input_audio_transcription.text":
      setLive(
        elements.sourceLive,
        `${event.text || ""}${event.stash || ""}`,
        "正在识别…",
      );
      break;
    case "conversation.item.input_audio_transcription.completed":
      appendFinal(elements.sourceHistory, event.transcript);
      setLive(elements.sourceLive, "", "等待下一句话…");
      break;
    case "response.text.text":
      setLive(
        elements.targetLive,
        `${event.text || ""}${event.stash || ""}`,
        "正在翻译…",
      );
      break;
    case "response.text.done":
      appendFinal(elements.targetHistory, event.text);
      setLive(elements.targetLive, "", "等待下一句话…");
      break;
    case "response.done":
      updateUsage(event);
      if (activeProvider === "local" && sessionState === "running") {
        setStatus("正在聆听", "working");
      }
      break;
    case "error":
      abortSession(event.error?.message || "Qwen 返回错误。");
      break;
    default:
      break;
  }
}

async function acquireMedia() {
  if (selectedValue("source") === "display") {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      preferCurrentTab: false,
      selfBrowserSurface: "exclude",
      systemAudio: "include",
      surfaceSwitching: "include",
    });
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error(
        "没有取得音频轨道。请重新选择一个正在播放声音的 Chrome 标签页，并勾选“分享标签页音频”。",
      );
    }
    stream.getVideoTracks()[0]?.addEventListener("ended", () => stopSession());
    return stream;
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

async function beginAudioPipeline() {
  if (!mediaStream || sessionState !== "starting") return;
  audioContext = new AudioContext({ latencyHint: "interactive" });
  await audioContext.audioWorklet.addModule("/pcm-worklet.js");
  await audioContext.resume();
  audioSource = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, "pcm16-resampler", {
    processorOptions: { targetSampleRate: 16000, chunkMilliseconds: 100 },
  });
  silentSink = audioContext.createGain();
  silentSink.gain.value = 0;
  audioSource.connect(workletNode);
  workletNode.connect(silentSink);
  silentSink.connect(audioContext.destination);
  workletNode.port.onmessage = (event) => {
    if (socket?.readyState === WebSocket.OPEN && sessionState === "running") {
      socket.send(event.data);
    }
  };
  sessionState = "running";
  setControls(true);
}

async function releaseMedia() {
  workletNode?.port.postMessage({ type: "stop" });
  try {
    audioSource?.disconnect();
    workletNode?.disconnect();
    silentSink?.disconnect();
  } catch {
    // Nodes can already be disconnected when a browser revokes capture.
  }
  workletNode = null;
  audioSource = null;
  silentSink = null;
  if (audioContext) await audioContext.close().catch(() => {});
  audioContext = null;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = null;
}

function socketUrl() {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/live`;
}

async function startSession() {
  if (sessionState !== "idle") return;
  setError();
  clearTranscripts();
  let glossary;
  try {
    glossary = parseGlossary(elements.glossary.value);
    mediaStream = await acquireMedia();
  } catch (error) {
    setError(error.message);
    await releaseMedia();
    return;
  }

  const currentDirection = direction();
  sessionState = "starting";
  setControls(true);
  setStatus("正在连接本机代理", "working");
  socket = new WebSocket(socketUrl());
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    socket.send(
      JSON.stringify({
        type: "start",
        provider: provider(),
        ...currentDirection,
        glossary,
      }),
    );
  });
  socket.addEventListener("message", (message) => {
    try {
      handleServerEvent(JSON.parse(message.data));
    } catch {
      abortSession("收到无法解析的服务端消息。");
    }
  });
  socket.addEventListener("error", () => {
    if (!["idle", "finishing"].includes(sessionState)) {
      abortSession("无法连接本机翻译服务。");
    }
  });
  socket.addEventListener("close", () => {
    if (!["idle", "finishing"].includes(sessionState)) {
      abortSession("翻译连接已关闭。");
    }
  });
}

async function stopSession() {
  if (!["starting", "running"].includes(sessionState)) return;
  sessionState = "finishing";
  setControls(true);
  await releaseMedia();
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "finish" }));
  } else {
    completeSession();
  }
}

async function completeSession() {
  await releaseMedia();
  if (socket?.readyState === WebSocket.OPEN) socket.close(1000);
  socket = null;
  sessionState = "idle";
  setControls(false);
  setStatus(configured ? "就绪" : "服务未配置", configured ? "ready" : "error");
  updateProviderUI();
}

async function abortSession(message) {
  await releaseMedia();
  if (socket?.readyState === WebSocket.OPEN) socket.close(1011);
  socket = null;
  sessionState = "idle";
  setControls(false);
  setError(message);
}

async function checkHealth() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    const health = await response.json();
    healthState = health;
    updateProviderUI();
  } catch {
    healthState = null;
    configured = false;
    setError("无法读取本机服务状态，请确认服务已经启动。");
  }
}

elements.startButton.addEventListener("click", startSession);
elements.stopButton.addEventListener("click", stopSession);
elements.clearButton.addEventListener("click", clearTranscripts);
document.querySelectorAll('input[name="direction"]').forEach((input) => {
  input.addEventListener("change", updateLanguageLabels);
});
document.querySelectorAll('input[name="source"]').forEach((input) => {
  input.addEventListener("change", updateSourceHint);
});
document.querySelectorAll('input[name="provider"]').forEach((input) => {
  input.addEventListener("change", updateProviderUI);
});
window.addEventListener("beforeunload", () => {
  mediaStream?.getTracks().forEach((track) => track.stop());
  if (socket?.readyState === WebSocket.OPEN) socket.close();
});

updateLanguageLabels();
updateSourceHint();
clearTranscripts();
checkHealth();
