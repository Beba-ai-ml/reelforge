"""Library search service for ReelForge.

Adapted from /home/beba/reels/scripts/search_library.py for database-backed
clip search with weighted keyword scoring.
"""

import json
import re
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import joinedload

from backend.db.database import SessionLocal
from backend.db.models import Clip, ClipSegment, Category


def _tokenize(query: str) -> list[str]:
    """Split query into lowercase keywords."""
    return [w.lower() for w in re.split(r"\s+", query.strip()) if w]


def _count_matches(text: Optional[str], keywords: list[str]) -> int:
    """Count how many keywords appear in text (case-insensitive substring)."""
    if not text:
        return 0
    text_lower = text.lower()
    return sum(1 for kw in keywords if kw in text_lower)


def _clip_to_dict(clip: Clip) -> dict:
    """Serialize a Clip ORM object to a plain dict."""
    tags = None
    if clip.tags:
        try:
            tags = json.loads(clip.tags)
        except (json.JSONDecodeError, TypeError):
            tags = clip.tags
    return {
        "id": clip.id,
        "filename": clip.filename,
        "filepath": clip.filepath,
        "category": clip.category,
        "type": clip.type,
        "title_en": clip.title_en,
        "title_pl": clip.title_pl,
        "summary_en": clip.summary_en,
        "summary_pl": clip.summary_pl,
        "duration": clip.duration,
        "fps": clip.fps,
        "width": clip.width,
        "height": clip.height,
        "is_dynamic": clip.is_dynamic,
        "focus_x": clip.focus_x,
        "focus_y": clip.focus_y,
        "thumbnail_path": clip.thumbnail_path,
        "tags": tags,
        "created_at": clip.created_at,
    }


def _segment_to_dict(seg: ClipSegment) -> dict:
    """Serialize a ClipSegment ORM object to a plain dict."""
    return {
        "id": seg.id,
        "clip_id": seg.clip_id,
        "start_time": seg.start_time,
        "end_time": seg.end_time,
        "description_en": seg.description_en,
        "description_pl": seg.description_pl,
    }


def search_clips(
    query: str,
    category: Optional[str] = None,
    clip_type: Optional[str] = None,
    is_dynamic: Optional[bool] = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    """Search the clip library with weighted keyword scoring.

    Opens its own DB session. Scores clips by keyword matches across
    title, summary, tags, category, and segment descriptions.

    Returns dict with results, total count, offset, and limit.
    """
    db = SessionLocal()
    try:
        # Base query with eager-loaded segments
        q = db.query(Clip).options(joinedload(Clip.segments))

        # Apply filters
        if category is not None:
            q = q.filter(Clip.category == category)
        if clip_type is not None:
            q = q.filter(Clip.type == clip_type)
        if is_dynamic is not None:
            q = q.filter(Clip.is_dynamic == is_dynamic)

        keywords = _tokenize(query)

        # Empty query: return filtered clips ordered by created_at desc
        if not keywords:
            total = q.count()
            clips = (
                q.order_by(Clip.created_at.desc())
                .offset(offset)
                .limit(limit)
                .all()
            )
            # Deduplicate clips (joinedload can produce duplicates)
            seen = set()
            unique_clips = []
            for clip in clips:
                if clip.id not in seen:
                    seen.add(clip.id)
                    unique_clips.append(clip)
            return {
                "results": [
                    {
                        "clip": _clip_to_dict(c),
                        "score": 0,
                        "matching_segments": [
                            _segment_to_dict(s) for s in c.segments
                        ],
                    }
                    for c in unique_clips
                ],
                "total": total,
                "offset": offset,
                "limit": limit,
            }

        # Load all matching clips into memory for scoring
        all_clips = q.all()
        # Deduplicate (joinedload can produce duplicates)
        seen = set()
        unique_clips = []
        for clip in all_clips:
            if clip.id not in seen:
                seen.add(clip.id)
                unique_clips.append(clip)

        scored = []
        for clip in unique_clips:
            score = 0

            # Title matches: 3 points per keyword
            score += _count_matches(clip.title_en, keywords) * 3
            score += _count_matches(clip.title_pl, keywords) * 3

            # Summary matches: 2 points per keyword
            score += _count_matches(clip.summary_en, keywords) * 2
            score += _count_matches(clip.summary_pl, keywords) * 2

            # Tags matches: 2 points per keyword (parse JSON array)
            if clip.tags:
                try:
                    tags_list = json.loads(clip.tags)
                    if isinstance(tags_list, list):
                        tags_text = " ".join(str(t) for t in tags_list)
                        score += _count_matches(tags_text, keywords) * 2
                except (json.JSONDecodeError, TypeError):
                    # tags stored as plain string
                    score += _count_matches(clip.tags, keywords) * 2

            # Category match: 1 point per keyword
            score += _count_matches(clip.category, keywords) * 1

            # Segment description matches: 1 point per keyword per segment
            matching_segments = []
            for seg in clip.segments:
                seg_score = 0
                seg_score += _count_matches(seg.description_en, keywords)
                seg_score += _count_matches(seg.description_pl, keywords)
                if seg_score > 0:
                    matching_segments.append(_segment_to_dict(seg))
                    score += seg_score

            if score > 0:
                scored.append((clip, score, matching_segments))

        # Sort by score descending
        scored.sort(key=lambda x: x[1], reverse=True)

        total = len(scored)

        # Apply offset/limit
        page = scored[offset : offset + limit]

        return {
            "results": [
                {
                    "clip": _clip_to_dict(clip),
                    "score": score,
                    "matching_segments": segs,
                }
                for clip, score, segs in page
            ],
            "total": total,
            "offset": offset,
            "limit": limit,
        }
    finally:
        db.close()


def get_clip_stats() -> dict:
    """Return library statistics.

    Opens its own DB session. Returns counts, breakdowns, and totals.
    """
    db = SessionLocal()
    try:
        total_clips = db.query(func.count(Clip.id)).scalar() or 0
        total_segments = db.query(func.count(ClipSegment.id)).scalar() or 0
        total_categories = db.query(func.count(Category.name)).scalar() or 0

        # Clips by category
        clips_by_category_rows = (
            db.query(Clip.category, func.count(Clip.id))
            .group_by(Clip.category)
            .all()
        )
        clips_by_category = [
            {"name": cat or "uncategorized", "count": cnt}
            for cat, cnt in clips_by_category_rows
        ]

        # Clips by type
        clips_by_type_rows = (
            db.query(Clip.type, func.count(Clip.id))
            .group_by(Clip.type)
            .all()
        )
        clips_by_type = {
            (t or "unknown"): cnt for t, cnt in clips_by_type_rows
        }

        # Total duration
        total_duration = (
            db.query(func.sum(Clip.duration)).scalar() or 0.0
        )

        return {
            "total_clips": total_clips,
            "total_segments": total_segments,
            "total_categories": total_categories,
            "clips_by_category": clips_by_category,
            "clips_by_type": clips_by_type,
            "total_duration": round(total_duration, 2),
        }
    finally:
        db.close()
