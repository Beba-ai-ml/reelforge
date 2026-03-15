"""AI clip analysis and categorization API routes."""

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.db.database import get_db, SessionLocal
from backend.db.models import Clip

logger = logging.getLogger(__name__)

router = APIRouter()


# --------------- Schemas ---------------

class AnalyzeResponse(BaseModel):
    status: str


class AnalyzeBatchRequest(BaseModel):
    clip_ids: Optional[list[str]] = None
    all_unanalyzed: bool = False


class AnalyzeBatchResponse(BaseModel):
    status: str
    count: int


class CategorizeResponse(BaseModel):
    category: str


class CategorizeBatchRequest(BaseModel):
    clip_ids: Optional[list[str]] = None
    all_uncategorized: bool = False


class CategorizeBatchResponse(BaseModel):
    status: str
    count: int


class AnalyzeProgressResponse(BaseModel):
    status: str
    current: int
    total: int
    current_clip: str
    success: int
    failed: int


class EmbedResponse(BaseModel):
    status: str


class EmbedBatchResponse(BaseModel):
    status: str
    embedded: int = 0
    skipped: int = 0
    errors: int = 0


# --------------- Background tasks ---------------

def _run_analyze_clip(clip_id: str):
    """Background task: analyze a single clip."""
    try:
        from backend.services.vision import analyze_clip
        analyze_clip(clip_id)
    except Exception as e:
        logger.exception("Background analysis failed for clip %s: %s", clip_id, e)


def _run_analyze_batch(clip_ids: list[str]):
    """Background task: analyze multiple clips."""
    try:
        from backend.services.vision import analyze_clips_batch
        result = analyze_clips_batch(clip_ids)
        logger.info("Batch analysis result: %s", result)
    except Exception as e:
        logger.exception("Background batch analysis failed: %s", e)


def _run_categorize_batch(clip_ids: list[str]):
    """Background task: categorize multiple clips."""
    try:
        from backend.services.categorizer import categorize_clips_batch
        result = categorize_clips_batch(clip_ids)
        logger.info("Batch categorization result: %s", result)
    except Exception as e:
        logger.exception("Background batch categorization failed: %s", e)


def _run_embed_clip(clip_id: str):
    """Background task: embed a single clip."""
    try:
        from backend.services.embeddings import embed_clip
        embed_clip(clip_id)
    except Exception as e:
        logger.exception("Background embedding failed for clip %s: %s", clip_id, e)


def _run_embed_all():
    """Background task: embed all clips missing embeddings."""
    try:
        from backend.services.embeddings import embed_all_clips
        result = embed_all_clips()
        logger.info("Batch embedding result: %s", result)
    except Exception as e:
        logger.exception("Background batch embedding failed: %s", e)


# --------------- Helpers ---------------

def _get_clip_or_404(clip_id: str, db: Session) -> Clip:
    clip = db.query(Clip).filter(Clip.id == clip_id).first()
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    return clip


# --------------- Endpoints ---------------

@router.post("/{clip_id}/analyze", response_model=AnalyzeResponse)
def analyze_single_clip(
    clip_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Trigger AI vision analysis for a single clip as a background task."""
    _get_clip_or_404(clip_id, db)
    background_tasks.add_task(_run_analyze_clip, clip_id)
    return AnalyzeResponse(status="analyzing")


@router.post("/analyze-batch", response_model=AnalyzeBatchResponse)
def analyze_batch(
    body: AnalyzeBatchRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Trigger AI analysis for multiple clips or all unanalyzed clips."""
    if body.all_unanalyzed:
        clips = db.query(Clip).filter(Clip.title_en.is_(None)).all()
        clip_ids = [c.id for c in clips]
    elif body.clip_ids:
        clip_ids = body.clip_ids
    else:
        raise HTTPException(
            status_code=400,
            detail="Provide clip_ids or set all_unanalyzed=true",
        )

    if not clip_ids:
        return AnalyzeBatchResponse(status="nothing_to_analyze", count=0)

    background_tasks.add_task(_run_analyze_batch, clip_ids)
    return AnalyzeBatchResponse(status="analyzing", count=len(clip_ids))


@router.get("/analyze-progress", response_model=AnalyzeProgressResponse)
def analyze_progress():
    """Get the current batch analysis progress."""
    from backend.services.vision import get_analysis_progress
    return AnalyzeProgressResponse(**get_analysis_progress())


@router.post("/analyze-cancel")
def analyze_cancel():
    """Cancel the running batch analysis."""
    from backend.services.vision import cancel_analysis
    cancel_analysis()
    return {"status": "cancel_requested"}


@router.post("/{clip_id}/categorize", response_model=CategorizeResponse)
def categorize_single_clip(
    clip_id: str,
    db: Session = Depends(get_db),
):
    """Categorize a single clip based on its analysis data.

    This is synchronous since categorization is fast (no AI model call).
    """
    clip = _get_clip_or_404(clip_id, db)

    if not clip.title_en and not clip.summary_en:
        raise HTTPException(
            status_code=400,
            detail="Clip has no analysis data. Run analyze first.",
        )

    from backend.services.categorizer import categorize_clip
    category = categorize_clip(clip_id)
    return CategorizeResponse(category=category)


@router.post("/categorize-batch", response_model=CategorizeBatchResponse)
def categorize_batch(
    body: CategorizeBatchRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Categorize multiple clips or all uncategorized analyzed clips."""
    if body.all_uncategorized:
        # Find clips that have analysis but no category
        clips = (
            db.query(Clip)
            .filter(Clip.title_en.isnot(None))
            .filter(Clip.category.is_(None))
            .all()
        )
        clip_ids = [c.id for c in clips]
    elif body.clip_ids:
        clip_ids = body.clip_ids
    else:
        raise HTTPException(
            status_code=400,
            detail="Provide clip_ids or set all_uncategorized=true",
        )

    if not clip_ids:
        return CategorizeBatchResponse(status="nothing_to_categorize", count=0)

    background_tasks.add_task(_run_categorize_batch, clip_ids)
    return CategorizeBatchResponse(status="categorizing", count=len(clip_ids))


@router.post("/embed-all", response_model=EmbedBatchResponse)
def embed_all(background_tasks: BackgroundTasks):
    """Trigger batch embedding for all clips missing embeddings."""
    background_tasks.add_task(_run_embed_all)
    return EmbedBatchResponse(status="embedding")


@router.post("/{clip_id}/embed", response_model=EmbedResponse)
def embed_single_clip(
    clip_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Trigger embedding for a single clip as a background task."""
    _get_clip_or_404(clip_id, db)
    background_tasks.add_task(_run_embed_clip, clip_id)
    return EmbedResponse(status="embedding")
