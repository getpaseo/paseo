"""WebSocket streaming transcription state machine.

Manages the hybrid timer + silence detection strategy and the
dedicated ASR worker thread. Decoupled from FastAPI — receives
audio and produces text events via callbacks.
"""

import asyncio
import json
import logging
import threading
from typing import Callable, Optional

import numpy as np

from audio import SilenceDetector, pcm_to_wav
from config import (
    FINAL_MODE,
    MIN_SPEECH_SAMPLES,
    OVERLAP_SAMPLES,
    SAMPLE_RATE,
    TIMER_INTERVAL_S,
)
from engine import ASREngine

logger = logging.getLogger("funasr-server.streaming")


class StreamingSession:
    """Manages one streaming transcription session.

    Usage:
        session = StreamingSession(engine, vad_model, loop, on_partial, on_final, on_error)
        session.start()
        session.feed_audio(pcm_bytes)   # call from asyncio
        session.feed_audio(pcm_bytes)
        await session.finish()          # triggers final pass
        # on_partial / on_final callbacks fire as results arrive
    """

    def __init__(
        self,
        engine: ASREngine,
        vad_model: object,
        loop: asyncio.AbstractEventLoop,
        on_partial: Callable[[str], None],
        on_final: Callable[[str], None],
        on_error: Callable[[str], None],
    ):
        self._engine = engine
        self._vad_model = vad_model
        self._loop = loop
        self._on_partial = on_partial
        self._on_final = on_final
        self._on_error = on_error

        # Audio buffer
        self._lock = threading.Lock()
        self._all_samples: list[np.ndarray] = []
        self._total_samples = 0

        # Transcription state
        self._committed: list[str] = []
        self._current_text = ""
        self._sentence_start = 0
        self._last_timer_at = 0
        self._last_sent_text = ""

        # Silence detection
        self._detector = SilenceDetector()

        # ASR worker thread
        self._asr_queue: list[tuple[str, np.ndarray]] = []
        self._asr_has_work = threading.Event()
        self._finished = threading.Event()
        self._result_queue: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        self._worker: Optional[threading.Thread] = None

    def start(self):
        """Start the ASR worker thread."""
        self._worker = threading.Thread(target=self._asr_worker, daemon=True)
        self._worker.start()

    def feed_audio(self, pcm_bytes: bytes):
        """Feed raw PCM16 audio. Call from asyncio thread."""
        samples = np.frombuffer(pcm_bytes, dtype=np.int16)
        offset = self._total_samples
        with self._lock:
            self._all_samples.append(samples)
            self._total_samples += len(samples)

        self._check_silence(samples, offset)
        self._check_timer()

    async def process_results(self):
        """Drain result queue and fire callbacks. Call from asyncio."""
        while True:
            try:
                kind, text = await asyncio.wait_for(self._result_queue.get(), timeout=0.05)
            except asyncio.TimeoutError:
                return

            if kind == "timer":
                if text:
                    with self._lock:
                        self._current_text = text
            elif kind == "silence":
                with self._lock:
                    self._current_text = ""
                    if text:
                        self._committed.append(text)
            elif kind == "final":
                self._on_final(text)
                return

            # Send partial
            with self._lock:
                parts = self._committed[:]
                if self._current_text:
                    parts.append(self._current_text)
            partial = "".join(parts)
            if partial and partial != self._last_sent_text:
                self._last_sent_text = partial
                self._on_partial(partial)

    def check_timer_idle(self):
        """Check if timer should fire (call when no audio messages pending)."""
        self._check_timer()

    async def finish(self):
        """Signal end of recording and wait for final result."""
        if FINAL_MODE == "tail":
            await self._finish_tail()
        else:
            await self._finish_full()

    def stop(self):
        """Clean up worker thread."""
        self._finished.set()
        self._asr_has_work.set()

    # --- Private: ASR worker thread ---

    def _asr_worker(self):
        while True:
            self._asr_has_work.wait()
            self._asr_has_work.clear()

            while True:
                with self._lock:
                    if not self._asr_queue:
                        break
                    kind, samples = self._asr_queue.pop(0)

                try:
                    if kind == "final":
                        text = self._engine.transcribe_with_vad(samples, self._vad_model)
                    else:
                        text = self._engine.transcribe(samples)
                    self._loop.call_soon_threadsafe(
                        self._result_queue.put_nowait, (kind, text)
                    )
                except Exception as e:
                    logger.error(f"ASR worker error ({kind}): {e}")
                    self._loop.call_soon_threadsafe(
                        self._result_queue.put_nowait, (kind, "")
                    )

            if self._finished.is_set():
                with self._lock:
                    if not self._asr_queue:
                        break

    def _enqueue(self, kind: str, arr: np.ndarray):
        with self._lock:
            self._asr_queue.append((kind, arr.copy()))
        self._asr_has_work.set()

    # --- Private: timer + silence ---

    def _check_timer(self):
        with self._lock:
            ts = self._total_samples
            ss = self._sentence_start
            lt = self._last_timer_at
        if ts - lt < int(TIMER_INTERVAL_S * SAMPLE_RATE):
            return
        if not self._all_samples:
            return
        with self._lock:
            full = np.concatenate(self._all_samples)
            chunk_start = max(0, ss - OVERLAP_SAMPLES)
            chunk = full[chunk_start:ts]
            self._last_timer_at = ts
        if len(chunk) >= MIN_SPEECH_SAMPLES:
            self._enqueue("timer", chunk)

    def _check_silence(self, new_samples: np.ndarray, offset: int):
        boundaries = self._detector.feed(new_samples, offset)
        for bstart, bend in boundaries:
            with self._lock:
                full = np.concatenate(self._all_samples)
                seg = full[bstart:bend]
            if len(seg) >= MIN_SPEECH_SAMPLES:
                self._enqueue("silence", seg)
            with self._lock:
                self._sentence_start = self._total_samples
                self._last_timer_at = self._total_samples
                self._current_text = ""

    # --- Private: final pass ---

    async def _finish_tail(self):
        """Tail mode: only re-transcribe the last sentence."""
        with self._lock:
            if self._all_samples:
                full = np.concatenate(self._all_samples)
                last = full[max(0, self._sentence_start - OVERLAP_SAMPLES):]
            else:
                last = np.array([], dtype=np.int16)
        if len(last) >= MIN_SPEECH_SAMPLES:
            self._enqueue("tail", last)
        self._finished.set()
        self._asr_has_work.set()

        tail_text = ""
        while True:
            try:
                kind, text = await asyncio.wait_for(self._result_queue.get(), timeout=10)
            except asyncio.TimeoutError:
                break
            if kind == "tail":
                tail_text = text
                break
            # Process stragglers
            if kind == "timer" and text:
                with self._lock:
                    self._current_text = text
            elif kind == "silence":
                with self._lock:
                    self._current_text = ""
                    if text:
                        self._committed.append(text)

        with self._lock:
            parts = self._committed[:]
            ct = self._current_text
        parts.append(tail_text if tail_text else ct)
        self._on_final("".join(parts))

    async def _finish_full(self):
        """Full mode: VAD re-transcription of entire audio."""
        with self._lock:
            if self._all_samples:
                full = np.concatenate(self._all_samples)
            else:
                full = np.array([], dtype=np.int16)
        self._enqueue("final", full)
        self._finished.set()
        self._asr_has_work.set()

        while True:
            kind, text = await self._result_queue.get()
            if kind == "final":
                self._on_final(text)
                break
            if kind == "timer" and text:
                with self._lock:
                    self._current_text = text
            elif kind == "silence":
                with self._lock:
                    self._current_text = ""
                    if text:
                        self._committed.append(text)
