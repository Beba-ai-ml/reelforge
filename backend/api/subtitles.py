"""Subtitle management API routes."""

import json
import logging
import urllib.request
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.config import OLLAMA_HOST, VISION_MODEL
from backend.db.database import get_db
from backend.db.models import Project, Subtitle
from backend.services.subtitle_gen import generate_ass_content, _resolve_canvas_dimensions

logger = logging.getLogger(__name__)

router = APIRouter()

TEXT_MODEL = VISION_MODEL  # Use same model for text-only tasks (MiniCPM-V handles text)
OLLAMA_TIMEOUT = 60  # seconds per subtitle call


# --------------- Schemas ---------------

class SubtitleCreate(BaseModel):
    text: str
    start_time: float
    end_time: float
    style: Optional[str] = None
    position_x: Optional[float] = None
    position_y: Optional[float] = None
    font_size: Optional[int] = None
    color: Optional[str] = None
    karaoke_style: Optional[str] = None
    outline_color: Optional[str] = None
    highlight_color: Optional[str] = None
    words_json: Optional[str] = None
    language: Optional[str] = None


class SubtitleUpdate(BaseModel):
    text: Optional[str] = None
    start_time: Optional[float] = None
    end_time: Optional[float] = None
    style: Optional[str] = None
    position_x: Optional[float] = None
    position_y: Optional[float] = None
    font_size: Optional[int] = None
    color: Optional[str] = None
    karaoke_style: Optional[str] = None
    outline_color: Optional[str] = None
    highlight_color: Optional[str] = None
    words_json: Optional[str] = None
    language: Optional[str] = None


class SubtitleResponse(BaseModel):
    id: int
    project_id: str
    text: str
    start_time: float
    end_time: float
    style: Optional[str] = None
    position_x: Optional[float] = None
    position_y: Optional[float] = None
    font_size: Optional[int] = None
    color: Optional[str] = None
    karaoke_style: Optional[str] = None
    outline_color: Optional[str] = None
    highlight_color: Optional[str] = "#8b5cf6"
    words_json: Optional[str] = None
    language: Optional[str] = "en"

    model_config = {"from_attributes": True}


class BulkPositionUpdate(BaseModel):
    position_y: float


class BulkStyleUpdate(BaseModel):
    """Update any combination of style fields for ALL subtitles in a project."""
    font_size: Optional[int] = None
    color: Optional[str] = None
    outline_color: Optional[str] = None
    highlight_color: Optional[str] = None
    position_x: Optional[float] = None
    position_y: Optional[float] = None
    style: Optional[str] = None
    karaoke_style: Optional[str] = None


class PolishRequest(BaseModel):
    mode: str  # "grammar" | "punchier" | "shorter"


class PolishResponse(BaseModel):
    subtitle_id: int
    original_text: str
    polished_text: str
    mode: str


class BulkPolishRequest(BaseModel):
    mode: str  # "grammar" | "punchier" | "shorter"
    subtitle_ids: Optional[List[int]] = None  # None = polish all


class BulkPolishResult(BaseModel):
    id: int
    original_text: str
    polished_text: str


class BulkPolishResponse(BaseModel):
    mode: str
    results: List[BulkPolishResult]
    total: int


# --------------- Helpers ---------------

def _get_project_or_404(project_id: str, db: Session) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _get_subtitle_or_404(subtitle_id: int, project_id: str, db: Session) -> Subtitle:
    subtitle = (
        db.query(Subtitle)
        .filter(Subtitle.id == subtitle_id, Subtitle.project_id == project_id)
        .first()
    )
    if not subtitle:
        raise HTTPException(status_code=404, detail="Subtitle not found")
    return subtitle


def _call_ollama_text(prompt: str) -> str:
    """Call Ollama generate API with a text-only prompt. Returns response text."""
    payload = {
        "model": TEXT_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.3, "num_predict": 256},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_HOST}/api/generate",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=OLLAMA_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise ConnectionError(
            f"Cannot connect to Ollama at {OLLAMA_HOST}. Is it running? Error: {e}"
        ) from e
    except TimeoutError as e:
        raise RuntimeError(f"Ollama request timed out after {OLLAMA_TIMEOUT}s") from e

    if "error" in body:
        raise RuntimeError(f"Ollama API error: {body['error']}")

    return body.get("response", "").strip()


