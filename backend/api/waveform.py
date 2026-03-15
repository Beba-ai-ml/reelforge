"""Waveform generation API route."""

import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from backend.config import PROJECTS_DIR
from backend.db.database import get_db
from backend.db.models import Project

router = APIRouter()


def _get_project_or_404(project_id: str, db: Session) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("/{project_id}/waveform")
def get_waveform(project_id: str, db: Session = Depends(get_db)):
    """Generate and return a waveform image for Clip A of the project.

    Uses FFmpeg to render audio peaks as a PNG image (800x100).
    The image is cached at data/projects/{id}/waveform.png.
    """
    project = _get_project_or_404(project_id, db)

    if not project.clip_a_path:
        raise HTTPException(status_code=404, detail="No clip A uploaded for this project")

    clip_path = Path(project.clip_a_path)
    if not clip_path.is_file():
        raise HTTPException(status_code=404, detail="Clip A file not found on disk")

    project_dir = PROJECTS_DIR / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    waveform_path = project_dir / "waveform.png"

    # Regenerate only if the waveform image does not exist yet
    if not waveform_path.exists():
        cmd = [
            "ffmpeg", "-y",
            "-i", str(clip_path),
            "-filter_complex",
            "compand,aformat=channel_layouts=mono,showwavespic=s=800x100:colors=8b5cf6",
            "-frames:v", "1",
            str(waveform_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            # Fallback: try without compand (some inputs don't support it)
            cmd_fallback = [
                "ffmpeg", "-y",
                "-i", str(clip_path),
                "-filter_complex",
                "aformat=channel_layouts=mono,showwavespic=s=800x100:colors=8b5cf6",
                "-frames:v", "1",
                str(waveform_path),
            ]
            result2 = subprocess.run(cmd_fallback, capture_output=True, text=True, check=False)
            if result2.returncode != 0:
                raise HTTPException(
                    status_code=500,
                    detail=f"Waveform generation failed: {result2.stderr[-500:]}",
                )

    return FileResponse(str(waveform_path), media_type="image/png")
