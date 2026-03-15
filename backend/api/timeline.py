"""Timeline management API routes."""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.db.database import get_db
from backend.db.models import Clip, Project, TimelineItem


router = APIRouter()


# --------------- Schemas ---------------

class TimelineItemCreate(BaseModel):
    clip_id: Optional[str] = None
    source_type: str = "library"
    source_path: Optional[str] = None
    position: int
    timeline_start: float
    timeline_end: float
    clip_trim_start: float = 0.0
    clip_trim_end: Optional[float] = None
    speed: float = 1.0
    transition_in: str = "cut"
    transition_duration: float = 0.0


class TimelineItemUpdate(BaseModel):
    clip_id: Optional[str] = None
    source_type: Optional[str] = None
    source_path: Optional[str] = None
    position: Optional[int] = None
    timeline_start: Optional[float] = None
    timeline_end: Optional[float] = None
    clip_trim_start: Optional[float] = None
    clip_trim_end: Optional[float] = None
    speed: Optional[float] = None
    transition_in: Optional[str] = None
    transition_duration: Optional[float] = None


class TimelineItemResponse(BaseModel):
    id: int
    project_id: str
    clip_id: Optional[str] = None
    source_type: Optional[str] = None
    source_path: Optional[str] = None
    position: int
    timeline_start: float
    timeline_end: float
    clip_trim_start: Optional[float] = None
    clip_trim_end: Optional[float] = None
    speed: Optional[float] = None
    transition_in: Optional[str] = None
    transition_duration: Optional[float] = None
    clip_title: Optional[str] = None
    clip_type: Optional[str] = None

    model_config = {"from_attributes": True}


class ReorderItem(BaseModel):
    id: int
    position: int


class ReorderBody(BaseModel):
    items: list[ReorderItem]


# --------------- Helpers ---------------

def _get_project_or_404(project_id: str, db: Session) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _get_timeline_item_or_404(item_id: int, project_id: str, db: Session) -> TimelineItem:
    item = (
        db.query(TimelineItem)
        .filter(TimelineItem.id == item_id, TimelineItem.project_id == project_id)
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="Timeline item not found")
    return item


# --------------- Endpoints ---------------

@router.get("/{project_id}/timeline", response_model=list[TimelineItemResponse])
def list_timeline_items(project_id: str, db: Session = Depends(get_db)):
    """Get all timeline items for a project, ordered by position."""
    _get_project_or_404(project_id, db)
    items = (
        db.query(TimelineItem)
        .filter(TimelineItem.project_id == project_id)
        .order_by(TimelineItem.position)
        .all()
    )

    # Enrich with clip info
    clip_ids = [i.clip_id for i in items if i.clip_id]
    clip_map: dict[str, Clip] = {}
    if clip_ids:
        clips = db.query(Clip).filter(Clip.id.in_(clip_ids)).all()
        clip_map = {c.id: c for c in clips}

    result = []
    for item in items:
        data = TimelineItemResponse.model_validate(item)
        clip = clip_map.get(item.clip_id) if item.clip_id else None
        if clip:
            data.clip_title = clip.title_en or clip.filename
            data.clip_type = clip.type
        result.append(data)

    return result


@router.post("/{project_id}/timeline", response_model=TimelineItemResponse, status_code=201)
def create_timeline_item(
    project_id: str,
    body: TimelineItemCreate,
    db: Session = Depends(get_db),
):
    """Add a new timeline item to a project."""
    _get_project_or_404(project_id, db)

    item = TimelineItem(
        project_id=project_id,
        clip_id=body.clip_id,
        source_type=body.source_type,
        source_path=body.source_path,
        position=body.position,
        timeline_start=body.timeline_start,
        timeline_end=body.timeline_end,
        clip_trim_start=body.clip_trim_start,
        clip_trim_end=body.clip_trim_end,
        speed=body.speed,
        transition_in=body.transition_in,
        transition_duration=body.transition_duration,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


# NOTE: reorder MUST be defined before {item_id} routes
# to prevent FastAPI from matching "reorder" as an item_id.

@router.put("/{project_id}/timeline/reorder", response_model=list[TimelineItemResponse])
def reorder_timeline(
    project_id: str,
    body: ReorderBody,
    db: Session = Depends(get_db),
):
    """Bulk reorder timeline items by setting new position values."""
    _get_project_or_404(project_id, db)

    # Build a map of item_id -> new_position
    position_map = {entry.id: entry.position for entry in body.items}

    # Fetch all referenced items
    items = (
        db.query(TimelineItem)
        .filter(
            TimelineItem.project_id == project_id,
            TimelineItem.id.in_(position_map.keys()),
        )
        .all()
    )

    if len(items) != len(position_map):
        found_ids = {item.id for item in items}
        missing = set(position_map.keys()) - found_ids
        raise HTTPException(
            status_code=404,
            detail=f"Timeline items not found: {sorted(missing)}",
        )

    for item in items:
        item.position = position_map[item.id]

    db.commit()

    # Return all timeline items in new order
    all_items = (
        db.query(TimelineItem)
        .filter(TimelineItem.project_id == project_id)
        .order_by(TimelineItem.position)
        .all()
    )
    return all_items


@router.put("/{project_id}/timeline/{item_id}", response_model=TimelineItemResponse)
def update_timeline_item(
    project_id: str,
    item_id: int,
    body: TimelineItemUpdate,
    db: Session = Depends(get_db),
):
    """Partially update a timeline item."""
    _get_project_or_404(project_id, db)
    item = _get_timeline_item_or_404(item_id, project_id, db)

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(item, field, value)

    db.commit()
    db.refresh(item)
    return item


@router.delete("/{project_id}/timeline/{item_id}", status_code=204)
def delete_timeline_item(
    project_id: str,
    item_id: int,
    db: Session = Depends(get_db),
):
    """Delete a timeline item."""
    _get_project_or_404(project_id, db)
    item = _get_timeline_item_or_404(item_id, project_id, db)
    db.delete(item)
    db.commit()
    return None
