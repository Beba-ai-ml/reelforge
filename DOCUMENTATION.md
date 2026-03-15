# ReelForge -- Technical Documentation

## 1. Project Overview

ReelForge is a local web application for creating Instagram/TikTok-style short-form video reels. It provides an end-to-end pipeline: upload source media, transcribe audio with faster-whisper, auto-generate karaoke subtitles, build a B-Roll clip library with AI-powered vision analysis and semantic embeddings, automatically match B-Roll to transcript content, arrange clips on a drag-and-drop timeline, mix background music, and render the final video with FFmpeg. The backend is a FastAPI service backed by SQLite; the frontend is a React + TypeScript SPA served through Vite with a proxy to the API.

---

## 2. Architecture

### Component Diagram

```
+---------------------------+          +-----------------------------+
|    Frontend (Vite/React)  |          |     External Services       |
|    localhost:5173          |          |                             |
|                           |   REST   |  Ollama (MiniCPM-V :8b)    |
|  Dashboard / Editor /     | <------> |    localhost:11434          |
|  Library pages            |          |                             |
+----------+----------------+          +-----------------------------+
           |
           | Vite proxy: /api -> :8000
           | Vite proxy: /data -> :8000
           v
+----------+----------------+          +-----------------------------+
|    Backend (FastAPI)      |          |     AI Models (in-process)  |
|    localhost:8000          |          |                             |
|                           |          |  faster-whisper (large-v3)  |
|  9 API routers            |          |  sentence-transformers      |
|  8 service modules        |          |    (all-MiniLM-L6-v2)      |
|  SQLAlchemy ORM           |          +-----------------------------+
|  Background tasks         |
+----------+----------------+
           |
           v
+----------+----------------+          +-----------------------------+
|    SQLite Database        |          |     File System             |
|    data/reelforge.db      |          |                             |
|    WAL journal mode       |          |  data/projects/{id}/        |
|    Foreign keys ON        |          |  data/library/{category}/   |
+---------------------------+          |  data/thumbnails/           |
                                       +-----------------------------+
```

### Data Flow: Upload to Render

1. **Upload** -- User uploads video/audio file via `POST /api/projects/{id}/upload`. File saved to `data/projects/{id}/input.{ext}`. Media probed with ffprobe for duration/dimensions.
2. **Transcribe** -- `POST /api/projects/{id}/transcribe` triggers background task. Audio extracted to 16kHz mono WAV, split into 300s chunks, run through faster-whisper with word-level timestamps. Result stored in `project.transcript_json`.
3. **Generate Subtitles** -- `POST /api/projects/{id}/generate-subtitles` groups words into subtitle chunks (max 4 words or 25 chars, split on 0.5s pauses). Subtitle records created in DB with word-level timing JSON.
4. **B-Roll Matching** (optional) -- `POST /api/projects/{id}/match-broll` groups transcript into phrases, extracts keywords, searches library with weighted scoring, reranks with semantic embeddings, applies pacing rules. Creates timeline items.
5. **Edit** -- User adjusts timeline, subtitles, and clip choices in the editor UI.
6. **Render** -- `POST /api/projects/{id}/render` triggers background render. Timeline clips are preprocessed (trim, speed, crop, scale), concatenated, clip_a audio mixed in, optional background music overlaid, ASS subtitles burned. Output saved as `draft.mp4` or `final.mp4`.

### Frontend-Backend Communication

| Channel | Usage |
|---------|-------|
| REST (JSON) | All CRUD operations, AI triggers, status polling |
| WebSocket | Real-time render progress (`/api/projects/{id}/render/ws`) |
| Static files | `/data` mount serves project files, thumbnails, library clips |
| Vite proxy | Dev server proxies `/api` and `/data` to `localhost:8000` |

---

## 3. Database Schema

SQLite with WAL journal mode and foreign keys enabled. 6 tables total.

### `projects`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | String (PK) | uuid4 hex | 32-char hex string |
| name | String | -- | Required |
| status | String | `"draft"` | draft / transcribing / transcribed / subtitled / editing / rendering / rendered / error |
| clip_a_path | String | NULL | Absolute path to uploaded source file |
| clip_a_type | String | NULL | `"video"`, `"audio"`, or `"image"` |
| transcript_json | Text | NULL | JSON array of `{word, start, end}` |
| duration | Float | NULL | Seconds, from ffprobe |
| output_format | String | `"9:16"` | `"9:16"`, `"16:9"`, or `"1:1"` |
| output_path | String | NULL | Path to final render |
| draft_path | String | NULL | Path to draft render |
| thumbnail_path | String | NULL | Path to project thumbnail |
| music_path | String | NULL | Path to background music file |
| music_volume | Float | 0.3 | 0.0 to 1.0 |
| created_at | String | ISO UTC | |
| updated_at | String | ISO UTC | |

**Relationships:** has many `timeline_items`, has many `subtitles` (cascade delete).

