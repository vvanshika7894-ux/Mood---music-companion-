import os
import warnings
warnings.filterwarnings("ignore")

os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["TRANSFORMERS_VERBOSITY"] = "error"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"

_classifier = None
_load_error = None

def _fallback(text: str):
    t = (text or "").lower()

    # tiny heuristic fallback (keeps app usable if HF model not available)
    if any(w in t for w in ["happy", "excited", "great", "good", "amazing", "joy", "love"]):
        return {"joy": 0.8, "neutral": 0.2}
    if any(w in t for w in ["sad", "down", "depressed", "lonely", "cry", "upset"]):
        return {"sadness": 0.8, "neutral": 0.2}
    if any(w in t for w in ["angry", "mad", "furious", "rage", "annoyed"]):
        return {"anger": 0.8, "neutral": 0.2}
    if any(w in t for w in ["anxious", "worried", "scared", "panic", "fear"]):
        return {"fear": 0.8, "neutral": 0.2}

    return {"neutral": 1.0}

def _ensure_model():
    global _classifier, _load_error
    if _classifier is not None or _load_error is not None:
        return

    try:
        from transformers import pipeline
        from transformers.utils import logging as hf_logging

        hf_logging.set_verbosity_error()
        hf_logging.disable_progress_bar()

        # ✅ Force CPU (-1) so Mac MPS never triggers weird logs
        _classifier = pipeline(
            "text-classification",
            model="j-hartmann/emotion-english-distilroberta-base",
            top_k=None,
            device=-1
        )
    except Exception as e:
        _load_error = str(e)
        _classifier = None

def analyze_text(text: str):
    _ensure_model()
    if _classifier is None:
        return _fallback(text)

    scores = _classifier(text)[0]
    return {s["label"].lower(): float(s["score"]) for s in scores}