POLISH_PROMPTS = {
    "grammar": (
        "Fix any grammar, spelling, or punctuation errors in this subtitle text. "
        "Keep the text in its ORIGINAL language. Do NOT translate to English or any other language. "
        "Return ONLY the corrected text, nothing else: {text}"
    ),
    "punchier": (
        "Rewrite this subtitle to be more engaging and punchy, using active voice and shorter phrases. "
        "Keep the same meaning. Keep the text in its ORIGINAL language. Do NOT translate to English or any other language. "
        "Return ONLY the rewritten text, nothing else: {text}"
    ),
    "shorter": (
        "Shorten this subtitle text to fit better on screen while keeping the key meaning. "
        "Max 6 words. Keep the text in its ORIGINAL language. Do NOT translate to English or any other language. "
        "Return ONLY the shortened text, nothing else: {text}"
    ),
}


def _polish_text(text: str, mode: str) -> str:
    """Call Ollama to polish a subtitle text. Falls back gracefully on error."""
    prompt_template = POLISH_PROMPTS.get(mode)
    if not prompt_template:
        raise ValueError(f"Unknown polish mode: {mode}")

    prompt = prompt_template.format(text=text)
    try:
        result = _call_ollama_text(prompt)
        # Clean up: strip quotes if model wraps the answer
        result = result.strip('"\'').strip()
        return result if result else text
    except Exception as e:
        logger.warning("Polish failed for mode=%s, text=%r: %s", mode, text, e)
        # Graceful fallback: return original text
        return text


# --------------- Endpoints ---------------

