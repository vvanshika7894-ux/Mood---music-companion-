def analyze_video(frame_path):
    # Lazy import so DeepFace doesn't download/init unless video is used
    from deepface import DeepFace

    result = DeepFace.analyze(
        img_path=frame_path,
        actions=["emotion"],
        enforce_detection=False
    )

    emotions = result[0]["emotion"]
    total = sum(emotions.values()) or 1.0
    return {k.lower(): float(v) / total for k, v in emotions.items()}
