#!/usr/bin/env python3
"""Migrate existing B-Roll Library data (segments.jsonl) into ReelForge database.

Usage:
    python scripts/migrate_broll_library.py
    python scripts/migrate_broll_library.py --dry-run
    python scripts/migrate_broll_library.py --jsonl-path /custom/path/segments.jsonl
    python -m scripts.migrate_broll_library

Reads segments.jsonl line by line and creates Clip, ClipSegment, and Category
records in the ReelForge SQLite database.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

# Ensure project root is on sys.path for imports
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend.db.database import SessionLocal, engine
from backend.db.models import Base, Clip, ClipSegment, Category

DEFAULT_JSONL_PATH = "/home/beba/reels/library_cache/segments.jsonl"

# Common mount points where Google Drive B-Roll files might be found
DRIVE_MOUNT_POINTS = [
    Path("/home/beba/Google Drive"),
    Path("/home/beba/gdrive"),
    Path("/home/beba/Dysk Google"),
    Path("/mnt/gdrive"),
    Path(os.path.expanduser("~/Google Drive")),
]


def probe_media(filepath: Path) -> dict:
    """Use ffprobe to get width, height, fps from a video file.

    Returns dict with keys: width, height, fps (or empty dict on failure).
    """
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "quiet",
                "-print_format", "json",
                "-show_streams",
                "-select_streams", "v:0",
                str(filepath),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return {}
        data = json.loads(result.stdout)
        streams = data.get("streams", [])
        if not streams:
            return {}
        stream = streams[0]
        info = {}
        if "width" in stream:
            info["width"] = int(stream["width"])
        if "height" in stream:
            info["height"] = int(stream["height"])
        # Parse fps from r_frame_rate (e.g., "30/1" or "30000/1001")
        rfr = stream.get("r_frame_rate", "")
        if "/" in rfr:
            num, den = rfr.split("/")
            try:
                fps = float(num) / float(den)
                if fps > 0:
                    info["fps"] = round(fps, 3)
            except (ValueError, ZeroDivisionError):
                pass
        return info
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError):
        return {}


def find_actual_file(relative_path: str) -> Path | None:
    """Try to locate a B-Roll file on disk by checking common mount points.

    The path in segments.jsonl is like:
        "B-Roll Library/roboty-rc/filename/filename.mp4"
    We check if it exists under any known Google Drive mount point.
    """
    for mount in DRIVE_MOUNT_POINTS:
        full = mount / relative_path
        if full.exists():
            return full
    return None


def determine_clip_type(entry: dict) -> str:
    """Determine if a clip is video or image based on path extension."""
    path = entry.get("path", "")
    ext = Path(path).suffix.lower()
    image_exts = {".jpg", ".jpeg", ".png", ".heic", ".webp", ".gif"}
    if ext in image_exts:
        return "image"
    return "video"


def migrate(jsonl_path: str, dry_run: bool = False) -> None:
    """Run the migration from segments.jsonl to the ReelForge database."""
    if not os.path.exists(jsonl_path):
        print(f"Error: {jsonl_path} not found.", file=sys.stderr)
        print(
            "Make sure the B-Roll Library cache is synced.\n"
            "Expected path: /home/beba/reels/library_cache/segments.jsonl",
            file=sys.stderr,
        )
        sys.exit(1)

    # Ensure tables exist
    if not dry_run:
        Base.metadata.create_all(bind=engine)

    db = SessionLocal()
    try:
        # Track existing clip IDs to handle duplicates
        existing_ids = set()
        if not dry_run:
            existing_ids = {
                row[0] for row in db.query(Clip.id).all()
            }

        # Track categories we've seen
        existing_categories = set()
        if not dry_run:
            existing_categories = {
                row[0] for row in db.query(Category.name).all()
            }

        clips_imported = 0
        clips_skipped = 0
        segments_imported = 0
        categories_created = 0

        with open(jsonl_path, "r", encoding="utf-8") as f:
            for line_num, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue

                try:
                    entry = json.loads(line)
                except json.JSONDecodeError as e:
                    print(
                        f"Warning: skipping malformed line {line_num}: {e}",
                        file=sys.stderr,
                    )
                    continue

                clip_id = entry.get("clip_id", "")
                if not clip_id:
                    print(
                        f"Warning: skipping line {line_num}: missing clip_id",
                        file=sys.stderr,
                    )
                    continue

                # Skip duplicates
                if clip_id in existing_ids:
                    clips_skipped += 1
                    continue

                # Category handling
                cat_name = entry.get("category", "")
                if cat_name and cat_name not in existing_categories:
                    if not dry_run:
                        category = Category(
                            name=cat_name,
                            display_name=cat_name.replace("-", " ").title(),
                            clip_count=0,
                        )
                        db.add(category)
                    existing_categories.add(cat_name)
                    categories_created += 1

                # Determine filepath
                relative_path = entry.get("path", "")
                filename = Path(relative_path).name if relative_path else ""

                # Determine clip type
                clip_type = determine_clip_type(entry)

                # Extract focus point
                focus_point = entry.get("focus_point", {})
                focus_x = focus_point.get("x", 0.5) if isinstance(focus_point, dict) else 0.5
                focus_y = focus_point.get("y", 0.5) if isinstance(focus_point, dict) else 0.5

                # Build tags from entry (some entries may have tags)
                tags_data = entry.get("tags")
                tags_json = json.dumps(tags_data) if tags_data else None

                # Try to probe actual file for width/height/fps
                width = None
                height = None
                fps = None
                actual_file = find_actual_file(relative_path)
                if actual_file and clip_type == "video":
                    probe_info = probe_media(actual_file)
                    width = probe_info.get("width")
                    height = probe_info.get("height")
                    fps = probe_info.get("fps")

                # Create Clip record
                clip = Clip(
                    id=clip_id,
                    filename=filename,
                    filepath=relative_path,
                    category=cat_name or None,
                    type=clip_type,
                    title_en=entry.get("title_en"),
                    title_pl=entry.get("title_pl"),
                    summary_en=entry.get("summary_en"),
                    summary_pl=entry.get("summary_pl"),
                    duration=entry.get("duration"),
                    fps=fps,
                    width=width,
                    height=height,
                    is_dynamic=entry.get("is_dynamic", False),
                    focus_x=focus_x,
                    focus_y=focus_y,
                    tags=tags_json,
                )

                if not dry_run:
                    db.add(clip)

                existing_ids.add(clip_id)
                clips_imported += 1

                # Create ClipSegment records
                for seg in entry.get("segments", []):
                    start_time = seg.get("start", seg.get("start_time", 0.0))
                    end_time = seg.get("end", seg.get("end_time", 0.0))

                    segment = ClipSegment(
                        clip_id=clip_id,
                        start_time=float(start_time),
                        end_time=float(end_time),
                        description_en=seg.get("description_en"),
                        description_pl=seg.get("description_pl"),
                    )

                    if not dry_run:
                        db.add(segment)
                    segments_imported += 1

        # Update category clip counts
        if not dry_run:
            db.flush()
            for cat_name in existing_categories:
                count = db.query(Clip).filter(Clip.category == cat_name).count()
                db.query(Category).filter(Category.name == cat_name).update(
                    {"clip_count": count}
                )
            db.commit()

        # Print summary
        mode_str = "[DRY RUN] " if dry_run else ""
        print(f"{mode_str}Migration complete:")
        print(f"  Imported {clips_imported} clips, {segments_imported} segments, {categories_created} categories")
        if clips_skipped:
            print(f"  Skipped {clips_skipped} duplicate clips (already in DB)")

    except Exception:
        if not dry_run:
            db.rollback()
        raise
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(
        description="Migrate B-Roll Library (segments.jsonl) into ReelForge database.",
    )
    parser.add_argument(
        "--jsonl-path",
        default=DEFAULT_JSONL_PATH,
        help=f"Path to segments.jsonl (default: {DEFAULT_JSONL_PATH})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview import without writing to database",
    )
    args = parser.parse_args()
    migrate(args.jsonl_path, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