### `clips`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | String (PK) | uuid4 hex | |
| filename | String | -- | Original filename |
| filepath | String | -- | Relative to LIBRARY_DIR |
| category | String | NULL | Category slug |
| type | String | NULL | CHECK: `"video"` or `"image"` |
| title_en | String | NULL | AI-generated English title |
| title_pl | String | NULL | AI-generated Polish title |
| summary_en | Text | NULL | AI-generated English description |
| summary_pl | Text | NULL | AI-generated Polish description |
| duration | Float | NULL | Seconds |
| fps | Float | NULL | Frames per second |
| width | Integer | NULL | Pixels |
| height | Integer | NULL | Pixels |
| is_dynamic | Boolean | False | True = significant motion |
| focus_x | Float | 0.5 | Normalized focal point X |
| focus_y | Float | 0.5 | Normalized focal point Y |
| thumbnail_path | String | NULL | Filename in THUMBNAILS_DIR |
| embedding | LargeBinary | NULL | 384-dim float32 vector (1536 bytes) |
| tags | Text | NULL | JSON array of strings |
| created_at | String | ISO UTC | |
| imported_at | DateTime | func.now() | |
| is_favorite | Boolean | False | |

**Relationships:** has many `clip_segments` (cascade delete).

### `clip_segments`

| Column | Type | Notes |
|--------|------|-------|
| id | Integer (PK) | Auto-increment |
| clip_id | String (FK -> clips.id) | CASCADE delete |
| start_time | Float | Seconds |
| end_time | Float | Seconds |
| description_en | Text | AI-generated segment description (English) |
| description_pl | Text | AI-generated segment description (Polish) |
| embedding | LargeBinary | Per-segment embedding (unused currently) |

### `categories`

| Column | Type | Notes |
|--------|------|-------|
| name | String (PK) | Slug format: lowercase-hyphenated |
| display_name | String | Human-readable name |
| clip_count | Integer | Cached count, synced on category list |
| created_at | String | ISO UTC |

### `timeline_items`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | Integer (PK) | Auto-increment | |
| project_id | String (FK -> projects.id) | -- | CASCADE delete |
| clip_id | String (FK -> clips.id) | NULL | References library clip |
| source_type | String | `"library"` | `"library"`, `"clip_a"`, or `"custom"` |
| source_path | String | NULL | Direct file path override |
| position | Integer | -- | Sort order |
| timeline_start | Float | -- | Start time in project timeline (seconds) |
| timeline_end | Float | -- | End time in project timeline (seconds) |
| clip_trim_start | Float | 0.0 | Trim point within source clip |
| clip_trim_end | Float | NULL | Trim end within source clip |
| speed | Float | 1.0 | Playback speed multiplier |
| transition_in | String | `"cut"` | Transition type |
| transition_duration | Float | 0.0 | Transition duration (seconds) |

### `subtitles`

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| id | Integer (PK) | Auto-increment | |
| project_id | String (FK -> projects.id) | -- | CASCADE delete |
| text | Text | -- | Subtitle display text |
| start_time | Float | -- | Seconds |
| end_time | Float | -- | Seconds |
| style | String | `"body"` | `"hook"`, `"body"`, `"label"`, `"credit"` |
| position_x | Float | 0.5 | Normalized X (0-1) |
| position_y | Float | 0.6 | Normalized Y (0-1) |
| font_size | Integer | NULL | CSS px (scaled to ASS at render) |
| color | String | `"#FFFFFF"` | Hex RGB |
| karaoke_style | String | `"classic"` | `"normal"`, `"classic"`, `"pop"`, `"typewriter"`, `"bounce"` |
| outline_color | String | `"#000000"` | Hex RGB |
| highlight_color | String | `"#8b5cf6"` | Karaoke highlight color (hex RGB) |
| words_json | Text | NULL | JSON: `[{word, start, end}, ...]` |
| language | String | `"en"` | ISO 639-1 code |

---

## 4. API Reference

### Projects (`/api/projects`) -- 12 endpoints

| Method | Path | Request Body | Response | Notes |
|--------|------|-------------|----------|-------|
| POST | `/` | `{name, output_format?}` | ProjectSummary (201) | Creates project + directory |
| GET | `/` | -- | ProjectSummary[] | Ordered by created_at desc |
| GET | `/{id}` | -- | ProjectDetail | Includes subtitle_count, timeline_item_count |
| DELETE | `/{id}` | -- | 204 | Deletes project dir on disk |
| POST | `/{id}/upload` | multipart file | ProjectDetail | Saves as `input.{ext}`, probes duration |
| POST | `/{id}/duplicate` | -- | ProjectSummary (201) | Deep copies subtitles, timeline, files |
| GET | `/{id}/export` | -- | JSON (EDL format) | Timeline + subtitles + transcript |
| POST | `/import` | ProjectImport JSON | ProjectSummary (201) | Creates from exported JSON |
| GET | `/{id}/thumbnail` | -- | JPEG FileResponse | 404 if no thumbnail |
| POST | `/{id}/upload-music` | multipart audio file | ProjectDetail | Saves as `music.{ext}` |
| PUT | `/{id}/music-volume` | `{music_volume}` | ProjectDetail | Clamped 0.0-1.0 |
| DELETE | `/{id}/music` | -- | ProjectDetail | Deletes music file |

