"""Clip and category management API routes (B-Roll Library)."""

import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from backend.config import (
    LIBRARY_DIR, THUMBNAILS_DIR,
    VIDEO_EXTENSIONS, IMAGE_EXTENSIONS,
)
from backend.db.database import get_db
from backend.db.models import Clip, ClipSegment, Category, _uuid, _now
from backend.utils.ffmpeg import detect_media_type, probe_video
from backend.services.thumbnails import generate_thumbnail
from backend.services.search import get_clip_stats, search_clips


router = APIRouter()

CLIP_EXTENSIONS = VIDEO_EXTENSIONS | IMAGE_EXTENSIONS
UNSORTED_DIR = LIBRARY_DIR / "_unsorted"


# --------------- Schemas ---------------

class ClipSegmentOut(BaseModel):
    id: int
    clip_id: str
    start_time: float
    end_time: float
    description_en: Optional[str] = None
    description_pl: Optional[str] = None

    model_config = {"from_attributes": True}


class ClipOut(BaseModel):
    id: str
    filename: str
    filepath: str
    category: Optional[str] = None
    type: Optional[str] = None
    title_en: Optional[str] = None
    title_pl: Optional[str] = None
    summary_en: Optional[str] = None
    summary_pl: Optional[str] = None
    duration: Optional[float] = None
    fps: Optional[float] = None
    width: Optional[int] = None
    height: Optional[int] = None
    is_dynamic: Optional[bool] = False
    focus_x: Optional[float] = 0.5
    focus_y: Optional[float] = 0.5
    thumbnail_path: Optional[str] = None
    tags: Optional[str] = None
    created_at: Optional[str] = None
    imported_at: Optional[datetime] = None
    is_favorite: Optional[bool] = False

    model_config = {"from_attributes": True}


class ClipDetail(ClipOut):
    segments: list[ClipSegmentOut] = []


class ClipUpdate(BaseModel):
    title_en: Optional[str] = None
    title_pl: Optional[str] = None
    summary_en: Optional[str] = None
    summary_pl: Optional[str] = None
    category: Optional[str] = None
    tags: Optional[str] = None
    is_dynamic: Optional[bool] = None
    focus_x: Optional[float] = None
    focus_y: Optional[float] = None


class ClipListResponse(BaseModel):
    items: list[ClipOut]
    total: int
    limit: int
    offset: int


class BulkImportResponse(BaseModel):
    imported: list[ClipOut]
    error_count: int
    errors: list[str] = []


class FolderImportRequest(BaseModel):
    path: str
    recursive: bool = False


class FolderImportResponse(BaseModel):
    imported_count: int
    skipped_count: int
    error_count: int
    errors: list[str] = []


class CategoryOut(BaseModel):
    name: str
    display_name: Optional[str] = None
    clip_count: int = 0
    created_at: Optional[str] = None

    model_config = {"from_attributes": True}


class CategoryCreate(BaseModel):
    name: str
    display_name: Optional[str] = None


class CategoryUpdate(BaseModel):
    display_name: str


# --------------- Helpers ---------------

def _validate_extension(filename: str) -> str:
    """Validate file extension and return it. Raises HTTPException on invalid."""
    ext = Path(filename).suffix.lower()
    if ext not in CLIP_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: {sorted(CLIP_EXTENSIONS)}",
        )
    return ext


def _process_clip_file(filepath: Path, filename: str, db: Session) -> Clip:
    """Create a Clip record from a file on disk, probe it, generate thumbnail."""
    media_type = detect_media_type(filename)
    if media_type not in ("video", "image"):
        raise ValueError(f"Unsupported media type for '{filename}'")

    # Relative path from LIBRARY_DIR
    try:
        rel_path = filepath.relative_to(LIBRARY_DIR)
    except ValueError:
        rel_path = Path(filepath.name)

    clip_id = _uuid()

    clip = Clip(
        id=clip_id,
        filename=filename,
        filepath=str(rel_path),
        type=media_type,
    )

    # Probe media info
    try:
        info = probe_video(str(filepath))
        clip.duration = info.get("duration", 0.0) or None
        clip.fps = info.get("fps", 0.0) or None
        clip.width = info.get("width", 0) or None
        clip.height = info.get("height", 0) or None
    except Exception:
        # Probing may fail for images or corrupt files -- continue anyway
        pass

    db.add(clip)
    db.commit()
    db.refresh(clip)

    # Generate thumbnail
    try:
        generate_thumbnail(clip_id, db=db)
        db.refresh(clip)
    except Exception:
        # Thumbnail generation is non-critical
        pass

    return clip


