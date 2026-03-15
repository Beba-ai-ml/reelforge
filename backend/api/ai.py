"""AI service API routes (transcription, subtitle generation)."""

import json
import logging
import urllib.request
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.config import OLLAMA_HOST, VISION_MODEL
from backend.db.database import get_db, SessionLocal
from backend.db.models import Project, Subtitle, _now

logger = logging.getLogger(__name__)

router = APIRouter()


# --------------- Schemas ---------------

class TranscribeStatusResponse(BaseModel):
    project_id: str
    status: str

    model_config = {"from_attributes": True}


class GenerateSubtitlesResponse(BaseModel):
    project_id: str
    subtitle_count: int


class TranscriptResponse(BaseModel):
    project_id: str
    transcript: Optional[dict | list] = None


class MatchBrollRequest(BaseModel):
    max_broll: Optional[int] = None  # None = auto


class MatchBrollResponse(BaseModel):
    project_id: str
    timeline_items: list[dict]
    count: int


class AlternativeClipResponse(BaseModel):
    clip: dict
    score: float
    reason: str


# --------------- Helpers ---------------

def _get_project_or_404(project_id: str, db: Session) -> Project:
    project = db.query(Project).filter(Project.id == project_id).first()
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _run_transcription(project_id: str):
    """Background task that calls the transcription service."""
    db = SessionLocal()
    try:
        # Stub import - the transcription service will be implemented separately
        from backend.services.transcription import transcribe_project
        transcribe_project(project_id)
    except ImportError:
        logger.error("Transcription service not yet implemented")
        project = db.query(Project).filter(Project.id == project_id).first()
        if project:
            project.status = "error"
            project.updated_at = _now()
            db.commit()
    except Exception as e:
        logger.exception("Transcription failed for project %s: %s", project_id, e)
        project = db.query(Project).filter(Project.id == project_id).first()
        if project:
            project.status = "error"
            project.updated_at = _now()
            db.commit()
    finally:
        db.close()


# --------------- Endpoints ---------------

@router.post("/{project_id}/transcribe", response_model=TranscribeStatusResponse)
def transcribe(
    project_id: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """Trigger transcription as a background task."""
    project = _get_project_or_404(project_id, db)

    if not project.clip_a_path:
        raise HTTPException(status_code=400, detail="No clip uploaded for this project")

    if project.status == "transcribing":
        raise HTTPException(status_code=409, detail="Transcription already in progress")

    project.status = "transcribing"
    project.updated_at = _now()
    db.commit()
    db.refresh(project)

    background_tasks.add_task(_run_transcription, project_id)

    return TranscribeStatusResponse(
        project_id=project.id,
        status=project.status,
    )


@router.post("/{project_id}/generate-subtitles", response_model=GenerateSubtitlesResponse)
def generate_subtitles(project_id: str, db: Session = Depends(get_db)):
    """Generate subtitles from the transcript using AI."""
    project = _get_project_or_404(project_id, db)

    if not project.transcript_json:
        raise HTTPException(
            status_code=400,
            detail="No transcript available. Run transcription first.",
        )

    try:
        from backend.services.subtitle_gen import generate_subtitles as gen_subs
        result = gen_subs(project_id)
    except ImportError:
        raise HTTPException(
            status_code=501,
            detail="Subtitle generation service not yet implemented",
        )

    return GenerateSubtitlesResponse(
        project_id=project.id,
        subtitle_count=len(result) if isinstance(result, list) else int(result),
    )


@router.get("/{project_id}/transcript", response_model=TranscriptResponse)
def get_transcript(project_id: str, db: Session = Depends(get_db)):
    """Return the raw transcript JSON for a project."""
    project = _get_project_or_404(project_id, db)

    transcript = None
    if project.transcript_json:
        try:
            transcript = json.loads(project.transcript_json)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=500,
                detail="Stored transcript JSON is malformed",
            )

    return TranscriptResponse(
        project_id=project.id,
        transcript=transcript,
    )


@router.post("/{project_id}/match-broll", response_model=MatchBrollResponse)
def match_broll_endpoint(
    project_id: str,
    body: Optional[MatchBrollRequest] = None,
    db: Session = Depends(get_db),
):
    """Run AI B-Roll matching on the project transcript."""
    project = _get_project_or_404(project_id, db)

    if not project.transcript_json:
        raise HTTPException(
            status_code=400,
            detail="No transcript available. Run transcription first.",
        )

    max_broll = body.max_broll if body else None

    try:
        from backend.services.matcher import match_broll
        items = match_broll(project_id, max_broll=max_broll)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.exception("B-Roll matching failed for project %s: %s", project_id, e)
        raise HTTPException(status_code=500, detail=f"Matching failed: {e}")

    return MatchBrollResponse(
        project_id=project_id,
        timeline_items=items,
        count=len(items),
    )


