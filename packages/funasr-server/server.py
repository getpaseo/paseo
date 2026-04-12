"""Standalone FunASR server for Chinese/English/Japanese speech-to-text."""

import io
import logging
import os
import sys
import tempfile
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import numpy as np
import uvicorn
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

logger = logging.getLogger("funasr-server")

asr_model: Optional[object] = None
vad_model: Optional[object] = None

# Fun-ASR repo must be on sys.path for model.py's sibling imports (ctc, tools.utils)
_FUN_ASR_DIR = str(Path(__file__).resolve().parent / "Fun-ASR")
if _FUN_ASR_DIR not in sys.path:
    sys.path.insert(0, _FUN_ASR_DIR)

SAMPLE_RATE = 16000


def _wrap_pcm_in_wav(pcm_bytes: bytes, sample_rate: int = 16000, channels: int = 1, sample_width: int = 2) -> bytes:
    """Wrap raw PCM data (16kHz mono 16-bit) in a WAV header."""
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


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load models on startup."""
    global asr_model, vad_model
    from funasr import AutoModel

    logger.info("Loading VAD model...")
    vad_model = AutoModel(model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch", disable_update=True)

    logger.info("Loading Fun-ASR-Nano-2512 model...")
    asr_model = AutoModel(
        model="FunAudioLLM/Fun-ASR-Nano-2512",
        trust_remote_code=True,
        remote_code=os.path.join(_FUN_ASR_DIR, "model.py"),
        disable_update=True,
    )
    logger.info("Models loaded successfully")
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

    audio_bytes = await file.read()

    # Detect raw PCM and wrap in WAV header
    is_pcm = False
    if file.content_type and "pcm" in file.content_type:
        is_pcm = True
    if file.filename and file.filename.endswith(".pcm"):
        is_pcm = True

    if is_pcm:
        audio_bytes = _wrap_pcm_in_wav(audio_bytes)

    # Step 1: Run VAD to find speech segments
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name

    try:
        vad_result = vad_model.generate(input=tmp_path)
    except Exception:
        os.unlink(tmp_path)
        raise

    # Parse VAD segments: [{'key': '...', 'value': [[start_ms, end_ms], ...]}]
    segments = []
    if vad_result and isinstance(vad_result, list) and len(vad_result) > 0:
        segments = vad_result[0].get("value", [])

    if not segments:
        os.unlink(tmp_path)
        return {"text": ""}

    # Step 2: Extract each segment and run ASR individually
    samples = _read_wav_as_int16(audio_bytes)
    texts = []

    for start_ms, end_ms in segments:
        segment_samples = _extract_segment(samples, start_ms, end_ms, SAMPLE_RATE)
        if len(segment_samples) == 0:
            continue

        # Write segment to temp WAV
        segment_wav = _wrap_pcm_in_wav(segment_samples.tobytes())
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as seg_tmp:
            seg_tmp.write(segment_wav)
            seg_path = seg_tmp.name

        try:
            result = asr_model.generate(input=seg_path, cache={}, batch_size=1, itn=True)
            if result and isinstance(result, list) and len(result) > 0:
                entry = result[0]
                t = entry.get("text", "") if isinstance(entry, dict) else str(entry)
                if t.strip():
                    texts.append(t.strip())
        finally:
            os.unlink(seg_path)

    os.unlink(tmp_path)

    return {"text": "".join(texts)}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="127.0.0.1", port=10095)
