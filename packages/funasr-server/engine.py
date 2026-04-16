"""ASR engine abstraction and implementations.

Provides a uniform interface for different speech recognition models.
Select engine via FUNASR_MODEL env var (see config.py).
"""

import logging
import os
import re
import sys
import tempfile
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

import numpy as np

from audio import pcm_to_wav
from config import MIN_SPEECH_SAMPLES, SAMPLE_RATE

logger = logging.getLogger("funasr-server.engine")

# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------


class ASREngine(ABC):
    """Interface for ASR engines."""

    @abstractmethod
    def transcribe(self, samples: np.ndarray) -> str:
        """Transcribe int16 mono audio samples. Returns text or empty string."""

    @abstractmethod
    def transcribe_with_vad(self, samples: np.ndarray, vad_model: object) -> str:
        """VAD segmentation + per-segment transcription. Returns joined text."""


class BaseEngine(ASREngine):
    """Common logic shared by all FunASR-based engines."""

    def __init__(self, model: object):
        self._model = model

    def _generate(self, wav_path: str) -> str:
        """Run model.generate on a WAV file. Subclasses override for different params."""
        raise NotImplementedError

    def _clean(self, text: str) -> str:
        """Post-process model output. Override if model adds special tokens."""
        return text.strip()

    def transcribe(self, samples: np.ndarray) -> str:
        if len(samples) < MIN_SPEECH_SAMPLES:
            return ""
        wav = pcm_to_wav(samples.tobytes())
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
            f.write(wav)
            path = f.name
        try:
            return self._clean(self._generate(path))
        finally:
            os.unlink(path)

    def transcribe_with_vad(self, samples: np.ndarray, vad_model: object) -> str:
        if len(samples) < MIN_SPEECH_SAMPLES:
            return ""
        wav = pcm_to_wav(samples.tobytes())
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
            si = int(s * SAMPLE_RATE / 1000)
            ei = int(e * SAMPLE_RATE / 1000)
            seg = samples[si:ei]
            if len(seg) > 0:
                t = self.transcribe(seg)
                if t:
                    texts.append(t)
        os.unlink(path)
        return "".join(texts)


# ---------------------------------------------------------------------------
# SenseVoiceSmall
# ---------------------------------------------------------------------------

_SENSEVOICE_TAG_RE = re.compile(r"<\|[^|]*\|>")


class SenseVoiceSmallEngine(BaseEngine):
    """SenseVoiceSmall (234M) — supports zh/en/ja/ko/yue, MPS accelerated."""

    def _generate(self, wav_path: str) -> str:
        r = self._model.generate(input=wav_path, language="auto", use_itn=True)
        if r and isinstance(r, list) and len(r) > 0:
            e = r[0]
            return e.get("text", "") if isinstance(e, dict) else str(e)
        return ""

    def _clean(self, text: str) -> str:
        return _SENSEVOICE_TAG_RE.sub("", text).strip()


# ---------------------------------------------------------------------------
# Fun-ASR-Nano-2512
# ---------------------------------------------------------------------------


class FunASRNanoEngine(BaseEngine):
    """Fun-ASR-Nano-2512 (800M) — supports zh/en/ja + dialects, CPU only."""

    def _generate(self, wav_path: str) -> str:
        r = self._model.generate(input=wav_path, cache={}, batch_size=1, itn=True)
        if r and isinstance(r, list) and len(r) > 0:
            e = r[0]
            return e.get("text", "") if isinstance(e, dict) else str(e)
        return ""


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def _resolve_device() -> str:
    """Pick best available device: MPS (Apple Silicon) > CUDA > CPU."""
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda:0"
        if torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def create_engine(model_name: str) -> tuple[ASREngine, object]:
    """Create an ASR engine and VAD model.

    Returns (engine, vad_model).
    """
    from funasr import AutoModel

    device = _resolve_device()
    logger.info(f"Device: {device}, Model: {model_name}")

    # VAD model (always CPU, lightweight)
    logger.info("Loading VAD model...")
    vad_model = AutoModel(
        model="iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
        disable_update=True,
    )

    if model_name == "sensevoice-small":
        logger.info("Loading SenseVoiceSmall...")
        asr = AutoModel(
            model="iic/SenseVoiceSmall",
            trust_remote_code=True,
            device=device,
            disable_update=True,
        )
        engine = SenseVoiceSmallEngine(asr)

    elif model_name == "fun-asr-nano-2512":
        # Fun-ASR-Nano requires the Fun-ASR repo for model.py
        fun_asr_dir = str(Path(__file__).resolve().parent / "Fun-ASR")
        if fun_asr_dir not in sys.path:
            sys.path.insert(0, fun_asr_dir)
        model_py = os.path.join(fun_asr_dir, "model.py")

        if not os.path.exists(model_py):
            raise RuntimeError(
                f"Fun-ASR repo not found at {fun_asr_dir}. "
                "Run: git clone https://github.com/FunAudioLLM/Fun-ASR.git "
                "inside packages/funasr-server/"
            )

        # Fun-ASR-Nano does NOT support MPS — force CPU
        nano_device = "cuda:0" if "cuda" in device else "cpu"
        if nano_device != device:
            logger.warning(f"Fun-ASR-Nano does not support {device}, using {nano_device}")

        logger.info("Loading Fun-ASR-Nano-2512...")
        asr = AutoModel(
            model="FunAudioLLM/Fun-ASR-Nano-2512",
            trust_remote_code=True,
            remote_code=model_py,
            device=nano_device,
            disable_update=True,
        )
        engine = FunASRNanoEngine(asr)

    else:
        raise ValueError(
            f"Unknown model: {model_name}. "
            "Supported: sensevoice-small, fun-asr-nano-2512"
        )

    logger.info(f"Engine ready: {model_name} on {device}")
    return engine, vad_model
