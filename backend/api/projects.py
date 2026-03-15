"""Project management API routes."""

import json
import shutil
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.config import PROJECTS_DIR, ALLOWED_EXTENSIONS
from backend.db.database import get_db
from backend.db.models import Project, Subtitle, TimelineItem, _now
from backend.utils.ffmpeg import detect_media_type, probe_video


router = APIRouter()


# --------------- Schemas ---------------

class ProjectCreate(BaseModel):
    name: str
    output_format: str = "9:16"


class ProjectSummary(BaseModel):
    id: str
    name: str
    status: str
    created_at: str
    duration: Optional[float] = None
    clip_a_path: Optional[str] = None
    clip_a_type: Optional[str] = None
    output_format: str = "9:16"
    thumbnail_path: Optional[str] = None

    model_config = {"from_attributes": True}


class ProjectDetail(BaseModel):
    id: str
    name: str
    status: str
    clip_a_path: Optional[str] = None
    clip_a_type: Optional[str] = None
    transcript_json: Optional[str] = None
    duration: Optional[float] = None
    output_format: str
    output_path: Optional[str] = None
    draft_path: Optional[str] = None
    thumbnail_path: Optional[str] = None
    music_path: Optional[str] = None
    music_volume: float = 0.3
    created_at: str
    updated_at: str
    subtitle_count: int = 0
    timeline_item_count: int = 0

    model_config = {"from_attributes": True}


# --------------- Helpers ---------------

def _get_project_or_404(project_id: str, db: Session) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _project_detail(project: Project) -> ProjectDetail:
    return ProjectDetail(
        id=project.id,
        name=project.name,
        status=project.status,
        clip_a_path=project.clip_a_path,
        clip_a_type=project.clip_a_type,
        transcript_json=project.transcript_json,
        duration=project.duration,
        output_format=project.output_format,
        output_path=project.output_path,
        draft_path=project.draft_path,
        thumbnail_path=project.thumbnail_path,
        music_path=project.music_path,
        music_volume=project.music_volume if project.music_volume is not None else 0.3,
        created_at=project.created_at,
        updated_at=project.updated_at,
        subtitle_count=len(project.subtitles),
        timeline_item_count=len(project.timeline_items),
    )


# --------------- Endpoints ---------------

@router.post("/", response_model=ProjectSummary, status_code=201)
def create_project(body: ProjectCreate, db: Session = Depends(get_db)):
    """Create a new project."""
    project = Project(name=body.name, output_format=body.output_format)
    db.add(project)
    db.commit()
    db.refresh(project)

    # Create project directory
    project_dir = PROJECTS_DIR / project.id
    project_dir.mkdir(parents=True, exist_ok=True)

    return project


@router.get("/", response_model=list[ProjectSummary])
def list_projects(db: Session = Depends(get_db)):
    """List all projects."""
    projects = db.query(Project).order_by(Project.created_at.desc()).all()
    return projects


@router.get("/{project_id}", response_model=ProjectDetail)
def get_project(project_id: str, db: Session = Depends(get_db)):
    """Get project details including subtitle and timeline item counts."""
    project = _get_project_or_404(project_id, db)
    return _project_detail(project)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str, db: Session = Depends(get_db)):
    """Delete a project and its files on disk."""
    project = _get_project_or_404(project_id, db)

    # Remove project directory
    project_dir = PROJECTS_DIR / project.id
    if project_dir.exists():
        shutil.rmtree(project_dir)

    db.delete(project)
    db.commit()
    return None


