"""Library API endpoints - search and stats for the B-Roll clip library."""

from typing import Optional

from fastapi import APIRouter, Query

from backend.services.search import get_clip_stats, search_clips

router = APIRouter()


@router.get("/stats")
def library_stats():
    """Return library statistics (total clips, segments, categories, etc.)."""
    return get_clip_stats()


@router.get("/search")
def library_search(
    q: str = Query("", description="Search query keywords"),
    category: Optional[str] = Query(None, description="Filter by category"),
    clip_type: Optional[str] = Query(None, alias="type", description="Filter by clip type (video/image)"),
    is_dynamic: Optional[bool] = Query(None, description="Filter by dynamic flag"),
    limit: int = Query(50, ge=1, le=200, description="Max results per page"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
):
    """Search the clip library with keyword scoring."""
    return search_clips(
        query=q,
        category=category,
        clip_type=clip_type,
        is_dynamic=is_dynamic,
        limit=limit,
        offset=offset,
    )