### AI + Matching (`/api/projects`) -- 6 endpoints

| Method | Path | Request Body | Response | Notes |
|--------|------|-------------|----------|-------|
| POST | `/{id}/transcribe` | -- | `{project_id, status}` | Background task; requires clip_a |
| POST | `/{id}/generate-subtitles` | -- | `{project_id, subtitle_count}` | Synchronous; requires transcript |
| GET | `/{id}/transcript` | -- | `{project_id, transcript}` | Raw word-level JSON |
| POST | `/{id}/match-broll` | `{max_broll?}` | `{project_id, timeline_items, count}` | Synchronous; creates timeline |
| GET | `/{id}/timeline/{tid}/alternatives` | `?limit=5` | Alternative[] | Scored clip suggestions |
| POST | `/{id}/translate-subtitles` | `{target_language, source_language?}` | `{project_id, target_language, translated_count}` | Creates new subtitle track via Ollama |

### Subtitles (`/api/projects`) -- 10 endpoints

| Method | Path | Request Body | Response | Notes |
|--------|------|-------------|----------|-------|
| GET | `/{id}/subtitles` | `?language=` | SubtitleResponse[] | Ordered by start_time |
| POST | `/{id}/subtitles` | SubtitleCreate | SubtitleResponse (201) | |
| GET | `/{id}/subtitles/languages` | -- | `{languages: string[]}` | Distinct language codes |
| PUT | `/{id}/subtitles/bulk-position` | `{position_y}` | SubtitleResponse[] | Updates all subtitles |
| PUT | `/{id}/subtitles/bulk-style` | BulkStyleUpdate | `{updated: int}` | Partial update all |
| GET | `/{id}/subtitles/export-ass` | -- | ASS file download | `text/x-ssa` content type |
| POST | `/{id}/subtitles/polish-all` | `{mode, subtitle_ids?}` | BulkPolishResponse | AI text polishing (preview only) |
| PUT | `/{id}/subtitles/{sid}` | SubtitleUpdate | SubtitleResponse | Partial update |
| DELETE | `/{id}/subtitles/{sid}` | -- | 204 | |
| POST | `/{id}/subtitles/{sid}/polish` | `{mode}` | PolishResponse | AI polish single (preview only) |

Polish modes: `"grammar"` (fix errors), `"punchier"` (more engaging), `"shorter"` (max 6 words).

### Render (`/api/projects`) -- 6 endpoints

| Method | Path | Request Body | Response | Notes |
|--------|------|-------------|----------|-------|
| POST | `/{id}/render` | `{draft: bool}` | RenderStatusResponse | Background task; 409 if already rendering |
| GET | `/{id}/render/status` | -- | RenderStatusResponse | |
| GET | `/{id}/render/download` | -- | MP4 FileResponse | Prefers final, falls back to draft |
| WS | `/{id}/render/ws` | -- | JSON frames | `{progress, stage, eta_seconds}` every 0.5s |
| GET | `/{id}/render/history` | -- | RenderHistoryResponse | Last 5 renders |
| GET | `/{id}/render/history/{rid}/download` | -- | MP4 FileResponse | Download past render |

### Timeline (`/api/projects`) -- 5 endpoints

| Method | Path | Request Body | Response | Notes |
|--------|------|-------------|----------|-------|
| GET | `/{id}/timeline` | -- | TimelineItemResponse[] | Enriched with clip_title, clip_type |
| POST | `/{id}/timeline` | TimelineItemCreate | TimelineItemResponse (201) | |
| PUT | `/{id}/timeline/reorder` | `{items: [{id, position}]}` | TimelineItemResponse[] | Bulk position update |
| PUT | `/{id}/timeline/{tid}` | TimelineItemUpdate | TimelineItemResponse | Partial update |
| DELETE | `/{id}/timeline/{tid}` | -- | 204 | |

### Clips / B-Roll Library (`/api/clips`) -- 17 endpoints