# --------------- Clip Endpoints ---------------

@router.post("/import", response_model=ClipOut, status_code=201)
async def import_clip(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload a single clip (video or image) to the library."""
    filename = file.filename or "unknown"
    _validate_extension(filename)

    # Ensure _unsorted directory exists
    UNSORTED_DIR.mkdir(parents=True, exist_ok=True)

    # Save file -- avoid overwriting by appending uuid if file exists
    dest = UNSORTED_DIR / filename
    if dest.exists():
        stem = Path(filename).stem
        ext = Path(filename).suffix
        dest = UNSORTED_DIR / f"{stem}_{_uuid()[:8]}{ext}"

    content = await file.read()
    with open(dest, "wb") as f:
        f.write(content)

    try:
        clip = _process_clip_file(dest, filename, db)
    except Exception as e:
        # Clean up the saved file on error
        dest.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Failed to process clip: {e}")

    return clip


@router.post("/import-bulk", response_model=BulkImportResponse, status_code=201)
async def import_bulk(
    files: list[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    """Upload multiple clips in one request."""
    UNSORTED_DIR.mkdir(parents=True, exist_ok=True)

    imported = []
    errors = []

    for file in files:
        filename = file.filename or "unknown"

        # Validate extension
        ext = Path(filename).suffix.lower()
        if ext not in CLIP_EXTENSIONS:
            errors.append(f"Skipped '{filename}': unsupported extension '{ext}'")
            continue

        # Save file
        dest = UNSORTED_DIR / filename
        if dest.exists():
            stem = Path(filename).stem
            dest = UNSORTED_DIR / f"{stem}_{_uuid()[:8]}{ext}"

        try:
            content = await file.read()
            with open(dest, "wb") as f:
                f.write(content)

            clip = _process_clip_file(dest, filename, db)
            imported.append(clip)
        except Exception as e:
            dest.unlink(missing_ok=True)
            errors.append(f"Failed '{filename}': {e}")

    return BulkImportResponse(
        imported=imported,
        error_count=len(errors),
        errors=errors,
    )


@router.post("/import-folder", response_model=FolderImportResponse)
def import_folder(
    body: FolderImportRequest,
    db: Session = Depends(get_db),
):
    """Import clips from a local directory on the server."""
    source_dir = Path(body.path)
    if not source_dir.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory not found: {body.path}")

    UNSORTED_DIR.mkdir(parents=True, exist_ok=True)

    imported_count = 0
    skipped_count = 0
    errors = []

    # Collect files
    if body.recursive:
        files = list(source_dir.rglob("*"))
    else:
        files = list(source_dir.iterdir())

    for file_path in files:
        if not file_path.is_file():
            continue

        ext = file_path.suffix.lower()
        if ext not in CLIP_EXTENSIONS:
            skipped_count += 1
            continue

        # Copy to _unsorted
        dest = UNSORTED_DIR / file_path.name
        if dest.exists():
            stem = file_path.stem
            dest = UNSORTED_DIR / f"{stem}_{_uuid()[:8]}{ext}"

        try:
            shutil.copy2(str(file_path), str(dest))
            _process_clip_file(dest, file_path.name, db)
            imported_count += 1
        except Exception as e:
            dest.unlink(missing_ok=True)
            errors.append(f"Failed '{file_path.name}': {e}")

    return FolderImportResponse(
        imported_count=imported_count,
        skipped_count=skipped_count,
        error_count=len(errors),
        errors=errors,
    )


@router.get("/", response_model=ClipListResponse)
def list_clips(
    q: Optional[str] = Query(None, description="Search text"),
    category: Optional[str] = Query(None),
    type: Optional[str] = Query(None, description="video or image"),
    is_dynamic: Optional[bool] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    """List and search clips with filtering and pagination."""
    query = db.query(Clip)

    # Text search
    if q:
        search_term = f"%{q}%"
        query = query.filter(
            or_(
                Clip.title_en.ilike(search_term),
                Clip.title_pl.ilike(search_term),
                Clip.summary_en.ilike(search_term),
                Clip.summary_pl.ilike(search_term),
                Clip.tags.ilike(search_term),
                Clip.filename.ilike(search_term),
            )
        )

    # Filters
    if category is not None:
        query = query.filter(Clip.category == category)
    if type is not None:
        query = query.filter(Clip.type == type)
    if is_dynamic is not None:
        query = query.filter(Clip.is_dynamic == is_dynamic)

    total = query.count()
    clips = query.order_by(Clip.created_at.desc()).offset(offset).limit(limit).all()

    return ClipListResponse(
        items=clips,
        total=total,
        limit=limit,
        offset=offset,
    )


@router.get("/stats")
def clip_stats():
    """Return library statistics (total clips, segments, categories, durations)."""
    return get_clip_stats()


@router.get("/search")
def clip_search(
    q: str = Query("", description="Search query keywords"),
    category: Optional[str] = Query(None),
    clip_type: Optional[str] = Query(None, alias="type", description="video or image"),
    is_dynamic: Optional[bool] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """Scored keyword search across all clip fields and segments."""
    return search_clips(
        query=q,
        category=category,
        clip_type=clip_type,
        is_dynamic=is_dynamic,
        limit=limit,
        offset=offset,
    )


@router.get("/{clip_id}", response_model=ClipDetail)
def get_clip(clip_id: str, db: Session = Depends(get_db)):
    """Get clip details including segments."""
    clip = (
        db.query(Clip)
        .options(joinedload(Clip.segments))
        .filter(Clip.id == clip_id)
        .first()
    )
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    return clip


@router.put("/{clip_id}", response_model=ClipOut)
def update_clip(clip_id: str, body: ClipUpdate, db: Session = Depends(get_db)):
    """Update clip metadata (partial update)."""
    clip = db.query(Clip).filter(Clip.id == clip_id).first()
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(clip, field, value)

    db.commit()
    db.refresh(clip)
    return clip


class BulkDeleteRequest(BaseModel):
    clip_ids: list[str]


class BulkDeleteResponse(BaseModel):
    deleted: int
    errors: list[str] = []


@router.post("/delete-bulk", response_model=BulkDeleteResponse)
def delete_clips_bulk(body: BulkDeleteRequest, db: Session = Depends(get_db)):
    """Delete multiple clips at once."""
    deleted = 0
    errors: list[str] = []

    for clip_id in body.clip_ids:
        clip = db.query(Clip).filter(Clip.id == clip_id).first()
        if not clip:
            errors.append(f"Clip {clip_id} not found")
            continue

        # Delete source file
        source_path = Path(clip.filepath)
        if not source_path.is_absolute():
            source_path = LIBRARY_DIR / source_path
        source_path.unlink(missing_ok=True)

        # Delete thumbnail
        thumb_path = THUMBNAILS_DIR / f"{clip_id}.jpg"
        thumb_path.unlink(missing_ok=True)

        db.delete(clip)
        deleted += 1

    db.commit()
    return BulkDeleteResponse(deleted=deleted, errors=errors)


@router.delete("/{clip_id}", status_code=204)
def delete_clip(clip_id: str, db: Session = Depends(get_db)):
    """Delete a clip, its file on disk, and its thumbnail."""
    clip = db.query(Clip).filter(Clip.id == clip_id).first()
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")

    # Delete the source file
    source_path = Path(clip.filepath)
    if not source_path.is_absolute():
        source_path = LIBRARY_DIR / source_path
    source_path.unlink(missing_ok=True)

    # Delete thumbnail
    thumb_path = THUMBNAILS_DIR / f"{clip_id}.jpg"
    thumb_path.unlink(missing_ok=True)

    # Delete DB record (cascades to segments)
    db.delete(clip)
    db.commit()
    return None


@router.get("/{clip_id}/file")
def get_clip_file(clip_id: str, db: Session = Depends(get_db)):
    """Serve the actual clip file (video or image)."""
    clip = db.query(Clip).filter(Clip.id == clip_id).first()
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")

    file_path = Path(clip.filepath)
    if not file_path.is_absolute():
        file_path = LIBRARY_DIR / file_path
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Clip file not found on disk")

    # Determine media type
    ext = file_path.suffix.lower()
    media_types = {
        ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
        ".mkv": "video/x-matroska", ".webm": "video/webm",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".heic": "image/heic", ".webp": "image/webp",
    }
    return FileResponse(str(file_path), media_type=media_types.get(ext, "application/octet-stream"))


@router.get("/{clip_id}/thumbnail")
def get_thumbnail(clip_id: str):
    """Serve the thumbnail image for a clip."""
    thumb_path = THUMBNAILS_DIR / f"{clip_id}.jpg"
    if not thumb_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")
    return FileResponse(str(thumb_path), media_type="image/jpeg")


class FavoriteResponse(BaseModel):
    id: str
    is_favorite: bool


@router.put("/{clip_id}/favorite", response_model=FavoriteResponse)
def toggle_favorite(clip_id: str, db: Session = Depends(get_db)):
    """Toggle the favorite status of a clip."""
    clip = db.query(Clip).filter(Clip.id == clip_id).first()
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")
    clip.is_favorite = not clip.is_favorite
    db.commit()
    db.refresh(clip)
    return FavoriteResponse(id=clip.id, is_favorite=bool(clip.is_favorite))


class ClipUsageProject(BaseModel):
    id: str
    name: str


class ClipUsageResponse(BaseModel):
    clip_id: str
    usage_count: int
    projects: list[ClipUsageProject]


@router.get("/{clip_id}/usage", response_model=ClipUsageResponse)
def get_clip_usage(clip_id: str, db: Session = Depends(get_db)):
    """Return list of projects that use this clip in their timeline."""
    from backend.db.models import TimelineItem, Project as ProjectModel

    clip = db.query(Clip).filter(Clip.id == clip_id).first()
    if not clip:
        raise HTTPException(status_code=404, detail="Clip not found")

    rows = (
        db.query(ProjectModel.id, ProjectModel.name)
        .join(TimelineItem, TimelineItem.project_id == ProjectModel.id)
        .filter(TimelineItem.clip_id == clip_id)
        .distinct()
        .all()
    )

    projects = [ClipUsageProject(id=row.id, name=row.name) for row in rows]
    return ClipUsageResponse(
        clip_id=clip_id,
        usage_count=len(projects),
        projects=projects,
    )


# --------------- Category Endpoints ---------------

@router.get("/categories/list", response_model=list[CategoryOut])
def list_categories(db: Session = Depends(get_db)):
    """List all categories with live clip counts computed from clips table."""
    # Compute actual counts from clips table instead of relying on cached clip_count
    count_map: dict[str, int] = {}
    rows = (
        db.query(Clip.category, func.count(Clip.id))
        .filter(Clip.category.isnot(None))
        .group_by(Clip.category)
        .all()
    )
    for cat_name, cnt in rows:
        count_map[cat_name] = cnt

    categories = db.query(Category).all()

    # Update cached counts to match reality and remove empty categories
    result = []
    for cat in categories:
        real_count = count_map.get(cat.name, 0)
        if real_count != cat.clip_count:
            cat.clip_count = real_count
        if real_count > 0:
            result.append(cat)
        else:
            # Auto-delete empty categories
            db.delete(cat)

    db.commit()

    result.sort(key=lambda c: c.clip_count, reverse=True)
    return result


@router.post("/categories", response_model=CategoryOut, status_code=201)
def create_category(body: CategoryCreate, db: Session = Depends(get_db)):
    """Create a new category."""
    existing = db.query(Category).filter(Category.name == body.name).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"Category '{body.name}' already exists")

    category = Category(
        name=body.name,
        display_name=body.display_name or body.name,
    )
    db.add(category)
    db.commit()
    db.refresh(category)
    return category


@router.put("/categories/{name}", response_model=CategoryOut)
def update_category(name: str, body: CategoryUpdate, db: Session = Depends(get_db)):
    """Update a category's display name."""
    category = db.query(Category).filter(Category.name == name).first()
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")

    category.display_name = body.display_name
    db.commit()
    db.refresh(category)
    return category


@router.delete("/categories/{name}", status_code=204)
def delete_category(name: str, db: Session = Depends(get_db)):
    """Delete a category. Fails if it has clips assigned."""
    category = db.query(Category).filter(Category.name == name).first()
    if not category:
        raise HTTPException(status_code=404, detail="Category not found")

    if category.clip_count and category.clip_count > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete category '{name}': {category.clip_count} clips assigned",
        )

    db.delete(category)
    db.commit()
    return None
