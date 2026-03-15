"""AI B-Roll matching service.

Hybrid keyword + embedding search to automatically place B-Roll clips
on the project timeline based on transcript content.
"""

import json
import logging
from typing import Optional

import numpy as np

from backend.db.database import SessionLocal
from backend.db.models import Clip, Project, TimelineItem, _now
from backend.services.search import search_clips, _clip_to_dict

logger = logging.getLogger(__name__)

# Stop words filtered when extracting visual keywords from transcript
STOP_WORDS = frozenset({
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "shall",
    "should", "may", "might", "must", "can", "could",
    "i", "me", "my", "myself", "we", "our", "ours", "ourselves",
    "you", "your", "yours", "yourself", "yourselves",
    "he", "him", "his", "himself", "she", "her", "hers", "herself",
    "it", "its", "itself", "they", "them", "their", "theirs", "themselves",
    "what", "which", "who", "whom", "this", "that", "these", "those",
    "am", "is", "are", "was", "were", "be", "been", "being",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
    "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "here", "there", "when", "where", "why", "how", "all", "both",
    "each", "few", "more", "most", "other", "some", "such", "no", "nor",
    "not", "only", "own", "same", "so", "than", "too", "very",
    "and", "but", "or", "if", "because", "about", "just", "also",
    "like", "really", "actually", "basically", "literally", "gonna",
    "going", "get", "got", "thing", "things", "well", "yeah", "okay",
    "right", "know", "think", "want", "need", "make", "go", "come",
    "take", "see", "look", "say", "said", "tell", "told", "use", "way",
    "even", "still", "much", "now", "let", "um", "uh", "oh",
})

# Pacing constraints
HOOK_DURATION = 2.0        # First 2s = clip A only
MIN_KEYWORD_SCORE = 2      # Minimum keyword search score
MIN_EMBEDDING_SIM = 0.3    # Minimum embedding cosine similarity
MAX_CONSECUTIVE_BROLL = 3  # Max consecutive B-Roll clips
MIN_GAP_BETWEEN = 2.0      # Minimum gap between B-Roll insertions (seconds)
MAX_DYNAMIC_DURATION = 5.0 # Max B-Roll duration for dynamic clips
MAX_STATIC_DURATION = 3.0  # Max B-Roll duration for static clips
DEDUP_WINDOW = 3           # Avoid reusing any of the last N clips
REUSE_PENALTY = 0.5        # Multiply score by this factor for each prior use of a clip


def _group_transcript_words(transcript: list[dict]) -> list[dict]:
    """Group transcript words into phrases based on pauses and length.

    Each group is: {text: str, words: list, start: float, end: float}
    """
    if not transcript:
        return []

    groups = []
    current_words = []

    for word_info in transcript:
        word = word_info.get("word", "").strip()
        start = word_info.get("start", 0)
        end = word_info.get("end", 0)

        if not word:
            continue

        # Start new group on pause > 0.8s or if current group is long enough
        if current_words:
            last_end = current_words[-1]["end"]
            pause = start - last_end
            if pause > 0.8 or len(current_words) >= 8:
                groups.append({
                    "text": " ".join(w["word"].strip() for w in current_words),
                    "words": current_words,
                    "start": current_words[0]["start"],
                    "end": current_words[-1]["end"],
                })
                current_words = []

        current_words.append(word_info)

    # Flush remaining
    if current_words:
        groups.append({
            "text": " ".join(w["word"].strip() for w in current_words),
            "words": current_words,
            "start": current_words[0]["start"],
            "end": current_words[-1]["end"],
        })

    return groups


def _extract_keywords(text: str) -> str:
    """Extract visual keywords from a phrase by filtering stop words."""
    words = text.lower().split()
    keywords = [w for w in words if w not in STOP_WORDS and len(w) > 1]
    return " ".join(keywords) if keywords else text.lower()