| Method | Path | Request Body | Response | Notes |
|--------|------|-------------|----------|-------|
| POST | `/import` | multipart file | ClipOut (201) | Single clip upload to `_unsorted/` |
| POST | `/import-bulk` | multipart files | BulkImportResponse (201) | Multiple files |
| POST | `/import-folder` | `{path, recursive?}` | FolderImportResponse | Server-side directory |
| GET | `/` | `?q=&category=&type=&is_dynamic=&limit=&offset=` | ClipListResponse | ILIKE text search |
| GET | `/stats` | -- | LibraryStats | Totals, breakdowns |
| GET | `/search` | `?q=&category=&type=&is_dynamic=&limit=&offset=` | Scored search results | Weighted keyword scoring |
| GET | `/{id}` | -- | ClipDetail (with segments) | |
| PUT | `/{id}` | ClipUpdate | ClipOut | Partial metadata update |
| DELETE | `/{id}` | -- | 204 | Deletes file + thumbnail |
| POST | `/delete-bulk` | `{clip_ids}` | `{deleted, errors}` | Mass delete |
| GET | `/{id}/file` | -- | FileResponse | Serve actual media file |
| GET | `/{id}/thumbnail` | -- | JPEG FileResponse | |
| PUT | `/{id}/favorite` | -- | `{id, is_favorite}` | Toggle favorite |
| GET | `/{id}/usage` | -- | ClipUsageResponse | Projects using this clip |
| GET | `/categories/list` | -- | CategoryOut[] | Auto-cleans empty categories |
| POST | `/categories` | `{name, display_name?}` | CategoryOut (201) | |
| PUT | `/categories/{name}` | `{display_name}` | CategoryOut | |
| DELETE | `/categories/{name}` | -- | 204 | 409 if clips assigned |

### AI Clips (`/api/clips`) -- 8 endpoints

| Method | Path | Request Body | Response | Notes |
|--------|------|-------------|----------|-------|
| POST | `/{id}/analyze` | -- | `{status}` | Background: vision analysis |
| POST | `/analyze-batch` | `{clip_ids?, all_unanalyzed?}` | `{status, count}` | Background batch |
| GET | `/analyze-progress` | -- | AnalyzeProgressResponse | Live batch progress |
| POST | `/analyze-cancel` | -- | `{status}` | Cancel running batch |
| POST | `/{id}/categorize` | -- | `{category}` | Synchronous |
| POST | `/categorize-batch` | `{clip_ids?, all_uncategorized?}` | `{status, count}` | Background batch |
| POST | `/embed-all` | -- | `{status}` | Background: embed all missing |
| POST | `/{id}/embed` | -- | `{status}` | Background: single clip |

### Waveform (`/api/projects`) -- 1 endpoint

| Method | Path | Response | Notes |
|--------|------|----------|-------|
| GET | `/{id}/waveform` | PNG FileResponse | 800x100 waveform image, cached |

### Library (`/api/library`) -- 2 endpoints

| Method | Path | Response | Notes |
|--------|------|----------|-------|
| GET | `/stats` | LibraryStats | Same as `/api/clips/stats` |
| GET | `/search` | Scored results | Same as `/api/clips/search` |

**Total: 67 endpoints** (12 projects + 6 AI/matching + 10 subtitles + 6 render + 5 timeline + 17 clips + 8 AI clips + 1 waveform + 2 library).

---

## 5. Services Reference

### `backend/services/transcription.py`

**Key function:** `transcribe_project(project_id: str) -> list[dict]`

- Extracts audio to 16kHz mono WAV via FFmpeg
- Splits long audio into 300-second chunks (`CHUNK_SECONDS`)
- Loads faster-whisper model (singleton with thread lock)
- Transcribes each chunk with `word_timestamps=True`
- Accumulates words with time offsets across chunks
- Stores `[{word, start, end}, ...]` JSON in `project.transcript_json`
- Updates project status: `transcribing` -> `transcribed` (or `error`)
- Idle timer: auto-unloads model after `WHISPER_IDLE_TIMEOUT` seconds (default 300)

**Other functions:**
- `unload_model()` -- Force-unload whisper model to free VRAM

### `backend/services/subtitle_gen.py`

**Key functions:**

`generate_subtitles(project_id: str) -> list[dict]`
- Parses `transcript_json` into word list
- Groups words via `_group_words_into_subtitles()`:
  - Max 4 words per subtitle (`MAX_WORDS_PER_SUBTITLE`)
  - Max 25 characters per subtitle (`MAX_CHARS_PER_SUBTITLE`)
  - Splits on pauses >= 0.5s (`PAUSE_THRESHOLD`)
- Creates Subtitle DB records with `words_json` for karaoke timing
- Updates project status to `subtitled`

`generate_ass_file(project_id: str, output_path: str) -> str`
- Builds complete ASS subtitle file with:
  - `[Script Info]`: PlayResX/Y matching output format
  - `[V4+ Styles]`: 4 predefined styles (hook, body, label, credit) with font scaling
  - `[Events]`: Dialogue lines with karaoke timing

**ASS Styles (base values for 1080x1920 canvas):**

| Style | Font Size | Alignment | Margin V | Outline |
|-------|-----------|-----------|----------|---------|
| hook | 72 | 8 (top-center) | 640 | 3 |
| body | 48 | 8 (top-center) | 768 | 2 |
| label | 36 | 1 (bottom-left) | 120 | 2 |
| credit | 28 | 2 (bottom-center) | 60 | 1 |

Font sizes are scaled by `canvas_height / 660` (preview reference height).

**Karaoke styles:**

| Style | ASS Implementation |
|-------|-------------------|
| `classic` | `\kf` tags for smooth color fill |
| `pop` | `\kf` + `\t` scale animation (100% -> 125% -> 100%) |
| `typewriter` | `\alpha` transitions from invisible to visible per word |
| `bounce` | `\kf` + `\fad(0,100)` fade-out tail |
| `normal` | `\k` tags with explicit color swaps per word |