@router.get(
    "/{project_id}/timeline/{item_id}/alternatives",
    response_model=list[AlternativeClipResponse],
)
def get_alternatives_endpoint(
    project_id: str,
    item_id: int,
    limit: int = 5,
    db: Session = Depends(get_db),
):
    """Get alternative B-Roll clips for a timeline item."""
    _get_project_or_404(project_id, db)

    try:
        from backend.services.matcher import get_alternatives
        alternatives = get_alternatives(project_id, item_id, limit=limit)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception(
            "Failed to get alternatives for item %d in project %s: %s",
            item_id, project_id, e,
        )
        raise HTTPException(status_code=500, detail=f"Failed to get alternatives: {e}")

    return alternatives


# --------------- Translation ---------------

LANGUAGE_NAMES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "pl": "Polish",
    "pt": "Portuguese",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
}

_TRANSLATE_TIMEOUT = 60  # seconds per subtitle


class TranslateSubtitlesRequest(BaseModel):
    target_language: str  # ISO 639-1 code, e.g. "pl"
    source_language: Optional[str] = "en"


class TranslateSubtitlesResponse(BaseModel):
    project_id: str
    target_language: str
    translated_count: int


def _call_ollama_translate(text: str, language_name: str) -> str:
    """Translate subtitle text using Ollama. Falls back to prefixed copy on error."""
    prompt = (
        f"Translate the following subtitle text to {language_name}. "
        f"Return ONLY the translated text, nothing else: {text}"
    )
    payload = {
        "model": VISION_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": 256},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_HOST}/api/generate",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_TRANSLATE_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
        result = body.get("response", "").strip().strip('"\'').strip()
        return result if result else f"[{language_name}] {text}"
    except Exception as e:
        logger.warning("Translation failed for text=%r lang=%s: %s", text, language_name, e)
        return f"[{language_name}] {text}"  # Graceful placeholder fallback


@router.post("/{project_id}/translate-subtitles", response_model=TranslateSubtitlesResponse)
def translate_subtitles(
    project_id: str,
    body: TranslateSubtitlesRequest,
    db: Session = Depends(get_db),
):
    """Translate subtitles to a target language.

    For each subtitle in the source language, creates a new subtitle with the
    same timing but translated text in the target language.
    Existing subtitles in the target language are deleted first.
    """
    _get_project_or_404(project_id, db)

    target_lang = body.target_language.lower()
    source_lang = (body.source_language or "en").lower()

    language_name = LANGUAGE_NAMES.get(target_lang, target_lang.title())

    # Load source subtitles
    source_subtitles = (
        db.query(Subtitle)
        .filter(Subtitle.project_id == project_id, Subtitle.language == source_lang)
        .order_by(Subtitle.start_time)
        .all()
    )

    if not source_subtitles:
        raise HTTPException(
            status_code=400,
            detail=f"No subtitles found in source language '{source_lang}' for this project.",
        )

    # Remove existing subtitles in the target language
    db.query(Subtitle).filter(
        Subtitle.project_id == project_id,
        Subtitle.language == target_lang,
    ).delete()
    db.commit()

    translated_count = 0
    for src in source_subtitles:
        translated_text = _call_ollama_translate(src.text, language_name)
        new_sub = Subtitle(
            project_id=project_id,
            text=translated_text,
            start_time=src.start_time,
            end_time=src.end_time,
            style=src.style,
            position_x=src.position_x,
            position_y=src.position_y,
            font_size=src.font_size,
            color=src.color,
            karaoke_style=src.karaoke_style,
            outline_color=src.outline_color,
            language=target_lang,
            # words_json intentionally not copied: word timings are language-specific
        )
        db.add(new_sub)
        translated_count += 1

    db.commit()
    logger.info(
        "Translated %d subtitles for project %s to %s",
        translated_count, project_id, target_lang,
    )

    return TranslateSubtitlesResponse(
        project_id=project_id,
        target_language=target_lang,
        translated_count=translated_count,
    )
