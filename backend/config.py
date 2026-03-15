"""ReelForge configuration."""

import os
from pathlib import Path

# Paths
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
LIBRARY_DIR = DATA_DIR / "library"
PROJECTS_DIR = DATA_DIR / "projects"
THUMBNAILS_DIR = DATA_DIR / "thumbnails"
DB_PATH = DATA_DIR / "reelforge.db"

# Ensure directories exist
for d in [LIBRARY_DIR, PROJECTS_DIR, THUMBNAILS_DIR]:
    d.mkdir(parents=True, exist_ok=True)

# Database
DATABASE_URL = f"sqlite:///{DB_PATH}"

# Server
HOST = os.getenv("REELFORGE_HOST", "0.0.0.0")
PORT = int(os.getenv("REELFORGE_PORT", "8000"))

# Whisper
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "large-v3")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "auto")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8_float16")
WHISPER_BEAM_SIZE = int(os.getenv("WHISPER_BEAM_SIZE", "1"))
WHISPER_IDLE_TIMEOUT = int(os.getenv("WHISPER_IDLE_TIMEOUT", "300"))  # seconds

# Ollama (MiniCPM-V)
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
VISION_MODEL = os.getenv("VISION_MODEL", "minicpm-v:8b")

# FFmpeg
FONT_PATH = Path("/home/beba/reels/fonts/Montserrat-Bold.ttf")
FONT_NAME = "Montserrat Bold"
TARGET_WIDTH = 1080
TARGET_HEIGHT = 1920
TARGET_FPS = 30

# Render
DRAFT_CRF = 28
DRAFT_PRESET = "ultrafast"
FINAL_CRF = 18
FINAL_PRESET = "fast"

# Allowed upload extensions
VIDEO_EXTENSIONS = {".mp4", ".mov", ".avi", ".mkv", ".webm"}
AUDIO_EXTENSIONS = {".mp3", ".m4a", ".wav", ".ogg", ".flac"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".webp"}
ALLOWED_EXTENSIONS = VIDEO_EXTENSIONS | AUDIO_EXTENSIONS | IMAGE_EXTENSIONS
