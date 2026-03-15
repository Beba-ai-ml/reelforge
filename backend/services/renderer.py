"""Video render pipeline for ReelForge projects."""

import logging
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from backend.config import (
    FONT_PATH,
    LIBRARY_DIR,
    TARGET_WIDTH,
    TARGET_HEIGHT,
    TARGET_FPS,
    DRAFT_CRF,
    DRAFT_PRESET,
    FINAL_CRF,
    FINAL_PRESET,
    PROJECTS_DIR,
)
from backend.db.database import SessionLocal
from backend.db.models import Clip, Project, TimelineItem, Subtitle
from backend.services.subtitle_gen import generate_ass_file
from backend.utils.ffmpeg import probe_video, extract_thumbnail

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Render progress tracking
# ---------------------------------------------------------------------------

_render_progress: dict[str, dict] = {}


def get_render_progress(project_id: str) -> dict | None:
    """Get current render progress for a project."""
    return _render_progress.get(project_id)


def _update_progress(project_id: str, progress: float, stage: str) -> None:
    """Update the render progress for a project."""
    entry = _render_progress.get(project_id)
    if entry is None:
        _render_progress[project_id] = {
            "progress": progress,
            "stage": stage,
            "started_at": time.time(),
        }
    else:
        entry["progress"] = progress
        entry["stage"] = stage


def _clear_progress(project_id: str) -> None:
    """Remove progress tracking for a finished project."""
    _render_progress.pop(project_id, None)


def _parse_ffmpeg_time(time_str: str) -> float:
    """Parse FFmpeg time string HH:MM:SS.mm to seconds."""
    parts = time_str.split(":")
    return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])


_FFMPEG_TIME_RE = re.compile(r"time=(\d{2}:\d{2}:\d{2}\.\d+)")


# ---------------------------------------------------------------------------
# FFmpeg helpers
# ---------------------------------------------------------------------------

def _run_ffmpeg(
    cmd: list[str],
    description: str = "FFmpeg",
    project_id: str | None = None,
    total_duration: float | None = None,
    stage: str = "encoding",
) -> subprocess.CompletedProcess:
    """Run an FFmpeg command, raising on failure.

    If project_id and total_duration are provided, parses FFmpeg stderr
    in real-time to update render progress.
    """
    logger.debug("%s command: %s", description, " ".join(cmd))

    if project_id and total_duration and total_duration > 0:
        # Stream stderr for progress tracking
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        stderr_lines: list[str] = []
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_lines.append(line)
            match = _FFMPEG_TIME_RE.search(line)
            if match:
                current = _parse_ffmpeg_time(match.group(1))
                pct = min(current / total_duration, 1.0)
                _update_progress(project_id, pct, stage)
        proc.wait()
        stderr_text = "".join(stderr_lines)
        if proc.returncode != 0:
            stderr_tail = stderr_text[-2000:] if stderr_text else "(no stderr)"
            raise RuntimeError(f"{description} failed (rc={proc.returncode}):\n{stderr_tail}")
        return subprocess.CompletedProcess(cmd, proc.returncode, proc.stdout, stderr_text)

    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        stderr_tail = result.stderr[-2000:] if result.stderr else "(no stderr)"
        raise RuntimeError(f"{description} failed (rc={result.returncode}):\n{stderr_tail}")
    return result


def _get_render_settings(draft: bool) -> tuple[int, str]:
    """Return (crf, preset) based on draft/final mode."""
    if draft:
        return DRAFT_CRF, DRAFT_PRESET
    return FINAL_CRF, FINAL_PRESET


def _resolve_dimensions(output_format: str | None) -> tuple[int, int]:
    """Return (width, height) based on project output_format.

    Supported formats: '9:16' (portrait), '16:9' (landscape), '1:1' (square).
    Falls back to config defaults.
    """
    if output_format == "16:9":
        return 1920, 1080
    if output_format == "1:1":
        return 1080, 1080
    # Default: 9:16 portrait
    return TARGET_WIDTH, TARGET_HEIGHT


