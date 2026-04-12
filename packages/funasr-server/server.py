"""Standalone FunASR server for Chinese/English/Japanese speech-to-text.

Uses SenseVoiceSmall (234M) with Apple Silicon MPS acceleration.
Provides:
- POST /transcribe — batch transcription (file upload)
- WS /ws/transcribe — streaming hybrid transcription (timer + silence)
- GET /health — readiness check
"""

import asyncio
import io
import json
import logging
import os
import re
import tempfile
import threading
import time
import wave
from contextlib import asynccontextmanager
from typing import Optional

import numpy as np
import uvicorn
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

logger = logging.getLogger("funasr-server")

asr_model: Optional[object] = None
vad_model: Optional[object] = None

SAMPLE_RATE = 16000
MIN_SPEECH_SAMPLES = int(0.3 * SAMPLE_RATE)  # 300ms minimum

# --- Streaming config (env var overridable) ---
TIMER_INTERVAL_S = float(os.environ.get("FUNASR_TIMER_INTERVAL", "1.5"))
SILENCE_THRESHOLD = int(os.environ.get("FUNASR_SILENCE_THRESHOLD", "500"))
SILENCE_DURATION_MS = int(os.environ.get("FUNASR_SILENCE_DURATION_MS", "600"))
SILENCE_DURATION_SAMPLES = int(SILENCE_DURATION_MS * SAMPLE_RATE / 1000)
OVERLAP_S = float(os.environ.get("FUNASR_OVERLAP", "0.5"))
OVERLAP_SAMPLES = int(OVERLAP_S * SAMPLE_RATE)

_SENSEVOICE_TAG_RE = re.compile(r"<\|[^|]*\|>")


def _clean(text: str) -> str:
    return _SENSEVOICE_TAG_RE.sub("", text).strip()


def _pcm_to_wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm)
    return buf.getvalue()


def _transcribe(samples: np.ndarray) -> str:
    """Transcribe int16 samples. Thread-safe (called from ASR thread)."""
    if len(samples) < MIN_SPEECH_SAMPLES:
        return ""
    wav = _pcm_to_wav(samples.tobytes())
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav)
        path = f.name
    try:
        r = asr_model.generate(input=path, language="auto", use_itn=True)
        if r and isinstance(r, list) and len(r) > 0:
            e = r[0]
            return _clean(e.get("text", "") if isinstance(e, dict) else str(e))
    finally:
        os.unlink(path)
    return ""


def _transcribe_vad(samples: np.ndarray) -> str:
    """VAD + per-segment ASR. Thread-safe."""
    if len(samples) < MIN_SPEECH_SAMPLES:
        return ""
    wav = _pcm_to_wav(samples.tobytes())
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(wav)
        path = f.name
    try:
        vr = vad_model.generate(input=path)
    except Exception:
        os.unlink(path)
        raise
    segs = vr[0].get("value", []) if vr and isinstance(vr, list) and len(vr) > 0 else []
    if not segs:
        os.unlink(path)
        return ""
    texts = []
    for s, e in segs:
        si, ei = int(s * SAMPLE_RATE / 1000), int(e * SAMPLE_RATE / 1000)
        seg = samples[si:ei]
        if len(seg) > 0:
            t = _transcribe(seg)
            if t:
                texts.append(t)
    os.unlink(path)
    return "".join(texts)


def _resolve_device() -> str:
    try:
        import torch
        if torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


