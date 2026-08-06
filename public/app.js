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
  if (message) setStatus("Error", "error");
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
    elements.modelPill.lastChild.textContent = " Local MLX + Qwen3";
    elements.modelPill.title = "Runs locally without an API key";
    elements.providerDescription.textContent =
      "MLX Whisper recognition + Qwen3 1.7B translation. Audio stays on this Mac and subtitles appear after each pause.";
    elements.privacyText.textContent =
      "Local mode processes only the audio you choose on this Mac. It does not upload or save audio or subtitles.";
    if (available) {
      setStatus("Local mode ready", "ready");
    } else {
      setError("Run npm run local in a terminal. For first-time setup, run npm run local:setup first.");
      setStatus("Local model service is not running", "error");
    }
  } else {
    elements.modelPill.lastChild.textContent = " Qwen3.5 LiveTranslate";
    elements.modelPill.title = "Cloud mode returns text only to reduce quota usage";
    elements.providerDescription.textContent =
      "Qwen3.5 LiveTranslate provides lower-latency cloud streaming and requires a Model Studio API key and quota.";
    elements.privacyText.textContent =
      "Cloud mode sends the audio you choose to Alibaba Cloud Model Studio through the local proxy. This demo does not save audio or subtitles.";
    if (available) {
      setStatus("Cloud mode ready", "ready");
    } else {
      setError("Set DASHSCOPE_API_KEY and QWEN_WORKSPACE_ID in the server-side .env file, then restart the service.");
      setStatus("Cloud configuration missing", "error");
    }
  }
  setControls(sessionState !== "idle");
}

function parseGlossary(text) {
  const glossary = {};
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > 50) throw new Error("The glossary can contain at most 50 lines.");
  for (const [index, line] of lines.entries()) {
    const separator = line.indexOf("=");
    if (separator < 1 || separator === line.length - 1) {
      throw new Error(`Glossary line ${index + 1} is invalid. Use “source term=target term”.`);
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
    current.sourceLanguage === "zh" ? "Chinese · Transcript" : "English · Transcript";
  elements.targetLabel.textContent =
    current.targetLanguage === "zh" ? "Chinese · Translation" : "English · Translation";
}

function updateSourceHint() {
  elements.displayHint.hidden = selectedValue("source") !== "display";
}

function resetLiveLines() {
  elements.sourceLive.textContent = "The transcript will appear here";
  elements.sourceLive.classList.add("muted");
  elements.targetLive.textContent = "The translation will appear here";
  elements.targetLive.classList.add("muted");
}

function clearTranscripts() {
  elements.sourceHistory.replaceChildren();
  elements.targetHistory.replaceChildren();
  resetLiveLines();
  totalInputAudioTokens = 0;
  totalOutputTextTokens = 0;
  elements.usage.textContent = "Waiting for audio";
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
    elements.usage.textContent = `${seconds}s audio · ${latency}s local processing · $0 API cost`;
    return;
  }
  const usage = event.response?.usage;
  if (!usage) return;
  totalInputAudioTokens += usage.input_tokens_details?.audio_tokens || 0;
  totalOutputTextTokens += usage.output_tokens_details?.text_tokens || 0;
  elements.usage.textContent =
    `Audio input ${totalInputAudioTokens.toLocaleString()} tokens · ` +
    `Text output ${totalOutputTextTokens.toLocaleString()} tokens`;
}

function handleServerEvent(event) {
  switch (event.type) {
    case "proxy.connected":
      activeProvider = event.provider || "qwen";
      setStatus(
        activeProvider === "local" ? "Connecting to local models" : "Configuring Qwen",
        "working",
      );
      break;
    case "proxy.ready":
      setStatus("Listening", "working");
      beginAudioPipeline().catch((error) => abortSession(error.message));
      break;
    case "proxy.processing":
      setStatus("Recognizing and translating locally", "working");
      setLive(elements.sourceLive, "", "Recognizing…");
      setLive(elements.targetLive, "", "Translating…");
      break;
    case "proxy.flushing":
      setStatus("Flushing the final sentence", "working");
      break;
    case "proxy.finished":
      completeSession();
      break;
    case "proxy.error":
      abortSession(event.message || "The translation service returned an error.");
      break;
    case "conversation.item.input_audio_transcription.text":
      setLive(
        elements.sourceLive,
        `${event.text || ""}${event.stash || ""}`,
        "Recognizing…",
      );
      break;
    case "conversation.item.input_audio_transcription.completed":
      appendFinal(elements.sourceHistory, event.transcript);
      setLive(elements.sourceLive, "", "Waiting for the next sentence…");
      break;
    case "response.text.text":
      setLive(
        elements.targetLive,
        `${event.text || ""}${event.stash || ""}`,
        "Translating…",
      );
      break;
    case "response.text.done":
      appendFinal(elements.targetHistory, event.text);
      setLive(elements.targetLive, "", "Waiting for the next sentence…");
      break;
    case "response.done":
      updateUsage(event);
      if (activeProvider === "local" && sessionState === "running") {
        setStatus("Listening", "working");
      }
      break;
    case "error":
      abortSession(event.error?.message || "Qwen returned an error.");
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
        "No audio track was captured. Choose a Chrome tab that is playing audio and enable “Share tab audio”.",
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
  setStatus("Connecting to the local proxy", "working");
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
      abortSession("Received an invalid message from the server.");
    }
  });
  socket.addEventListener("error", () => {
    if (!["idle", "finishing"].includes(sessionState)) {
      abortSession("Could not connect to the local translation service.");
    }
  });
  socket.addEventListener("close", () => {
    if (!["idle", "finishing"].includes(sessionState)) {
      abortSession("The translation connection closed unexpectedly.");
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
  setStatus(configured ? "Ready" : "Service not configured", configured ? "ready" : "error");
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
    setError("Could not read the local service status. Confirm that the service is running.");
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