def _resolve_source_path(item: "TimelineItem", db) -> str:
    """Resolve the actual file path for a timeline item.

    For library clips: looks up Clip.filepath via clip_id.
    For clip_a: uses the project's clip_a_path.
    For custom: uses item.source_path.
    """
    # If source_path is set and the file exists, use it directly
    if item.source_path and os.path.isfile(item.source_path):
        return item.source_path

    # Library clips: resolve via clip_id -> Clip table
    if item.clip_id:
        clip = db.query(Clip).filter(Clip.id == item.clip_id).first()
        if clip:
            file_path = Path(clip.filepath)
            if not file_path.is_absolute():
                file_path = LIBRARY_DIR / file_path
            if file_path.exists():
                return str(file_path)
            raise FileNotFoundError(
                f"Library clip file not found: {file_path} (clip_id={item.clip_id})"
            )
        raise FileNotFoundError(
            f"Clip record not found in DB: clip_id={item.clip_id}"
        )

    # clip_a type: look up the project's clip_a_path
    if item.source_type == "clip_a":
        project = db.query(Project).filter(Project.id == item.project_id).first()
        if project and project.clip_a_path and os.path.isfile(project.clip_a_path):
            return project.clip_a_path
        raise FileNotFoundError(
            f"Clip A not found for project {item.project_id}"
        )

    raise FileNotFoundError(
        f"Cannot resolve source for timeline item {item.id} "
        f"(source_type={item.source_type}, source_path={item.source_path}, clip_id={item.clip_id})"
    )


# ---------------------------------------------------------------------------
# Clip pre-processing
# ---------------------------------------------------------------------------

def _preprocess_clip(
    src: str,
    output_path: str,
    trim_start: float = 0,
    trim_end: float | None = None,
    speed: float = 1.0,
    draft: bool = True,
    target_w: int = TARGET_WIDTH,
    target_h: int = TARGET_HEIGHT,
    strip_audio: bool = False,
) -> None:
    """Pre-process a single clip: trim, speed, crop & scale to target, set fps.

    Crops source to match target aspect ratio using center crop.
    If strip_audio is True, replaces original audio with silence (for B-Roll
    clips where only the user's main audio should play).
    """
    crf, preset = _get_render_settings(draft)
    info = probe_video(src)

    src_w = info["width"]
    src_h = info["height"]
    src_dur = info["duration"]

    if trim_end is None:
        trim_end = src_dur

    # Build video filter chain
    vfilters = []

    # Trim
    vfilters.append(f"trim=start={trim_start}:end={trim_end},setpts=PTS-STARTPTS")

    # Speed
    if speed != 1.0 and speed > 0:
        pts_factor = 1.0 / speed
        vfilters.append(f"setpts={pts_factor:.4f}*PTS")

    # Crop to target aspect ratio if source aspect doesn't match
    src_aspect = src_w / src_h if src_h > 0 else 1.0
    target_aspect = target_w / target_h if target_h > 0 else 1.0

    if abs(src_aspect - target_aspect) > 0.05:
        crop_w = int(src_h * target_aspect)
        crop_h = src_h

        if crop_w > src_w:
            crop_w = src_w
            crop_h = int(src_w / target_aspect)

        crop_x = (src_w - crop_w) // 2
        crop_y = (src_h - crop_h) // 2

        crop_x = max(0, min(crop_x, src_w - crop_w))
        crop_y = max(0, min(crop_y, src_h - crop_h))

        vfilters.append(f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y}")

    # Scale to target with padding
    vfilters.append(
        f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
        f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black,"
        f"setsar=1"
    )

    # FPS
    vfilters.append(f"fps={TARGET_FPS}")

    vf = ",".join(vfilters)

    if strip_audio:
        # Strip original audio — use silent audio track instead
        cmd = [
            "ffmpeg", "-y",
            "-i", src,
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
            "-vf", vf,
            "-map", "0:v", "-map", "1:a",
            "-c:v", "libx264",
            "-crf", str(crf),
            "-preset", preset,
            "-c:a", "aac", "-b:a", "128k",
            "-shortest",
            "-movflags", "+faststart",
            output_path,
        ]
        try:
            _run_ffmpeg(cmd, f"Pre-process clip (no broll audio) {os.path.basename(src)}")
        except RuntimeError:
            # If that fails too, try video-only with null audio
            logger.warning("Retrying with simpler approach: %s", src)
            cmd2 = [
                "ffmpeg", "-y",
                "-i", src,
                "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
                "-vf", vf,
                "-c:v", "libx264",
                "-crf", str(crf),
                "-preset", preset,
                "-c:a", "aac", "-b:a", "128k",
                "-shortest",
                "-movflags", "+faststart",
                output_path,
            ]
            _run_ffmpeg(cmd2, f"Pre-process clip (fallback) {os.path.basename(src)}")
        return

    # Audio filters
    afilters = []
    afilters.append(f"atrim=start={trim_start}:end={trim_end},asetpts=PTS-STARTPTS")
    if speed != 1.0 and speed > 0:
        afilters.append(f"atempo={speed:.4f}")
    af = ",".join(afilters)

    cmd = [
        "ffmpeg", "-y",
        "-i", src,
        "-vf", vf,
        "-af", af,
        "-c:v", "libx264",
        "-crf", str(crf),
        "-preset", preset,
        "-c:a", "aac", "-b:a", "128k",
        "-ar", "44100", "-ac", "2",
        "-movflags", "+faststart",
        output_path,
    ]

    try:
        _run_ffmpeg(cmd, f"Pre-process clip {os.path.basename(src)}")
    except RuntimeError:
        # Retry without audio (clip might not have audio track)
        logger.warning("Retrying clip without audio: %s", src)
        cmd_no_audio = [
            "ffmpeg", "-y",
            "-i", src,
            "-vf", vf,
            "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
            "-c:v", "libx264",
            "-crf", str(crf),
            "-preset", preset,
            "-c:a", "aac", "-b:a", "128k",
            "-shortest",
            "-movflags", "+faststart",
            output_path,
        ]
        _run_ffmpeg(cmd_no_audio, f"Pre-process clip (no audio) {os.path.basename(src)}")


