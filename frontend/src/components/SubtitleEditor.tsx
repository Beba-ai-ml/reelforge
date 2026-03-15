import { useState, useCallback, useRef } from 'react'
import {
  Check,
  Pencil,
  ChevronDown,
  ChevronUp,
  Scissors,
  Merge,
  Settings,
  GripVertical,
  Trash2,
  Clock,
  Paintbrush,
  Replace,
} from 'lucide-react'
import type { Subtitle, KaraokeStyle, Word, SubtitleTemplate, BulkPolishResult } from '@/types'
import { api } from '@/api/client'
import SubtitleTemplates from './SubtitleTemplates'
import SubtitlePositionGrid from './SubtitlePositionGrid'
import LanguageSelector from './LanguageSelector'
import { SubtitlePolishButtons, BulkPolishToolbar } from './SubtitlePolishButtons'

interface Props {
  subtitles: Subtitle[]
  projectId: string
  onUpdate: (subtitleId: number, data: Partial<Subtitle>) => void
  onRefetch: () => void
  currentTime: number
  selectedSubtitleId?: number | null
  onSelectSubtitle?: (sub: Subtitle) => void
  activeLanguage?: string
  onLanguageChange?: (lang: string) => void
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  const cs = Math.floor((s % 1) * 100)
  return `${m}:${sec.toString().padStart(2, '0')}.${cs.toString().padStart(2, '0')}`
}

const STYLE_PRESETS: Record<string, { fontSize: number; color: string }> = {
  hook: { fontSize: 72, color: '#FACC15' },
  body: { fontSize: 48, color: '#FFFFFF' },
  label: { fontSize: 36, color: '#22D3EE' },
  credit: { fontSize: 28, color: '#9CA3AF' },
  custom: { fontSize: 48, color: '#FFFFFF' },
}

const STYLES = Object.keys(STYLE_PRESETS)

const KARAOKE_STYLES: KaraokeStyle[] = ['normal', 'classic', 'pop', 'typewriter', 'bounce']

const COLOR_SWATCHES = ['#FFFFFF', '#FACC15', '#22D3EE', '#EF4444', '#22C55E', '#8B5CF6', '#F97316']

/** Redistribute word timings proportionally when text changes */
function recalcWordsJson(
  oldWordsJson: string | null,
  newText: string,
  startTime: number,
  endTime: number
): string | null {
  if (!oldWordsJson) return null
  const newWords = newText.trim().split(/\s+/)
  if (newWords.length === 0) return null
  const duration = endTime - startTime
  const wordDuration = duration / newWords.length
  const words: Word[] = newWords.map((w, i) => ({
    word: w,
    start: startTime + i * wordDuration,
    end: startTime + (i + 1) * wordDuration,
  }))
  return JSON.stringify(words)
}

