"""SQLAlchemy ORM models for ReelForge."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, Column, DateTime, Float, ForeignKey, Integer, LargeBinary, String, Text,
    CheckConstraint, func,
)
from sqlalchemy.orm import DeclarativeBase, relationship


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Base(DeclarativeBase):
    pass


class Clip(Base):
    __tablename__ = "clips"

    id = Column(String, primary_key=True, default=_uuid)
    filename = Column(String, nullable=False)
    filepath = Column(String, nullable=False)
    category = Column(String)
    type = Column(String, CheckConstraint("type IN ('video', 'image')"))
    title_en = Column(String)
    title_pl = Column(String)
    summary_en = Column(Text)
    summary_pl = Column(Text)
    duration = Column(Float)
    fps = Column(Float)
    width = Column(Integer)
    height = Column(Integer)
    is_dynamic = Column(Boolean, default=False)
    focus_x = Column(Float, default=0.5)
    focus_y = Column(Float, default=0.5)
    thumbnail_path = Column(String)
    embedding = Column(LargeBinary)
    tags = Column(Text)  # JSON array
    created_at = Column(String, default=_now)
    imported_at = Column(DateTime, default=func.now())
    is_favorite = Column(Boolean, default=False)

    segments = relationship("ClipSegment", back_populates="clip", cascade="all, delete-orphan")


class ClipSegment(Base):
    __tablename__ = "clip_segments"

    id = Column(Integer, primary_key=True, autoincrement=True)
    clip_id = Column(String, ForeignKey("clips.id", ondelete="CASCADE"), nullable=False)
    start_time = Column(Float, nullable=False)
    end_time = Column(Float, nullable=False)
    description_en = Column(Text)
    description_pl = Column(Text)
    embedding = Column(LargeBinary)

    clip = relationship("Clip", back_populates="segments")


class Category(Base):
    __tablename__ = "categories"

    name = Column(String, primary_key=True)
    display_name = Column(String)
    clip_count = Column(Integer, default=0)
    created_at = Column(String, default=_now)


class Project(Base):
    __tablename__ = "projects"

    id = Column(String, primary_key=True, default=_uuid)
    name = Column(String, nullable=False)
    status = Column(String, default="draft")
    clip_a_path = Column(String)
    clip_a_type = Column(String)
    transcript_json = Column(Text)
    duration = Column(Float)
    output_format = Column(String, default="9:16")
    output_path = Column(String)
    draft_path = Column(String)
    thumbnail_path = Column(String)
    created_at = Column(String, default=_now)
    updated_at = Column(String, default=_now)

    music_path = Column(String, nullable=True)
    music_volume = Column(Float, default=0.3)

    timeline_items = relationship("TimelineItem", back_populates="project", cascade="all, delete-orphan")
    subtitles = relationship("Subtitle", back_populates="project", cascade="all, delete-orphan")


class TimelineItem(Base):
    __tablename__ = "timeline_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    clip_id = Column(String, ForeignKey("clips.id"))
    source_type = Column(String, default="library")
    source_path = Column(String)
    position = Column(Integer, nullable=False)
    timeline_start = Column(Float, nullable=False)
    timeline_end = Column(Float, nullable=False)
    clip_trim_start = Column(Float, default=0)
    clip_trim_end = Column(Float)
    speed = Column(Float, default=1.0)
    transition_in = Column(String, default="cut")
    transition_duration = Column(Float, default=0.0)

    project = relationship("Project", back_populates="timeline_items")


class Subtitle(Base):
    __tablename__ = "subtitles"

    id = Column(Integer, primary_key=True, autoincrement=True)
    project_id = Column(String, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False)
    text = Column(Text, nullable=False)
    start_time = Column(Float, nullable=False)
    end_time = Column(Float, nullable=False)
    style = Column(String, default="body")
    position_x = Column(Float, default=0.5)
    position_y = Column(Float, default=0.6)
    font_size = Column(Integer)
    color = Column(String, default="#FFFFFF")
    karaoke_style = Column(String, default="classic")  # normal, classic, pop, typewriter, bounce
    outline_color = Column(String, default="#000000")
    highlight_color = Column(String, default="#8b5cf6")
    words_json = Column(Text)  # JSON: [{word, start, end}, ...]
    language = Column(String, default="en")  # ISO 639-1 language code

    project = relationship("Project", back_populates="subtitles")