### `backend/services/embeddings.py`

**Model:** `all-MiniLM-L6-v2` (sentence-transformers), 384-dimensional vectors.

**Key functions:**

| Function | Signature | Description |
|----------|-----------|-------------|
| `encode_text` | `(text: str) -> np.ndarray` | Encode single string to 384-dim float32 |
| `encode_texts` | `(texts: list[str]) -> list[np.ndarray]` | Batch encode, batch_size=32 |
| `cosine_similarity` | `(a, b) -> float` | Cosine similarity between two vectors |
| `embed_clip` | `(clip_id: str) -> None` | Build text from clip metadata + segments, embed, store as LargeBinary |
| `embed_all_clips` | `() -> dict` | Batch embed clips with `embedding IS NULL` and `title_en IS NOT NULL` |
| `search_by_embedding` | `(query, limit, category?) -> list[dict]` | Semantic search: encode query, compare against all clip embeddings |
| `unload_model` | `() -> None` | Free model memory |

**Clip text construction:** Concatenates `title_en + summary_en + segment descriptions` into a single string for embedding.

Idle timeout: 300 seconds (auto-unloads model).

### `backend/services/matcher.py`

**Key function:** `match_broll(project_id: str, max_broll: int | None) -> list[dict]`

**Algorithm:**

1. **Phrase grouping:** Split transcript words into phrases (pause > 0.8s or 8+ words triggers split)
2. **Keyword extraction:** Remove stop words from each phrase
3. **Candidate search:** For each phrase, search library with `search_clips(query=keywords, limit=50)`
4. **Embedding rerank:** If embeddings exist, compute cosine similarity and combine: `combined_score = keyword_score + embedding_similarity * 10`
5. **Diversity scoring:** Multiply score by `0.5^(prior_uses)` to penalize reuse
6. **Dedup window:** Skip clips used in the last 3 selections
7. **Pacing rules:**
   - Skip first 2 seconds (hook period, unless audio-only)
   - Minimum gap between B-Roll: 2 seconds
   - Maximum 3 consecutive B-Roll clips
   - Score thresholds: keyword >= 2, embedding >= 0.3
   - Max duration: 5s (dynamic), 3s (static)
8. **Gap filling (audio-only):** Extends clips to fill gaps so no black screen appears
9. **Gap closing:** If gap between adjacent B-Roll is <= 2s, extend previous clip to close it
10. **Timeline creation:** Deletes existing timeline, creates clip_a at position 0, B-Roll items at positions 1..N

**Other function:** `get_alternatives(project_id, item_id, limit) -> list[dict]`
- Finds words around the timeline item's time range (+/- 1s)
- Searches library with extracted keywords
- Reranks with embeddings
- Returns top N alternatives excluding current clip

### `backend/services/vision.py`

**Key function:** `analyze_clip(clip_id: str) -> dict`

- For video: extracts frames at 2 FPS via FFmpeg, max 20 frames, scaled to 720px width
- For image: reads and base64-encodes directly
- Sends to Ollama MiniCPM-V model with structured JSON prompt
- Parses response (with JSON repair for truncated output)
- Updates clip record: title, summary, is_dynamic, focus_point, tags
- Creates ClipSegment records for temporal segments
- Retries once with simplified prompt on failure
- Schedules Ollama model unload after 60s idle

**Batch function:** `analyze_clips_batch(clip_ids: list[str]) -> dict`
- Sequential processing (VRAM constraint)
- Progress tracking with cancellation support
- Warm-up call before first clip to pre-load model
- Request timeout: 600 seconds per clip

**Model unload:** `unload_ollama_model()` sends `keep_alive: 0` to Ollama `/api/generate`

### `backend/services/categorizer.py`

**Key function:** `categorize_clip(clip_id: str) -> str`

1. Extract keywords from clip's title, summary, and tags
2. Score each existing category by keyword overlap
3. If a match found (score > 0): assign to existing category
4. Otherwise: generate new category name from title or tags, create Category record
5. Move clip file to `data/library/{category}/` directory
6. Update category clip counts

Category name format: lowercase hyphenated slug derived from the most distinctive 2-3 words in the title.

### `backend/services/search.py`

**Key function:** `search_clips(query, category?, clip_type?, is_dynamic?, limit, offset) -> dict`

**Weighted keyword scoring:**

| Field | Points per keyword match |
|-------|------------------------|
| title_en, title_pl | 3 |
| summary_en, summary_pl | 2 |
| tags (JSON array) | 2 |
| category | 1 |
| segment descriptions | 1 per segment |

Results sorted by total score descending. Empty query returns all clips ordered by `created_at desc`.

**Other function:** `get_clip_stats() -> dict` -- Returns total clips, segments, categories, clips by category/type, total duration.

### `backend/services/thumbnails.py`