def _generate_gradient_video(
    audio_path: str,
    output_path: str,
    duration: float,
    draft: bool = True,
    target_w: int = TARGET_WIDTH,
    target_h: int = TARGET_HEIGHT,
) -> None:
    """Generate a gradient background video from an audio file.

    Used when the input is audio-only (no video track).
    """
    crf, preset = _get_render_settings(draft)

    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=c=0x1a1a2e:s={target_w}x{target_h}:d={duration}",
        "-i", audio_path,
        "-c:v", "libx264",
        "-crf", str(crf),
        "-preset", preset,
        "-c:a", "aac", "-b:a", "128k",
        "-shortest",
        "-movflags", "+faststart",
        output_path,
    ]
    _run_ffmpeg(cmd, "Generate gradient video from audio")


# ---------------------------------------------------------------------------
# Subtitle overlay
# ---------------------------------------------------------------------------

def _overlay_ass_subtitles(
    video_path: str,
    ass_path: str,
    output_path: str,
    draft: bool = True,
) -> None:
    """Overlay ASS subtitles on a video."""
    crf, preset = _get_render_settings(draft)

    # Escape special characters in path for FFmpeg filtergraph
    ass_escaped = ass_path.replace("\\", "/").replace(":", "\\:")

    # Build ASS filter with optional fontsdir
    fontsdir_opt = ""
    if FONT_PATH.is_file():
        font_dir = str(FONT_PATH.parent).replace("\\", "/").replace(":", "\\:")
        fontsdir_opt = f":fontsdir={font_dir}"

    vf = f"ass={ass_escaped}{fontsdir_opt}"

    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-vf", vf,
        "-c:v", "libx264",
        "-crf", str(crf),
        "-preset", preset,
        "-c:a", "copy",
        "-movflags", "+faststart",
        output_path,
    ]

    try:
        _run_ffmpeg(cmd, "Overlay ASS subtitles")
    except RuntimeError as e:
        # If ASS filter fails, try without subtitles as fallback
        logger.warning("ASS overlay failed, rendering without subtitles: %s", e)
        cmd_fallback = [
            "ffmpeg", "-y",
            "-i", video_path,
            "-c:v", "libx264",
            "-crf", str(crf),
            "-preset", preset,
            "-c:a", "copy",
            "-movflags", "+faststart",
            output_path,
        ]
        _run_ffmpeg(cmd_fallback, "Render without subtitles (fallback)")


# ---------------------------------------------------------------------------
# Main render function
# ---------------------------------------------------------------------------

