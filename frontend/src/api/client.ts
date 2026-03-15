import type { Project, Subtitle, Word, Clip, Category, LibraryStats, TimelineItem, Alternative, ClipUsageResponse, RenderHistoryResponse, PolishMode, PolishResponse, BulkPolishResponse, SubtitleLanguagesResponse, TranslateSubtitlesResponse } from '@/types'

const BASE = ''

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || res.statusText)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  // Projects
  listProjects: () => request<Project[]>('/api/projects'),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  createProject: (data: { name: string; output_format?: string }) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(data) }),
  deleteProject: (id: string) =>
    request<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  duplicateProject: (id: string) =>
    request<Project>(`/api/projects/${id}/duplicate`, { method: 'POST' }),
  exportProject: async (id: string) => {
    const res = await fetch(`/api/projects/${id}/export`)
    if (!res.ok) throw new Error('Export failed')
    const data = await res.json()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${data.name || 'project'}.json`
    a.click()
    URL.revokeObjectURL(url)
    return data
  },
  importProject: (data: Record<string, unknown>) =>
    request<Project>('/api/projects/import', { method: 'POST', body: JSON.stringify(data) }),
  getProjectThumbnail: (id: string) => `/api/projects/${id}/thumbnail`,
  uploadClipA: async (projectId: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`/api/projects/${projectId}/upload`, { method: 'POST', body: form })
    if (!res.ok) throw new Error('Upload failed')
    return res.json() as Promise<Project>
  },

  // AI
  transcribe: (projectId: string) =>
    request<{ status: string }>(`/api/projects/${projectId}/transcribe`, { method: 'POST' }),
  getTranscript: (projectId: string) =>
    request<{ transcript: Word[] | null }>(`/api/projects/${projectId}/transcript`),
  generateSubtitles: (projectId: string) =>
    request<{ count: number }>(`/api/projects/${projectId}/generate-subtitles`, { method: 'POST' }),

  // Subtitles
  listSubtitles: (projectId: string, language?: string) => {
    const qs = language ? `?language=${encodeURIComponent(language)}` : ''
    return request<Subtitle[]>(`/api/projects/${projectId}/subtitles${qs}`)
  },
  createSubtitle: (projectId: string, data: Partial<Subtitle>) =>
    request<Subtitle>(`/api/projects/${projectId}/subtitles`, {
      method: 'POST', body: JSON.stringify(data),
    }),
  updateSubtitle: (projectId: string, subtitleId: number, data: Partial<Subtitle>) =>
    request<Subtitle>(`/api/projects/${projectId}/subtitles/${subtitleId}`, {
      method: 'PUT', body: JSON.stringify(data),
    }),
  deleteSubtitle: (projectId: string, subtitleId: number) =>
    request<void>(`/api/projects/${projectId}/subtitles/${subtitleId}`, {
      method: 'DELETE',
    }),
  bulkUpdatePosition: (projectId: string, positionY: number) =>
    request<Subtitle[]>(`/api/projects/${projectId}/subtitles/bulk-position`, {
      method: 'PUT', body: JSON.stringify({ position_y: positionY }),
    }),
  bulkUpdateStyle: (projectId: string, data: Record<string, unknown>) =>
    request<{ updated: number }>(`/api/projects/${projectId}/subtitles/bulk-style`, {
      method: 'PUT', body: JSON.stringify(data),
    }),

  // Render
  triggerRender: (projectId: string, draft = true) =>
    request<{ status: string }>(`/api/projects/${projectId}/render`, {
      method: 'POST', body: JSON.stringify({ draft }),
    }),
  getRenderStatus: (projectId: string) =>
    request<{ status: string; draft_path?: string; output_path?: string }>(
      `/api/projects/${projectId}/render/status`
    ),

  // Clips / Library
  listClips: (params?: { q?: string; category?: string; type?: string; is_dynamic?: boolean; limit?: number; offset?: number }) => {
    const search = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') search.set(k, String(v))
      })
    }
    const qs = search.toString()
    return request<{ items: Clip[]; total: number }>(`/api/clips${qs ? '?' + qs : ''}`)
  },
  getClip: (id: string) => request<Clip>(`/api/clips/${id}`),
  updateClip: (id: string, data: Partial<Clip>) =>
    request<Clip>(`/api/clips/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteClip: (id: string) =>
    request<void>(`/api/clips/${id}`, { method: 'DELETE' }),
  deleteClipsBulk: (clipIds: string[]) =>
    request<{ deleted: number; errors: string[] }>('/api/clips/delete-bulk', {
      method: 'POST', body: JSON.stringify({ clip_ids: clipIds }),
    }),
  uploadClip: async (file: File) => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/clips/import', { method: 'POST', body: form })
    if (!res.ok) throw new Error('Upload failed')
    return res.json() as Promise<Clip>
  },
  uploadClipsBulk: async (files: File[]) => {
    const form = new FormData()
    files.forEach(f => form.append('files', f))
    const res = await fetch('/api/clips/import-bulk', { method: 'POST', body: form })
    if (!res.ok) throw new Error('Bulk upload failed')
    return res.json()
  },
  importFolder: (path: string, recursive = false) =>
    request<{ imported: number; skipped: number; errors: number }>('/api/clips/import-folder', {
      method: 'POST', body: JSON.stringify({ path, recursive }),
    }),
  listCategories: () => request<Category[]>('/api/clips/categories/list'),
  analyzeClip: (id: string) =>
    request<{ status: string }>(`/api/clips/${id}/analyze`, { method: 'POST' }),
  categorizeClip: (id: string) =>
    request<{ category: string }>(`/api/clips/${id}/categorize`, { method: 'POST' }),
  analyzeAllUnanalyzed: () =>
    request<{ status: string }>('/api/clips/analyze-batch', {
      method: 'POST', body: JSON.stringify({ all_unanalyzed: true }),
    }),
  getAnalyzeProgress: () =>
    request<{ status: string; current: number; total: number; current_clip: string; success: number; failed: number }>(
      '/api/clips/analyze-progress'
    ),
  cancelAnalyze: () =>
    request<{ status: string }>('/api/clips/analyze-cancel', { method: 'POST' }),
  categorizeAllUncategorized: () =>
    request<{ status: string }>('/api/clips/categorize-batch', {
      method: 'POST', body: JSON.stringify({ all_uncategorized: true }),
    }),
  getLibraryStats: () => request<LibraryStats>('/api/library/stats'),

  // Timeline
  listTimeline: (projectId: string) =>
    request<TimelineItem[]>(`/api/projects/${projectId}/timeline`),
  addTimelineItem: (projectId: string, item: Partial<TimelineItem>) =>
    request<TimelineItem>(`/api/projects/${projectId}/timeline`, {
      method: 'POST', body: JSON.stringify(item),
    }),
  updateTimelineItem: (projectId: string, itemId: number, data: Partial<TimelineItem>) =>
    request<TimelineItem>(`/api/projects/${projectId}/timeline/${itemId}`, {
      method: 'PUT', body: JSON.stringify(data),
    }),
  deleteTimelineItem: (projectId: string, itemId: number) =>
    request<void>(`/api/projects/${projectId}/timeline/${itemId}`, { method: 'DELETE' }),
  reorderTimeline: (projectId: string, items: { id: number; position: number }[]) =>
    request<{ status: string }>(`/api/projects/${projectId}/timeline/reorder`, {
      method: 'PUT', body: JSON.stringify({ items }),
    }),

  // B-Roll Matching
  matchBroll: (projectId: string, maxBroll?: number) =>
    request<{ status: string; matched: number }>(`/api/projects/${projectId}/match-broll`, {
      method: 'POST',
      body: maxBroll !== undefined ? JSON.stringify({ max_broll: maxBroll }) : undefined,
    }),
  getAlternatives: (projectId: string, itemId: number) =>
    request<Alternative[]>(`/api/projects/${projectId}/timeline/${itemId}/alternatives`),

  // Embeddings
  embedAllClips: () =>
    request<{ status: string }>('/api/clips/embed-all', { method: 'POST' }),
  embedClip: (clipId: string) =>
    request<{ status: string }>(`/api/clips/${clipId}/embed`, { method: 'POST' }),

  // === Library Features ===

  // Favorites
  toggleFavorite: (clipId: string) =>
    request<{ id: string; is_favorite: boolean }>(`/api/clips/${clipId}/favorite`, { method: 'PUT' }),

  // Usage tracking
  getClipUsage: (clipId: string) =>
    request<ClipUsageResponse>(`/api/clips/${clipId}/usage`),

  // === Timeline Features: Waveform + Music ===

  // Waveform: returns URL to waveform PNG image
  getWaveformUrl: (projectId: string) => `/api/projects/${projectId}/waveform`,

  // Background music upload
  uploadMusic: async (projectId: string, file: File) => {
    const form = new FormData()
    form.append('file', file)
    const res = await fetch(`/api/projects/${projectId}/upload-music`, { method: 'POST', body: form })
    if (!res.ok) throw new Error('Music upload failed')
    return res.json() as Promise<Project>
  },

  // Update music volume
  updateMusicVolume: (projectId: string, volume: number) =>
    request<Project>(`/api/projects/${projectId}/music-volume`, {
      method: 'PUT',
      body: JSON.stringify({ music_volume: volume }),
    }),

  // Remove background music
  removeMusic: (projectId: string) =>
    request<Project>(`/api/projects/${projectId}/music`, { method: 'DELETE' }),

  // === Render History ===

  getRenderHistory: (projectId: string) =>
    request<RenderHistoryResponse>(`/api/projects/${projectId}/render/history`),

  getRenderHistoryDownloadUrl: (projectId: string, renderId: string) =>
    `/api/projects/${projectId}/render/history/${renderId}/download`,

  // === AI Language & Polish ===

  // List distinct subtitle language codes for a project
  listSubtitleLanguages: (projectId: string) =>
    request<SubtitleLanguagesResponse>(`/api/projects/${projectId}/subtitles/languages`),

  // List subtitles filtered by language
  listSubtitlesByLanguage: (projectId: string, language: string) =>
    request<Subtitle[]>(`/api/projects/${projectId}/subtitles?language=${encodeURIComponent(language)}`),

  // Translate subtitles to a target language
  translateSubtitles: (projectId: string, targetLanguage: string, sourceLanguage = 'en') =>
    request<TranslateSubtitlesResponse>(`/api/projects/${projectId}/translate-subtitles`, {
      method: 'POST',
      body: JSON.stringify({ target_language: targetLanguage, source_language: sourceLanguage }),
    }),

  // AI-polish a single subtitle (returns polished text, does NOT auto-save)
  polishSubtitle: (projectId: string, subtitleId: number, mode: PolishMode) =>
    request<PolishResponse>(`/api/projects/${projectId}/subtitles/${subtitleId}/polish`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    }),

  // Bulk-polish multiple subtitles (returns list of {id, original_text, polished_text})
  bulkPolishSubtitles: (projectId: string, mode: PolishMode, subtitleIds?: number[]) =>
    request<BulkPolishResponse>(`/api/projects/${projectId}/subtitles/polish-all`, {
      method: 'POST',
      body: JSON.stringify({ mode, subtitle_ids: subtitleIds ?? null }),
    }),
}