**Key function:** `generate_thumbnail(clip_id: str, db?) -> str`

- Video: extract frame at 50% duration, scale to 320x180 with aspect ratio padding
- Image: resize to 320x180 with aspect ratio padding
- Output: `data/thumbnails/{clip_id}.jpg`
- Also: `regenerate_all_thumbnails() -> int`

---

## 6. Frontend Reference

### Pages

| Page | Route | Key State | Description |
|------|-------|-----------|-------------|
| `Dashboard` | `/` | Project list, sort/filter, create modal | Lists projects with thumbnails, status badges. Supports duplicate, export, import, delete. Sort by date/name/status. Filter by status. |
| `Editor` | `/editor/:projectId` | Project, subtitles, timeline, preview time | Main editing workspace. Sections: video preview with karaoke overlay, transcript display, subtitle editor, timeline, B-Roll matching, render controls. |
| `Library` | `/library` | Clips, categories, search, pagination | Grid of clip cards with thumbnails. Search, category filter, type filter. Import (file/folder), analyze, categorize, embed actions. Batch operations. |

### Key Components

| Component | Props/Key State | Description |
|-----------|-----------------|-------------|
| `Timeline` | timeline items, duration, zoom, snap config | Horizontal scrollable timeline with drag-and-drop blocks. Zoom control, snap-to-grid, position indicators. B-Roll blocks show clip names. |
| `TimelineBlock` | item, duration, zoom, selected | Individual timeline block. Draggable, resizable trim handles (left/right edges). Color-coded by source type. |
| `SubtitleEditor` | subtitles, selected subtitle | List of subtitle entries with inline text editing, timing adjustment, style controls (font size, color, outline, highlight, karaoke style, position). Bulk operations. |
| `SubtitleTrack` | subtitles, duration | Horizontal visualization of subtitle timing below the timeline. |
| `VideoPreview` | project, current time | Video player with time display. Syncs with timeline cursor. |
| `KaraokeOverlay` | subtitles, current time | Renders karaoke word highlighting over the video preview in real-time. Matches the 5 karaoke styles. |
| `RenderProgress` | project ID | WebSocket-connected progress bar with ETA. Shows stage name (preparing, encoding, subtitles, done). |
| `ClipCard` | clip | Thumbnail, title, duration badge, category tag, favorite button. Click opens detail. |
| `ClipDetail` | clip | Full metadata display, edit fields, segment list, usage info. Analyze/categorize/embed actions. |
| `ClipReplacer` | timeline item | Shows alternatives for a B-Roll slot. Click to swap clip. |
| `EditorLibraryPanel` | -- | In-editor library panel for drag-dropping clips onto timeline. |
| `ImportDialog` | -- | Project import from JSON file upload. |
| `ProjectSetup` | -- | Initial project setup wizard (name, format). |

### State Management

- **React Query** (`@tanstack/react-query`) for server state (projects, clips, subtitles, timeline)
- **Local React state** for UI state (selection, zoom, modals, preview time)
- **Custom hooks:** `useTimeline` for timeline drag/drop, zoom, snap logic

### Routing

| Route | Page |
|-------|------|
| `/` | Dashboard |
| `/editor/:projectId` | Editor |
| `/library` | Library |

---

## 7. Configuration Reference

All configuration is in `backend/config.py`. Environment variables override defaults.

### Paths

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `PROJECT_ROOT` | Path | Auto-detected | Parent of `backend/` |
| `DATA_DIR` | Path | `{PROJECT_ROOT}/data` | Root data directory |
| `LIBRARY_DIR` | Path | `{DATA_DIR}/library` | B-Roll clip storage |
| `PROJECTS_DIR` | Path | `{DATA_DIR}/projects` | Per-project storage |
| `THUMBNAILS_DIR` | Path | `{DATA_DIR}/thumbnails` | Clip thumbnail storage |
| `DB_PATH` | Path | `{DATA_DIR}/reelforge.db` | SQLite database file |

### Server

| Parameter | Env Var | Default | Description |
|-----------|---------|---------|-------------|
| `HOST` | `REELFORGE_HOST` | `"0.0.0.0"` | Bind address |
| `PORT` | `REELFORGE_PORT` | `8000` | Bind port |
| `DATABASE_URL` | -- | `sqlite:///{DB_PATH}` | SQLAlchemy connection string |

### Whisper (Transcription)

| Parameter | Env Var | Default | Description |
|-----------|---------|---------|-------------|
| `WHISPER_MODEL` | `WHISPER_MODEL` | `"large-v3"` | faster-whisper model name |
| `WHISPER_DEVICE` | `WHISPER_DEVICE` | `"auto"` | `"auto"`, `"cuda"`, or `"cpu"` |
| `WHISPER_COMPUTE_TYPE` | `WHISPER_COMPUTE_TYPE` | `"int8_float16"` | Quantization type |
| `WHISPER_BEAM_SIZE` | `WHISPER_BEAM_SIZE` | `1` | Beam search width |
| `WHISPER_IDLE_TIMEOUT` | `WHISPER_IDLE_TIMEOUT` | `300` | Seconds before auto-unloading model |

