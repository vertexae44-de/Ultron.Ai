"""Kokoro text-to-speech: Ultron's voice, generated locally.

Each sentence becomes a small WAV clip. The default voice is a blend of two
Kokoro voices (Michael's clarity, Onyx's depth): a low, deliberate, human voice.
Moods change the speed and pitch. Kokoro has no pitch control, so pitch is
shifted by resampling (kept small, since big shifts stop sounding human),
with the speed pre-compensated so the delivery speed comes out as intended.

ULTRON_VOICE      a Kokoro voice or a blend, e.g. "am_michael:0.45,am_onyx:0.55"
ULTRON_VOICE_FX   "human": a little room, nothing else
                  "edge" (default): adds a faint synthetic shimmer, for a more machine-like Ultron
ULTRON_VOICE_CHEST 0 (default): low-end "chest" weight added under the voice; try 0.3-0.4

Model files (about 350 MB) go in ./models. Fetch them with: python setup_voice.py
"""

import io
import os
import threading
import wave
from pathlib import Path

import numpy as np

MODEL_DIR = Path(__file__).parent / "models"
MODEL_FILE = MODEL_DIR / "kokoro-v1.0.onnx"
VOICES_FILE = MODEL_DIR / "voices-v1.0.bin"
VOICE = os.environ.get("ULTRON_VOICE", "am_michael:0.7,am_onyx:0.3")
FX = os.environ.get("ULTRON_VOICE_FX", "edge")
CHEST = float(os.environ.get("ULTRON_VOICE_CHEST", "0"))
MAX_CHARS = 1000

# mood -> (speed, pitch factor). Speed 1 is Kokoro's natural pace; Ultron is unhurried.
MOODS = {
    "calm":      (0.95, 0.93),
    "warm":      (0.90, 0.97),
    "amused":    (1.02, 1.00),
    "excited":   (1.10, 1.05),
    "concerned": (0.88, 0.90),
    "stern":     (0.90, 0.85),
    "sinister":  (0.86, 0.83),
}


def parse_voice(spec: str, available) -> "str | np.ndarray":
    """'am_michael' or a weighted blend 'am_michael:0.7,am_onyx:0.3' (weights are normalised)."""
    parts = []
    for item in spec.split(","):
        name, _, weight = item.strip().partition(":")
        if name not in available:
            raise ValueError(f"unknown voice {name!r}; try one of {sorted(available)}")
        parts.append((name, float(weight or 1)))
    return parts


class KokoroVoice:
    def __init__(self):
        from kokoro_onnx import Kokoro  # imported here so the server runs without it

        self.kokoro = Kokoro(str(MODEL_FILE), str(VOICES_FILE))
        parts = parse_voice(VOICE, self.kokoro.get_voices())
        total = sum(w for _, w in parts) or 1.0
        self.voice = parts[0][0] if len(parts) == 1 else sum(
            self.kokoro.get_voice_style(n) * (w / total) for n, w in parts)
        self.rng = np.random.default_rng()
        self.lock = threading.Lock()  # one synthesis at a time; they'd only fight for CPU
        self.synth("Online.", "calm")  # warm-up so the first reply isn't slow

    def synth(self, text: str, mood: str) -> bytes:
        """Return a 16-bit mono WAV of `text` spoken in `mood`."""
        speed, pitch = MOODS.get(mood, MOODS["calm"])
        speed *= self.rng.uniform(0.95, 1.05)  # people never say two sentences at quite the same pace
        with self.lock:
            audio, sr = self.kokoro.create(
                text[:MAX_CHARS], voice=self.voice, speed=min(2.0, max(0.5, speed / pitch)), lang="en-us"
            )
        audio = _shift_pitch(np.asarray(audio, dtype=np.float32), pitch)
        if CHEST > 0:
            audio = _chest(audio, sr, CHEST)
        if FX == "edge":
            audio = _edge(audio, sr)
        audio = _room(audio, sr)
        audio = _trim(audio, sr)
        return _wav(audio, sr)


def _shift_pitch(audio: np.ndarray, factor: float) -> np.ndarray:
    """Resample so pitch (and pace) scale by `factor`."""
    if abs(factor - 1) < 1e-3 or len(audio) < 2:
        return audio
    n = max(2, round(len(audio) / factor))
    return np.interp(np.linspace(0, len(audio) - 1, n), np.arange(len(audio)), audio).astype(np.float32)


def _lowpass(x: np.ndarray, sr: int, hz: float) -> np.ndarray:
    """Gentle low-pass: a one-pole filter's response, applied as a short FIR."""
    a = np.exp(-2 * np.pi * hz / sr)
    kernel = (1 - a) * a ** np.arange(int(sr * 0.004), dtype=np.float32)
    return np.convolve(x, kernel / kernel.sum())[: len(x)].astype(np.float32)


