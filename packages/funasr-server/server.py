"""Standalone FunASR server for Chinese/English/Japanese speech-to-text.

Uses SenseVoiceSmall (234M) with Apple Silicon MPS acceleration.
Provides:
- POST /transcribe — batch transcription (file upload)
- WS /ws/transcribe — streaming 2-pass transcription
- GET /health — readiness check
"""

import io
import json
import logging
import os
import re
import tempfile
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

# SenseVoiceSmall adds special tags like <|zh|><|NEUTRAL|><|Speech|><|withitn|>
_SENSEVOICE_TAG_RE = re.compile(r"<\|[^|]*\|>")


def _clean_sensevoice_text(text: str) -> str:
    """Remove SenseVoiceSmall's special tags from output."""
    return _SENSEVOICE_TAG_RE.sub("", text).strip()


def _wrap_pcm_in_wav(pcm_bytes: bytes, sample_rate: int = 16000, channels: int = 1, sample_width: int = 2) -> bytes:
    """Wrap raw PCM data in a WAV header."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


def _read_wav_as_int16(wav_bytes: bytes) -> np.ndarray:
    """Read WAV bytes and return mono int16 numpy array."""
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, "rb") as wf:
        assert wf.getnchannels() == 1, "Expected mono audio"
        assert wf.getsampwidth() == 2, "Expected 16-bit audio"
        frames = wf.readframes(wf.getnframes())
    return np.frombuffer(frames, dtype=np.int16)


def _extract_segment(samples: np.ndarray, start_ms: int, end_ms: int, sample_rate: int) -> np.ndarray:
    """Extract a segment from audio samples given start/end in milliseconds."""
    start_sample = int(start_ms * sample_rate / 1000)
    end_sample = int(end_ms * sample_rate / 1000)
    return samples[start_sample:end_sample]


def _transcribe_segment(samples: np.ndarray) -> str:
    """Transcribe a numpy int16 audio segment. Returns text or empty string."""
    if len(samples) < MIN_SPEECH_SAMPLES:
        return ""
    wav_bytes = _wrap_pcm_in_wav(samples.tobytes())
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(wav_bytes)
        tmp_path = tmp.name
    try:
        result = asr_model.generate(input=tmp_path, language="auto", use_itn=True)
        if result and isinstance(result, list) and len(result) > 0:
            entry = result[0]
            t = entry.get("text", "") if isinstance(entry, dict) else str(entry)
            return _clean_sensevoice_text(t)
    finally:
        os.unlink(tmp_path)
    return ""


def _transcribe_full_with_vad(all_samples: np.ndarray) -> str:
    """Run VAD + per-segment ASR on full audio (pass 2). Returns joined text."""
    if len(all_samples) < MIN_SPEECH_SAMPLES:
        return ""

    wav_bytes = _wrap_pcm_in_wav(all_samples.tobytes())
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(wav_bytes)
        tmp_path = tmp.name

    try:
        vad_result = vad_model.generate(input=tmp_path)
    except Exception:
        os.unlink(tmp_path)
        raise

    segments = []
    if vad_result and isinstance(vad_result, list) and len(vad_result) > 0:
        segments = vad_result[0].get("value", [])

    if not segments:
        os.unlink(tmp_path)
        return ""

    texts = []
    for start_ms, end_ms in segments:
        seg = _extract_segment(all_samples, start_ms, end_ms, SAMPLE_RATE)
        if len(seg) == 0:
            continue
        t = _transcribe_segment(seg)
        if t:
            texts.append(t)

    os.unlink(tmp_path)
    return "".join(texts)


def _resolve_device() -> str:
    """Pick best available device: MPS (Apple Silicon) > CPU."""
    try:
        import torch
        if torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"



@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models on startup."""
    global asr_model, vad_model
    from funasr import AutoModel

    device = _resolve_device()
    logger.info(f"Using device: {device}")

    logger.info("Loading VAD model...")
    vad_model = AutoModel(model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch", disable_update=True)

    logger.info("Loading SenseVoiceSmall model...")
    asr_model = AutoModel(
        model="iic/SenseVoiceSmall",
        trust_remote_code=True,
        device=device,
        disable_update=True,
    )
    logger.info(f"Models loaded successfully (ASR on {device})")
    yield
    asr_model = None
    vad_model = None


app = FastAPI(title="FunASR Server", lifespan=lifespan)


@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": asr_model is not None and vad_model is not None}


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    """Batch transcription endpoint."""
    if asr_model is None or vad_model is None:
        return JSONResponse(status_code=503, content={"error": "Models not loaded"})

    audio_bytes = await file.read()

    is_pcm = False
    if file.content_type and "pcm" in file.content_type:
        is_pcm = True
    if file.filename and file.filename.endswith(".pcm"):
        is_pcm = True

    if is_pcm:
        audio_bytes = _wrap_pcm_in_wav(audio_bytes)

    samples = _read_wav_as_int16(audio_bytes)
    text = _transcribe_full_with_vad(samples)
    return {"text": text}


@app.websocket("/ws/transcribe")
async def ws_transcribe(ws: WebSocket):
    """Streaming 2-pass transcription.

    Client sends:
      - Binary frames: PCM16 16kHz mono audio chunks
      - Text frame: {"type": "finish"} when recording ends

    Server sends:
      - {"type": "partial", "text": "..."} every ~1s with latest transcription
      - {"type": "final", "text": "..."}  full VAD re-transcription (pass 2)
    """
    import asyncio

    await ws.accept()

    if asr_model is None or vad_model is None:
        await ws.send_json({"type": "error", "error": "Models not loaded"})
        await ws.close()
        return

    all_samples_list: list[np.ndarray] = []
    total_samples_received = 0
    last_transcribed_samples = 0
    last_partial_text = ""
    finished = False
    # Minimum new audio before re-transcribing (1 second at 16kHz)
    PARTIAL_INTERVAL_SAMPLES = SAMPLE_RATE * 1

    loop = asyncio.get_event_loop()

    async def periodic_transcribe():
        """Run ASR on new audio chunks every ~1 second, append to running text."""
        nonlocal last_transcribed_samples, last_partial_text
        committed_texts: list[str] = []

        while not finished:
            await asyncio.sleep(0.5)
            if finished:
                break
            new_samples = total_samples_received - last_transcribed_samples
            if new_samples < PARTIAL_INTERVAL_SAMPLES:
                continue
            if not all_samples_list:
                continue

            try:
                full_so_far = np.concatenate(all_samples_list)
                # Only transcribe the new chunk since last transcription
                new_chunk = full_so_far[last_transcribed_samples:]
                text = await loop.run_in_executor(None, _transcribe_segment, new_chunk)
                last_transcribed_samples = total_samples_received
                if text:
                    committed_texts.append(text)
                    combined = "".join(committed_texts)
                    if combined != last_partial_text:
                        last_partial_text = combined
                        await ws.send_json({"type": "partial", "text": combined})
            except Exception as e:
                logger.error(f"Periodic transcription error: {e}")

    transcribe_task = asyncio.create_task(periodic_transcribe())

    try:
        while True:
            message = await ws.receive()

            if message["type"] == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"]:
                pcm_bytes = message["bytes"]
                samples = np.frombuffer(pcm_bytes, dtype=np.int16)
                all_samples_list.append(samples)
                total_samples_received += len(samples)

            elif "text" in message and message["text"]:
                try:
                    data = json.loads(message["text"])
                except json.JSONDecodeError:
                    continue

                if data.get("type") == "finish":
                    finished = True
                    transcribe_task.cancel()
                    try:
                        await transcribe_task
                    except asyncio.CancelledError:
                        pass

                    # Pass 2: full re-transcription with VAD model (in thread pool)
                    if all_samples_list:
                        full_audio = np.concatenate(all_samples_list)
                        final_text = await loop.run_in_executor(None, _transcribe_full_with_vad, full_audio)
                    else:
                        final_text = ""

                    await ws.send_json({"type": "final", "text": final_text})
                    break

    except WebSocketDisconnect:
        logger.debug("WebSocket client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        try:
            await ws.send_json({"type": "error", "error": str(e)})
        except Exception:
            pass
    finally:
        try:
            await ws.close()
        except Exception:
            pass


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="127.0.0.1", port=10095)
