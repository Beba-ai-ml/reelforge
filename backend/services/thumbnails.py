"""Thumbnail generation service for clips."""

import subprocess
from pathlib import Path

from sqlalchemy.orm import Session

from backend.config import THUMBNAILS_DIR, LIBRARY_DIR
from backend.db.database import SessionLocal
from backend.db.models import Clip
from backend.utils.ffmpeg import probe_video


THUMB_WIDTH = 320
THUMB_HEIGHT = 180


def generate_thumbnail(clip_id: str, db: Session | None = None) -> str:
    """Generate a thumbnail for a clip.

    For video: extract frame at 50% duration, scale to 320x180.
    For image: resize to 320x180, maintain aspect ratio, pad with black.

    Returns the thumbnail path relative to THUMBNAILS_DIR.
    """
    own_session = db is None
    if own_session:
        db = SessionLocal()

    try:
        clip = db.query(Clip).filter(Clip.id == clip_id).first()
        if not clip:
            raise ValueError(f"Clip {clip_id} not found")

        # Resolve the source file path
        source_path = Path(clip.filepath)
        if not source_path.is_absolute():
            source_path = LIBRARY_DIR / source_path

        if not source_path.exists():
            raise FileNotFoundError(f"Source file not found: {source_path}")

        output_path = THUMBNAILS_DIR / f"{clip_id}.jpg"
        THUMBNAILS_DIR.mkdir(parents=True, exist_ok=True)

        if clip.type == "video":
            _thumbnail_from_video(source_path, output_path, clip.duration)
        elif clip.type == "image":
            _thumbnail_from_image(source_path, output_path)
        else:
            raise ValueError(f"Unsupported clip type: {clip.type}")

        # Update DB record
        clip.thumbnail_path = f"{clip_id}.jpg"
        db.commit()

        return str(output_path)
    finally:
        if own_session:
            db.close()


def _thumbnail_from_video(
    source: Path, output: Path, duration: float | None = None
) -> None:
    """Extract a frame at 50% of duration and scale to thumbnail size."""
    if duration is None or duration <= 0:
        try:
            info = probe_video(source)
            duration = info.get("duration", 0)
        except Exception:
            duration = 0

    seek_time = (duration or 0) * 0.5

    cmd = [
        "ffmpeg", "-y",
        "-ss", str(seek_time),
        "-i", str(source),
        "-vframes", "1",
        "-vf", (
            f"scale={THUMB_WIDTH}:{THUMB_HEIGHT}"
            f":force_original_aspect_ratio=decrease,"
            f"pad={THUMB_WIDTH}:{THUMB_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black"
        ),
        "-q:v", "5",
        str(output),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg thumbnail extraction failed: {result.stderr}")


def _thumbnail_from_image(source: Path, output: Path) -> None:
    """Resize image to thumbnail size, maintain aspect ratio, pad with black."""
    cmd = [
        "ffmpeg", "-y",
        "-i", str(source),
        "-vf", (
            f"scale={THUMB_WIDTH}:{THUMB_HEIGHT}"
            f":force_original_aspect_ratio=decrease,"
            f"pad={THUMB_WIDTH}:{THUMB_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black"
        ),
        "-q:v", "5",
        str(output),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg image thumbnail failed: {result.stderr}")


def regenerate_all_thumbnails() -> int:
    """Regenerate thumbnails for all clips in the database.

    Returns the count of successfully regenerated thumbnails.
    """
    db = SessionLocal()
    count = 0
    try:
        clips = db.query(Clip).all()
        for clip in clips:
            try:
                generate_thumbnail(clip.id, db=db)
                count += 1
            except Exception:
                # Skip clips that fail (missing file, etc.)
                continue
        return count
    finally:
        db.close()
