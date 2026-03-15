"""MiniCPM-V vision analysis service via Ollama API."""

import base64
import json
import logging
import os
import re
import subprocess
import tempfile
import threading
import urllib.request
from pathlib import Path

from backend.config import LIBRARY_DIR, OLLAMA_HOST, VISION_MODEL, IMAGE_EXTENSIONS
from backend.db.database import SessionLocal
from backend.db.models import Clip, ClipSegment

logger = logging.getLogger(__name__)

# Idle timer: unload Ollama model 60s after last analysis
OLLAMA_IDLE_TIMEOUT = 60  # seconds
_ollama_idle_timer: threading.Timer | None = None
_ollama_timer_lock = threading.Lock()


def _schedule_ollama_unload():
    """Schedule Ollama model unload after idle timeout."""
    global _ollama_idle_timer
    with _ollama_timer_lock:
        if _ollama_idle_timer is not None:
            _ollama_idle_timer.cancel()
        _ollama_idle_timer = threading.Timer(OLLAMA_IDLE_TIMEOUT, _do_ollama_unload)
        _ollama_idle_timer.daemon = True
        _ollama_idle_timer.start()
        logger.info("Ollama model will unload in %ds if idle", OLLAMA_IDLE_TIMEOUT)


def _cancel_ollama_timer():
    """Cancel the idle unload timer."""
    global _ollama_idle_timer
    with _ollama_timer_lock:
        if _ollama_idle_timer is not None:
            _ollama_idle_timer.cancel()
            _ollama_idle_timer = None


def _do_ollama_unload():
    """Actually unload the Ollama model (called by timer)."""
    logger.info("Ollama idle timeout reached, unloading model...")
    unload_ollama_model()


# ---------------------------------------------------------------------------
# Batch analysis progress tracking + cancellation
# ---------------------------------------------------------------------------

_analysis_progress: dict = {
    "status": "idle",       # idle | running | cancelled | done | error
    "current": 0,
    "total": 0,
    "current_clip": "",
    "success": 0,
    "failed": 0,
}
_analysis_lock = threading.Lock()
_cancel_event = threading.Event()


def get_analysis_progress() -> dict:
    """Return a snapshot of the current batch analysis progress."""
    with _analysis_lock:
        return dict(_analysis_progress)


def cancel_analysis():
    """Signal the running batch analysis to stop after the current clip finishes."""
    _cancel_event.set()
    with _analysis_lock:
        if _analysis_progress["status"] == "running":
            _analysis_progress["status"] = "cancelling"


def _reset_progress(total: int):
    """Reset progress for a new batch run."""
    _cancel_event.clear()
    with _analysis_lock:
        _analysis_progress.update({
            "status": "running",
            "current": 0,
            "total": total,
            "current_clip": "",
            "success": 0,
            "failed": 0,
        })


def _update_progress(current: int, clip_name: str, success: int, failed: int):
    """Update progress counters."""
    with _analysis_lock:
        _analysis_progress.update({
            "current": current,
            "current_clip": clip_name,
            "success": success,
            "failed": failed,
        })


def _finish_progress(status: str, success: int, failed: int):
    """Mark batch as finished."""
    with _analysis_lock:
        _analysis_progress.update({
            "status": status,
            "success": success,
            "failed": failed,
            "current_clip": "",
        })

# Max frames to extract from a video
MAX_FRAMES = 20
EXTRACT_FPS = 2
REQUEST_TIMEOUT = 600  # seconds — generous timeout for complex clips

def _safe_float(val, default: float = 0.0) -> float:
    """Convert value to float, returning default if None or invalid."""
    if val is None:
        return default
    try:
        return float(val)
    except (ValueError, TypeError):
        return default


ANALYSIS_PROMPT = """\
Analyze this video clip / image. Return a JSON object with these fields:
{
  "title_en": "short English title describing the content",
  "title_pl": "short Polish title",
  "summary_en": "1-2 sentence English description of what's shown",
  "summary_pl": "1-2 sentence Polish description",
  "is_dynamic": true/false (true if there's significant motion/action),
  "focus_point": {"x": 0.0-1.0, "y": 0.0-1.0} (where the main subject is),
  "tags": ["tag1", "tag2", "tag3", ...],
  "segments": [
    {"start": 0.0, "end": 3.5, "description_en": "what happens in this part", "description_pl": "co się dzieje"},
    ...
  ]
}
Only return valid JSON, no other text."""

