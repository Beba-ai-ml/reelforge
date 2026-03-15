"""ReelForge - FastAPI entry point."""

import atexit
import logging
import signal
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.config import DATA_DIR
from backend.db.database import engine
from backend.db.models import Base
from backend.api import projects, subtitles, render, ai, timeline, clips, ai_clips, library, waveform

_shutdown_logger = logging.getLogger("reelforge.shutdown")


def _migrate_db():
    """Run lightweight migrations for existing databases."""
    from sqlalchemy import text, inspect
    insp = inspect(engine)
    # Add thumbnail_path to projects if missing
    if "projects" in insp.get_table_names():
        columns = {c["name"] for c in insp.get_columns("projects")}
        if "thumbnail_path" not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN thumbnail_path TEXT"))
        if "music_path" not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN music_path TEXT"))
        if "music_volume" not in columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE projects ADD COLUMN music_volume REAL DEFAULT 0.3"))
    # Add language column to subtitles if missing
    if "subtitles" in insp.get_table_names():
        sub_columns = {c["name"] for c in insp.get_columns("subtitles")}
        if "language" not in sub_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE subtitles ADD COLUMN language TEXT DEFAULT 'en'"))
        if "highlight_color" not in sub_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE subtitles ADD COLUMN highlight_color TEXT DEFAULT '#8b5cf6'"))
    # Add missing columns to clips table
    if "clips" in insp.get_table_names():
        clip_columns = {c["name"] for c in insp.get_columns("clips")}
        if "imported_at" not in clip_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE clips ADD COLUMN imported_at TIMESTAMP"))
        if "is_favorite" not in clip_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE clips ADD COLUMN is_favorite BOOLEAN DEFAULT 0"))


def _cleanup_vram():
    """Unload all AI models from VRAM."""
    _shutdown_logger.info("Unloading AI models from VRAM...")
    try:
        from backend.services.vision import unload_ollama_model
        unload_ollama_model()
    except Exception as e:
        _shutdown_logger.warning("Failed to unload Ollama model: %s", e)
    try:
        from backend.services.transcription import unload_model
        unload_model()
        _shutdown_logger.info("Whisper model unloaded")
    except Exception as e:
        _shutdown_logger.warning("Failed to unload Whisper model: %s", e)
    try:
        from backend.services.embeddings import unload_model as unload_embeddings
        unload_embeddings()
        _shutdown_logger.info("Embeddings model unloaded")
    except Exception as e:
        _shutdown_logger.warning("Failed to unload embeddings model: %s", e)
    _shutdown_logger.info("VRAM cleanup complete")


# Register atexit + signal handlers so Ctrl+C always cleans up
atexit.register(_cleanup_vram)

_orig_sigint = signal.getsignal(signal.SIGINT)
_orig_sigterm = signal.getsignal(signal.SIGTERM)


def _signal_handler(signum, frame):
    _shutdown_logger.info("Signal %s received, cleaning up VRAM...", signum)
    _cleanup_vram()
    # Re-raise the original handler so uvicorn can shut down properly
    orig = _orig_sigint if signum == signal.SIGINT else _orig_sigterm
    if callable(orig):
        orig(signum, frame)
    else:
        raise SystemExit(0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    _migrate_db()
    # Install signal handlers after uvicorn is running
    signal.signal(signal.SIGINT, _signal_handler)
    signal.signal(signal.SIGTERM, _signal_handler)
    yield
    _cleanup_vram()


app = FastAPI(title="ReelForge", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API routers
app.include_router(projects.router, prefix="/api/projects", tags=["projects"])
app.include_router(subtitles.router, prefix="/api/projects", tags=["subtitles"])
app.include_router(render.router, prefix="/api/projects", tags=["render"])
app.include_router(ai.router, prefix="/api/projects", tags=["ai"])
app.include_router(timeline.router, prefix="/api/projects", tags=["timeline"])
app.include_router(ai_clips.router, prefix="/api/clips", tags=["ai-clips"])
app.include_router(clips.router, prefix="/api/clips", tags=["clips"])
app.include_router(library.router, prefix="/api/library", tags=["library"])
app.include_router(waveform.router, prefix="/api/projects", tags=["waveform"])

# Serve project files (uploads, renders, thumbnails)
app.mount("/data", StaticFiles(directory=str(DATA_DIR)), name="data")
