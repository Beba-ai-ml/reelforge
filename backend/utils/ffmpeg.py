"""FFprobe wrapper and format detection utilities."""

import json
import subprocess
from pathlib import Path

from backend.config import VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, IMAGE_EXTENSIONS


def probe_video(path: str | Path) -> dict:
    """Return media info using ffprobe.

    Returns dict with keys: width, height, duration, fps, has_video, has_audio, rotation.
    """
    cmd = [
        "ffprobe", "-v", "quiet",
        "-print_format", "json",
        "-show_streams", "-show_format",
        str(path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    info = json.loads(result.stdout)

    video_stream = None
    audio_stream = None
    for s in info.get("streams", []):
        if s.get("codec_type") == "video" and video_stream is None:
            video_stream = s
        elif s.get("codec_type") == "audio" and audio_stream is None:
            audio_stream = s

    duration = float(info.get("format", {}).get("duration", 0))

    if video_stream:
        w = int(video_stream["width"])
        h = int(video_stream["height"])
        fps = 0.0
        r_frame_rate = video_stream.get("r_frame_rate", "0/1")
        if "/" in r_frame_rate:
            num, den = r_frame_rate.split("/")
            if int(den) > 0:
                fps = round(int(num) / int(den), 2)

        # Check rotation metadata
        rotation = 0
        for side_data in video_stream.get("side_data_list", []):
            if "rotation" in side_data:
                rotation = int(side_data["rotation"])
                break
        if rotation == 0:
            rotation = int(video_stream.get("tags", {}).get("rotate", 0))

        if abs(rotation) in (90, 270):
            w, h = h, w

        return {
            "width": w,
            "height": h,
            "duration": duration,
            "fps": fps,
            "has_video": True,
            "has_audio": audio_stream is not None,
            "rotation": rotation,
        }

    # Audio-only file
    return {
        "width": 0,
        "height": 0,
        "duration": duration,
        "fps": 0,
        "has_video": False,
        "has_audio": audio_stream is not None,
        "rotation": 0,
    }


def detect_media_type(filename: str) -> str | None:
    """Detect media type from filename extension. Returns 'video', 'audio', 'image', or None."""
    ext = Path(filename).suffix.lower()
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    return None


def extract_thumbnail(video_path: str | Path, output_path: str | Path, at_percent: float = 0.5) -> bool:
    """Extract a single frame as JPEG thumbnail.

    Args:
        video_path: Path to video file.
        output_path: Path for output JPEG.
        at_percent: Position in video (0.0 to 1.0).

    Returns True on success.
    """
    info = probe_video(video_path)
    if not info["has_video"]:
        return False

    seek_time = info["duration"] * at_percent
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(seek_time),
        "-i", str(video_path),
        "-vframes", "1",
        "-vf", "scale=320:-1",
        "-q:v", "5",
        str(output_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.returncode == 0