### Ollama (Vision)

| Parameter | Env Var | Default | Description |
|-----------|---------|---------|-------------|
| `OLLAMA_HOST` | `OLLAMA_HOST` | `"http://localhost:11434"` | Ollama API base URL |
| `VISION_MODEL` | `VISION_MODEL` | `"minicpm-v:8b"` | Model name for vision + text tasks |

### FFmpeg / Render

| Parameter | Default | Description |
|-----------|---------|-------------|
| `FONT_PATH` | `/home/beba/reels/fonts/Montserrat-Bold.ttf` | Font for ASS subtitles |
| `FONT_NAME` | `"Montserrat Bold"` | ASS font name |
| `TARGET_WIDTH` | `1080` | Default output width (px) |
| `TARGET_HEIGHT` | `1920` | Default output height (px) |
| `TARGET_FPS` | `30` | Output frame rate |
| `DRAFT_CRF` | `28` | H.264 CRF for draft renders |
| `DRAFT_PRESET` | `"ultrafast"` | x264 preset for draft renders |
| `FINAL_CRF` | `18` | H.264 CRF for final renders |
| `FINAL_PRESET` | `"fast"` | x264 preset for final renders |

### Allowed Upload Extensions

| Type | Extensions |
|------|-----------|
| Video | `.mp4`, `.mov`, `.avi`, `.mkv`, `.webm` |
| Audio | `.mp3`, `.m4a`, `.wav`, `.ogg`, `.flac` |
| Image | `.jpg`, `.jpeg`, `.png`, `.heic`, `.webp` |

---

## 8. FFmpeg Commands

### Audio Extraction (Transcription)

```bash
ffmpeg -y -i {input} -ar 16000 -ac 1 -f wav {output.wav}
```

Converts any media to 16kHz mono WAV for whisper processing.

### Audio Chunking

```bash
ffmpeg -y -i {input.wav} -map 0:a:0 -f segment -segment_time 300 -c:a pcm_s16le {part_%03d.wav}
```

Splits long audio into 5-minute WAV chunks.

### Clip Preprocessing (with audio)

```bash
ffmpeg -y -i {src} \
  -vf "trim=start={start}:end={end},setpts=PTS-STARTPTS,\
       setpts={1/speed}*PTS,\
       crop={w}:{h}:{x}:{y},\
       scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,\
       pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,\
       fps={target_fps}" \
  -af "atrim=start={start}:end={end},asetpts=PTS-STARTPTS,atempo={speed}" \
  -c:v libx264 -crf {crf} -preset {preset} \
  -c:a aac -b:a 128k -ar 44100 -ac 2 \
  -movflags +faststart {output.mp4}
```

### Clip Preprocessing (strip audio, for B-Roll)

```bash
ffmpeg -y -i {src} -f lavfi -i anullsrc=r=44100:cl=stereo \
  -vf "{same vf chain}" \
  -map 0:v -map 1:a \
  -c:v libx264 -crf {crf} -preset {preset} \
  -c:a aac -b:a 128k -shortest \
  -movflags +faststart {output.mp4}
```

Replaces original audio with silence so only the main clip_a audio plays.

### Gradient Background (Audio-Only Projects)

```bash
ffmpeg -y \
  -f lavfi -i "color=c=0x1a1a2e:s={w}x{h}:d={duration}" \
  -i {audio} \
  -c:v libx264 -crf {crf} -preset {preset} \
  -c:a aac -b:a 128k -shortest \
  -movflags +faststart {output.mp4}
```

Dark navy gradient background for audio-only inputs.

### Gap Filler (Solid Color Segment)

```bash
ffmpeg -y \
  -f lavfi -i "color=c=0x1a1a2e:s={w}x{h}:d={duration}:r={fps}" \
  -f lavfi -i "anullsrc=r=44100:cl=stereo" \
  -c:v libx264 -crf {crf} -preset {preset} \
  -c:a aac -b:a 128k -shortest \
  -movflags +faststart {output.mp4}
```

### Timeline Concatenation

```bash
# Write concat list
echo "file 'segment_001.mp4'" > concat.txt
echo "file 'segment_002.mp4'" >> concat.txt
...

# Concat (stream copy, no re-encode)
ffmpeg -y -f concat -safe 0 -i concat.txt -c copy -movflags +faststart {output.mp4}
```

### Audio Mixing (Replace B-Roll Audio with Clip A Audio)

```bash
ffmpeg -y -i {concat_video.mp4} -i {clip_a} \
  -map 0:v:0 -map 1:a:0 \
  -c:v copy -c:a aac -b:a 128k -shortest \
  -movflags +faststart {output.mp4}
```

### Background Music Mix

```bash
ffmpeg -y -i {video} -stream_loop -1 -i {music} \
  -filter_complex "[1:a]volume={vol}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[a]" \
  -map 0:v -map "[a]" \
  -c:v copy -c:a aac -b:a 128k -shortest \
  -movflags +faststart {output.mp4}
```

