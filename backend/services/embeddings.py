"""Semantic embedding service using sentence-transformers."""

import json
import logging
import threading

import numpy as np

from backend.db.database import SessionLocal
from backend.db.models import Clip, ClipSegment

try:
    from sentence_transformers import SentenceTransformer
except ImportError:
    SentenceTransformer = None

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

EMBEDDING_MODEL = "all-MiniLM-L6-v2"
EMBEDDING_DIM = 384
IDLE_TIMEOUT = 300  # seconds

# ---------------------------------------------------------------------------
# Module-level model singleton
# ---------------------------------------------------------------------------

_model: "SentenceTransformer | None" = None
_model_lock = threading.Lock()

_idle_timer: threading.Timer | None = None
_idle_timer_lock = threading.Lock()


def _load_model() -> "SentenceTransformer":
    """Load the sentence-transformers model (singleton with lock)."""
    global _model
    if SentenceTransformer is None:
        raise RuntimeError("sentence-transformers is not installed")
    with _model_lock:
        if _model is None:
            logger.info("Loading embedding model %s", EMBEDDING_MODEL)
            _model = SentenceTransformer(EMBEDDING_MODEL)
            logger.info("Embedding model loaded")
    return _model


def unload_model() -> None:
    """Public API: unload embedding model to free memory."""
    _unload_model()


def _unload_model() -> None:
    """Unload model to free memory."""
    _cancel_idle_timer()
    global _model
    with _model_lock:
        if _model is not None:
            logger.info("Unloading embedding model")
            _model = None
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _reset_idle_timer() -> None:
    """Reset the idle timer. Fires model unload after IDLE_TIMEOUT seconds."""
    global _idle_timer
    with _idle_timer_lock:
        if _idle_timer is not None:
            _idle_timer.cancel()
        if IDLE_TIMEOUT > 0:
            _idle_timer = threading.Timer(IDLE_TIMEOUT, _unload_model)
            _idle_timer.daemon = True
            _idle_timer.start()


def _cancel_idle_timer() -> None:
    """Cancel the idle timer."""
    global _idle_timer
    with _idle_timer_lock:
        if _idle_timer is not None:
            _idle_timer.cancel()
            _idle_timer = None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def encode_text(text: str) -> np.ndarray:
    """Encode a single text string to a 384-dim embedding vector."""
    model = _load_model()
    embedding = model.encode(text, convert_to_numpy=True)
    _reset_idle_timer()
    return embedding.astype(np.float32)


def encode_texts(texts: list[str]) -> list[np.ndarray]:
    """Batch encode multiple texts to embedding vectors."""
    model = _load_model()
    embeddings = model.encode(texts, convert_to_numpy=True, batch_size=32)
    _reset_idle_timer()
    return [e.astype(np.float32) for e in embeddings]


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Compute cosine similarity between two vectors."""
    norm_a = np.linalg.norm(a)
    norm_b = np.linalg.norm(b)
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return float(np.dot(a, b) / (norm_a * norm_b))


def _build_clip_text(clip: Clip) -> str:
    """Build the text to embed for a clip from its metadata and segments."""
    parts = []
    if clip.title_en:
        parts.append(clip.title_en)
    if clip.summary_en:
        parts.append(clip.summary_en)

    # Collect segment descriptions
    for seg in clip.segments:
        if seg.description_en:
            parts.append(seg.description_en)

    return " ".join(parts)


def embed_clip(clip_id: str) -> None:
    """Compute embedding for a clip and store it in the database."""
    db = SessionLocal()
    try:
        clip = db.query(Clip).filter(Clip.id == clip_id).first()
        if clip is None:
            raise ValueError(f"Clip {clip_id} not found")

        # Eagerly load segments
        _ = clip.segments

        text = _build_clip_text(clip)
        if not text.strip():
            logger.warning("Clip %s has no text to embed, skipping", clip_id)
            return

        embedding = encode_text(text)
        clip.embedding = embedding.tobytes()
        db.commit()
        logger.info("Embedded clip %s (%d chars)", clip_id, len(text))
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def embed_all_clips() -> dict:
    """Batch embed all clips that are missing embeddings.

    Returns dict with keys: embedded, skipped, errors.
    """
    db = SessionLocal()
    try:
        clips = (
            db.query(Clip)
            .filter(Clip.embedding.is_(None))
            .filter(Clip.title_en.isnot(None))
            .all()
        )

        embedded = 0
        skipped = 0
        errors = 0

        for clip in clips:
            try:
                # Eagerly load segments
                _ = clip.segments

                text = _build_clip_text(clip)
                if not text.strip():
                    skipped += 1
                    continue

                embedding = encode_text(text)
                clip.embedding = embedding.tobytes()
                db.commit()
                embedded += 1
            except Exception as e:
                db.rollback()
                logger.exception("Failed to embed clip %s: %s", clip.id, e)
                errors += 1

        logger.info(
            "Batch embedding complete: embedded=%d, skipped=%d, errors=%d",
            embedded, skipped, errors,
        )
        return {"embedded": embedded, "skipped": skipped, "errors": errors}
    finally:
        db.close()


def search_by_embedding(
    query: str,
    limit: int = 20,
    category: str | None = None,
) -> list[dict]:
    """Search clips by semantic similarity to a query string.

    Returns top matches sorted by cosine similarity (descending).
    """
    query_vec = encode_text(query)

    db = SessionLocal()
    try:
        q = db.query(Clip).filter(Clip.embedding.isnot(None))
        if category:
            q = q.filter(Clip.category == category)

        clips = q.all()

        results = []
        for clip in clips:
            clip_vec = np.frombuffer(clip.embedding, dtype=np.float32)
            score = cosine_similarity(query_vec, clip_vec)
            results.append({
                "clip_id": clip.id,
                "filename": clip.filename,
                "title_en": clip.title_en,
                "summary_en": clip.summary_en,
                "category": clip.category,
                "duration": clip.duration,
                "type": clip.type,
                "score": round(score, 4),
            })

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:limit]
    finally:
        db.close()
