"""Render management API routes."""

import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.config import PROJECTS_DIR
from backend.db.database import get_db, SessionLocal
from backend.db.models import Project, _now

logger = logging.getLogger(__name__)

router = APIRouter()

# Maximum number of past render files to retain per project
MAX_RENDER_HISTORY = 5


# --------------- Schemas ---------------

class RenderRequest(BaseModel):
    draft: bool = True


class RenderStatusResponse(BaseModel):
    project_id: str
    status: str
    output_path: Optional[str] = None
    draft_path: Optional[str] = None

    model_config = {"from_attributes": True}


class RenderHistoryEntry(BaseModel):
    id: str
    timestamp: str
    format: str
    duration_sec: Optional[float] = None
    file_size_bytes: Optional[int] = None
    filename: str


class RenderHistoryResponse(BaseModel):
    entries: List[RenderHistoryEntry]


# --------------- Helpers ---------------

def _history_path(project_id: str) -> Path:
    """Return path to the render_history.json for a project."""
    return PROJECTS_DIR / project_id / "render_history.json"


def _load_history(project_id: str) -> List[dict]:
    path = _history_path(project_id)
    if path.is_file():
        try:
            return json.loads(path.read_text())
        except Exception:
            return []
    return []


def _save_history(project_id: str, entries: List[dict]) -> None:
    path = _history_path(project_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, indent=2))


def _record_render(project_id: str, file_path: str, output_format: str) -> None:
    """Append a render entry and evict oldest if over limit."""
    p = Path(file_path)
    if not p.is_file():
        return

    entry_id = str(uuid.uuid4())
    try:
        file_size = p.stat().st_size
    except OSError:
        file_size = None

    # Try to get duration via ffprobe
    duration_sec: Optional[float] = None
    try:
        import subprocess
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", str(p)],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            info = json.loads(result.stdout)
            duration_sec = float(info.get("format", {}).get("duration", 0)) or None
    except Exception:
        pass

    composite_filename = f"{entry_id}_{p.name}"
    entry = {
        "id": entry_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "format": output_format or "9:16",
        "duration_sec": duration_sec,
        "file_size_bytes": file_size,
        "filename": composite_filename,
    }

    entries = _load_history(project_id)
    entries.insert(0, entry)  # newest first

    # Evict oldest entries beyond MAX_RENDER_HISTORY
    while len(entries) > MAX_RENDER_HISTORY:
        old = entries.pop()
        old_file = PROJECTS_DIR / project_id / "history" / old["filename"]
        try:
            if old_file.is_file():
                old_file.unlink()
        except OSError:
            pass

    # Copy the rendered file into history folder
    history_dir = PROJECTS_DIR / project_id / "history"
    history_dir.mkdir(parents=True, exist_ok=True)
    dest = history_dir / composite_filename
    try:
        import shutil
        shutil.copy2(str(p), str(dest))
    except Exception as exc:
        logger.warning("Failed to archive render %s: %s", p, exc)

    _save_history(project_id, entries)

def _get_project_or_404(project_id: str, db: Session) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _run_render(project_id: str, draft: bool):
    """Background task that calls the renderer service."""
    db = SessionLocal()
    try:
        # Stub import - the renderer service will be implemented separately
        from backend.services.renderer import render_project
        render_project(project_id, draft)

        # Record successful render in history
        project = db.query(Project).filter(Project.id == project_id).first()
        if project:
            rendered_file = project.draft_path if draft else project.output_path
            if rendered_file and Path(rendered_file).is_file():
                _record_render(project_id, rendered_file, project.output_format or "9:16")
    except ImportError:
        logger.error("Renderer service not yet implemented")
        project = db.query(Project).filter(Project.id == project_id).first()
        if project:
            project.status = "error"
            project.updated_at = _now()
            db.commit()
    except Exception as e:
        logger.exception("Render failed for project %s: %s", project_id, e)
        project = db.query(Project).filter(Project.id == project_id).first()
        if project:
            project.status = "error"
            project.updated_at = _now()
            db.commit()
    finally:
        db.close()


# --------------- Endpoints ---------------