def _try_embedding_rerank(
    phrase: str,
    candidates: list[dict],
    db_session,
) -> list[dict]:
    """Rerank candidates by embedding similarity if embeddings are available.

    Returns candidates sorted by combined score (keyword + embedding).
    """
    try:
        from backend.services.embeddings import encode_text, cosine_similarity
    except Exception:
        return candidates

    # Check if any candidate clips have embeddings
    clip_ids = [c["clip"]["id"] for c in candidates if c.get("clip")]
    if not clip_ids:
        return candidates

    clips_with_emb = (
        db_session.query(Clip.id, Clip.embedding)
        .filter(Clip.id.in_(clip_ids), Clip.embedding.isnot(None))
        .all()
    )

    if not clips_with_emb:
        return candidates

    # Encode the phrase
    try:
        query_vec = encode_text(phrase)
    except Exception:
        return candidates

    emb_map = {cid: emb for cid, emb in clips_with_emb}

    for candidate in candidates:
        clip_id = candidate["clip"]["id"]
        if clip_id in emb_map:
            clip_vec = np.frombuffer(emb_map[clip_id], dtype=np.float32)
            sim = cosine_similarity(query_vec, clip_vec)
            candidate["embedding_score"] = sim
            # Combined score: keyword score + embedding similarity * 10
            candidate["combined_score"] = candidate["score"] + sim * 10
        else:
            candidate["embedding_score"] = 0.0
            candidate["combined_score"] = candidate["score"]

    candidates.sort(key=lambda x: x.get("combined_score", x["score"]), reverse=True)
    return candidates


def _timeline_item_to_dict(item: TimelineItem) -> dict:
    """Serialize a TimelineItem to a dict."""
    return {
        "id": item.id,
        "project_id": item.project_id,
        "clip_id": item.clip_id,
        "source_type": item.source_type,
        "source_path": item.source_path,
        "position": item.position,
        "timeline_start": item.timeline_start,
        "timeline_end": item.timeline_end,
        "clip_trim_start": item.clip_trim_start,
        "clip_trim_end": item.clip_trim_end,
        "speed": item.speed,
        "transition_in": item.transition_in,
        "transition_duration": item.transition_duration,
    }


