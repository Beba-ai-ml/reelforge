"""Word-level transcription service using faster-whisper."""

import json
import logging
import os
import subprocess
import tempfile
import threading
from pathlib import Path

from backend.config import (
    WHISPER_MODEL,
    WHISPER_DEVICE,
    WHISPER_COMPUTE_TYPE,
    WHISPER_BEAM_SIZE,
    WHISPER_IDLE_TIMEOUT,
)
from backend.db.database import SessionLocal
from backend.db.models import Project
from backend.utils.ffmpeg import detect_media_type

try:
    from faster_whisper import WhisperModel
except ImportError:
    WhisperModel = None

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level model singleton
# ---------------------------------------------------------------------------

CHUNK_SECONDS = 300

_model: "WhisperModel | None" = None
_model_lock = threading.Lock()

_idle_timer: threading.Timer | None = None
_idle_timer_lock = threading.Lock()


def _load_model() -> "WhisperModel":
    """Load the faster-whisper model (singleton with lock)."""
    global _model
    if WhisperModel is None:
        raise RuntimeError("faster-whisper is not installed")
    with _model_lock:
        if _model is None:
            logger.info(
                "Loading whisper model %s (device=%s, compute=%s)",
                WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE,
            )
            _model = WhisperModel(
                WHISPER_MODEL,
                device=WHISPER_DEVICE,
                compute_type=WHISPER_COMPUTE_TYPE,
            )
            logger.info("Whisper model loaded")
    return _model


def unload_model() -> None:
    """Public API: unload whisper model to free VRAM."""
    _unload_model()


def _unload_model() -> None:
    """Unload model to free VRAM."""
    _cancel_idle_timer()
    global _model
    with _model_lock:
        if _model is not None:
            logger.info("Unloading whisper model")
            _model = None
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _reset_idle_timer() -> None:
    """Reset the idle timer. Fires model unload after WHISPER_IDLE_TIMEOUT seconds."""
    global _idle_timer
    with _idle_timer_lock:
        if _idle_timer is not None:
            _idle_timer.cancel()
        if WHISPER_IDLE_TIMEOUT > 0:
            _idle_timer = threading.Timer(WHISPER_IDLE_TIMEOUT, _unload_model)
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
# Audio extraction helpers
# ---------------------------------------------------------------------------

def _extract_audio_to_wav(input_path: str, output_path: str) -> None:
    """Extract audio from a media file to 16kHz mono WAV."""
    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-ar", "16000",
        "-ac", "1",
        "-f", "wav",
        output_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg audio extraction failed: {result.stderr.strip()}")


def _split_wav_into_chunks(wav_path: str, chunk_seconds: int) -> tuple[list[str], str | None]:
    """Split a WAV file into fixed-duration chunks for long audio.

    Returns (list_of_chunk_paths, chunk_dir_or_None).
    """
    if chunk_seconds <= 0:
        return [wav_path], None

    chunk_dir = tempfile.mkdtemp(prefix="rf_whisper_chunks_")
    pattern = os.path.join(chunk_dir, "part_%03d.wav")

    cmd = [
        "ffmpeg", "-y",
        "-i", wav_path,
        "-map", "0:a:0",
        "-f", "segment",
        "-segment_time", str(chunk_seconds),
        "-c:a", "pcm_s16le",
        pattern,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        # Fallback: use the whole file
        try:
            os.rmdir(chunk_dir)
        except OSError:
            pass
        return [wav_path], None

    chunks = sorted(str(p) for p in Path(chunk_dir).glob("part_*.wav"))
    if not chunks:
        try:
            os.rmdir(chunk_dir)
        except OSError:
            pass
        return [wav_path], None

    return chunks, chunk_dir


def _cleanup_dir(dir_path: str | None) -> None:
    """Remove a temporary directory and its contents."""
    if not dir_path:
        return
    p = Path(dir_path)
    if not p.exists():
        return
    for f in p.glob("*"):
        try:
            f.unlink(missing_ok=True)
        except OSError:
            pass
    try:
        p.rmdir()
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Main transcription function
# ---------------------------------------------------------------------------

def transcribe_project(project_id: str) -> list[dict]:
    """Transcribe a project's clip_a audio and store word-level timestamps.

    Opens its own DB session. Updates project.transcript_json and
    project.status ('transcribed' on success, 'error' on failure).

    Returns the list of word dicts: [{"word": str, "start": float, "end": float}, ...]
    """
    db = SessionLocal()
    tmp_dir = None
    chunk_dir = None

    try:
        project = db.query(Project).filter(Project.id == project_id).first()
        if project is None:
            raise ValueError(f"Project {project_id} not found")

        clip_path = project.clip_a_path
        if not clip_path or not os.path.isfile(clip_path):
            raise FileNotFoundError(f"Clip A not found: {clip_path}")

        logger.info("Transcribing project %s: %s", project_id, clip_path)

        # Determine if we need to extract audio first
        media_type = detect_media_type(clip_path) or project.clip_a_type
        tmp_dir = tempfile.mkdtemp(prefix="rf_transcribe_")

        if media_type == "video" or media_type != "audio":
            # Extract audio to WAV
            wav_path = os.path.join(tmp_dir, "audio.wav")
            _extract_audio_to_wav(clip_path, wav_path)
        else:
            # Audio file -- still convert to 16kHz mono WAV for consistency
            wav_path = os.path.join(tmp_dir, "audio.wav")
            _extract_audio_to_wav(clip_path, wav_path)

        # Split into chunks if long
        chunk_paths, chunk_dir = _split_wav_into_chunks(wav_path, CHUNK_SECONDS)

        # Load model
        model = _load_model()

        # Transcribe each chunk, accumulating word-level results
        all_words: list[dict] = []
        time_offset = 0.0

        for i, chunk_path in enumerate(chunk_paths):
            logger.info(
                "  Transcribing chunk %d/%d (offset=%.1fs)",
                i + 1, len(chunk_paths), time_offset,
            )

            with _model_lock:
                segments, info = model.transcribe(
                    chunk_path,
                    beam_size=WHISPER_BEAM_SIZE,
                    word_timestamps=True,
                )

                # Iterate through segments and collect words
                chunk_end_time = 0.0
                for segment in segments:
                    if segment.words:
                        for w in segment.words:
                            all_words.append({
                                "word": w.word.strip(),
                                "start": round(w.start + time_offset, 3),
                                "end": round(w.end + time_offset, 3),
                            })
                            chunk_end_time = max(chunk_end_time, w.end)
                    else:
                        # Fallback: no word-level data for this segment
                        chunk_end_time = max(chunk_end_time, segment.end)

            # Advance the offset for the next chunk
            if chunk_dir is not None:
                # Each chunk is ~CHUNK_SECONDS long; use actual detected end
                time_offset += chunk_end_time if chunk_end_time > 0 else CHUNK_SECONDS

        # Filter out empty words
        all_words = [w for w in all_words if w["word"]]

        logger.info(
            "Transcription complete: %d words from %s",
            len(all_words), clip_path,
        )

        # Store results
        project.transcript_json = json.dumps(all_words, ensure_ascii=False)
        project.status = "transcribed"
        db.commit()

        # Reset idle timer after successful transcription
        _reset_idle_timer()

        return all_words

    except Exception as e:
        logger.exception("Transcription failed for project %s: %s", project_id, e)
        try:
            project = db.query(Project).filter(Project.id == project_id).first()
            if project:
                project.status = "error"
                db.commit()
        except Exception:
            db.rollback()
        raise

    finally:
        _cleanup_dir(chunk_dir)
        _cleanup_dir(tmp_dir)
        db.close()
