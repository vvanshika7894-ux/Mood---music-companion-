import subprocess
import tempfile
import os
import shutil

from faster_whisper import WhisperModel
from text_emotion import analyze_text

model = WhisperModel("tiny", compute_type="int8")

def _to_wav_16k_mono(input_path: str) -> tuple[str, str]:
    tmpdir = tempfile.mkdtemp(prefix="mmc-")
    out = os.path.join(tmpdir, "audio.wav")
    cmd = ["ffmpeg", "-y", "-i", input_path, "-vn", "-ac", "1", "-ar", "16000", out]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip() or p.stdout.strip() or "ffmpeg failed")
    return out, tmpdir

def analyze_voice(audio_path: str):
    wav = None
    tmpdir = None
    try:
        wav, tmpdir = _to_wav_16k_mono(audio_path)
        segments, _ = model.transcribe(wav, vad_filter=True, beam_size=5)
        text = " ".join(s.text.strip() for s in segments).strip()
        if not text:
            return {"transcript": "", "emotions": {}}
        emotions = analyze_text(text)
        return {"transcript": text, "emotions": emotions}
    finally:
        if tmpdir and os.path.exists(tmpdir):
            shutil.rmtree(tmpdir, ignore_errors=True)