@router.post("/{project_id}/upload", response_model=ProjectDetail)
async def upload_clip_a(
    project_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload clip A (video/audio/image) for a project."""
    project = _get_project_or_404(project_id, db)

    # Validate extension
    ext = Path(file.filename).suffix.lower() if file.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: {sorted(ALLOWED_EXTENSIONS)}",
        )

    # Detect media type
    media_type = detect_media_type(file.filename or "")
    if media_type is None:
        raise HTTPException(status_code=400, detail="Cannot determine media type")

    # Save file
    project_dir = PROJECTS_DIR / project.id
    project_dir.mkdir(parents=True, exist_ok=True)
    dest = project_dir / f"input{ext}"

    with open(dest, "wb") as f:
        content = await file.read()
        f.write(content)

    # Probe media info
    try:
        info = probe_video(str(dest))
        duration = info.get("duration", 0.0)
    except Exception:
        duration = None

    # Update project
    project.clip_a_path = str(dest)
    project.clip_a_type = media_type
    project.duration = duration
    project.updated_at = _now()
    db.commit()
    db.refresh(project)

    return _project_detail(project)


@router.post("/{project_id}/duplicate", response_model=ProjectSummary, status_code=201)
def duplicate_project(project_id: str, db: Session = Depends(get_db)):
    """Create a copy of an existing project."""
    source = _get_project_or_404(project_id, db)

    new_project = Project(
        name=f"{source.name} (copy)",
        status="draft",
        output_format=source.output_format,
        transcript_json=source.transcript_json,
        duration=source.duration,
        clip_a_type=source.clip_a_type,
    )
    db.add(new_project)
    db.flush()

    # Create project directory and copy clip_a
    new_dir = PROJECTS_DIR / new_project.id
    new_dir.mkdir(parents=True, exist_ok=True)

    if source.clip_a_path and Path(source.clip_a_path).is_file():
        src_file = Path(source.clip_a_path)
        dst_file = new_dir / src_file.name
        shutil.copy2(src_file, dst_file)
        new_project.clip_a_path = str(dst_file)

    # Copy subtitles
    for sub in source.subtitles:
        new_sub = Subtitle(
            project_id=new_project.id,
            text=sub.text,
            start_time=sub.start_time,
            end_time=sub.end_time,
            style=sub.style,
            position_x=sub.position_x,
            position_y=sub.position_y,
            font_size=sub.font_size,
            color=sub.color,
            karaoke_style=sub.karaoke_style,
            outline_color=sub.outline_color,
            words_json=sub.words_json,
            language=sub.language,
        )
        db.add(new_sub)

    # Copy timeline items
    for item in source.timeline_items:
        new_item = TimelineItem(
            project_id=new_project.id,
            clip_id=item.clip_id,
            source_type=item.source_type,
            source_path=item.source_path,
            position=item.position,
            timeline_start=item.timeline_start,
            timeline_end=item.timeline_end,
            clip_trim_start=item.clip_trim_start,
            clip_trim_end=item.clip_trim_end,
            speed=item.speed,
            transition_in=item.transition_in,
            transition_duration=item.transition_duration,
        )
        db.add(new_item)

    db.commit()
    db.refresh(new_project)
    return new_project


@router.get("/{project_id}/export")
def export_project(project_id: str, db: Session = Depends(get_db)):
    """Export project as EDL-compatible JSON."""
    project = _get_project_or_404(project_id, db)

    # Parse transcript
    transcript = None
    if project.transcript_json:
        try:
            transcript = json.loads(project.transcript_json)
        except (json.JSONDecodeError, TypeError):
            transcript = None

    timeline = []
    for item in sorted(project.timeline_items, key=lambda x: x.position):
        timeline.append({
            "source_type": item.source_type,
            "source_path": item.source_path,
            "clip_id": item.clip_id,
            "position": item.position,
            "timeline_start": item.timeline_start,
            "timeline_end": item.timeline_end,
            "clip_trim_start": item.clip_trim_start,
            "clip_trim_end": item.clip_trim_end,
            "speed": item.speed,
            "transition_in": item.transition_in,
            "transition_duration": item.transition_duration,
        })

    subtitles_list = []
    for sub in sorted(project.subtitles, key=lambda x: x.start_time):
        subtitles_list.append({
            "text": sub.text,
            "start_time": sub.start_time,
            "end_time": sub.end_time,
            "style": sub.style,
            "position_x": sub.position_x,
            "position_y": sub.position_y,
            "font_size": sub.font_size,
            "color": sub.color,
            "karaoke_style": sub.karaoke_style,
            "outline_color": sub.outline_color,
            "words_json": sub.words_json,
            "language": sub.language,
        })

    return {
        "name": project.name,
        "format": project.output_format,
        "duration": project.duration,
        "timeline": timeline,
        "subtitles": subtitles_list,
        "transcript": transcript,
    }


class ProjectImport(BaseModel):
    name: str
    format: str = "9:16"
    duration: Optional[float] = None
    timeline: list[dict] = []
    subtitles: list[dict] = []
    transcript: Optional[list] = None


@router.post("/import", response_model=ProjectSummary, status_code=201)
def import_project(body: ProjectImport, db: Session = Depends(get_db)):
    """Create a project from exported EDL JSON."""
    project = Project(
        name=body.name,
        status="draft",
        output_format=body.format,
        duration=body.duration,
        transcript_json=json.dumps(body.transcript) if body.transcript else None,
    )
    db.add(project)
    db.flush()

    # Create project directory
    project_dir = PROJECTS_DIR / project.id
    project_dir.mkdir(parents=True, exist_ok=True)

    # Import subtitles
    for sub_data in body.subtitles:
        sub = Subtitle(
            project_id=project.id,
            text=sub_data.get("text", ""),
            start_time=sub_data.get("start_time", 0),
            end_time=sub_data.get("end_time", 0),
            style=sub_data.get("style", "body"),
            position_x=sub_data.get("position_x", 0.5),
            position_y=sub_data.get("position_y", 0.6),
            font_size=sub_data.get("font_size"),
            color=sub_data.get("color", "#FFFFFF"),
            karaoke_style=sub_data.get("karaoke_style", "classic"),
            outline_color=sub_data.get("outline_color", "#000000"),
            words_json=sub_data.get("words_json"),
            language=sub_data.get("language", "en"),
        )
        db.add(sub)

    # Import timeline items
    for i, item_data in enumerate(body.timeline):
        item = TimelineItem(
            project_id=project.id,
            clip_id=item_data.get("clip_id"),
            source_type=item_data.get("source_type", "library"),
            source_path=item_data.get("source_path"),
            position=item_data.get("position", i),
            timeline_start=item_data.get("timeline_start", 0),
            timeline_end=item_data.get("timeline_end", 0),
            clip_trim_start=item_data.get("clip_trim_start", 0),
            clip_trim_end=item_data.get("clip_trim_end"),
            speed=item_data.get("speed", 1.0),
            transition_in=item_data.get("transition_in", "cut"),
            transition_duration=item_data.get("transition_duration", 0.0),
        )
        db.add(item)

    db.commit()
    db.refresh(project)
    return project


@router.get("/{project_id}/thumbnail")
def get_project_thumbnail(project_id: str, db: Session = Depends(get_db)):
    """Serve the project thumbnail image."""
    project = _get_project_or_404(project_id, db)

    thumb_path = project.thumbnail_path
    if not thumb_path or not Path(thumb_path).is_file():
        raise HTTPException(status_code=404, detail="No thumbnail available")

    return FileResponse(thumb_path, media_type="image/jpeg")


ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"}


@router.post("/{project_id}/upload-music", response_model=ProjectDetail)
async def upload_music(
    project_id: str,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload a background music file for a project."""
    project = _get_project_or_404(project_id, db)

    ext = Path(file.filename).suffix.lower() if file.filename else ""
    if ext not in ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported audio format '{ext}'. Allowed: {sorted(ALLOWED_AUDIO_EXTENSIONS)}",
        )

    project_dir = PROJECTS_DIR / project.id
    project_dir.mkdir(parents=True, exist_ok=True)

    # Remove previous music file if different extension
    if project.music_path:
        old_path = Path(project.music_path)
        if old_path.is_file() and old_path != project_dir / f"music{ext}":
            old_path.unlink(missing_ok=True)

    dest = project_dir / f"music{ext}"
    with open(dest, "wb") as f:
        content = await file.read()
        f.write(content)

    project.music_path = str(dest)
    project.updated_at = _now()
    db.commit()
    db.refresh(project)
    return _project_detail(project)


class MusicVolumeUpdate(BaseModel):
    music_volume: float


@router.put("/{project_id}/music-volume", response_model=ProjectDetail)
def update_music_volume(
    project_id: str,
    body: MusicVolumeUpdate,
    db: Session = Depends(get_db),
):
    """Update the background music volume for a project (0.0 - 1.0)."""
    project = _get_project_or_404(project_id, db)
    project.music_volume = max(0.0, min(1.0, body.music_volume))
    project.updated_at = _now()
    db.commit()
    db.refresh(project)
    return _project_detail(project)


@router.delete("/{project_id}/music", response_model=ProjectDetail)
def remove_music(project_id: str, db: Session = Depends(get_db)):
    """Remove the background music from a project."""
    project = _get_project_or_404(project_id, db)

    if project.music_path:
        music_file = Path(project.music_path)
        if music_file.is_file():
            music_file.unlink(missing_ok=True)
        project.music_path = None

    project.updated_at = _now()
    db.commit()
    db.refresh(project)
    return _project_detail(project)
