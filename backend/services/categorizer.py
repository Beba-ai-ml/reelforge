"""Clip categorization service based on AI analysis results."""

import json
import logging
import re
import shutil
from pathlib import Path

from backend.config import LIBRARY_DIR
from backend.db.database import SessionLocal
from backend.db.models import Clip, Category

logger = logging.getLogger(__name__)

# Common words to skip when generating category names
STOP_WORDS = {
    "a", "an", "the", "in", "on", "at", "to", "for", "of", "with", "and",
    "or", "is", "it", "its", "this", "that", "from", "by", "as", "be",
    "are", "was", "were", "been", "being", "has", "have", "had", "do",
    "does", "did", "will", "would", "could", "should", "may", "might",
    "can", "shall", "not", "no", "but", "if", "so", "very", "just",
    "about", "up", "out", "into", "over", "after", "before", "between",
    "through", "during", "while", "some", "any", "all", "each", "every",
    "more", "most", "other", "than", "then", "also", "only",
    "short", "clip", "video", "image", "showing", "shows", "scene",
    "footage", "shot", "view", "close", "closeup", "wide", "angle",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _tokenize(text: str) -> set[str]:
    """Extract meaningful keywords from text, lowercased."""
    if not text:
        return set()
    # Split on non-alphanumeric, lowercase, filter stop words and short tokens
    words = re.findall(r"[a-zA-Z0-9]+", text.lower())
    return {w for w in words if w not in STOP_WORDS and len(w) > 2}


def _slugify(text: str) -> str:
    """Convert text to category slug: lowercase, hyphens, no special chars."""
    text = text.lower().strip()
    text = re.sub(r"[^a-z0-9\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-")


def _get_clip_keywords(clip: Clip) -> set[str]:
    """Extract all keywords from a clip's analysis data."""
    keywords = set()
    keywords.update(_tokenize(clip.title_en or ""))
    keywords.update(_tokenize(clip.summary_en or ""))

    # Parse tags if available
    if clip.tags:
        try:
            tags = json.loads(clip.tags)
            if isinstance(tags, list):
                for tag in tags:
                    keywords.update(_tokenize(str(tag)))
        except (json.JSONDecodeError, TypeError):
            pass

    return keywords


def _score_category(category: Category, keywords: set[str]) -> int:
    """Score how well a category matches given keywords."""
    cat_words = set()
    cat_words.update(_tokenize(category.name.replace("-", " ")))
    if category.display_name:
        cat_words.update(_tokenize(category.display_name))
    return len(keywords & cat_words)


def _pick_category_name(clip: Clip, keywords: set[str]) -> str:
    """Generate a category name from the clip's most distinctive phrase.

    Uses the title as primary source, falling back to top tags.
    """
    title = clip.title_en or ""

    # Try to get a 2-3 word phrase from title
    title_words = re.findall(r"[a-zA-Z0-9]+", title.lower())
    meaningful = [w for w in title_words if w not in STOP_WORDS and len(w) > 2]

    if len(meaningful) >= 2:
        slug = _slugify(" ".join(meaningful[:3]))
        if slug:
            return slug

    if meaningful:
        slug = _slugify(meaningful[0])
        if slug:
            return slug

    # Fallback: use first tag
    if clip.tags:
        try:
            tags = json.loads(clip.tags)
            if isinstance(tags, list) and tags:
                slug = _slugify(str(tags[0]))
                if slug:
                    return slug
        except (json.JSONDecodeError, TypeError):
            pass

    # Last resort: use top keywords
    if keywords:
        slug = _slugify(sorted(keywords, key=len, reverse=True)[0])
        if slug:
            return slug

    return "uncategorized"


def _move_clip_file(clip: Clip, category_name: str) -> str:
    """Move clip file from current location to the category directory.

    Returns the new relative filepath (relative to LIBRARY_DIR).
    """
    old_path = LIBRARY_DIR / clip.filepath
    if not old_path.exists():
        logger.warning("Clip file not found for move: %s", old_path)
        return clip.filepath

    # Create category directory
    category_dir = LIBRARY_DIR / category_name
    category_dir.mkdir(parents=True, exist_ok=True)

    new_filename = old_path.name
    new_path = category_dir / new_filename

    # Handle name collision
    if new_path.exists() and new_path != old_path:
        stem = old_path.stem
        suffix = old_path.suffix
        counter = 1
        while new_path.exists():
            new_filename = f"{stem}_{counter}{suffix}"
            new_path = category_dir / new_filename
            counter += 1

    # Move file (skip if already in the right place)
    if old_path != new_path:
        shutil.move(str(old_path), str(new_path))
        logger.info("Moved clip file: %s -> %s", old_path, new_path)

        # Clean up empty source directory
        old_dir = old_path.parent
        if old_dir != LIBRARY_DIR and old_dir.exists():
            try:
                old_dir.rmdir()  # Only removes if empty
            except OSError:
                pass

    # Return relative path from LIBRARY_DIR
    return str(new_path.relative_to(LIBRARY_DIR))


# ---------------------------------------------------------------------------
# Main categorization function
# ---------------------------------------------------------------------------

def categorize_clip(clip_id: str) -> str:
    """Categorize a clip based on its AI analysis data.

    Opens its own DB session. Matches clip to existing category or creates new.
    Moves the file to the category directory.

    Returns the assigned category name.
    """
    db = SessionLocal()
    try:
        clip = db.query(Clip).filter(Clip.id == clip_id).first()
        if clip is None:
            raise ValueError(f"Clip {clip_id} not found")

        if not clip.title_en and not clip.summary_en:
            raise ValueError(
                f"Clip {clip_id} has no analysis data. Run analyze_clip() first."
            )

        keywords = _get_clip_keywords(clip)
        logger.info(
            "Categorizing clip %s: title=%s, %d keywords",
            clip_id, clip.title_en, len(keywords),
        )

        # Load all existing categories
        categories = db.query(Category).all()

        # Score each category
        best_category = None
        best_score = 0
        for cat in categories:
            score = _score_category(cat, keywords)
            if score > best_score:
                best_score = score
                best_category = cat

        if best_category and best_score > 0:
            category_name = best_category.name
            logger.info(
                "Matched clip %s to existing category '%s' (score=%d)",
                clip_id, category_name, best_score,
            )
        else:
            # Create a new category
            category_name = _pick_category_name(clip, keywords)

            # Check if this name already exists (could match an existing one)
            existing = db.query(Category).filter(Category.name == category_name).first()
            if existing is None:
                display_name = category_name.replace("-", " ").title()
                new_cat = Category(
                    name=category_name,
                    display_name=display_name,
                    clip_count=0,
                )
                db.add(new_cat)
                db.flush()
                logger.info("Created new category '%s'", category_name)

        # Move file to category directory
        new_filepath = _move_clip_file(clip, category_name)

        # Update clip record
        old_category = clip.category
        clip.filepath = new_filepath
        clip.category = category_name

        # Update category clip counts
        # Decrement old category count
        if old_category and old_category != category_name:
            old_cat = db.query(Category).filter(Category.name == old_category).first()
            if old_cat and old_cat.clip_count > 0:
                old_cat.clip_count -= 1

        # Increment new category count
        new_cat = db.query(Category).filter(Category.name == category_name).first()
        if new_cat:
            new_cat.clip_count += 1

        db.commit()
        logger.info("Clip %s categorized as '%s'", clip_id, category_name)

        return category_name

    except Exception as e:
        db.rollback()
        logger.exception("Categorization failed for clip %s: %s", clip_id, e)
        raise

    finally:
        db.close()


def categorize_clips_batch(clip_ids: list[str]) -> dict:
    """Categorize multiple clips. Returns {categorized, errors}."""
    categorized = 0
    errors = 0

    for clip_id in clip_ids:
        try:
            categorize_clip(clip_id)
            categorized += 1
        except Exception as e:
            errors += 1
            logger.error("Batch categorization failed for clip %s: %s", clip_id, e)

    logger.info(
        "Batch categorization complete: %d categorized, %d errors out of %d",
        categorized, errors, len(clip_ids),
    )

    return {"categorized": categorized, "errors": errors}


def recategorize_all() -> dict:
    """Reset and recategorize all clips that have analysis data.

    Returns {categorized, errors, total}.
    """
    db = SessionLocal()
    try:
        # Find all analyzed clips (have title_en)
        clips = db.query(Clip).filter(Clip.title_en.isnot(None)).all()
        clip_ids = [c.id for c in clips]
        total = len(clip_ids)
    finally:
        db.close()

    if not clip_ids:
        return {"categorized": 0, "errors": 0, "total": 0}

    logger.info("Recategorizing all %d analyzed clips", total)
    result = categorize_clips_batch(clip_ids)
    result["total"] = total
    return result
