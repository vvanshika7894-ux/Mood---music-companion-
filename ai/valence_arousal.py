MAP = {
    "sadness": (-0.7, -0.4),
    "sad": (-0.7, -0.4),
    "joy": (0.8, 0.6),
    "happy": (0.8, 0.6),
    "neutral": (0.0, 0.0),
    "anger": (-0.6, 0.7),
    "angry": (-0.6, 0.7),
    "fear": (-0.7, 0.8),
    "surprise": (0.4, 0.7),
    "disgust": (-0.5, 0.3),
    "calm": (0.4, -0.3),
}

def to_valence_arousal(emotions: dict):
    v = 0.0
    a = 0.0
    total = sum(emotions.values()) or 1.0

    for emo, score in emotions.items():
        emo = emo.lower()
        if emo in MAP:
            dv, da = MAP[emo]
            v += dv * score
            a += da * score

    return {
        "valence": round(v / total, 3),
        "arousal": round(a / total, 3),
    }