def match_broll(project_id: str, max_broll: int | None = None) -> list[dict]:
    """Run hybrid keyword + embedding B-Roll matching for a project.

    Opens its own DB session. Analyzes the transcript, searches the library,
    and creates timeline items with pacing rules applied.

    Args:
        project_id: The project to match for.
        max_broll: Maximum number of B-Roll clips to place (None = auto).

    Returns list of created timeline item dicts.
    """
    db = SessionLocal()
    try:
        project = db.query(Project).filter(Project.id == project_id).first()
        if not project:
            raise ValueError(f"Project {project_id} not found")

        if not project.transcript_json:
            raise ValueError("Project has no transcript. Run transcription first.")

        transcript = json.loads(project.transcript_json)
        if not isinstance(transcript, list) or not transcript:
            raise ValueError("Transcript is empty or invalid format")

        duration = project.duration or 0
        if duration <= 0:
            raise ValueError("Project has no duration set")

        is_audio_only = project.clip_a_type in ("audio", "audio/mpeg", "audio/wav", "audio/mp3", "audio/m4a")

        # Group words into phrases
        phrase_groups = _group_transcript_words(transcript)
        if not phrase_groups:
            raise ValueError("Could not extract phrases from transcript")

        logger.info(
            "Project %s: %d phrases from %d words, duration=%.1fs, audio_only=%s, max_broll=%s",
            project_id, len(phrase_groups), len(transcript), duration, is_audio_only, max_broll,
        )

        # Match each phrase to a B-Roll clip (avoid recent duplicates + penalize reuse)
        matches = []
        recent_clip_ids: list[str] = []  # sliding window of last N selected clips
        clip_use_count: dict[str, int] = {}  # how many times each clip was selected
        for group in phrase_groups:
            keywords = _extract_keywords(group["text"])
            if not keywords.strip():
                continue

            # Search by keywords
            result = search_clips(query=keywords, limit=50)
            candidates = result.get("results", [])

            if not candidates:
                continue

            # Rerank with embeddings if available
            candidates = _try_embedding_rerank(group["text"], candidates, db)

            # Apply reuse penalty: clips already used get their score reduced
            for c in candidates:
                uses = clip_use_count.get(c["clip"]["id"], 0)
                base = c.get("combined_score", c["score"])
                c["diversity_score"] = base * (REUSE_PENALTY ** uses)

            # Sort by diversity-adjusted score
            candidates.sort(key=lambda x: x["diversity_score"], reverse=True)

            # Pick best candidate not in the recent window
            best = None
            for c in candidates:
                if c["clip"]["id"] not in recent_clip_ids:
                    best = c
                    break

            # Fallback: pick best not matching the immediate last
            if best is None:
                for c in candidates:
                    if not recent_clip_ids or c["clip"]["id"] != recent_clip_ids[-1]:
                        best = c
                        break

            # Final fallback
            if best is None:
                best = candidates[0]

            # Update tracking
            recent_clip_ids.append(best["clip"]["id"])
            if len(recent_clip_ids) > DEDUP_WINDOW:
                recent_clip_ids.pop(0)
            clip_use_count[best["clip"]["id"]] = clip_use_count.get(best["clip"]["id"], 0) + 1

            matches.append({
                "phrase": group["text"],
                "start": group["start"],
                "end": group["end"],
                "clip": best["clip"],
                "keyword_score": best["score"],
                "embedding_score": best.get("embedding_score", 0),
                "combined_score": best.get("combined_score", best["score"]),
            })

        # Apply pacing rules
        placed = []
        consecutive_broll = 0
        last_broll_end = -MIN_GAP_BETWEEN  # Allow first placement
        recent_placed_ids: list[str] = []  # sliding window of last N placed clips

        # Audio-only: relax constraints for full coverage
        hook_dur = 0.0 if is_audio_only else HOOK_DURATION
        min_gap = 0.0 if is_audio_only else MIN_GAP_BETWEEN
        max_consec = 999 if is_audio_only else MAX_CONSECUTIVE_BROLL

        for match in matches:
            # Enforce max_broll limit
            if max_broll is not None and len(placed) >= max_broll:
                break

            # Skip hook period
            if match["start"] < hook_dur:
                continue

            # Check score thresholds (relaxed for audio-only)
            if not is_audio_only:
                has_embedding = match["embedding_score"] > 0
                if has_embedding:
                    if match["embedding_score"] < MIN_EMBEDDING_SIM:
                        consecutive_broll = 0
                        continue
                else:
                    if match["keyword_score"] < MIN_KEYWORD_SCORE:
                        consecutive_broll = 0
                        continue

            # Max consecutive B-Roll
            if consecutive_broll >= max_consec:
                consecutive_broll = 0
                continue

            # Min gap between insertions
            if match["start"] - last_broll_end < min_gap:
                continue

            # Skip if clip is in the recent placement window (avoid repeating patterns)
            if match["clip"]["id"] in recent_placed_ids:
                continue

            # Determine B-Roll duration
            phrase_duration = match["end"] - match["start"]
            is_dynamic = match["clip"].get("is_dynamic", False)
            max_dur = MAX_DYNAMIC_DURATION if is_dynamic else MAX_STATIC_DURATION
            broll_duration = min(phrase_duration, max_dur)

            if broll_duration < 0.5:
                continue

            placed.append({
                "clip_id": match["clip"]["id"],
                "timeline_start": match["start"],
                "timeline_end": match["start"] + broll_duration,
                "clip": match["clip"],
            })

            consecutive_broll += 1
            last_broll_end = match["start"] + broll_duration
            recent_placed_ids.append(match["clip"]["id"])
            if len(recent_placed_ids) > DEDUP_WINDOW:
                recent_placed_ids.pop(0)

        # Audio-only: fill gaps between B-Roll with extended clips
        if is_audio_only and placed:
            placed = _fill_gaps_audio_only(placed, duration, matches, db)

        # Close small gaps between adjacent B-Roll clips by extending timeline_end
        if len(placed) > 1:
            placed.sort(key=lambda p: p["timeline_start"])
            for i in range(len(placed) - 1):
                gap = placed[i + 1]["timeline_start"] - placed[i]["timeline_end"]
                if 0 < gap <= 2.0:
                    # Extend current clip to meet the next one
                    placed[i]["timeline_end"] = placed[i + 1]["timeline_start"]

        unique_clips = len(set(p["clip_id"] for p in placed))
        logger.info(
            "Project %s: placed %d B-Roll clips (%d unique) from %d matches",
            project_id, len(placed), unique_clips, len(matches),
        )

        # Delete existing timeline items
        db.query(TimelineItem).filter(
            TimelineItem.project_id == project_id
        ).delete()

        # Create clip_a base layer (position 0)
        clip_a_item = TimelineItem(
            project_id=project_id,
            source_type="clip_a",
            source_path=project.clip_a_path,
            position=0,
            timeline_start=0,
            timeline_end=duration,
        )
        db.add(clip_a_item)

        # Create B-Roll items
        created_items = [clip_a_item]
        for i, p in enumerate(placed):
            item = TimelineItem(
                project_id=project_id,
                clip_id=p["clip_id"],
                source_type="library",
                position=i + 1,
                timeline_start=p["timeline_start"],
                timeline_end=p["timeline_end"],
                clip_trim_start=0,
                clip_trim_end=p["timeline_end"] - p["timeline_start"],
                transition_in="crossfade",
                transition_duration=0.3,
            )
            db.add(item)
            created_items.append(item)

        # Update project status
        project.status = "editing"
        project.updated_at = _now()
        db.commit()

        # Refresh to get IDs
        for item in created_items:
            db.refresh(item)

        return [_timeline_item_to_dict(item) for item in created_items]

    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def _fill_gaps_audio_only(
    placed: list[dict],
    duration: float,
    matches: list[dict],
    db_session,
) -> list[dict]:
    """For audio-only projects, fill gaps so there's no black screen.

    Extends existing clips or inserts filler clips from the library to cover
    the entire timeline.
    """
    if not placed:
        return placed

    # Sort by timeline_start
    placed.sort(key=lambda p: p["timeline_start"])

    filled: list[dict] = []

    # Fill gap from 0 to first clip
    if placed[0]["timeline_start"] > 0.5:
        filled.append({
            "clip_id": placed[0]["clip_id"],
            "timeline_start": 0.0,
            "timeline_end": placed[0]["timeline_start"],
            "clip": placed[0]["clip"],
        })

    for i, item in enumerate(placed):
        filled.append(item)

        # Check gap to next clip
        next_start = placed[i + 1]["timeline_start"] if i + 1 < len(placed) else duration
        gap_start = item["timeline_end"]

        if next_start - gap_start > 0.5:
            # Fill gap by extending current clip or using same clip
            filled.append({
                "clip_id": item["clip_id"],
                "timeline_start": gap_start,
                "timeline_end": next_start,
                "clip": item["clip"],
            })

    # Fill gap from last clip to end
    if placed and placed[-1]["timeline_end"] < duration - 0.5:
        filled.append({
            "clip_id": placed[-1]["clip_id"],
            "timeline_start": placed[-1]["timeline_end"],
            "timeline_end": duration,
            "clip": placed[-1]["clip"],
        })

    return filled