def render_project(project_id: str, draft: bool = True) -> str:
    """Render a project to video.

    Handles two cases:
      - Simple (Phase 1 MVP): clip_a + subtitles
      - Timeline (Phase 3): multiple timeline_items + subtitles

    Opens its own DB session. Updates project.draft_path or output_path.
    Sets project.status to 'rendered' on success, 'error' on failure.

    Returns the path to the rendered output file.
    """
    db = SessionLocal()
    tmpdir = None

    try:
        project = db.query(Project).filter(Project.id == project_id).first()
        if project is None:
            raise ValueError(f"Project {project_id} not found")

        timeline_items = (
            db.query(TimelineItem)
            .filter(TimelineItem.project_id == project_id)
            .order_by(TimelineItem.position)
            .all()
        )

        subtitles = (
            db.query(Subtitle)
            .filter(Subtitle.project_id == project_id)
            .order_by(Subtitle.start_time)
            .all()
        )

        # Determine output path
        project_dir = PROJECTS_DIR / project_id
        project_dir.mkdir(parents=True, exist_ok=True)

        if draft:
            out_filename = "draft.mp4"
        else:
            out_filename = "final.mp4"
        out_path = str(project_dir / out_filename)

        logger.info(
            "Rendering project %s (%s mode): %d timeline items, %d subtitles",
            project_id,
            "draft" if draft else "final",
            len(timeline_items),
            len(subtitles),
        )

        # Resolve target dimensions from project format
        target_w, target_h = _resolve_dimensions(project.output_format)
        logger.info("Output format: %s -> %dx%d", project.output_format, target_w, target_h)

        _update_progress(project_id, 0.0, "preparing")
        tmpdir = tempfile.mkdtemp(prefix="rf_render_")

        # Generate ASS file if there are subtitles
        ass_path = None
        if subtitles:
            ass_path = os.path.join(tmpdir, "subs.ass")
            generate_ass_file(project_id, ass_path)

        if timeline_items:
            # -----------------------------------------------------------
            # Timeline case (Phase 3): multiple clips
            # -----------------------------------------------------------
            base_video = _render_timeline(
                timeline_items, tmpdir, draft,
                project_id=project_id,
                db=db,
                target_w=target_w,
                target_h=target_h,
            )
        else:
            # -----------------------------------------------------------
            # Simple case (Phase 1 MVP): just clip_a
            # -----------------------------------------------------------
            clip_path = project.clip_a_path
            if not clip_path or not os.path.isfile(clip_path):
                raise FileNotFoundError(f"Clip A not found: {clip_path}")

            base_video = _render_simple(
                clip_path, project.clip_a_type, tmpdir, draft,
                target_w=target_w, target_h=target_h,
            )

        # Mix background music if the project has one
        music_path = getattr(project, "music_path", None)
        music_volume = getattr(project, "music_volume", 0.3) or 0.3
        if music_path and os.path.isfile(music_path):
            _update_progress(project_id, 0.75, "mixing music")
            music_out = os.path.join(tmpdir, "music_mixed.mp4")
            _mix_background_music(base_video, music_path, music_out, music_volume, draft)
            base_video = music_out

        # Overlay subtitles on the base video
        if ass_path:
            _update_progress(project_id, 0.8, "subtitles")
            _overlay_ass_subtitles(base_video, ass_path, out_path, draft)
        else:
            # No subtitles -- just copy/re-encode the base video to output
            shutil.copy2(base_video, out_path)

        _update_progress(project_id, 1.0, "done")

        # Generate thumbnail from rendered output
        thumb_path = str(project_dir / "thumbnail.jpg")
        try:
            info = probe_video(out_path)
            # Extract frame at 2s, or at 10% if video is shorter than 2s
            seek_pct = min(2.0 / info["duration"], 0.5) if info["duration"] > 0 else 0.1
            if extract_thumbnail(out_path, thumb_path, at_percent=seek_pct):
                project.thumbnail_path = thumb_path
        except Exception as thumb_err:
            logger.warning("Thumbnail generation failed: %s", thumb_err)

        # Update project in DB
        if draft:
            project.draft_path = out_path
        else:
            project.output_path = out_path
        project.status = "rendered"
        db.commit()

        logger.info("Render complete: %s", out_path)
        return out_path

    except Exception as e:
        logger.exception("Render failed for project %s: %s", project_id, e)
        try:
            project = db.query(Project).filter(Project.id == project_id).first()
            if project:
                project.status = "error"
                db.commit()
        except Exception:
            db.rollback()
        raise

    finally:
        _clear_progress(project_id)
        if tmpdir:
            shutil.rmtree(tmpdir, ignore_errors=True)
        db.close()


# ---------------------------------------------------------------------------
# Internal render strategies
# ---------------------------------------------------------------------------