@router.get("/{project_id}/subtitles", response_model=list[SubtitleResponse])
def list_subtitles(
    project_id: str,
    language: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """List subtitles for a project, ordered by start_time. Filter by language if provided; otherwise return all."""
    _get_project_or_404(project_id, db)
    query = (
        db.query(Subtitle)
        .filter(Subtitle.project_id == project_id)
    )
    if language is not None:
        query = query.filter(Subtitle.language == language)
    subtitles = query.order_by(Subtitle.start_time).all()
    return subtitles


@router.post("/{project_id}/subtitles", response_model=SubtitleResponse, status_code=201)
def create_subtitle(project_id: str, body: SubtitleCreate, db: Session = Depends(get_db)):
    """Create a new subtitle for a project."""
    _get_project_or_404(project_id, db)

    subtitle = Subtitle(
        project_id=project_id,
        text=body.text,
        start_time=body.start_time,
        end_time=body.end_time,
        language=body.language or "en",
    )

    # Apply optional fields
    if body.style is not None:
        subtitle.style = body.style
    if body.position_x is not None:
        subtitle.position_x = body.position_x
    if body.position_y is not None:
        subtitle.position_y = body.position_y
    if body.font_size is not None:
        subtitle.font_size = body.font_size
    if body.color is not None:
        subtitle.color = body.color
    if body.karaoke_style is not None:
        subtitle.karaoke_style = body.karaoke_style
    if body.outline_color is not None:
        subtitle.outline_color = body.outline_color
    if body.highlight_color is not None:
        subtitle.highlight_color = body.highlight_color
    if body.words_json is not None:
        subtitle.words_json = body.words_json

    db.add(subtitle)
    db.commit()
    db.refresh(subtitle)
    return subtitle


# NOTE: static-path routes MUST be defined before {subtitle_id} routes
# to prevent FastAPI from matching them as subtitle_id.

@router.get("/{project_id}/subtitles/languages")
def list_subtitle_languages(project_id: str, db: Session = Depends(get_db)):
    """Return distinct language codes for all subtitle tracks in this project."""
    _get_project_or_404(project_id, db)
    rows = (
        db.query(Subtitle.language)
        .filter(Subtitle.project_id == project_id)
        .distinct()
        .all()
    )
    languages = sorted({r.language for r in rows if r.language})
    if not languages:
        languages = ["en"]
    return {"languages": languages}


@router.put("/{project_id}/subtitles/bulk-position", response_model=list[SubtitleResponse])
def bulk_update_position(
    project_id: str,
    body: BulkPositionUpdate,
    db: Session = Depends(get_db),
):
    """Update position_y for ALL subtitles in a project."""
    _get_project_or_404(project_id, db)

    subtitles = (
        db.query(Subtitle)
        .filter(Subtitle.project_id == project_id)
        .order_by(Subtitle.start_time)
        .all()
    )

    for subtitle in subtitles:
        subtitle.position_y = body.position_y

    db.commit()

    # Refresh all to return updated values
    for subtitle in subtitles:
        db.refresh(subtitle)

    return subtitles


@router.put("/{project_id}/subtitles/bulk-style")
def bulk_update_style(
    project_id: str,
    body: BulkStyleUpdate,
    db: Session = Depends(get_db),
):
    """Update style fields for ALL subtitles in a project in one request."""
    _get_project_or_404(project_id, db)

    subtitles = (
        db.query(Subtitle)
        .filter(Subtitle.project_id == project_id)
        .order_by(Subtitle.start_time)
        .all()
    )

    updates = body.model_dump(exclude_none=True)
    if not updates:
        return {"updated": 0}

    for subtitle in subtitles:
        for field, value in updates.items():
            setattr(subtitle, field, value)

    db.commit()
    return {"updated": len(subtitles)}


@router.get("/{project_id}/subtitles/export-ass")
def export_ass(project_id: str, db: Session = Depends(get_db)):
    """Export subtitles as an ASS file download."""
    project = _get_project_or_404(project_id, db)

    subtitles = (
        db.query(Subtitle)
        .filter(Subtitle.project_id == project_id)
        .order_by(Subtitle.start_time)
        .all()
    )

    if not subtitles:
        raise HTTPException(status_code=404, detail="No subtitles found for this project")

    canvas_w, canvas_h = _resolve_canvas_dimensions(project.output_format)
    ass_content = generate_ass_content(subtitles, canvas_w, canvas_h)

    return Response(
        content=ass_content,
        media_type="text/x-ssa",
        headers={"Content-Disposition": f'attachment; filename="{project_id}_subtitles.ass"'},
    )


@router.post("/{project_id}/subtitles/polish-all", response_model=BulkPolishResponse)
def bulk_polish_subtitles(
    project_id: str,
    body: BulkPolishRequest,
    db: Session = Depends(get_db),
):
    """Polish multiple subtitles at once using AI.

    Accepts optional subtitle_ids list; if omitted, polishes all subtitles for the project.
    Returns original and polished text for each subtitle (does not auto-save).
    """
    _get_project_or_404(project_id, db)

    if body.mode not in POLISH_PROMPTS:
        raise HTTPException(status_code=400, detail=f"Unknown mode '{body.mode}'. Use: grammar, punchier, shorter")

    query = db.query(Subtitle).filter(Subtitle.project_id == project_id)
    if body.subtitle_ids:
        query = query.filter(Subtitle.id.in_(body.subtitle_ids))
    subtitles = query.order_by(Subtitle.start_time).all()

    if not subtitles:
        raise HTTPException(status_code=404, detail="No subtitles found to polish")

    results: List[BulkPolishResult] = []
    for sub in subtitles:
        polished = _polish_text(sub.text, body.mode)
        results.append(BulkPolishResult(
            id=sub.id,
            original_text=sub.text,
            polished_text=polished,
        ))

    return BulkPolishResponse(mode=body.mode, results=results, total=len(results))


@router.put("/{project_id}/subtitles/{subtitle_id}", response_model=SubtitleResponse)
def update_subtitle(
    project_id: str,
    subtitle_id: int,
    body: SubtitleUpdate,
    db: Session = Depends(get_db),
):
    """Partially update a subtitle."""
    _get_project_or_404(project_id, db)
    subtitle = _get_subtitle_or_404(subtitle_id, project_id, db)

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(subtitle, field, value)

    db.commit()
    db.refresh(subtitle)
    return subtitle


@router.delete("/{project_id}/subtitles/{subtitle_id}", status_code=204)
def delete_subtitle(project_id: str, subtitle_id: int, db: Session = Depends(get_db)):
    """Delete a subtitle."""
    _get_project_or_404(project_id, db)
    subtitle = _get_subtitle_or_404(subtitle_id, project_id, db)
    db.delete(subtitle)
    db.commit()
    return None


@router.post("/{project_id}/subtitles/{subtitle_id}/polish", response_model=PolishResponse)
def polish_subtitle(
    project_id: str,
    subtitle_id: int,
    body: PolishRequest,
    db: Session = Depends(get_db),
):
    """AI-polish a single subtitle text.

    Modes: 'grammar' (fix errors), 'punchier' (more engaging), 'shorter' (max 6 words).
    Returns polished text — does NOT auto-save, let the frontend decide.
    """
    _get_project_or_404(project_id, db)
    subtitle = _get_subtitle_or_404(subtitle_id, project_id, db)

    if body.mode not in POLISH_PROMPTS:
        raise HTTPException(status_code=400, detail=f"Unknown mode '{body.mode}'. Use: grammar, punchier, shorter")

    polished = _polish_text(subtitle.text, body.mode)

    return PolishResponse(
        subtitle_id=subtitle.id,
        original_text=subtitle.text,
        polished_text=polished,
        mode=body.mode,
    )
