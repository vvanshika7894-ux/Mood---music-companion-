import sys
import json
import os
import warnings

warnings.filterwarnings("ignore")

# Silence common noisy libs
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["TRANSFORMERS_VERBOSITY"] = "error"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

sys.path.append(os.path.dirname(__file__))

from text_emotion import analyze_text
from voice_emotion import analyze_voice
from video_emotion import analyze_video
from fusion import fuse_emotions
from valence_arousal import to_valence_arousal


def safe_print(obj):
    print(json.dumps(obj), flush=True)


def main():
    if len(sys.argv) < 2:
        safe_print({"error": "Missing input payload"})
        return

    try:
        payload = json.loads(sys.argv[1])
    except Exception as e:
        safe_print({"error": f"Invalid JSON payload: {e}"})
        return

    text = payload.get("text", "") or ""
    audio = payload.get("audio", "") or ""
    frame = payload.get("frame", "") or ""

    try:
        text_scores = None
        if text.strip():
            try:
                text_scores = analyze_text(text)
            except Exception:
                text_scores = None

        voice_scores = None
        transcript = ""
        if audio:
            try:
                voice_out = analyze_voice(audio)
                voice_scores = voice_out.get("emotions")
                transcript = voice_out.get("transcript", "")
            except Exception:
                voice_scores = None

        video_scores = None
        if frame:
            try:
                video_scores = analyze_video(frame)
            except Exception:
                video_scores = None

        fused = fuse_emotions(text=text_scores, voice=voice_scores, video=video_scores)
        va = to_valence_arousal(fused)

        safe_print({
            "emotion": fused,
            "valence": va["valence"],
            "arousal": va["arousal"],
            "transcript": transcript
        })

    except Exception as e:
        # IMPORTANT: always return JSON on any unexpected crash
        safe_print({"error": f"AI crashed: {str(e)}"})


if __name__ == "__main__":
    main()
