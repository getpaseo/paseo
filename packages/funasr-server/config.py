"""Centralized configuration for the STT server.

All settings are env-var overridable. Import this module to access config values.
"""

import os

# --- Server ---
HOST = os.environ.get("FUNASR_HOST", "127.0.0.1")
PORT = int(os.environ.get("FUNASR_PORT", "10095"))

# --- Model selection ---
# "sensevoice-small" or "fun-asr-nano-2512"
MODEL = os.environ.get("FUNASR_MODEL", "sensevoice-small")

# --- Audio ---
SAMPLE_RATE = 16000
MIN_SPEECH_SAMPLES = int(0.3 * SAMPLE_RATE)  # 300ms minimum to bother transcribing

# --- Streaming ---
TIMER_INTERVAL_S = float(os.environ.get("FUNASR_TIMER_INTERVAL", "1.5"))
SILENCE_THRESHOLD = int(os.environ.get("FUNASR_SILENCE_THRESHOLD", "500"))
SILENCE_DURATION_MS = int(os.environ.get("FUNASR_SILENCE_DURATION_MS", "600"))
SILENCE_DURATION_SAMPLES = int(SILENCE_DURATION_MS * SAMPLE_RATE / 1000)
OVERLAP_S = float(os.environ.get("FUNASR_OVERLAP", "0.5"))
OVERLAP_SAMPLES = int(OVERLAP_S * SAMPLE_RATE)

# --- Final pass ---
# "tail" = only re-transcribe last sentence (~0.3s)
# "full" = VAD re-transcription of entire audio
FINAL_MODE = os.environ.get("FUNASR_FINAL_MODE", "tail")
