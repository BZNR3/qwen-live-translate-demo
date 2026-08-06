# Local Chinese-English Meeting Translator (MLX + Qwen3)

A working Chinese-English speech translation demo for Apple Silicon Macs. It captures microphone audio or audio from a Chrome meeting/video tab, then displays the transcript and translation as bilingual subtitles in the browser.

The default mode runs entirely on your Mac and does not require OpenAI, Alibaba Cloud, or another paid API:

```text
Microphone / Chrome tab audio
              ↓ 16 kHz PCM
Silence-based utterance segmentation (~0.8-second pause)
              ↓
MLX Whisper Small: Chinese/English speech recognition
              ↓
Qwen3 1.7B 4-bit: Chinese ↔ English translation
              ↓
Bilingual subtitles in the browser
```

An optional Alibaba Cloud Model Studio mode using `Qwen3.5 LiveTranslate` is included for comparing true streaming interpretation latency. It requires a cloud API key and is not the permanently free default.

## Why these models?

| Stage | Default model | Approx. size | Why it was selected |
| --- | --- | ---: | --- |
| Speech recognition | `mlx-community/whisper-small-mlx` | 459 MB | Reliable Chinese and English recognition; MLX uses Apple Silicon unified memory and GPU acceleration |
| Translation | `Qwen/Qwen3-1.7B-MLX-4bit` | 914 MB | Official Qwen 4-bit MLX weights, Apache 2.0, compact, and multilingual |
| Optional cloud mode | `qwen3.5-livetranslate-flash-realtime` | No local weights | Dedicated real-time translation model with streaming transcripts and translations |

Qwen also provides the open-source `Qwen3-ASR-0.6B/1.7B` models for 52 languages and dialects. Their high-performance streaming path mainly targets vLLM/CUDA. MLX Whisper is easier to run reliably on an Apple Silicon Mac, so this demo uses a two-stage Whisper + Qwen architecture. On an NVIDIA Linux server, the recognition layer can later be replaced with Qwen3-ASR.

Local inference means no API bill, but it is not resource-free. The default models require about 1.4 GB of downloads, disk space, memory, and local compute. After downloading the weights, local mode can run offline.

## Verified results

Real inference was tested on a 16 GB Apple Silicon Mac using clean system-generated speech rather than mocks:

- 3.50-second English sample
  - Transcript: `Good morning, today we will review the local translation demo.`
  - Translation: `Good morning. Today we will review the local translation demo.` translated into Chinese
  - Completed in about 4.6 seconds after the first model load
- 4.34-second Chinese sample
  - Transcript: a short greeting about testing local Chinese-English meeting translation
  - Translation: `Hello everyone, today we are testing the local Chinese-to-English translation meeting.`
  - Completed in about 0.6 seconds after model warm-up

These are functional checks, not a formal benchmark. Noise, overlapping speakers, accents, microphone quality, and device temperature will affect accuracy and latency.

## Five-minute local setup

### 1. Requirements

- Apple Silicon Mac (M1 or newer)
- macOS 13.5 or newer
- Python 3.10–3.13
- Node.js 20 or newer
- Chrome (recommended for tab-audio capture)
- Internet access for the first installation and model download

Check your installed versions:

```bash
python3 --version
node --version
```

### 2. Clone the repository and install web dependencies

Because this repository is private, GitHub authentication is required when cloning it.

```bash
git clone https://github.com/BZNR3/qwen-live-translate-demo.git
cd qwen-live-translate-demo
npm install
```

### 3. Create the Python environment

```bash
npm run local:setup
```

This creates `.venv` inside the project and installs `mlx-whisper` and `mlx-lm`. The virtual environment is ignored by Git.

If `python3` is not Python 3.10–3.13, create the environment with a compatible interpreter:

```bash
/path/to/python3.12 -m venv .venv
.venv/bin/pip install -r local/requirements.txt
```

### 4. Download the models in advance (recommended)

```bash
npm run local:download
```

This downloads and preloads about 1.4 GB of model weights. You may skip this step, but the first translation will then wait for the download.

### 5. Start both services

```bash
npm run local
```

The command starts:

- Local MLX inference service: `http://127.0.0.1:8765`
- Demo website and WebSocket proxy: `http://127.0.0.1:8787`

Open the demo in Chrome:

```text
http://127.0.0.1:8787
```

You can begin when the page shows **Local mode ready**. Press `Ctrl+C` in the terminal to stop both services.

## Using the app

### Translate microphone audio

1. Keep **Run mode** set to **Fully local · No API fees**.
2. Choose **English → Chinese** or **Chinese → English**.
3. Set **Audio source** to **Microphone**.
4. Optionally enter glossary mappings, one per line:

   ```text
Model Studio=Alibaba Cloud Model Studio
Qwen=Qwen
   ```

5. Select **Start translation** and allow Chrome to use the microphone.
6. Speak a complete sentence and pause for about one second.
7. Select **Stop and flush final sentence** to finish the current session.

Local mode is utterance-based rather than word-by-word streaming. It submits an utterance after roughly 0.8 seconds of silence, with a maximum utterance length of 15 seconds. Short sentences, clear pauses, and a headset microphone work best.

### Translate a Teams, Zoom, or Meet web meeting

1. Open the meeting or video in a Chrome tab.
2. In the demo, select **Tab / system audio**.
3. Select **Start translation**.
4. In Chrome's sharing dialog, choose the **Chrome tab** that is playing audio.
5. Enable **Share tab audio**.

