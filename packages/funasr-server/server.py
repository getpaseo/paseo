"""Standalone STT server for Paseo.

Thin FastAPI layer — delegates to engine.py for ASR and streaming.py
for WebSocket session management. See docs/STT_SERVER_PROTOCOL.md.
"""

import asyncio
import io
import json
import logging
import wave
from contextlib import asynccontextmanager

import numpy as np
import uvicorn
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

import config
from audio import pcm_to_wav
from engine import ASREngine, create_engine
from streaming import StreamingSession

logger = logging.getLogger("funasr-server")

_engine: ASREngine | None = None
_vad_model: object | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _engine, _vad_model
    _engine, _vad_model = create_engine(config.MODEL)
    yield
    _engine = None
    _vad_model = None


app = FastAPI(title="Paseo STT Server", lifespan=lifespan)


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model": config.MODEL,
        "model_loaded": _engine is not None and _vad_model is not None,
    }


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    """Batch transcription endpoint."""
    if _engine is None or _vad_model is None:
        return JSONResponse(status_code=503, content={"error": "Models not loaded"})

    audio = await file.read()
    is_pcm = (file.content_type and "pcm" in file.content_type) or (
        file.filename and file.filename.endswith(".pcm")
    )
    if is_pcm:
        audio = pcm_to_wav(audio)

    buf = io.BytesIO(audio)
    with wave.open(buf, "rb") as wf:
        frames = wf.readframes(wf.getnframes())
    samples = np.frombuffer(frames, dtype=np.int16)
    text = _engine.transcribe_with_vad(samples, _vad_model)
    return {"text": text}


@app.websocket("/ws/transcribe")
async def ws_transcribe(ws: WebSocket):
    """Streaming hybrid transcription via WebSocket."""
    await ws.accept()
    if _engine is None or _vad_model is None:
        await ws.send_json({"type": "error", "error": "Models not loaded"})
        await ws.close()
        return

    loop = asyncio.get_event_loop()

    # Callbacks buffer messages; server.py sends them in the asyncio loop
    pending_messages: list[dict] = []

    def on_partial(text: str):
        pending_messages.append({"type": "partial", "text": text})

    def on_final(text: str):
        pending_messages.append({"type": "final", "text": text})

    def on_error(error: str):
        pending_messages.append({"type": "error", "error": error})

    async def flush_messages() -> bool:
        """Send pending messages. Returns True if final was sent."""
        got_final = False
        while pending_messages:
            msg = pending_messages.pop(0)
            await ws.send_json(msg)
            if msg.get("type") == "final":
                got_final = True
        return got_final

    session = StreamingSession(
        engine=_engine,
        vad_model=_vad_model,
        loop=loop,
        on_partial=on_partial,
        on_final=on_final,
        on_error=on_error,
    )
    session.start()

    try:
        while True:
            await session.process_results()
            if await flush_messages():
                break

            try:
                message = await asyncio.wait_for(ws.receive(), timeout=0.05)
            except asyncio.TimeoutError:
                session.check_timer_idle()
                continue

            if message["type"] == "websocket.disconnect":
                break

            if "bytes" in message and message["bytes"]:
                session.feed_audio(message["bytes"])

            elif "text" in message and message["text"]:
                try:
                    data = json.loads(message["text"])
                except json.JSONDecodeError:
                    continue
                if data.get("type") == "finish":
                    await session.finish()
                    await flush_messages()
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
        session.stop()
        try:
            await ws.close()
        except Exception:
            pass


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host=config.HOST, port=config.PORT)
