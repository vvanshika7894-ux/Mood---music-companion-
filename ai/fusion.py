def fuse_emotions(text=None, voice=None, video=None):
    weights = {"text": 0.35, "voice": 0.50, "video": 0.15}
    combined = {}

    for source, data in [("text", text), ("voice", voice), ("video", video)]:
        if not data:
            continue
        for emo, score in data.items():
            combined[emo] = combined.get(emo, 0.0) + float(score) * weights[source]

    total = sum(combined.values()) or 1.0
    return {k: round(v / total, 6) for k, v in combined.items()}