def get_alternatives(
    project_id: str,
    item_id: int,
    limit: int = 5,
) -> list[dict]:
    """Find alternative B-Roll clips for a timeline item.

    Opens its own DB session. Searches using the narration text around
    the item's time range.

    Returns list of alternative clips with scores.
    """
    db = SessionLocal()
    try:
        item = (
            db.query(TimelineItem)
            .filter(TimelineItem.id == item_id, TimelineItem.project_id == project_id)
            .first()
        )
        if not item:
            raise ValueError(f"Timeline item {item_id} not found in project {project_id}")

        project = db.query(Project).filter(Project.id == project_id).first()
        if not project:
            raise ValueError(f"Project {project_id} not found")

        if not project.transcript_json:
            raise ValueError("Project has no transcript")

        transcript = json.loads(project.transcript_json)

        # Get narration text around the item's time range
        words_in_range = [
            w for w in transcript
            if w.get("start", 0) >= item.timeline_start - 1.0
            and w.get("end", 0) <= item.timeline_end + 1.0
        ]

        if not words_in_range:
            # Fallback: get words closest to the midpoint
            midpoint = (item.timeline_start + item.timeline_end) / 2
            sorted_words = sorted(
                transcript,
                key=lambda w: abs(w.get("start", 0) - midpoint),
            )
            words_in_range = sorted_words[:8]

        phrase_text = " ".join(w.get("word", "").strip() for w in words_in_range)
        keywords = _extract_keywords(phrase_text)

        # Search by keywords
        result = search_clips(query=keywords, limit=limit + 10)
        candidates = result.get("results", [])

        # Rerank with embeddings
        candidates = _try_embedding_rerank(phrase_text, candidates, db)

        # Exclude the current clip
        current_clip_id = item.clip_id
        alternatives = []
        for c in candidates:
            if c["clip"]["id"] == current_clip_id:
                continue

            reason_parts = []
            if c["score"] > 0:
                reason_parts.append(f"keyword score {c['score']}")
            emb_score = c.get("embedding_score", 0)
            if emb_score > 0:
                reason_parts.append(f"semantic similarity {emb_score:.2f}")
            reason = ", ".join(reason_parts) if reason_parts else "library match"

            alternatives.append({
                "clip": c["clip"],
                "score": c.get("combined_score", c["score"]),
                "reason": reason,
            })

            if len(alternatives) >= limit:
                break

        return alternatives

    finally:
        db.close()