class SilenceDetector:
    def __init__(self):
        self.speech_active = False
        self.silence_count = 0
        self.speech_start = 0

    def feed(self, samples: np.ndarray, offset: int) -> list[tuple[int, int]]:
        boundaries = []
        w = int(SAMPLE_RATE * 0.03)
        for i in range(0, len(samples), w):
            chunk = samples[i:i + w]
            if len(chunk) == 0:
                continue
            peak = int(np.max(np.abs(chunk)))
            pos = offset + i
            if not self.speech_active:
                if peak >= SILENCE_THRESHOLD:
                    self.speech_active = True
                    self.speech_start = pos
                    self.silence_count = 0
            else:
                if peak < SILENCE_THRESHOLD:
                    self.silence_count += len(chunk)
                    if self.silence_count >= SILENCE_DURATION_SAMPLES:
                        end = pos - self.silence_count + len(chunk)
                        boundaries.append((self.speech_start, end))
                        self.speech_active = False
                        self.silence_count = 0
                else:
                    self.silence_count = 0
        return boundaries


@asynccontextmanager
async def lifespan(app: FastAPI):
    global asr_model, vad_model
    from funasr import AutoModel
    device = _resolve_device()
    logger.info(f"Using device: {device}")
    logger.info("Loading VAD model...")
    vad_model = AutoModel(model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch", disable_update=True)
    logger.info("Loading SenseVoiceSmall model...")
    asr_model = AutoModel(model="iic/SenseVoiceSmall", trust_remote_code=True, device=device, disable_update=True)
    logger.info(f"Models loaded (ASR on {device}, timer={TIMER_INTERVAL_S}s, silence={SILENCE_DURATION_MS}ms)")
    yield
    asr_model = None
    vad_model = None


app = FastAPI(title="FunASR Server", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": asr_model is not None and vad_model is not None}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    if asr_model is None or vad_model is None:
        return JSONResponse(status_code=503, content={"error": "Models not loaded"})
    audio = await file.read()
    is_pcm = (file.content_type and "pcm" in file.content_type) or (
        file.filename and file.filename.endswith(".pcm"))
    if is_pcm:
        audio = _pcm_to_wav(audio)
    buf = io.BytesIO(audio)
    with wave.open(buf, "rb") as wf:
        frames = wf.readframes(wf.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16)
    text = _transcribe_vad(samples)
    return {"text": text}


@app.websocket("/ws/transcribe")
async def ws_transcribe(ws: WebSocket):
    """Streaming hybrid transcription.

    ASR runs in a dedicated thread so it never blocks WebSocket IO.
    The main asyncio loop receives audio and manages state; the ASR
    thread picks up transcription requests from a queue.
    """
    await ws.accept()
    if asr_model is None or vad_model is None:
        await ws.send_json({"type": "error", "error": "Models not loaded"})
        await ws.close()
        return

    loop = asyncio.get_event_loop()

    # Shared state (protected by lock)
    lock = threading.Lock()
    all_samples: list[np.ndarray] = []
    total_samples = 0
    committed: list[str] = []
    current_text = ""
    sentence_start = 0
    last_timer_at = 0
    last_sent_text = ""

    detector = SilenceDetector()
    finished_event = threading.Event()

    # Queue of ASR requests: ("timer", chunk) or ("silence", seg) or ("final", full)
    asr_queue: list[tuple[str, np.ndarray]] = []
    asr_has_work = threading.Event()

    # Results queue: (kind, text) to be sent as partials/finals
    result_queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()

    def asr_worker():
        """Dedicated ASR thread — processes requests sequentially."""
        while True:
            asr_has_work.wait()
            asr_has_work.clear()

            while True:
                with lock:
                    if not asr_queue:
                        break
                    kind, samples_arr = asr_queue.pop(0)

                if kind == "timer":
                    text = _transcribe(samples_arr)
                    loop.call_soon_threadsafe(result_queue.put_nowait, ("timer", text))
                elif kind == "silence":
                    text = _transcribe(samples_arr)
                    loop.call_soon_threadsafe(result_queue.put_nowait, ("silence", text))
                elif kind == "final":
                    text = _transcribe_vad(samples_arr)
                    loop.call_soon_threadsafe(result_queue.put_nowait, ("final", text))

            if finished_event.is_set():
                # Check if queue is truly empty
                with lock:
                    if not asr_queue:
                        break

    worker = threading.Thread(target=asr_worker, daemon=True)
    worker.start()

    def _enqueue(kind: str, arr: np.ndarray):
        with lock:
            asr_queue.append((kind, arr.copy()))
        asr_has_work.set()

    def _check_timer():
        nonlocal last_timer_at
        with lock:
            ts = total_samples
            ss = sentence_start
            lt = last_timer_at
        if ts - lt < int(TIMER_INTERVAL_S * SAMPLE_RATE):
            return
        if not all_samples:
            return
        with lock:
            full = np.concatenate(all_samples)
            chunk_start = max(0, ss - OVERLAP_SAMPLES)
            chunk = full[chunk_start:ts]
            last_timer_at = ts
        if len(chunk) >= MIN_SPEECH_SAMPLES:
            _enqueue("timer", chunk)

    def _check_silence(new_samples: np.ndarray, offset: int):
        boundaries = detector.feed(new_samples, offset)
        for bstart, bend in boundaries:
            with lock:
                full = np.concatenate(all_samples)
                seg = full[bstart:bend]
            if len(seg) >= MIN_SPEECH_SAMPLES:
                _enqueue("silence", seg)
            with lock:
                nonlocal sentence_start, last_timer_at, current_text
                sentence_start = total_samples
                last_timer_at = total_samples
                current_text = ""

    async def process_results():
        """Process ASR results and send to WebSocket."""
        nonlocal current_text, last_sent_text
        while True:
            try:
                kind, text = await asyncio.wait_for(result_queue.get(), timeout=0.05)
            except asyncio.TimeoutError:
                return  # no results right now

            if kind == "timer":
                if text:
                    with lock:
                        current_text = text
            elif kind == "silence":
                with lock:
                    current_text = ""
                    if text:
                        committed.append(text)
            elif kind == "final":
                await ws.send_json({"type": "final", "text": text})
                return

            # Send partial
            with lock:
                parts = committed[:]
                if current_text:
                    parts.append(current_text)
            partial = "".join(parts)
            if partial and partial != last_sent_text:
                last_sent_text = partial
                await ws.send_json({"type": "partial", "text": partial})

    try:
        while True:
            # Process any pending ASR results
            await process_results()

            try:
                message = await asyncio.wait_for(ws.receive(), timeout=0.05)
            except asyncio.TimeoutError:
                _check_timer()
                continue

            if message["type"] == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"]:
                pcm = message["bytes"]
                samples_arr = np.frombuffer(pcm, dtype=np.int16)
                offset = total_samples
                with lock:
                    all_samples.append(samples_arr)
                    total_samples += len(samples_arr)

                _check_silence(samples_arr, offset)
                _check_timer()

            elif "text" in message and message["text"]:
                try:
                    data = json.loads(message["text"])
                except json.JSONDecodeError:
                    continue

                if data.get("type") == "finish":
                    with lock:
                        if all_samples:
                            full = np.concatenate(all_samples)
                        else:
                            full = np.array([], dtype=np.int16)
                    _enqueue("final", full)
                    finished_event.set()
                    asr_has_work.set()

                    # Wait for final result
                    while True:
                        kind, text = await result_queue.get()
                        if kind == "final":
                            await ws.send_json({"type": "final", "text": text})
                            break
                        # Process any remaining partials
                        if kind == "timer" and text:
                            with lock:
                                current_text = text
                        elif kind == "silence":
                            with lock:
                                current_text = ""
                                if text:
                                    committed.append(text)
                        with lock:
                            parts = committed[:]
                            if current_text:
                                parts.append(current_text)
                        partial = "".join(parts)
                        if partial and partial != last_sent_text:
                            last_sent_text = partial
                            await ws.send_json({"type": "partial", "text": partial})
                    break

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await ws.send_json({"type": "error", "error": str(e)})
        except Exception:
            pass
    finally:
        finished_event.set()
        asr_has_work.set()
        try:
            await ws.close()
        except Exception:
            pass


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="127.0.0.1", port=10095)
