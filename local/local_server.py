#!/usr/bin/env python3
"""Local Chinese-English speech recognition and translation service for Apple Silicon."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import numpy as np


DEFAULT_ASR_MODEL = "mlx-community/whisper-small-mlx"
DEFAULT_TRANSLATION_MODEL = "Qwen/Qwen3-1.7B-MLX-4bit"
MAX_REQUEST_BYTES = 2 * 1024 * 1024


class LocalModels:
    def __init__(self, asr_model: str, translation_model: str) -> None:
        self.asr_model_name = asr_model
        self.translation_model_name = translation_model
        self.asr_loaded = False
        self.translation_loaded = False
        self._translation_model = None
        self._tokenizer = None
        self._lock = threading.Lock()

    def load_asr(self) -> None:
        if self.asr_loaded:
            return
        import mlx_whisper

        # A short silent array forces weights to download and initialize.
        mlx_whisper.transcribe(
            np.zeros(1600, dtype=np.float32),
            path_or_hf_repo=self.asr_model_name,
            language="en",
            task="transcribe",
            temperature=0.0,
            condition_on_previous_text=False,
            verbose=False,
        )
        self.asr_loaded = True

    def load_translation(self) -> None:
        if self.translation_loaded:
            return
        from mlx_lm import load

        self._translation_model, self._tokenizer = load(
            self.translation_model_name,
        )
        self.translation_loaded = True

    def preload(self) -> None:
        print(f"Downloading/loading ASR model: {self.asr_model_name}", flush=True)
        self.load_asr()
        print(
            f"Downloading/loading translation model: {self.translation_model_name}",
            flush=True,
        )
        self.load_translation()
        print("Local models are ready.", flush=True)

    def transcribe(
        self,
        pcm16: bytes,
        language: str,
        sample_rate: int,
        glossary: dict[str, str],
    ) -> str:
        if sample_rate != 16000:
            raise ValueError("Only 16 kHz PCM audio is supported.")
        if len(pcm16) < 2 or len(pcm16) % 2:
            raise ValueError("Audio must be non-empty little-endian PCM16.")
        import mlx_whisper

        self.load_asr()
        samples = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        result = mlx_whisper.transcribe(
            samples,
            path_or_hf_repo=self.asr_model_name,
            language=language,
            task="transcribe",
            initial_prompt=", ".join(glossary.keys()) or None,
            temperature=0.0,
            condition_on_previous_text=False,
            no_speech_threshold=0.6,
            verbose=False,
        )
        return str(result.get("text", "")).strip()

    def translate(
        self,
        text: str,
        source_language: str,
        target_language: str,
        glossary: dict[str, str],
    ) -> str:
        from mlx_lm import generate
        from mlx_lm.sample_utils import make_sampler

        self.load_translation()
        source_name = "Chinese" if source_language == "zh" else "English"
        target_name = "Chinese" if target_language == "zh" else "English"
        glossary_lines = "\n".join(
            f"- {source} => {target}" for source, target in glossary.items()
        )
        glossary_instruction = (
            f"\nUse these required term mappings:\n{glossary_lines}"
            if glossary_lines
            else ""
        )
        messages = [
            {
                "role": "system",
                "content": (
                    "You are a precise meeting subtitle translator. "
                    f"Translate from {source_name} to {target_name}. "
                    "Return only the translation, with no explanation, labels, "
                    "analysis, quotation marks, or extra text. Preserve names, "
                    "numbers, and meaning."
                    f"{glossary_instruction}"
                ),
            },
            {"role": "user", "content": text},
        ]
        try:
            prompt = self._tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
                enable_thinking=False,
            )
        except TypeError:
            prompt = self._tokenizer.apply_chat_template(
                messages,
                tokenize=False,
                add_generation_prompt=True,
            )
        output = generate(
            self._translation_model,
            self._tokenizer,
            prompt,
            max_tokens=256,
            sampler=make_sampler(temp=0.0),
            verbose=False,
        ).strip()
        output = re.sub(r"(?s)^.*?</think>\s*", "", output).strip()
        return output

    def process(self, request: dict[str, Any]) -> dict[str, Any]:
        source = request.get("sourceLanguage")
        target = request.get("targetLanguage")
        if source not in {"zh", "en"} or target not in {"zh", "en"}:
            raise ValueError("Only Chinese (zh) and English (en) are supported.")
        if source == target:
            raise ValueError("Source and target language must differ.")
        glossary = request.get("glossary") or {}
        if not isinstance(glossary, dict) or len(glossary) > 50:
            raise ValueError("Glossary must be an object with at most 50 entries.")
        try:
            pcm16 = base64.b64decode(request["audio"], validate=True)
        except (KeyError, ValueError) as error:
            raise ValueError("audio must be valid Base64 PCM16.") from error
        sample_rate = int(request.get("sampleRate", 16000))

        started = time.perf_counter()
        with self._lock:
            transcript = self.transcribe(pcm16, source, sample_rate, glossary)
            translation = (
                self.translate(transcript, source, target, glossary)
                if transcript
                else ""
            )
        return {
            "ok": True,
            "transcript": transcript,
            "translation": translation,
            "audioSeconds": round(len(pcm16) / 2 / sample_rate, 3),
            "latencyMs": round((time.perf_counter() - started) * 1000),
        }


def make_handler(models: LocalModels):
    class Handler(BaseHTTPRequestHandler):
        server_version = "LocalQwenTranslate/1.0"

        def send_json(self, status: int, body: dict[str, Any]) -> None:
            encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(encoded)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(encoded)

        def do_GET(self) -> None:
            if self.path != "/health":
                self.send_json(404, {"error": "Not found"})
                return
            self.send_json(
                200,
                {
                    "ok": True,
                    "provider": "local-mlx",
                    "asrModel": models.asr_model_name,
                    "translationModel": models.translation_model_name,
                    "modelsLoaded": models.asr_loaded and models.translation_loaded,
                },
            )

        def do_POST(self) -> None:
            if self.path != "/translate":
                self.send_json(404, {"error": "Not found"})
                return
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
                if content_length <= 0 or content_length > MAX_REQUEST_BYTES:
                    raise ValueError("Request body is empty or too large.")
                request = json.loads(self.rfile.read(content_length))
                self.send_json(200, models.process(request))
            except (ValueError, TypeError, json.JSONDecodeError) as error:
                self.send_json(400, {"ok": False, "error": str(error)})
            except Exception as error:  # Keep model failures visible to the local user.
                print(f"Model error: {error}", flush=True)
                self.send_json(500, {"ok": False, "error": str(error)})

        def log_message(self, format: str, *args: Any) -> None:
            if os.environ.get("LOCAL_TRANSLATOR_VERBOSE") == "1":
                super().log_message(format, *args)

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--preload-only", action="store_true")
    args = parser.parse_args()

    models = LocalModels(
        os.environ.get("LOCAL_ASR_MODEL", DEFAULT_ASR_MODEL),
        os.environ.get("LOCAL_QWEN_MODEL", DEFAULT_TRANSLATION_MODEL),
    )
    if args.preload_only:
        models.preload()
        return

    server = ThreadingHTTPServer((args.host, args.port), make_handler(models))
    print(
        f"Local MLX model service: http://{args.host}:{args.port} "
        "(models load on the first utterance)",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