Music loops indefinitely, mixed at user-defined volume level.

### ASS Subtitle Overlay

```bash
ffmpeg -y -i {video} \
  -vf "ass={ass_path}:fontsdir={font_dir}" \
  -c:v libx264 -crf {crf} -preset {preset} \
  -c:a copy -movflags +faststart {output.mp4}
```

### Thumbnail Extraction

```bash
# Video thumbnail (at 50% duration)
ffmpeg -y -ss {seek_time} -i {video} -vframes 1 \
  -vf "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:black" \
  -q:v 5 {output.jpg}

# Project thumbnail (from rendered output)
ffmpeg -y -ss {seek_time} -i {video} -vframes 1 -vf "scale=320:-1" -q:v 5 {output.jpg}
```

### Waveform Image

```bash
ffmpeg -y -i {clip_a} \
  -filter_complex "compand,aformat=channel_layouts=mono,showwavespic=s=800x100:colors=8b5cf6" \
  -frames:v 1 {output.png}
```

### Vision Frame Extraction

```bash
ffmpeg -y -i {video} -vf "fps=2,scale=720:-1" -vframes 20 -q:v 5 {frame_%04d.jpg}
```

---

## 9. AI Models

### faster-whisper (large-v3)

| Property | Value |
|----------|-------|
| Purpose | Speech-to-text transcription with word-level timestamps |
| Model | `large-v3` (configurable via `WHISPER_MODEL`) |
| Framework | CTranslate2 via faster-whisper |
| Input | 16kHz mono WAV audio |
| Output | `[{word: str, start: float, end: float}, ...]` |
| VRAM | ~4-6 GB (int8_float16 quantization) |
| Idle unload | After 300s (configurable via `WHISPER_IDLE_TIMEOUT`) |
| Loading | Singleton with thread lock, lazy on first transcription |
| Beam size | 1 (configurable) |

### MiniCPM-V 8B (via Ollama)

| Property | Value |
|----------|-------|
| Purpose | Vision analysis (clip description, segmentation, tagging) and text tasks (translation, subtitle polishing) |
| Model | `minicpm-v:8b` (configurable via `VISION_MODEL`) |
| Framework | Ollama server (HTTP API) |
| Input | Base64-encoded JPEG frames + text prompt |
| Output | JSON with title, summary, tags, segments, focus point |
| VRAM | ~8-10 GB |
| Idle unload | After 60s via `keep_alive: 0` to Ollama `/api/generate` |
| Request timeout | 600s for vision, 60s for text-only tasks |
| Temperature | 0.1 (vision), 0.2 (translation), 0.3 (polishing) |
| Context | 4096 tokens |
| Warm-up | 1-token generation with tiny image before batch |

### sentence-transformers (all-MiniLM-L6-v2)

| Property | Value |
|----------|-------|
| Purpose | Semantic text embeddings for B-Roll matching |
| Model | `all-MiniLM-L6-v2` |
| Framework | sentence-transformers (PyTorch) |
| Input | Text string |
| Output | 384-dimensional float32 numpy array |
| VRAM | ~0.1 GB (can run on CPU) |
| Idle unload | After 300s (`IDLE_TIMEOUT`) |
| Storage | Embeddings stored as LargeBinary (1536 bytes per clip) in SQLite |
| Batch size | 32 |

---

## 10. File Storage

### `data/projects/{project_id}/`

Per-project directory. Created on project creation.

| File | Purpose |
|------|---------|
| `input.{ext}` | Uploaded source media (clip A) |
| `music.{ext}` | Background music file (optional) |
| `draft.mp4` | Draft render output |
| `final.mp4` | Final render output |
| `thumbnail.jpg` | Project thumbnail (from rendered output) |
| `waveform.png` | Cached waveform image (800x100) |
| `render_history.json` | JSON array of render history entries (max 5) |
| `history/` | Directory of archived render files |

### `data/library/`

B-Roll clip storage. Files organized by category after categorization.

| Directory | Purpose |
|-----------|---------|
| `_unsorted/` | Default landing for new imports |
| `{category-name}/` | Category directories (created by categorizer) |

Files are moved between directories when categorized. Filenames preserved; collisions resolved by appending `_{uuid8}`.

### `data/thumbnails/`

| Pattern | Purpose |
|---------|---------|
| `{clip_id}.jpg` | Clip thumbnail (320x180 JPEG, q=5) |

### `data/reelforge.db`

SQLite database. WAL journal mode for concurrent reads during writes. Foreign keys enforced via PRAGMA.

### Naming Conventions

- **Project IDs:** 32-character hex strings (`uuid4().hex`)
- **Clip IDs:** Same format
- **Category slugs:** Lowercase alphanumeric with hyphens (e.g., `metal-workshop`, `aerial-drone`)
- **File paths in DB:** Clips store paths relative to `LIBRARY_DIR`; projects store absolute paths
