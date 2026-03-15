export interface Project {
  id: string
  name: string
  status: string
  clip_a_path: string | null
  clip_a_type: string | null
  transcript_json: string | null
  duration: number | null
  output_format: string
  output_path: string | null
  draft_path: string | null
  thumbnail_path: string | null
  music_path: string | null
  music_volume: number
  created_at: string
  updated_at: string
  subtitle_count?: number
  timeline_item_count?: number
}

export type KaraokeStyle = 'normal' | 'classic' | 'pop' | 'typewriter' | 'bounce'

export interface Subtitle {
  id: number
  project_id: string
  text: string
  start_time: number
  end_time: number
  style: string
  position_x: number
  position_y: number
  font_size: number | null
  color: string
  words_json: string | null
  karaoke_style?: KaraokeStyle
  outline_color?: string
  highlight_color?: string
  language?: string
}

export interface Word {
  word: string
  start: number
  end: number
}

export interface TimelineItem {
  id: number
  project_id: string
  clip_id: string | null
  source_type: string
  source_path: string | null
  position: number
  timeline_start: number
  timeline_end: number
  clip_trim_start: number
  clip_trim_end: number | null
  speed: number
  transition_in: string
  transition_duration: number
  clip_title: string | null
  clip_type: string | null
}

// B-Roll Library types

export interface Clip {
  id: string
  filename: string
  filepath: string
  category: string | null
  type: 'video' | 'image'
  title_en: string | null
  title_pl: string | null
  summary_en: string | null
  summary_pl: string | null
  duration: number | null
  fps: number | null
  width: number | null
  height: number | null
  is_dynamic: boolean
  focus_x: number
  focus_y: number
  thumbnail_path: string | null
  tags: string | null  // JSON array
  created_at: string
  imported_at: string | null
  is_favorite: boolean
  segments?: ClipSegment[]
}

export interface ClipSegment {
  id: number
  clip_id: string
  start_time: number
  end_time: number
  description_en: string | null
  description_pl: string | null
}

export interface Category {
  name: string
  display_name: string | null
  clip_count: number
}

export interface LibrarySearchResult {
  results: Array<{
    clip: Clip
    score: number
    matching_segments: ClipSegment[]
  }>
  total: number
  offset: number
  limit: number
}

export interface Alternative {
  clip: Clip
  score: number
  reason: string
}

export interface LibraryStats {
  total_clips: number
  total_segments: number
  total_categories: number
  clips_by_category: Array<{ name: string; count: number }>
  clips_by_type: { video: number; image: number }
  total_duration: number
}

// === Library Feature Types ===

export interface ClipUsageProject {
  id: string
  name: string
}

export interface ClipUsageResponse {
  clip_id: string
  usage_count: number
  projects: ClipUsageProject[]
}

export type SortOption = 'date_newest' | 'date_oldest' | 'name_az' | 'name_za'

// === Subtitle Feature Types ===

export interface SubtitleTemplate {
  id: string
  name: string
  karaokeStyle: string
  preset: string
  fontSize: number
  color: string
  outlineColor: string
  highlightColor: string
  positionY: number
}

// === Toast & Dashboard Types ===

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface ToastItem {
  id: string
  type: ToastType
  message: string
  duration: number
}

export type DashboardSortOption =
  | 'created_desc'
  | 'created_asc'
  | 'name_asc'
  | 'name_desc'
  | 'status'
  | 'updated_desc'

export type DashboardStatusFilter =
  | 'all'
  | 'draft'
  | 'uploaded'
  | 'transcribed'
  | 'rendered'
  | 'error'

// === Timeline Feature Types ===

export interface TrimDragState {
  itemId: number
  edge: 'left' | 'right'
  startX: number
  originalTrimStart: number
  originalTrimEnd: number | null
  originalDuration: number
  blockWidthPx: number
}

export type SnapInterval = 0.1 | 0.5 | 1

export interface SnapConfig {
  enabled: boolean
  interval: SnapInterval
}

// === Editor Feature Types ===

export interface KeyboardShortcutDef {
  keys: string[]
  description: string
}

export interface UndoRedoAction {
  type: string
  description: string
  undo: () => Promise<void>
  redo: () => Promise<void>
}

export type EditorErrorState = {
  transcribe: string | null
  render: string | null
  subtitles: string | null
}

// === Preview & Render Types ===

export interface RenderHistoryEntry {
  id: string
  timestamp: string
  format: string
  duration_sec: number | null
  file_size_bytes: number | null
  filename: string
}

export interface RenderHistoryResponse {
  entries: RenderHistoryEntry[]
}

// === AI & Language Types ===

export type PolishMode = 'grammar' | 'punchier' | 'shorter'

export interface PolishResponse {
  subtitle_id: number
  original_text: string
  polished_text: string
  mode: PolishMode
}

export interface BulkPolishResult {
  id: number
  original_text: string
  polished_text: string
}

export interface BulkPolishResponse {
  mode: PolishMode
  results: BulkPolishResult[]
  total: number
}

export interface SubtitleLanguagesResponse {
  languages: string[]
}

export interface TranslateSubtitlesResponse {
  project_id: string
  target_language: string
  translated_count: number
}