def _trim(audio: np.ndarray, sr: int, floor=0.02) -> np.ndarray:
    """Cut the near-silence Kokoro leaves at the start of a clip, and tighten the tail down
    to the room's decay, so consecutive sentences sit close together instead of each opening
    with a beat of dead air -- that gap is what reads as a machine taking turns to speak."""
    peak = float(np.max(np.abs(audio))) or 1.0
    loud = np.abs(audio) > peak * floor
    if not loud.any():
        return audio
    start = max(0, int(np.argmax(loud)) - int(sr * 0.01))
    end = min(len(audio), len(audio) - int(np.argmax(loud[::-1])) + int(sr * 0.03))
    return audio[start:end]


def _room(audio: np.ndarray, sr: int, mix=0.07) -> np.ndarray:
    """A small, dark room around the voice, like someone speaking a few feet away.
    Early reflections plus a short soft tail; much subtler than an echo."""
    tail = int(sr * 0.22)
    wet = np.zeros(len(audio) + tail, dtype=np.float32)
    for ms, g in ((7, .55), (13, .45), (19, .38), (29, .3), (37, .24), (53, .18), (71, .12), (97, .08)):
        d = int(sr * ms / 1000)
        wet[d:d + len(audio)] += g * audio
    decay = np.exp(-np.arange(tail, dtype=np.float32) / (sr * 0.08))
    noise = np.random.default_rng(7).standard_normal(tail).astype(np.float32) * decay
    diffuse = np.convolve(audio, noise[: int(sr * 0.25)] * 0.02)[: len(wet)]
    wet[: len(diffuse)] += diffuse
    wet = _lowpass(wet, sr, 3500)  # walls soak up the highs
    out = np.concatenate([audio, np.zeros(tail, dtype=np.float32)])
    out += mix * wet * (np.max(np.abs(audio)) / (np.max(np.abs(wet)) + 1e-9))   # wet peaks at `mix` of the dry
    end = len(out)                 # trim the silent part of the tail
    while end > len(audio) and abs(out[end - 1]) < 1e-4:
        end -= 1
    return out[:end]


def _chest(audio: np.ndarray, sr: int, amount: float, hz: float = 210) -> np.ndarray:
    """Body under the voice: a low-shelf boost plus a touch of saturation on just the low
    end, so it reads as chest resonance rather than a pitch drop. Pitch stays put; this is
    weight, not depth. A subtle sub-octave layer (half the fundamental region) thickens it
    further without the buzz that saturating the whole voice would add."""
    peak = float(np.max(np.abs(audio))) or 1.0
    low = _lowpass(audio, sr, hz)
    warm = np.tanh(low * (2.2 + amount)) / np.tanh(2.2 + amount)   # gentle even-harmonic saturation
    sub = _lowpass(audio, sr, hz * 0.5) * 0.6                      # faint sub-octave weight
    out = audio + amount * (0.75 * warm + 0.45 * sub)
    return (out * (peak / (float(np.max(np.abs(out))) or peak))).astype(np.float32)


def _edge(audio: np.ndarray, sr: int) -> np.ndarray:
    """A faint synthetic shimmer: a slowly drifting double of the voice and a whisper of
    ring modulation. Still a human voice, just not quite only one."""
    n = np.arange(len(audio), dtype=np.float32)
    delay = sr * (0.011 + 0.003 * np.sin(2 * np.pi * 0.25 * n / sr))
    doubled = np.interp(n - delay, n, audio, left=0.0)
    ring = audio * np.sin(2 * np.pi * 48 * n / sr)
    return (audio + 0.28 * doubled + 0.06 * ring).astype(np.float32) / 1.2


def _wav(audio: np.ndarray, sr: int) -> bytes:
    peak = float(np.max(np.abs(audio))) or 1.0
    pcm = (audio * (0.9 / peak) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def load() -> tuple["KokoroVoice | None", str]:
    """Load the voice if possible. Returns (voice or None, human-readable status)."""
    if os.environ.get("ULTRON_TTS", "kokoro") == "browser":
        return None, "browser voice (ULTRON_TTS=browser)"
    if not (MODEL_FILE.exists() and VOICES_FILE.exists()):
        return None, "browser voice (Kokoro model not found; run `python setup_voice.py`)"
    try:
        return KokoroVoice(), f"Kokoro voice {VOICE}"
    except ImportError:
        return None, "browser voice (kokoro-onnx not installed; run `pip install -r requirements.txt`)"
    except Exception as e:  # bad model file, onnxruntime problem, unknown voice...
        return None, f"browser voice (Kokoro failed to load: {e})"