@router.post("/{project_id}/render", response_model=RenderStatusResponse)
def trigger_render(
    project_id: str,
    body: RenderRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Trigger a render (draft or final) as a background task."""
    project = _get_project_or_404(project_id, db)

    if project.status == "rendering":
        raise HTTPException(status_code=409, detail="Render already in progress")

    project.status = "rendering"
    project.updated_at = _now()
    db.commit()
    db.refresh(project)

    background_tasks.add_task(_run_render, project_id, body.draft)

    return RenderStatusResponse(
        project_id=project.id,
        status=project.status,
        output_path=project.output_path,
        draft_path=project.draft_path,
    )


@router.get("/{project_id}/render/status", response_model=RenderStatusResponse)
def render_status(project_id: str, db: Session = Depends(get_db)):
    """Get the current render status for a project."""
    project = _get_project_or_404(project_id, db)
    return RenderStatusResponse(
        project_id=project.id,
        status=project.status,
        output_path=project.output_path,
        draft_path=project.draft_path,
    )


@router.get("/{project_id}/render/download")
def download_render(project_id: str, db: Session = Depends(get_db)):
    """Download the rendered file (prefers final, falls back to draft)."""
    project = _get_project_or_404(project_id, db)

    # Prefer final output, fall back to draft
    file_path = None
    if project.output_path and Path(project.output_path).is_file():
        file_path = project.output_path
    elif project.draft_path and Path(project.draft_path).is_file():
        file_path = project.draft_path

    if not file_path:
        raise HTTPException(status_code=404, detail="No rendered file available")

    return FileResponse(
        path=file_path,
        media_type="video/mp4",
        filename=Path(file_path).name,
    )


@router.websocket("/{project_id}/render/ws")
async def render_ws(websocket: WebSocket, project_id: str):
    """WebSocket endpoint for real-time render progress updates."""
    await websocket.accept()
    try:
        from backend.services.renderer import get_render_progress

        last_sent = None
        while True:
            progress = get_render_progress(project_id)

            if progress is not None:
                elapsed = time.time() - progress["started_at"]
                pct = progress["progress"]
                eta = None
                if pct > 0.01:
                    eta = max(0, (elapsed / pct) * (1.0 - pct))

                msg = {
                    "progress": round(pct, 4),
                    "stage": progress["stage"],
                    "eta_seconds": round(eta, 1) if eta is not None else None,
                }

                if msg != last_sent:
                    await websocket.send_text(json.dumps(msg))
                    last_sent = msg

                if progress["stage"] == "done":
                    break
            else:
                # No progress data - check if render is still active via DB
                db = SessionLocal()
                try:
                    project = db.query(Project).filter(Project.id == project_id).first()
                    if project and project.status != "rendering":
                        # Render finished or was never started
                        await websocket.send_text(json.dumps({
                            "progress": 1.0 if project.status == "rendered" else 0.0,
                            "stage": project.status,
                            "eta_seconds": None,
                        }))
                        break
                finally:
                    db.close()

            await asyncio.sleep(0.5)

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.debug("Render WS closed for %s: %s", project_id, e)


# --------------- Render History Endpoints ---------------

@router.get("/{project_id}/render/history", response_model=RenderHistoryResponse)
def get_render_history(project_id: str, db: Session = Depends(get_db)):
    """Return the render history list for a project (newest first, max 5 entries)."""
    _get_project_or_404(project_id, db)
    entries = _load_history(project_id)
    return RenderHistoryResponse(entries=[RenderHistoryEntry(**e) for e in entries])


@router.get("/{project_id}/render/history/{render_id}/download")
def download_history_render(project_id: str, render_id: str, db: Session = Depends(get_db)):
    """Download a specific past render by its history entry ID."""
    _get_project_or_404(project_id, db)
    entries = _load_history(project_id)
    entry = next((e for e in entries if e["id"] == render_id), None)
    if not entry:
        raise HTTPException(status_code=404, detail="Render history entry not found")

    file_path = PROJECTS_DIR / project_id / "history" / entry["filename"]
    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Render file not found on disk")

    return FileResponse(
        path=str(file_path),
        media_type="video/mp4",
        filename=entry["filename"],
    )