ANALYSIS_PROMPT_SIMPLE = """\
Describe this image/video briefly. Return ONLY a JSON object:
{"title_en": "short title", "title_pl": "krótki tytuł", "summary_en": "one sentence description", "summary_pl": "opis jednym zdaniem", "is_dynamic": false, "tags": ["tag1", "tag2"]}"""


# ---------------------------------------------------------------------------
# Frame extraction helpers
# ---------------------------------------------------------------------------

def _extract_frames_to_base64(video_path: str | Path, max_frames: int = MAX_FRAMES) -> list[str]:
    """Extract frames from video at 2 FPS, return as base64 strings.

    Extracts to a temp directory as JPEGs, then reads and encodes them.
    Limits to max_frames total.
    """
    tmp_dir = tempfile.mkdtemp(prefix="rf_vision_frames_")
    try:
        pattern = os.path.join(tmp_dir, "frame_%04d.jpg")
        cmd = [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-vf", f"fps={EXTRACT_FPS},scale=720:-1",
            "-vframes", str(max_frames),
            "-q:v", "5",
            pattern,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            logger.warning("FFmpeg frame extraction failed: %s", result.stderr.strip())
            return []

        frames = []
        frame_files = sorted(Path(tmp_dir).glob("frame_*.jpg"))
        for frame_path in frame_files[:max_frames]:
            with open(frame_path, "rb") as f:
                frames.append(base64.b64encode(f.read()).decode("utf-8"))

        logger.info("Extracted %d frames from %s", len(frames), video_path)
        return frames

    finally:
        # Clean up temp frames
        for f in Path(tmp_dir).glob("*"):
            try:
                f.unlink(missing_ok=True)
            except OSError:
                pass
        try:
            Path(tmp_dir).rmdir()
        except OSError:
            pass


def _image_to_base64(image_path: str | Path) -> str:
    """Read an image file and return its base64-encoded content."""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


# ---------------------------------------------------------------------------
# Ollama API call
# ---------------------------------------------------------------------------

def _call_ollama_vision(images: list[str], prompt: str) -> str:
    """Call Ollama chat API with images and return the response text.

    Args:
        images: List of base64-encoded image strings.
        prompt: The text prompt.

    Returns:
        The assistant's response text.

    Raises:
        ConnectionError: If Ollama is not reachable.
        RuntimeError: If the API returns an error.
    """
    payload = {
        "model": VISION_MODEL,
        "messages": [{
            "role": "user",
            "content": prompt,
            "images": images,
        }],
        "stream": False,
        "options": {"temperature": 0.1, "num_ctx": 4096},
    }

    url = f"{OLLAMA_HOST}/api/chat"
    data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise ConnectionError(
            f"Cannot connect to Ollama at {OLLAMA_HOST}. "
            f"Is it running? Error: {e}"
        ) from e
    except TimeoutError as e:
        raise RuntimeError(
            f"Ollama request timed out after {REQUEST_TIMEOUT}s. "
            "The model might be loading or the clip is too complex."
        ) from e

    if "error" in body:
        raise RuntimeError(f"Ollama API error: {body['error']}")

    # Extract response text
    message = body.get("message", {})
    return message.get("content", "")


# ---------------------------------------------------------------------------
# JSON parsing
# ---------------------------------------------------------------------------

def _repair_truncated_json(text: str) -> str:
    """Try to repair truncated JSON by closing open brackets/braces/strings."""
    # Track parser state properly
    in_string = False
    escaped = False
    stack: list[str] = []  # track open delimiters: { [ "

    for ch in text:
        if escaped:
            escaped = False
            continue
        if ch == '\\' and in_string:
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == '{':
            stack.append('{')
        elif ch == '[':
            stack.append('[')
        elif ch == '}':
            if stack and stack[-1] == '{':
                stack.pop()
        elif ch == ']':
            if stack and stack[-1] == '[':
                stack.pop()

    # If we're inside a string, close it and trim the partial value
    if in_string:
        text += '"'

    # Remove trailing incomplete entries (partial key-value pairs after last complete one)
    # Find the last complete JSON value boundary
    text = re.sub(r',\s*"[^"]*"\s*:\s*"[^"]*$', '', text)  # truncated "key": "val...
    text = re.sub(r',\s*"[^"]*"\s*$', '', text)  # trailing "incomplete_key"
    text = re.sub(r',\s*\{[^}]*$', '', text)  # trailing incomplete object in array
    text = re.sub(r',\s*$', '', text)  # trailing comma

    # Close remaining open delimiters in reverse order
    for delim in reversed(stack):
        if delim == '{':
            text += '}'
        elif delim == '[':
            text += ']'

    return text


def _parse_analysis_json(text: str) -> dict:
    """Parse JSON from the model response, with repair for truncated output."""
    text = text.strip()

    # Try direct parse first
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Try to extract JSON block from markdown code fences
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # Try to find the outermost JSON object
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass

    # Try to repair truncated JSON (Ollama often cuts off mid-response)
    match = re.search(r"\{.*", text, re.DOTALL)
    if match:
        repaired = _repair_truncated_json(match.group(0))
        try:
            result = json.loads(repaired)
            logger.info("  ⚠ Repaired truncated JSON successfully")
            return result
        except json.JSONDecodeError:
            pass

    raise ValueError(f"Could not parse JSON from model response: {text[:200]}...")


# ---------------------------------------------------------------------------
# Main analysis function
# ---------------------------------------------------------------------------

def analyze_clip(clip_id: str) -> dict:
    """Analyze a clip using MiniCPM-V vision model via Ollama.

    Opens its own DB session. Extracts frames (video) or reads image,
    sends to Ollama for analysis, updates clip record and creates segments.

    Returns the parsed analysis dict.
    """
    db = SessionLocal()
    try:
        clip = db.query(Clip).filter(Clip.id == clip_id).first()
        if clip is None:
            raise ValueError(f"Clip {clip_id} not found")

        file_path = LIBRARY_DIR / clip.filepath
        if not file_path.exists():
            raise FileNotFoundError(f"Clip file not found: {file_path}")

        logger.info("Analyzing clip %s: %s (type=%s)", clip_id, file_path, clip.type)

        # Extract frames or read image
        if clip.type == "image" or file_path.suffix.lower() in IMAGE_EXTENSIONS:
            images = [_image_to_base64(file_path)]
        else:
            # Video: extract frames at 2 FPS
            images = _extract_frames_to_base64(file_path)
            if not images:
                raise RuntimeError(f"Could not extract frames from {file_path}")

        # Call Ollama vision (with retry on failure)
        logger.info(
            "▶ ANALYZE clip=%s file=%s type=%s frames=%d model=%s",
            clip_id, file_path.name, clip.type, len(images), VISION_MODEL,
        )
        analysis = None
        last_response = ""
        for attempt in range(2):
            try:
                prompt = ANALYSIS_PROMPT if attempt == 0 else ANALYSIS_PROMPT_SIMPLE
                response_text = _call_ollama_vision(images, prompt)
                last_response = response_text
                logger.info("  ✓ Ollama responded (%d chars, attempt %d)", len(response_text), attempt + 1)
                analysis = _parse_analysis_json(response_text)
                break
            except ValueError as e:
                # JSON parsing failed
                logger.error(
                    "  ✗ JSON PARSE FAILED (attempt %d) clip=%s error=%s\n"
                    "  ✗ Raw response (first 500 chars): %s",
                    attempt + 1, clip_id, e, response_text[:500] if response_text else "(empty)",
                )
                if attempt > 0:
                    raise
            except ConnectionError as e:
                logger.error(
                    "  ✗ CONNECTION ERROR (attempt %d) clip=%s: %s",
                    attempt + 1, clip_id, e,
                )
                if attempt > 0:
                    raise
            except RuntimeError as e:
                logger.error(
                    "  ✗ RUNTIME ERROR (attempt %d) clip=%s: %s",
                    attempt + 1, clip_id, e,
                )
                if attempt > 0:
                    raise
            except Exception as e:
                logger.error(
                    "  ✗ UNEXPECTED ERROR (attempt %d) clip=%s type=%s: %s",
                    attempt + 1, clip_id, type(e).__name__, e,
                )
                if attempt > 0:
                    raise

        if analysis is None:
            raise RuntimeError(
                f"Analysis failed after 2 attempts. Last response: {last_response[:300]}"
            )

        # Update clip record
        clip.title_en = analysis.get("title_en")
        clip.title_pl = analysis.get("title_pl")
        clip.summary_en = analysis.get("summary_en")
        clip.summary_pl = analysis.get("summary_pl")
        clip.is_dynamic = bool(analysis.get("is_dynamic", False))

        focus = analysis.get("focus_point", {})
        if isinstance(focus, dict):
            clip.focus_x = _safe_float(focus.get("x"), 0.5)
            clip.focus_y = _safe_float(focus.get("y"), 0.5)

        tags = analysis.get("tags", [])
        if isinstance(tags, list):
            clip.tags = json.dumps(tags, ensure_ascii=False)

        # Remove old segments before creating new ones
        db.query(ClipSegment).filter(ClipSegment.clip_id == clip_id).delete()

        # Create ClipSegment records
        segments = analysis.get("segments", [])
        for seg in segments:
            if not isinstance(seg, dict):
                continue
            start_t = _safe_float(seg.get("start"), 0.0)
            end_t = _safe_float(seg.get("end"), start_t)
            clip_segment = ClipSegment(
                clip_id=clip_id,
                start_time=start_t,
                end_time=end_t,
                description_en=seg.get("description_en"),
                description_pl=seg.get("description_pl"),
            )
            db.add(clip_segment)

        db.commit()
        logger.info(
            "Clip %s analyzed: title=%s, %d segments, %d tags",
            clip_id, clip.title_en, len(segments), len(tags),
        )

        # Schedule Ollama unload after idle timeout
        _schedule_ollama_unload()

        return analysis

    except Exception as e:
        db.rollback()
        logger.exception("Vision analysis failed for clip %s: %s", clip_id, e)
        raise

    finally:
        db.close()


def _warmup_ollama():
    """Pre-load the vision model into VRAM with a tiny request.

    Cold-starting the model can take 30-60s. By doing a warm-up call first,
    actual analysis requests don't eat into their timeout waiting for model load.
    """
    logger.info("Warming up Ollama model %s ...", VISION_MODEL)
    # Create a tiny 1x1 white pixel JPEG as base64
    TINY_IMAGE = (
        "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////"
        "////////////////////////////////////////////////////////////"
        "2wBDAf//////////////////////////////////////////////////////"
        "////////////////////////////////////////////////////////////"
        "wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/"
        "EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/"
        "8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA="
    )
    payload = {
        "model": VISION_MODEL,
        "messages": [{
            "role": "user",
            "content": "hi",
            "images": [TINY_IMAGE],
        }],
        "stream": False,
        "options": {"num_predict": 1},  # generate only 1 token — just load the model
    }

    url = f"{OLLAMA_HOST}/api/chat"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            resp.read()
        logger.info("✓ Ollama model %s warm and ready", VISION_MODEL)
    except Exception as e:
        logger.warning("Ollama warm-up failed (will retry on first clip): %s", e)


def analyze_clips_batch(clip_ids: list[str]) -> dict:
    """Analyze multiple clips sequentially (VRAM constraint).

    Supports progress tracking and cancellation via _cancel_event.
    Returns dict with keys: success, failed, errors.
    """
    _reset_progress(len(clip_ids))

    # Pre-load model into VRAM so first clip doesn't eat timeout waiting for load
    _cancel_ollama_timer()
    _warmup_ollama()
    success = 0
    failed = 0
    errors: list[str] = []

    # Fetch filenames for progress display
    clip_names: dict[str, str] = {}
    db = SessionLocal()
    try:
        for clip in db.query(Clip).filter(Clip.id.in_(clip_ids)).all():
            clip_names[clip.id] = clip.filename or clip.id
    finally:
        db.close()

    for i, clip_id in enumerate(clip_ids):
        if _cancel_event.is_set():
            logger.info("Batch analysis cancelled at clip %d/%d", i, len(clip_ids))
            break

        clip_name = clip_names.get(clip_id, clip_id)
        _update_progress(i + 1, clip_name, success, failed)
        logger.info("━━━ Batch [%d/%d] %s ━━━", i + 1, len(clip_ids), clip_name)

        try:
            analyze_clip(clip_id)
            success += 1
            logger.info("  ✓ OK (%d success, %d failed so far)", success, failed)
        except Exception as e:
            failed += 1
            error_msg = f"{type(e).__name__}: {e}"
            errors.append(f"Clip {clip_name} ({clip_id}): {error_msg}")
            logger.error("  ✗ FAILED: %s", error_msg)

    final_status = "cancelled" if _cancel_event.is_set() else "done"
    _finish_progress(final_status, success, failed)

    # Schedule Ollama unload after idle timeout
    _schedule_ollama_unload()

    logger.info(
        "Batch analysis %s: %d success, %d failed out of %d",
        final_status, success, failed, len(clip_ids),
    )

    return {"success": success, "failed": failed, "errors": errors}


def unload_ollama_model():
    """Unload the vision model from Ollama VRAM."""
    _cancel_ollama_timer()
    try:
        payload = json.dumps({
            "model": VISION_MODEL,
            "keep_alive": 0,
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{OLLAMA_HOST}/api/generate",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
        logger.info("Unloaded Ollama model %s from VRAM", VISION_MODEL)
    except Exception as e:
        logger.warning("Failed to unload Ollama model: %s", e)
