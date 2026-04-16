"""Audio utilities: PCM/WAV conversion and silence detection."""

import io
import wave

import numpy as np

from config import SAMPLE_RATE, SILENCE_THRESHOLD, SILENCE_DURATION_SAMPLES


def pcm_to_wav(pcm: bytes) -> bytes:
    """Wrap raw PCM16 mono bytes in a WAV header."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm)
    return buf.getvalue()


def wav_to_samples(wav_bytes: bytes) -> np.ndarray:
    """Read WAV bytes and return mono int16 numpy array."""
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, "rb") as wf:
        frames = wf.readframes(wf.getnframes())
    return np.frombuffer(frames, dtype=np.int16)


class SilenceDetector:
    """Detects sentence boundaries by tracking silence in streaming audio.

    Call feed() with each audio chunk. Returns list of (start, end) sample
    indices for completed speech segments (bounded by silence).
    """

    def __init__(self):
        self.speech_active = False
        self.silence_count = 0
        self.speech_start = 0

    def feed(self, samples: np.ndarray, offset: int) -> list[tuple[int, int]]:
        boundaries = []
        window = int(SAMPLE_RATE * 0.03)  # 30ms windows
        for i in range(0, len(samples), window):
            chunk = samples[i:i + window]
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
