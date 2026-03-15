"""Subtitle generation and ASS file builder for ReelForge."""

import json
import logging
import textwrap
from pathlib import Path

from backend.config import (
    FONT_PATH,
    FONT_NAME,
    TARGET_WIDTH,
    TARGET_HEIGHT,
)
from backend.db.database import SessionLocal
from backend.db.models import Project, Subtitle

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_WORDS_PER_SUBTITLE = 4
MAX_CHARS_PER_SUBTITLE = 25
PAUSE_THRESHOLD = 0.5  # seconds of silence to force a split

FADE_MS = 200

# Font sizes in the DB are CSS pixels matching the preview container.
# ASS fontsize must be scaled to the actual canvas resolution.
# 660 ≈ typical preview container height for a 9:16 video in the editor.
PREVIEW_REFERENCE_HEIGHT = 660

# ASS style definitions for 1080x1920 canvas
STYLES = {
    "hook": {
        "fontsize": 72,
        "bold": True,
        "alignment": 8,
        "margin_v": 640,
        "margin_l": 40,
        "margin_r": 40,
        "outline": 3,
        "wrap_width": 20,
    },
    "body": {
        "fontsize": 48,
        "bold": True,
        "alignment": 8,
        "margin_v": 768,
        "margin_l": 60,
        "margin_r": 60,
        "outline": 2,
        "wrap_width": 20,
    },
    "label": {
        "fontsize": 36,
        "bold": True,
        "alignment": 1,
        "margin_v": 120,
        "margin_l": 40,
        "margin_r": 40,
        "outline": 2,
        "wrap_width": 20,
    },
    "credit": {
        "fontsize": 28,
        "bold": True,
        "alignment": 2,
        "margin_v": 60,
        "margin_l": 40,
        "margin_r": 40,
        "outline": 1,
        "wrap_width": 20,
    },
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _format_ass_time(seconds: float) -> str:
    """Convert seconds to ASS timestamp: H:MM:SS.cc (centiseconds)."""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    cs = int(round((s - int(s)) * 100))
    return f"{h}:{m:02d}:{int(s):02d}.{cs:02d}"


def hex_to_ass_color(hex_color: str) -> str:
    """Convert '#RRGGBB' to ASS '&H00BBGGRR' format (BGR order with alpha prefix)."""
    hex_color = hex_color.lstrip("#")
    if len(hex_color) != 6:
        return "&H00FFFFFF"
    r = hex_color[0:2]
    g = hex_color[2:4]
    b = hex_color[4:6]
    return f"&H00{b}{g}{r}".upper()


def _group_words_into_subtitles(words: list[dict]) -> list[dict]:
    """Group word-level timing data into subtitle chunks.

    Each chunk has ~3-4 words, splits on natural pauses (>0.5s gap),
    and respects MAX_CHARS_PER_SUBTITLE.

    Returns list of dicts:
        [{"text": str, "start_time": float, "end_time": float,
          "words": [{"word": str, "start": float, "end": float}, ...]}]
    """
    if not words:
        return []

    subtitles = []
    current_words: list[dict] = []
    current_chars = 0

    def flush():
        nonlocal current_words, current_chars
        if not current_words:
            return
        text = " ".join(w["word"] for w in current_words)
        subtitles.append({
            "text": text,
            "start_time": current_words[0]["start"],
            "end_time": current_words[-1]["end"],
            "words": list(current_words),
        })
        current_words = []
        current_chars = 0

    for i, word in enumerate(words):
        word_text = word["word"]
        word_len = len(word_text)

        # Check for natural pause before this word
        if current_words and i > 0:
            gap = word["start"] - words[i - 1]["end"]
            if gap >= PAUSE_THRESHOLD:
                flush()

        # Check if adding this word would exceed limits
        new_chars = current_chars + (1 if current_chars > 0 else 0) + word_len
        if current_words and (
            len(current_words) >= MAX_WORDS_PER_SUBTITLE
            or new_chars > MAX_CHARS_PER_SUBTITLE
        ):
            flush()

        current_words.append(word)
        current_chars += (1 if current_chars > 0 else 0) + word_len

    # Flush remaining
    flush()

    return subtitles


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def generate_subtitles(project_id: str) -> list[dict]:
    """Generate subtitle records from a project's transcript.

    Opens its own DB session. Parses transcript_json, groups words
    into subtitle chunks, stores them in the subtitles table, and
    updates project.status to 'subtitled'.

    Returns the list of subtitle dicts for reference.
    """
    db = SessionLocal()

    try:
        project = db.query(Project).filter(Project.id == project_id).first()
        if project is None:
            raise ValueError(f"Project {project_id} not found")

        if not project.transcript_json:
            raise ValueError(f"Project {project_id} has no transcript")

        words = json.loads(project.transcript_json)
        if not words:
            raise ValueError(f"Project {project_id} transcript is empty")

        logger.info(
            "Generating subtitles for project %s (%d words)",
            project_id, len(words),
        )

        # Group words into subtitle chunks
        subtitle_groups = _group_words_into_subtitles(words)

        # Delete existing subtitles for this project
        db.query(Subtitle).filter(Subtitle.project_id == project_id).delete()

        # Insert new subtitles
        new_subtitles = []
        for group in subtitle_groups:
            sub = Subtitle(
                project_id=project_id,
                text=group["text"],
                start_time=group["start_time"],
                end_time=group["end_time"],
                style="body",
                words_json=json.dumps(group["words"], ensure_ascii=False),
            )
            db.add(sub)
            new_subtitles.append(group)

        project.status = "subtitled"
        db.commit()

        logger.info(
            "Generated %d subtitles for project %s",
            len(new_subtitles), project_id,
        )
        return new_subtitles

    except Exception as e:
        logger.exception("Subtitle generation failed for project %s: %s", project_id, e)
        db.rollback()
        raise

    finally:
        db.close()


def generate_ass_content(
    subtitles: list["Subtitle"],
    canvas_w: int = TARGET_WIDTH,
    canvas_h: int = TARGET_HEIGHT,
) -> str:
    """Generate ASS subtitle content from a list of Subtitle ORM objects.

    Returns the full ASS file content as a string.
    """
    # Resolve font name
    font_name = FONT_NAME
    if FONT_PATH.is_file():
        font_name = FONT_PATH.stem

    header = _build_ass_header(canvas_w, canvas_h, font_name)
    events = _build_ass_events(subtitles, canvas_w, canvas_h)

    return header + "\n" + events


def _resolve_canvas_dimensions(output_format: str | None) -> tuple[int, int]:
    """Return (width, height) for ASS PlayRes based on project format."""
    if output_format == "16:9":
        return 1920, 1080
    if output_format == "1:1":
        return 1080, 1080
    return TARGET_WIDTH, TARGET_HEIGHT


def generate_ass_file(project_id: str, output_path: str) -> str:
    """Generate an ASS subtitle file with karaoke timing for a project.

    Opens its own DB session. Loads all subtitles for the project and
    builds a full ASS file with word-by-word karaoke highlighting.
    Automatically detects project output format for correct canvas size.

    Returns the ASS file content as a string.
    """
    db = SessionLocal()

    try:
        project = db.query(Project).filter(Project.id == project_id).first()
        canvas_w, canvas_h = _resolve_canvas_dimensions(
            project.output_format if project else None
        )

        subtitles = (
            db.query(Subtitle)
            .filter(Subtitle.project_id == project_id)
            .order_by(Subtitle.start_time)
            .all()
        )

        if not subtitles:
            raise ValueError(f"No subtitles found for project {project_id}")

        ass_content = generate_ass_content(subtitles, canvas_w, canvas_h)

        # Write to file
        out = Path(output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(ass_content, encoding="utf-8")

        logger.info(
            "Generated ASS file for project %s: %s (%d events)",
            project_id, output_path, len(subtitles),
        )
        return ass_content

    finally:
        db.close()


# ---------------------------------------------------------------------------
# ASS file builders
# ---------------------------------------------------------------------------

def _build_ass_header(width: int, height: int, font_name: str) -> str:
    """Build the [Script Info] and [V4+ Styles] sections."""
    font_scale = height / PREVIEW_REFERENCE_HEIGHT

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding",
    ]

    for name, s in STYLES.items():
        scaled_fontsize = int(s['fontsize'] * font_scale)
        scaled_outline = max(1, int(s['outline'] * font_scale))
        bold_flag = -1 if s["bold"] else 0
        line = (
            f"Style: {name},{font_name},{scaled_fontsize},"
            f"&H00FFFFFF,&H00F65C8B,&H00000000,&H80000000,"
            f"{bold_flag},0,0,0,"
            f"100,100,0,0,"
            f"1,{scaled_outline},0,"
            f"{s['alignment']},{s['margin_l']},{s['margin_r']},{s['margin_v']},1"
        )
        lines.append(line)

    lines.append("")
    return "\n".join(lines)


def _build_override_tags(
    sub: "Subtitle",
    font_scale: float = 1.0,
    canvas_w: int = TARGET_WIDTH,
    canvas_h: int = TARGET_HEIGHT,
) -> str:
    """Build ASS override tags for per-subtitle property overrides."""
    tags = []

    # Font size override (scale from preview CSS px to ASS canvas units)
    if sub.font_size:
        tags.append(f"\\fs{int(sub.font_size * font_scale)}")

    # Primary color override (text fill color)
    if sub.color and sub.color != "#FFFFFF":
        tags.append(f"\\1c{hex_to_ass_color(sub.color)}")

    # Outline color override
    if sub.outline_color and sub.outline_color != "#000000":
        tags.append(f"\\3c{hex_to_ass_color(sub.outline_color)}")

    # Secondary/highlight color override (used by \kf karaoke fill)
    if sub.highlight_color and sub.highlight_color != "#8b5cf6":
        tags.append(f"\\2c{hex_to_ass_color(sub.highlight_color)}")

    # Position override (0-1 range to pixel coords)
    if sub.position_x is not None and sub.position_y is not None:
        px = int(sub.position_x * canvas_w)
        py = int(sub.position_y * canvas_h)
        tags.append(f"\\pos({px},{py})")

    return "".join(tags)


def _build_karaoke_classic(words: list[dict]) -> str:
    """Classic karaoke: smooth fill with \\kf tags."""
    parts = []
    for w in words:
        duration_cs = max(1, int(round((w["end"] - w["start"]) * 100)))
        parts.append(f"{{\\kf{duration_cs}}}{w['word']}")
    return " ".join(parts)


def _build_karaoke_pop(words: list[dict]) -> str:
    """Pop karaoke: classic fill + scale-up effect on the active word."""
    parts = []
    for w in words:
        duration_cs = max(1, int(round((w["end"] - w["start"]) * 100)))
        dur_ms = duration_cs * 10
        # Scale up to 125% during the word, then back to 100%
        half = dur_ms // 2
        parts.append(
            f"{{\\kf{duration_cs}"
            f"\\t(0,{half},\\fscx125\\fscy125)"
            f"\\t({half},{dur_ms},\\fscx100\\fscy100)"
            f"}}{w['word']}"
        )
    return " ".join(parts)


def _build_karaoke_typewriter(words: list[dict], sub_start: float) -> str:
    """Typewriter: words fade in one by one from invisible to visible."""
    parts = []
    for w in words:
        # Time offsets relative to subtitle start, in milliseconds
        w_start_ms = int(round((w["start"] - sub_start) * 1000))
        w_end_ms = int(round((w["end"] - sub_start) * 1000))
        # Start invisible, transition to fully visible over the word duration
        parts.append(
            f"{{\\alpha&HFF&"
            f"\\t({w_start_ms},{w_end_ms},\\alpha&H00&)"
            f"}}{w['word']}"
        )
    return " ".join(parts)


def _build_karaoke_bounce(words: list[dict]) -> str:
    """Bounce: classic karaoke fill with a fade-out tail."""
    parts = []
    for w in words:
        duration_cs = max(1, int(round((w["end"] - w["start"]) * 100)))
        parts.append(f"{{\\kf{duration_cs}}}{w['word']}")
    # Add a subtle fade-out at the end of the whole subtitle
    return f"{{\\fad(0,100)}}" + " ".join(parts)


def _build_karaoke_normal(
    words: list[dict],
    sub_start: float,
    highlight_color_ass: str,
    base_color_ass: str,
) -> str:
    """Normal karaoke: only the currently-spoken word is highlighted, others stay base color.

    Uses \\k tags for timing with explicit color overrides per word so that
    only the active word gets the highlight color and all others show base color.
    """
    parts = []
    for w in words:
        duration_cs = max(1, int(round((w["end"] - w["start"]) * 100)))
        # \\k sets the timing; \\1c sets fill color to highlight during that word's duration.
        # After the \\k duration expires, ASS reverts to the style's PrimaryColour (base).
        parts.append(f"{{\\k{duration_cs}\\1c{highlight_color_ass}}}{w['word']}")
    # Wrap the whole line in base color first so non-active words show base color.
    return f"{{\\1c{base_color_ass}}}" + " ".join(parts)


def _build_ass_events(
    subtitles: list["Subtitle"],
    canvas_w: int = TARGET_WIDTH,
    canvas_h: int = TARGET_HEIGHT,
) -> str:
    """Build the [Events] section with karaoke timing from subtitle records."""
    font_scale = canvas_h / PREVIEW_REFERENCE_HEIGHT

    lines = [
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    for sub in subtitles:
        start_str = _format_ass_time(sub.start_time)
        end_str = _format_ass_time(sub.end_time)
        style_name = sub.style or "body"
        karaoke_style = getattr(sub, "karaoke_style", None) or "classic"

        # Build per-subtitle override tags
        overrides = _build_override_tags(sub, font_scale, canvas_w, canvas_h)

        # Resolve highlight color (ASS BGR format)
        highlight_hex = getattr(sub, "highlight_color", None) or "#8b5cf6"
        highlight_color_ass = hex_to_ass_color(highlight_hex)
        base_color_ass = hex_to_ass_color(sub.color or "#FFFFFF")

        # Build karaoke text with word-level data if available
        if sub.words_json:
            try:
                words = json.loads(sub.words_json)
                if karaoke_style == "normal":
                    karaoke_text = _build_karaoke_normal(
                        words, sub.start_time, highlight_color_ass, base_color_ass
                    )
                elif karaoke_style == "pop":
                    karaoke_text = _build_karaoke_pop(words)
                elif karaoke_style == "typewriter":
                    karaoke_text = _build_karaoke_typewriter(words, sub.start_time)
                elif karaoke_style == "bounce":
                    karaoke_text = _build_karaoke_bounce(words)
                else:  # classic
                    karaoke_text = _build_karaoke_classic(words)

                # For bounce, fad is already embedded; for others, add standard fade
                if karaoke_style == "bounce":
                    text_with_fx = karaoke_text
                else:
                    text_with_fx = f"{{\\fad({FADE_MS},{FADE_MS})}}" + karaoke_text
            except (json.JSONDecodeError, KeyError):
                text_with_fx = f"{{\\fad({FADE_MS},{FADE_MS})}}{sub.text}"
        else:
            text_with_fx = f"{{\\fad({FADE_MS},{FADE_MS})}}{sub.text}"

        # Prepend per-subtitle overrides if any
        if overrides:
            text_with_fx = "{" + overrides + "}" + text_with_fx

        line = (
            f"Dialogue: 0,{start_str},{end_str},"
            f"{style_name},,0,0,0,,{text_with_fx}"
        )
        lines.append(line)

    lines.append("")
    return "\n".join(lines)