def _render_simple(
    clip_path: str,
    clip_type: str | None,
    tmpdir: str,
    draft: bool,
    target_w: int = TARGET_WIDTH,
    target_h: int = TARGET_HEIGHT,
) -> str:
    """Render simple case: single clip_a.

    If audio-only, generates a gradient background video.
    Returns path to the base video (without subtitles).
    """
    info = probe_video(clip_path)

    if not info["has_video"]:
        # Audio-only: generate gradient background
        logger.info("Audio-only input, generating gradient background")
        base_video = os.path.join(tmpdir, "base.mp4")
        _generate_gradient_video(
            clip_path, base_video, info["duration"], draft,
            target_w=target_w, target_h=target_h,
        )
        return base_video

    # Video input: pre-process (scale, crop, fps)
    base_video = os.path.join(tmpdir, "base.mp4")
    _preprocess_clip(
        clip_path, base_video,
        trim_start=0,
        trim_end=info["duration"],
        speed=1.0,
        draft=draft,
        target_w=target_w,
        target_h=target_h,
    )
    return base_video


def _render_timeline(
    timeline_items: list["TimelineItem"],
    tmpdir: str,
    draft: bool,
    project_id: str | None = None,
    db=None,
    target_w: int = TARGET_WIDTH,
    target_h: int = TARGET_HEIGHT,
) -> str:
    """Render timeline case: clip_a base + B-Roll overlays.

    The timeline has a clip_a base layer (position 0) and B-Roll overlays
    at specific time ranges. This function:
      1. Separates clip_a (base audio/video) from B-Roll items
      2. Builds a visual track from B-Roll clips + gap fillers
      3. Concatenates visual segments in time order
      4. Replaces audio with clip_a's audio track

    Returns path to the final base video (without subtitles).
    """
    # Separate clip_a from B-Roll overlay items
    clip_a_item = None
    broll_items = []
    for item in timeline_items:
        if item.source_type == "clip_a":
            clip_a_item = item
        else:
            broll_items.append(item)

    # Sort B-Roll by timeline_start
    broll_items.sort(key=lambda x: x.timeline_start)

    # Resolve clip_a path
    clip_a_path = None
    clip_a_has_video = False
    total_duration = 0.0
    if clip_a_item:
        clip_a_path = _resolve_source_path(clip_a_item, db)
        clip_a_info = probe_video(clip_a_path)
        clip_a_has_video = clip_a_info.get("has_video", False)
        total_duration = clip_a_item.timeline_end
    elif broll_items:
        total_duration = max(item.timeline_end for item in broll_items)

    if not broll_items:
        # No B-Roll — just render clip_a directly
        if clip_a_path:
            base_video = os.path.join(tmpdir, "base.mp4")
            if clip_a_has_video:
                _preprocess_clip(
                    clip_a_path, base_video, draft=draft,
                    target_w=target_w, target_h=target_h,
                )
            else:
                info = probe_video(clip_a_path)
                _generate_gradient_video(
                    clip_a_path, base_video, info["duration"], draft,
                    target_w=target_w, target_h=target_h,
                )
            return base_video
        raise FileNotFoundError("No clip_a and no B-Roll items to render")

    # Build visual segments in time order
    crf, preset = _get_render_settings(draft)
    segments = []
    current_time = 0.0

    for i, item in enumerate(broll_items):
        if project_id:
            pct = (i / len(broll_items)) * 0.6
            _update_progress(project_id, pct, f"clip {i+1}/{len(broll_items)}")

        gap = item.timeline_start - current_time

        # Fill gap before this B-Roll clip
        if gap > 0.1:
            gap_out = os.path.join(tmpdir, f"gap_{i:03d}.mp4")
            if clip_a_has_video and clip_a_path:
                # Use clip_a video for the gap (strip audio — will be mixed later)
                _preprocess_clip(
                    clip_a_path, gap_out,
                    trim_start=current_time,
                    trim_end=item.timeline_start,
                    draft=draft,
                    target_w=target_w, target_h=target_h,
                    strip_audio=True,
                )
            else:
                # Generate solid color filler for the gap
                _generate_color_segment(
                    gap_out, gap, target_w, target_h, draft,
                )
            segments.append(gap_out)

        # Process the B-Roll clip (strip audio — only clip_a audio goes in final)
        src = _resolve_source_path(item, db)
        broll_duration = item.timeline_end - item.timeline_start
        clip_out = os.path.join(tmpdir, f"broll_{i:03d}.mp4")
        logger.info(
            "Pre-processing B-Roll clip %d/%d: %s (%.1fs-%.1fs)",
            i + 1, len(broll_items), os.path.basename(src),
            item.timeline_start, item.timeline_end,
        )

        _preprocess_clip(
            src, clip_out,
            trim_start=item.clip_trim_start or 0,
            trim_end=item.clip_trim_end if item.clip_trim_end else broll_duration,
            speed=item.speed or 1.0,
            draft=draft,
            target_w=target_w, target_h=target_h,
            strip_audio=True,
        )
        segments.append(clip_out)
        current_time = item.timeline_end

    # Fill gap after last B-Roll clip
    if current_time < total_duration - 0.1:
        gap_out = os.path.join(tmpdir, "gap_end.mp4")
        remaining = total_duration - current_time
        if clip_a_has_video and clip_a_path:
            _preprocess_clip(
                clip_a_path, gap_out,
                trim_start=current_time,
                trim_end=total_duration,
                draft=draft,
                target_w=target_w, target_h=target_h,
                strip_audio=True,
            )
        else:
            _generate_color_segment(
                gap_out, remaining, target_w, target_h, draft,
            )
        segments.append(gap_out)

    if not segments:
        raise RuntimeError("No video segments to concatenate")

    # Concatenate all visual segments
    if project_id:
        _update_progress(project_id, 0.65, "concatenating")

    concat_list_path = os.path.join(tmpdir, "concat.txt")
    with open(concat_list_path, "w") as f:
        for seg in segments:
            f.write(f"file '{seg}'\n")

    concat_out = os.path.join(tmpdir, "concat_video.mp4")
    cmd_concat = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_list_path,
        "-c", "copy",
        "-movflags", "+faststart",
        concat_out,
    ]
    _run_ffmpeg(cmd_concat, "Concatenate timeline segments")

    # Replace audio with clip_a's audio track
    if clip_a_path:
        if project_id:
            _update_progress(project_id, 0.7, "mixing audio")

        final_out = os.path.join(tmpdir, "timeline_final.mp4")
        cmd_audio = [
            "ffmpeg", "-y",
            "-i", concat_out,       # video from concat
            "-i", clip_a_path,      # audio from clip_a
            "-map", "0:v:0",        # take video from first input
            "-map", "1:a:0",        # take audio from second input
            "-c:v", "copy",         # don't re-encode video
            "-c:a", "aac", "-b:a", "128k",
            "-shortest",
            "-movflags", "+faststart",
            final_out,
        ]
        try:
            _run_ffmpeg(cmd_audio, "Mix clip_a audio with B-Roll video")
            return final_out
        except RuntimeError as e:
            logger.warning("Audio mixing failed, returning video-only: %s", e)
            return concat_out

    return concat_out