Chrome requires a video sharing track to initiate tab capture, but the demo neither reads nor uploads video frames. It only processes audio.

A browser cannot reliably capture system audio from the native Teams or Zoom desktop apps. The most dependable prototype workflow is a web meeting or Chrome video tab. A production macOS desktop app should use ScreenCaptureKit; Windows should use WASAPI Loopback.

## Glossary behavior and limitations

- Source terms are passed to Whisper as recognition hints and to Qwen as required translation mappings.
- Use `source term=target term`, one mapping per line, with a maximum of 50 entries.
- A glossary improves names, product terms, and abbreviations, but a small ASR model can still mishear rare terms. A production version should add spelling correction or use a larger ASR model.

## Optional Qwen cloud streaming mode

Cloud mode is not permanently free. It is included because its end-to-end streaming latency is lower than the local utterance-based pipeline.

### Configuration

1. Create a workspace and API key in the Singapore region of Alibaba Cloud Model Studio.
2. Copy the environment template:

   ```bash
   cp .env.example .env
   ```

3. Edit `.env`:

   ```dotenv
   DASHSCOPE_API_KEY=sk-your-real-key
   QWEN_WORKSPACE_ID=your-real-workspace-id
   QWEN_REGION=singapore
   ```

4. Run `npm run local` to keep both providers available, or `npm start` for the web proxy only.
5. Select **Model Studio cloud · Trial quota** in the app.

The API key remains on the Node server and is never sent to the browser. Cloud mode sends the selected audio to Alibaba Cloud Model Studio; local mode does not.

## Configuration reference

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `LOCAL_ASR_MODEL` | `mlx-community/whisper-small-mlx` | Override the local ASR model |
| `LOCAL_QWEN_MODEL` | `Qwen/Qwen3-1.7B-MLX-4bit` | Override the local translation model |
| `LOCAL_TRANSLATOR_URL` | `http://127.0.0.1:8765` | URL used by Node to reach the local model service |
| `DASHSCOPE_API_KEY` | Empty | API key for the optional cloud provider |
| `QWEN_WORKSPACE_ID` | Empty | Alibaba Cloud Model Studio workspace ID |
| `QWEN_REGION` | `singapore` | `singapore` or `beijing` |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Demo web server bind address |

For higher translation quality, a 16 GB Mac can try a larger 4-bit Qwen model:

```bash
LOCAL_QWEN_MODEL=Qwen/Qwen3-4B-MLX-4bit npm run local
```

The larger model uses more memory and disk space and may increase latency, so it is not downloaded by default.

## Tests

```bash
npm test
```

The six automated tests do not call a cloud API. They cover:

- `.env` parsing
- Chinese/English and provider validation
- Local volume and silence-based utterance segmentation
- Browser → local model service → subtitle proxy flow with a fake model service
- Qwen cloud session configuration
- PCM forwarding, authorization, and final-utterance flushing

Real local Chinese-English inference was also tested manually, as described above.

## Troubleshooting

### The page says “Local model service is not running”

Local mode requires both services. Run:

```bash
npm run local
```

For a first-time installation, run `npm run local:setup` first.

### The first subtitle is slow

The first request loads about 1.4 GB of weights from disk. If they have not been downloaded, it also connects to Hugging Face. Run `npm run local:download` before starting the demo. Warm requests should be much faster.

### The page remains on “Listening”

- Pause for about one second after speaking.
- Verify that Chrome has microphone or tab-audio permission.
- Increase the meeting playback volume if it is too quiet.
- Ensure **Share tab audio** is enabled in Chrome's sharing dialog.

### Recognition is correct but the translation sounds unnatural

The 1.7B model is a lightweight local compromise. Add glossary mappings first; if quality is still insufficient, use the 4B model or compare with Qwen3.5 LiveTranslate cloud mode.

### Can it listen directly to the Teams or Zoom desktop app?

This browser prototype cannot guarantee it. Use the web meeting first. A production desktop app requires a native audio-capture layer, while the existing model service and subtitle UI can remain.

## Privacy and production boundaries

- Local mode listens only on `127.0.0.1` and does not upload or persist audio or subtitles.
- The browser captures only a source explicitly authorized by the user.
- Obtain participant consent and follow applicable law and company policy before recording or transcribing a meeting.
- This demo does not include accounts, permissions, subtitle export, speaker diarization, meeting history, or an installer.
- A production version also needs code signing, automatic updates, crash recovery, device selection, echo handling, speaker diarization, and data-retention controls.

## Project structure

```text
server.mjs                 Web server, WebSocket proxy, segmentation, and provider routing
public/                    Browser UI, audio capture, and 16 kHz PCM resampling
local/local_server.py      Local MLX Whisper + Qwen3 inference service
scripts/start-local.mjs    Starts and stops both local services
test/server.test.mjs       Node integration tests
```

## Official references

- [Apple MLX](https://github.com/ml-explore/mlx)
- [MLX Whisper example](https://github.com/ml-explore/mlx-examples/tree/main/whisper)
- [MLX LM](https://github.com/ml-explore/mlx-lm)
- [Official Qwen3 1.7B MLX 4-bit weights](https://huggingface.co/Qwen/Qwen3-1.7B-MLX-4bit)
- [Qwen3-ASR project](https://github.com/QwenLM/Qwen3-ASR)
- [Qwen3.5 LiveTranslate documentation](https://www.alibabacloud.com/help/en/model-studio/qwen3-5-livetranslate-flash-realtime)
- [Alibaba Cloud Model Studio pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing)