export default function SubtitleEditor({
  subtitles,
  projectId,
  onUpdate,
  onRefetch,
  currentTime,
  selectedSubtitleId,
  onSelectSubtitle,
  activeLanguage: activeLanguageProp,
  onLanguageChange: onLanguageChangeProp,
}: Props) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const [editingTimeId, setEditingTimeId] = useState<number | null>(null)
  const [editTimeField, setEditTimeField] = useState<'start' | 'end'>('start')
  const [editTimeValue, setEditTimeValue] = useState('')
  const [panelOpen, setPanelOpen] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [globalStyleOpen, setGlobalStyleOpen] = useState(false)
  const [localActiveLanguage, setLocalActiveLanguage] = useState('en')
  const activeLanguage = activeLanguageProp ?? localActiveLanguage
  const setActiveLanguage = onLanguageChangeProp ?? setLocalActiveLanguage

  // Feature 2: Batch operations state
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [shiftMs, setShiftMs] = useState('')
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [batchWorking, setBatchWorking] = useState(false)

  // Feature 4: Drag-reorder state
  const dragItemId = useRef<number | null>(null)
  const dragOverItemId = useRef<number | null>(null)
  const [dragOverId, setDragOverId] = useState<number | null>(null)

  const sorted = [...subtitles].sort((a, b) => a.start_time - b.start_time)
  const selectedSub = subtitles.find((s) => s.id === selectedSubtitleId) ?? null

  const startEdit = (sub: Subtitle) => {
    setEditingId(sub.id)
    setEditText(sub.text)
  }

  const saveEdit = useCallback(
    (sub: Subtitle) => {
      const trimmed = editText.trim()
      if (trimmed && trimmed !== sub.text) {
        const wordsJson = recalcWordsJson(sub.words_json, trimmed, sub.start_time, sub.end_time)
        onUpdate(sub.id, { text: trimmed, words_json: wordsJson })
      }
      setEditingId(null)
      setEditText('')
    },
    [editText, onUpdate]
  )

  const handleKeyDown = (e: React.KeyboardEvent, sub: Subtitle) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      saveEdit(sub)
    }
    if (e.key === 'Escape') {
      setEditingId(null)
      setEditText('')
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      saveEdit(sub)
      const idx = sorted.findIndex((s) => s.id === sub.id)
      const next = sorted[idx + 1]
      if (next) {
        onSelectSubtitle?.(next)
        startEdit(next)
      }
    }
  }

  const startTimeEdit = (sub: Subtitle, field: 'start' | 'end') => {
    setEditingTimeId(sub.id)
    setEditTimeField(field)
    setEditTimeValue(fmtTime(field === 'start' ? sub.start_time : sub.end_time))
  }

  const saveTimeEdit = (sub: Subtitle) => {
    const parsed = parseTime(editTimeValue)
    if (parsed !== null) {
      onUpdate(sub.id, { [editTimeField === 'start' ? 'start_time' : 'end_time']: parsed })
    }
    setEditingTimeId(null)
  }

  const handleStyleChange = (style: string) => {
    if (!selectedSub) return
    const preset = STYLE_PRESETS[style]
    onUpdate(selectedSub.id, {
      style,
      font_size: preset.fontSize,
      color: preset.color,
    })
  }

  const handleSyncAll = async () => {
    if (!selectedSub) return
    setSyncing(true)
    try {
      await api.bulkUpdatePosition(projectId, selectedSub.position_y)
      onRefetch()
    } finally {
      setSyncing(false)
    }
  }

  const handleSplit = async () => {
    if (!selectedSub) return
    const sub = selectedSub
    const splitTime = Math.max(sub.start_time + 0.1, Math.min(currentTime, sub.end_time - 0.1))

    let words: Word[] | null = null
    if (sub.words_json) {
      try {
        words = JSON.parse(sub.words_json) as Word[]
      } catch {
        /* skip */
      }
    }

    let text1 = sub.text
    let text2 = ''
    let words1Json: string | null = null
    let words2Json: string | null = null

    if (words && words.length > 1) {
      const splitIdx = words.findIndex((w) => w.start >= splitTime)
      const idx = splitIdx === -1 ? words.length : Math.max(1, splitIdx)
      const w1 = words.slice(0, idx)
      const w2 = words.slice(idx)
      text1 = w1.map((w) => w.word).join(' ')
      text2 = w2.map((w) => w.word).join(' ')
      words1Json = JSON.stringify(w1)
      words2Json = w2.length > 0 ? JSON.stringify(w2) : null
    } else {
      const allWords = sub.text.split(/\s+/)
      const mid = Math.max(1, Math.ceil(allWords.length / 2))
      text1 = allWords.slice(0, mid).join(' ')
      text2 = allWords.slice(mid).join(' ')
    }

    if (!text2) text2 = text1

    await api.deleteSubtitle(projectId, sub.id)
    await api.createSubtitle(projectId, {
      text: text1,
      start_time: sub.start_time,
      end_time: splitTime,
      style: sub.style,
      position_x: sub.position_x,
      position_y: sub.position_y,
      font_size: sub.font_size,
      color: sub.color,
      karaoke_style: sub.karaoke_style,
      outline_color: sub.outline_color,
      highlight_color: sub.highlight_color,
      words_json: words1Json,
    })
    await api.createSubtitle(projectId, {
      text: text2,
      start_time: splitTime,
      end_time: sub.end_time,
      style: sub.style,
      position_x: sub.position_x,
      position_y: sub.position_y,
      font_size: sub.font_size,
      color: sub.color,
      karaoke_style: sub.karaoke_style,
      outline_color: sub.outline_color,
      highlight_color: sub.highlight_color,
      words_json: words2Json,
    })
    onRefetch()
  }

  const handleMerge = async () => {
    if (!selectedSub) return
    const idx = sorted.findIndex((s) => s.id === selectedSub.id)
    if (idx < 0 || idx >= sorted.length - 1) return
    const sub1 = sorted[idx]
    const sub2 = sorted[idx + 1]

    const mergedText = `${sub1.text} ${sub2.text}`
    const startTime = Math.min(sub1.start_time, sub2.start_time)
    const endTime = Math.max(sub1.end_time, sub2.end_time)

    let mergedWordsJson: string | null = null
    if (sub1.words_json && sub2.words_json) {
      try {
        const w1 = JSON.parse(sub1.words_json) as Word[]
        const w2 = JSON.parse(sub2.words_json) as Word[]
        mergedWordsJson = JSON.stringify([...w1, ...w2])
      } catch {
        /* skip */
      }
    }

    await api.deleteSubtitle(projectId, sub1.id)
    await api.deleteSubtitle(projectId, sub2.id)
    await api.createSubtitle(projectId, {
      text: mergedText,
      start_time: startTime,
      end_time: endTime,
      style: sub1.style,
      position_x: sub1.position_x,
      position_y: sub1.position_y,
      font_size: sub1.font_size,
      color: sub1.color,
      karaoke_style: sub1.karaoke_style,
      outline_color: sub1.outline_color,
      highlight_color: sub1.highlight_color,
      words_json: mergedWordsJson,
    })
    onRefetch()
  }

  const applyToAll = useCallback(
    async (data: Record<string, unknown>) => {
      await api.bulkUpdateStyle(projectId, data)
      onRefetch()
    },
    [projectId, onRefetch]
  )

  // Compute current "global" values from the first subtitle for display
  const firstSub = sorted[0] ?? null

  // ── AI Bulk Polish apply ───────────────────────────────────────────────────
  const handleBulkPolishApply = useCallback(
    async (results: BulkPolishResult[]) => {
      await Promise.all(
        results.map((r) => api.updateSubtitle(projectId, r.id, { text: r.polished_text }))
      )
      onRefetch()
    },
    [projectId, onRefetch]
  )

  // ── Feature 1: Template apply ──────────────────────────────────────────────
  const handleApplyTemplate = useCallback(
    async (template: SubtitleTemplate) => {
      await applyToAll({
        karaoke_style: template.karaokeStyle,
        style: template.preset,
        font_size: template.fontSize,
        color: template.color,
        outline_color: template.outlineColor,
        highlight_color: template.highlightColor,
        position_y: template.positionY,
      })
    },
    [applyToAll]
  )

  // ── Feature 2: Batch operations ────────────────────────────────────────────
  const toggleSelect = (id: number, e: React.MouseEvent) => {
    e.stopPropagation()
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(sorted.map((s) => s.id)))
  const deselectAll = () => setSelected(new Set())

  const handleBatchDelete = async () => {
    if (selected.size === 0) return
    setBatchWorking(true)
    try {
      await Promise.all([...selected].map((id) => api.deleteSubtitle(projectId, id)))
      setSelected(new Set())
      onRefetch()
    } finally {
      setBatchWorking(false)
    }
  }

  const handleBatchShiftTiming = async () => {
    const ms = parseFloat(shiftMs)
    if (isNaN(ms) || selected.size === 0) return
    const delta = ms / 1000
    setBatchWorking(true)
    try {
      const selectedSubs = sorted.filter((s) => selected.has(s.id))
      await Promise.all(
        selectedSubs.map((sub) =>
          api.updateSubtitle(projectId, sub.id, {
            start_time: Math.max(0, sub.start_time + delta),
            end_time: Math.max(0, sub.end_time + delta),
          })
        )
      )
      onRefetch()
    } finally {
      setBatchWorking(false)
    }
  }

  const handleBatchApplyStyle = async () => {
    if (!firstSub || selected.size === 0) return
    setBatchWorking(true)
    try {
      const selectedSubs = sorted.filter((s) => selected.has(s.id))
      await Promise.all(
        selectedSubs.map((sub) =>
          api.updateSubtitle(projectId, sub.id, {
            karaoke_style: firstSub.karaoke_style,
            style: firstSub.style,
            font_size: firstSub.font_size,
            color: firstSub.color,
            outline_color: firstSub.outline_color,
            highlight_color: firstSub.highlight_color,
          })
        )
      )
      onRefetch()
    } finally {
      setBatchWorking(false)
    }
  }

  const handleBatchFindReplace = async () => {
    if (!findText || selected.size === 0) return
    setBatchWorking(true)
    try {
      const selectedSubs = sorted.filter((s) => selected.has(s.id))
      await Promise.all(
        selectedSubs
          .filter((sub) => sub.text.includes(findText))
          .map((sub) => {
            const newText = sub.text.split(findText).join(replaceText)
            const wordsJson = recalcWordsJson(sub.words_json, newText, sub.start_time, sub.end_time)
            return api.updateSubtitle(projectId, sub.id, { text: newText, words_json: wordsJson })
          })
      )
      onRefetch()
    } finally {
      setBatchWorking(false)
    }
  }

  // ── Feature 4: Drag-reorder ────────────────────────────────────────────────
  const handleDragStart = (e: React.DragEvent, id: number) => {
    dragItemId.current = id
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDragOver = (e: React.DragEvent, id: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    dragOverItemId.current = id
    setDragOverId(id)
  }

  const handleDragLeave = () => {
    setDragOverId(null)
  }

  const handleDrop = async (e: React.DragEvent, targetId: number) => {
    e.preventDefault()
    setDragOverId(null)

    const fromId = dragItemId.current
    if (fromId === null || fromId === targetId) return

    const fromIdx = sorted.findIndex((s) => s.id === fromId)
    const toIdx = sorted.findIndex((s) => s.id === targetId)
    if (fromIdx === -1 || toIdx === -1) return

    // Build new order
    const reordered = [...sorted]
    const [moved] = reordered.splice(fromIdx, 1)
    reordered.splice(toIdx, 0, moved)

    // Reassign timings: keep durations, redistribute sequentially
    const updates: Array<{ id: number; start_time: number; end_time: number }> = []
    let cursor = reordered[0].start_time

    for (const sub of reordered) {
      const duration = sub.end_time - sub.start_time
      const newStart = cursor
      const newEnd = cursor + duration
      if (sub.start_time !== newStart || sub.end_time !== newEnd) {
        updates.push({ id: sub.id, start_time: newStart, end_time: newEnd })
      }
      cursor = newEnd
    }

    if (updates.length > 0) {
      await Promise.all(
        updates.map(({ id, start_time, end_time }) =>
          api.updateSubtitle(projectId, id, { start_time, end_time })
        )
      )
      onRefetch()
    }

    dragItemId.current = null
    dragOverItemId.current = null
  }

  const handleDragEnd = () => {
    dragItemId.current = null
    dragOverItemId.current = null
    setDragOverId(null)
  }

  if (subtitles.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-[var(--muted-foreground)]">
        No subtitles yet. Generate them from the transcript.
      </p>
    )
  }

  const canMerge =
    selectedSub !== null && sorted.findIndex((s) => s.id === selectedSub.id) < sorted.length - 1

  return (
    <div className="flex flex-col gap-3">
      {/* Global subtitle settings panel */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
        <button
          onClick={() => setGlobalStyleOpen(!globalStyleOpen)}
          className="flex w-full items-center justify-between text-xs font-semibold text-[var(--foreground)]"
        >
          <span className="flex items-center gap-1.5">
            <Settings size={13} />
            Subtitle Settings
          </span>
          {globalStyleOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>

        {globalStyleOpen && firstSub && (
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-[10px] text-[var(--muted-foreground)]">Changes apply to all subtitles</p>

            {/* Feature 1: Templates */}
            <SubtitleTemplates
              currentKaraokeStyle={firstSub.karaoke_style ?? 'classic'}
              currentPreset={firstSub.style}
              currentFontSize={firstSub.font_size ?? 48}
              currentColor={firstSub.color}
              currentOutlineColor={firstSub.outline_color ?? '#000000'}
              currentHighlightColor={firstSub.highlight_color ?? '#8b5cf6'}
              currentPositionY={firstSub.position_y ?? 0.7}
              onApply={handleApplyTemplate}
            />

            {/* Karaoke style */}
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Karaoke
              </label>
              <div className="flex flex-wrap gap-1">
                {KARAOKE_STYLES.map((ks) => (
                  <button
                    key={ks}
                    onClick={() => applyToAll({ karaoke_style: ks })}
                    className={`rounded px-2 py-0.5 text-[10px] font-medium capitalize transition ${
                      (firstSub.karaoke_style ?? 'classic') === ks
                        ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                        : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                    }`}
                  >
                    {ks}
                  </button>
                ))}
              </div>
            </div>

            {/* Style presets */}
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Style Preset
              </label>
              <div className="flex flex-wrap gap-1">
                {STYLES.map((s) => (
                  <button
                    key={s}
                    onClick={() => {
                      const preset = STYLE_PRESETS[s]
                      applyToAll({ style: s, font_size: preset.fontSize, color: preset.color })
                    }}
                    className={`rounded px-2 py-0.5 text-[10px] font-medium capitalize transition ${
                      firstSub.style === s
                        ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                        : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Font size */}
            <div>
              <label className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                <span>Font Size</span>
                <span className="text-[var(--foreground)]">{firstSub.font_size ?? 48}px</span>
              </label>
              <input
                type="range"
                min={16}
                max={96}
                step={2}
                value={firstSub.font_size ?? 48}
                onChange={(e) => applyToAll({ font_size: parseInt(e.target.value) })}
                className="h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--muted)] accent-[var(--primary)]"
              />
            </div>

            {/* Colors */}
            <div className="flex gap-4">
              <div className="flex-1">
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  Text Color
                </label>
                <div className="flex items-center gap-1">
                  {COLOR_SWATCHES.map((c) => (
                    <button
                      key={c}
                      onClick={() => applyToAll({ color: c })}
                      className={`h-5 w-5 rounded-full border-2 transition ${
                        firstSub.color === c
                          ? 'border-[var(--primary)] scale-110'
                          : 'border-transparent hover:border-[var(--muted-foreground)]'
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <input
                    type="color"
                    value={firstSub.color || '#FFFFFF'}
                    onChange={(e) => applyToAll({ color: e.target.value })}
                    className="ml-1 h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                </div>
              </div>
              <div className="flex-1">
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  Outline
                </label>
                <div className="flex items-center gap-1">
                  {['#000000', '#1E1E1E', '#FFFFFF'].map((c) => (
                    <button
                      key={c}
                      onClick={() => applyToAll({ outline_color: c })}
                      className={`h-5 w-5 rounded-full border-2 transition ${
                        (firstSub.outline_color ?? '#000000') === c
                          ? 'border-[var(--primary)] scale-110'
                          : 'border-[var(--muted-foreground)]/30 hover:border-[var(--muted-foreground)]'
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <input
                    type="color"
                    value={firstSub.outline_color || '#000000'}
                    onChange={(e) => applyToAll({ outline_color: e.target.value })}
                    className="ml-1 h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                </div>
              </div>
            </div>

            {/* Highlight Color */}
            <div>
              <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Highlight Color
              </label>
              <div className="flex items-center gap-1">
                {COLOR_SWATCHES.map((c) => (
                  <button
                    key={c}
                    onClick={() => applyToAll({ highlight_color: c })}
                    className={`h-5 w-5 rounded-full border-2 transition ${
                      (firstSub.highlight_color ?? '#8b5cf6').toUpperCase() === c.toUpperCase()
                        ? 'border-[var(--primary)] scale-110'
                        : 'border-transparent hover:border-[var(--muted-foreground)]'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <input
                  type="color"
                  value={firstSub.highlight_color || '#8b5cf6'}
                  onChange={(e) => applyToAll({ highlight_color: e.target.value })}
                  className="ml-1 h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
                />
              </div>
            </div>

            {/* Position Y + Grid */}
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <label className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  <span>Position Y</span>
                  <span className="text-[var(--foreground)]">{(firstSub.position_y ?? 0.7).toFixed(2)}</span>
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={firstSub.position_y ?? 0.7}
                  onChange={(e) => applyToAll({ position_y: parseFloat(e.target.value) })}
                  className="h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--muted)] accent-[var(--primary)]"
                />
              </div>
              {/* Feature 3: Position grid */}
              <SubtitlePositionGrid
                positionX={firstSub.position_x ?? 0.5}
                positionY={firstSub.position_y ?? 0.7}
                onSelect={(x, y) => applyToAll({ position_x: x, position_y: y })}
              />
            </div>
          </div>
        )}
      </div>

      {/* AI Bulk Polish toolbar */}
      <BulkPolishToolbar projectId={projectId} onApplyAll={handleBulkPolishApply} />

      {/* Per-subtitle style editor panel */}
      {selectedSub && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
          <button
            onClick={() => setPanelOpen(!panelOpen)}
            className="flex w-full items-center justify-between text-xs font-semibold text-[var(--foreground)]"
          >
            <span>Style Editor</span>
            {panelOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {panelOpen && (
            <div className="mt-3 flex flex-col gap-3">
              {/* Style preset picker */}
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  Style
                </label>
                <div className="flex flex-wrap gap-1">
                  {STYLES.map((s) => (
                    <button
                      key={s}
                      onClick={() => handleStyleChange(s)}
                      className={`rounded px-2 py-0.5 text-[10px] font-medium capitalize transition ${
                        selectedSub.style === s
                          ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                          : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              {/* Karaoke style */}
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  Karaoke
                </label>
                <div className="flex flex-wrap gap-1">
                  {KARAOKE_STYLES.map((ks) => (
                    <button
                      key={ks}
                      onClick={() => onUpdate(selectedSub.id, { karaoke_style: ks })}
                      className={`rounded px-2 py-0.5 text-[10px] font-medium capitalize transition ${
                        (selectedSub.karaoke_style ?? 'classic') === ks
                          ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                          : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                      }`}
                    >
                      {ks}
                    </button>
                  ))}
                </div>
              </div>

              {/* Font size */}
              <div>
                <label className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  <span>Font Size</span>
                  <span className="text-[var(--foreground)]">{selectedSub.font_size ?? 48}px</span>
                </label>
                <input
                  type="range"
                  min={16}
                  max={96}
                  step={2}
                  value={selectedSub.font_size ?? 48}
                  onChange={(e) =>
                    onUpdate(selectedSub.id, { font_size: parseInt(e.target.value) })
                  }
                  className="h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--muted)] accent-[var(--primary)]"
                />
              </div>

              {/* Colors */}
              <div className="flex gap-4">
                <div className="flex-1">
                  <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                    Text Color
                  </label>
                  <div className="flex items-center gap-1">
                    {COLOR_SWATCHES.map((c) => (
                      <button
                        key={c}
                        onClick={() => onUpdate(selectedSub.id, { color: c })}
                        className={`h-5 w-5 rounded-full border-2 transition ${
                          selectedSub.color === c
                            ? 'border-[var(--primary)] scale-110'
                            : 'border-transparent hover:border-[var(--muted-foreground)]'
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                    <input
                      type="color"
                      value={selectedSub.color || '#FFFFFF'}
                      onChange={(e) => onUpdate(selectedSub.id, { color: e.target.value })}
                      className="ml-1 h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
                    />
                  </div>
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                    Outline
                  </label>
                  <div className="flex items-center gap-1">
                    {['#000000', '#1E1E1E', '#FFFFFF'].map((c) => (
                      <button
                        key={c}
                        onClick={() => onUpdate(selectedSub.id, { outline_color: c })}
                        className={`h-5 w-5 rounded-full border-2 transition ${
                          (selectedSub.outline_color ?? '#000000') === c
                            ? 'border-[var(--primary)] scale-110'
                            : 'border-[var(--muted-foreground)]/30 hover:border-[var(--muted-foreground)]'
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                    <input
                      type="color"
                      value={selectedSub.outline_color || '#000000'}
                      onChange={(e) => onUpdate(selectedSub.id, { outline_color: e.target.value })}
                      className="ml-1 h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
                    />
                  </div>
                </div>
              </div>

              {/* Highlight Color */}
              <div>
                <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  Highlight Color
                </label>
                <div className="flex items-center gap-1">
                  {COLOR_SWATCHES.map((c) => (
                    <button
                      key={c}
                      onClick={() => onUpdate(selectedSub.id, { highlight_color: c })}
                      className={`h-5 w-5 rounded-full border-2 transition ${
                        (selectedSub.highlight_color ?? '#8b5cf6').toUpperCase() === c.toUpperCase()
                          ? 'border-[var(--primary)] scale-110'
                          : 'border-transparent hover:border-[var(--muted-foreground)]'
                      }`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                  <input
                    type="color"
                    value={selectedSub.highlight_color || '#8b5cf6'}
                    onChange={(e) => onUpdate(selectedSub.id, { highlight_color: e.target.value })}
                    className="ml-1 h-5 w-5 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                </div>
              </div>

              {/* Position sliders + grid */}
              <div className="flex items-start gap-4">
                <div className="flex flex-1 gap-4">
                  <div className="flex-1">
                    <label className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                      <span>Position X</span>
                      <span className="text-[var(--foreground)]">{selectedSub.position_x.toFixed(2)}</span>
                    </label>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={selectedSub.position_x}
                      onChange={(e) =>
                        onUpdate(selectedSub.id, { position_x: parseFloat(e.target.value) })
                      }
                      className="h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--muted)] accent-[var(--primary)]"
                    />
                    <div className="mt-2">
                      <label className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                        <span>Position Y</span>
                        <span className="text-[var(--foreground)]">{selectedSub.position_y.toFixed(2)}</span>
                      </label>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={selectedSub.position_y}
                        onChange={(e) =>
                          onUpdate(selectedSub.id, { position_y: parseFloat(e.target.value) })
                        }
                        className="h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--muted)] accent-[var(--primary)]"
                      />
                    </div>
                  </div>
                </div>
                {/* Feature 3: Position grid for per-subtitle */}
                <SubtitlePositionGrid
                  positionX={selectedSub.position_x}
                  positionY={selectedSub.position_y}
                  onSelect={(x, y) => onUpdate(selectedSub.id, { position_x: x, position_y: y })}
                />
              </div>

              {/* Action buttons: Sync All, Split, Merge */}
              <div className="flex gap-2">
                <button
                  onClick={handleSyncAll}
                  disabled={syncing}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-40"
                >
                  {syncing ? 'Syncing...' : 'Sync All'}
                </button>
                <button
                  onClick={handleSplit}
                  title="Split subtitle at current time"
                  className="flex items-center gap-1 rounded-lg bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
                >
                  <Scissors size={12} />
                  Split
                </button>
                <button
                  onClick={handleMerge}
                  disabled={!canMerge}
                  title="Merge with next subtitle"
                  className="flex items-center gap-1 rounded-lg bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-40"
                >
                  <Merge size={12} />
                  Merge
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Feature 2: Subtitle list header with Select All + count */}
      <div className="flex items-center justify-between">
        <button
          onClick={selected.size === sorted.length ? deselectAll : selectAll}
          className="text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition"
        >
          {selected.size === sorted.length ? 'Deselect All' : 'Select All'}
        </button>
        {selected.size > 0 && (
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {selected.size} of {sorted.length} selected
          </span>
        )}
      </div>

      {/* Feature 2: Batch toolbar */}
      {selected.size > 0 && (
        <div className="sticky top-0 z-10 rounded-lg border border-[var(--border)] bg-[var(--card)] p-2.5 shadow-md">
          <div className="mb-2 flex flex-wrap gap-1.5">
            <button
              onClick={handleBatchDelete}
              disabled={batchWorking}
              className="flex items-center gap-1 rounded-lg bg-red-500/10 px-2.5 py-1 text-[11px] font-medium text-red-400 transition hover:bg-red-500/20 disabled:opacity-40"
            >
              <Trash2 size={11} />
              Delete Selected
            </button>
            <button
              onClick={handleBatchApplyStyle}
              disabled={batchWorking || !firstSub}
              className="flex items-center gap-1 rounded-lg bg-[var(--muted)] px-2.5 py-1 text-[11px] text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-40"
            >
              <Paintbrush size={11} />
              Apply Style
            </button>
          </div>

          {/* Shift timing */}
          <div className="mb-1.5 flex items-center gap-1.5">
            <Clock size={11} className="shrink-0 text-[var(--muted-foreground)]" />
            <span className="text-[10px] text-[var(--muted-foreground)]">Shift:</span>
            <input
              type="number"
              value={shiftMs}
              onChange={(e) => setShiftMs(e.target.value)}
              placeholder="ms (e.g. -200)"
              className="w-28 rounded border border-[var(--border)] bg-[var(--muted)] px-1.5 py-0.5 text-[11px] text-[var(--foreground)] outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
            <button
              onClick={handleBatchShiftTiming}
              disabled={batchWorking || !shiftMs}
              className="rounded-lg bg-[var(--muted)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-40"
            >
              Apply
            </button>
          </div>

          {/* Find & Replace */}
          <div className="flex items-center gap-1.5">
            <Replace size={11} className="shrink-0 text-[var(--muted-foreground)]" />
            <input
              type="text"
              value={findText}
              onChange={(e) => setFindText(e.target.value)}
              placeholder="Find…"
              className="w-24 rounded border border-[var(--border)] bg-[var(--muted)] px-1.5 py-0.5 text-[11px] text-[var(--foreground)] outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
            <input
              type="text"
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              placeholder="Replace…"
              className="w-24 rounded border border-[var(--border)] bg-[var(--muted)] px-1.5 py-0.5 text-[11px] text-[var(--foreground)] outline-none focus:ring-1 focus:ring-[var(--ring)]"
            />
            <button
              onClick={handleBatchFindReplace}
              disabled={batchWorking || !findText}
              className="rounded-lg bg-[var(--muted)] px-2 py-0.5 text-[11px] text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-40"
            >
              Replace
            </button>
          </div>
        </div>
      )}

      {/* Language selector */}
      <LanguageSelector
        projectId={projectId}
        selectedLanguage={activeLanguage}
        onLanguageChange={setActiveLanguage}
      />

      {/* Subtitle list */}
      <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto">
        {sorted.map((sub) => {
          const isSelected = sub.id === selectedSubtitleId
          const isChecked = selected.has(sub.id)
          const isDragOver = dragOverId === sub.id

          return (
            <div
              key={sub.id}
              draggable
              onDragStart={(e) => handleDragStart(e, sub.id)}
              onDragOver={(e) => handleDragOver(e, sub.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, sub.id)}
              onDragEnd={handleDragEnd}
              onClick={() => onSelectSubtitle?.(sub)}
              className={`cursor-pointer rounded-lg border p-3 transition ${
                isDragOver
                  ? 'border-[var(--primary)] bg-[var(--primary)]/5 shadow-lg'
                  : isSelected
                  ? 'border-[var(--primary)]/60 bg-[var(--primary)]/10'
                  : 'border-[var(--border)] bg-[var(--muted)] hover:border-[var(--muted-foreground)]/30'
              }`}
            >
              <div className="mb-1 flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  {/* Feature 4: Drag handle */}
                  <div
                    className="cursor-grab active:cursor-grabbing text-[var(--muted-foreground)] opacity-40 hover:opacity-100 transition"
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <GripVertical size={13} />
                  </div>

                  {/* Feature 2: Checkbox */}
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onClick={(e) => toggleSelect(sub.id, e)}
                    onChange={() => {}}
                    className="h-3 w-3 cursor-pointer rounded accent-[var(--primary)]"
                  />

                  {editingTimeId === sub.id && editTimeField === 'start' ? (
                    <input
                      type="text"
                      value={editTimeValue}
                      onChange={(e) => setEditTimeValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveTimeEdit(sub)
                        if (e.key === 'Escape') setEditingTimeId(null)
                        if (e.key === 'Tab') {
                          e.preventDefault()
                          saveTimeEdit(sub)
                          startTimeEdit(sub, 'end')
                        }
                      }}
                      onBlur={() => saveTimeEdit(sub)}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      className="w-20 rounded border border-[var(--border)] bg-[var(--card)] px-1 py-0 text-xs text-[var(--foreground)] outline-none focus:ring-1 focus:ring-[var(--ring)]"
                    />
                  ) : (
                    <span
                      className="cursor-text text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                      onClick={(e) => {
                        e.stopPropagation()
                        startTimeEdit(sub, 'start')
                      }}
                    >
                      {fmtTime(sub.start_time)}
                    </span>
                  )}
                  <span className="text-xs text-[var(--muted-foreground)]">-</span>
                  {editingTimeId === sub.id && editTimeField === 'end' ? (
                    <input
                      type="text"
                      value={editTimeValue}
                      onChange={(e) => setEditTimeValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveTimeEdit(sub)
                        if (e.key === 'Escape') setEditingTimeId(null)
                      }}
                      onBlur={() => saveTimeEdit(sub)}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      className="w-20 rounded border border-[var(--border)] bg-[var(--card)] px-1 py-0 text-xs text-[var(--foreground)] outline-none focus:ring-1 focus:ring-[var(--ring)]"
                    />
                  ) : (
                    <span
                      className="cursor-text text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                      onClick={(e) => {
                        e.stopPropagation()
                        startTimeEdit(sub, 'end')
                      }}
                    >
                      {fmtTime(sub.end_time)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {sub.karaoke_style && sub.karaoke_style !== 'classic' && (
                    <span className="rounded bg-[var(--primary)]/20 px-1 py-0.5 text-[9px] text-[var(--primary)]">
                      {sub.karaoke_style}
                    </span>
                  )}
                  <span className="rounded bg-[var(--card)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
                    {sub.style}
                  </span>
                </div>
              </div>

              {editingId === sub.id ? (
                <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="text"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => handleKeyDown(e, sub)}
                    onBlur={() => saveEdit(sub)}
                    autoFocus
                    className="flex-1 rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-sm text-[var(--foreground)] outline-none focus:ring-1 focus:ring-[var(--ring)]"
                  />
                  <button
                    onClick={() => saveEdit(sub)}
                    className="rounded p-1 text-[var(--primary)] hover:bg-[var(--primary)]/10"
                  >
                    <Check size={14} />
                  </button>
                </div>
              ) : (
                <div
                  className="group flex items-start gap-2"
                  onClick={(e) => {
                    e.stopPropagation()
                    startEdit(sub)
                  }}
                >
                  <p className="flex-1 text-sm text-[var(--foreground)]">{sub.text}</p>
                  <Pencil
                    size={12}
                    className="mt-0.5 shrink-0 text-[var(--muted-foreground)] opacity-0 transition group-hover:opacity-100"
                  />
                </div>
              )}
              <SubtitlePolishButtons
                projectId={projectId}
                subtitleId={sub.id}
                onApply={(sid, newText) => onUpdate(sid, { text: newText })}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Parse time string m:ss.cc or m:ss into seconds */
function parseTime(str: string): number | null {
  const match = str.match(/^(\d+):(\d{1,2})(?:\.(\d{1,2}))?$/)
  if (!match) return null
  const m = parseInt(match[1])
  const s = parseInt(match[2])
  const cs = match[3] ? parseInt(match[3].padEnd(2, '0')) : 0
  return m * 60 + s + cs / 100
}