def _mix_background_music(
    video_path: str,
    music_path: str,
    output_path: str,
    music_volume: float = 0.3,
    draft: bool = True,
) -> None:
    """Mix background music into a video, ducking behind the main audio.

    Uses amix to blend main audio with music at music_volume level.
    Music is trimmed/looped to match the video duration.
    """
    crf, preset = _get_render_settings(draft)
    vol = max(0.0, min(1.0, music_volume))

    cmd = [
        "ffmpeg", "-y",
        "-i", video_path,
        "-stream_loop", "-1", "-i", music_path,
        "-filter_complex",
        (
            f"[1:a]volume={vol:.3f}[music];"
            f"[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[a]"
        ),
        "-map", "0:v",
        "-map", "[a]",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "128k",
        "-shortest",
        "-movflags", "+faststart",
        output_path,
    ]
    try:
        _run_ffmpeg(cmd, "Mix background music")
    except RuntimeError as e:
        logger.warning("Background music mixing failed, skipping music: %s", e)
        import shutil as _shutil
        _shutil.copy2(video_path, output_path)


def _generate_color_segment(
    output_path: str,
    duration: float,
    target_w: int,
    target_h: int,
    draft: bool,
) -> None:
    """Generate a solid color video segment (gap filler)."""
    crf, preset = _get_render_settings(draft)
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i",
        f"color=c=0x1a1a2e:s={target_w}x{target_h}:d={duration:.3f}:r={TARGET_FPS}",
        "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo",
        "-c:v", "libx264",
        "-crf", str(crf),
        "-preset", preset,
        "-c:a", "aac", "-b:a", "128k",
        "-shortest",
        "-movflags", "+faststart",
        output_path,
    ]
    _run_ffmpeg(cmd, f"Generate {duration:.1f}s gap filler")
