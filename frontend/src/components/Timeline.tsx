import { useRef, useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ZoomIn, ZoomOut, Sparkles, Loader2, Magnet } from 'lucide-react'
import { api } from '@/api/client'
import type { TimelineItem, Subtitle, SnapInterval } from '@/types'
import TimelineBlock from './TimelineBlock'
import SubtitleTrack from './SubtitleTrack'
import AudioWaveform from './AudioWaveform'

interface Props {
  projectId: string
  duration: number
  currentTime: number
  subtitles?: Subtitle[]
  maxBroll: number
  onMaxBrollChange: (val: number) => void
  onSeek: (time: number) => void
  onSelectItem: (item: TimelineItem | null) => void
  onReplace: (item: TimelineItem) => void
  onSelectSubtitle?: (sub: Subtitle) => void
  onEditSubtitleText?: (subtitleId: number, newText: string) => void
  /** Whether the project has a Clip A (waveform only shows if true) */
  hasClipA?: boolean
}

const SNAP_OPTIONS: SnapInterval[] = [0.1, 0.5, 1]

export default function Timeline({
  projectId,
  duration,
  currentTime,
  subtitles,
  maxBroll,
  onMaxBrollChange,
  onSeek,
  onSelectItem,
  onReplace,
  onSelectSubtitle,
  onEditSubtitleText,
  hasClipA = false,
}: Props) {
  const queryClient = useQueryClient()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pxPerSec, setPxPerSec] = useState(50)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [dragItemId, setDragItemId] = useState<number | null>(null)

  // ── Snap-to-grid state ────────────────────────────────────────────────────
  const [snapEnabled, setSnapEnabled] = useState(false)
  const [snapInterval, setSnapInterval] = useState<SnapInterval>(0.5)

  const snapValue = useCallback(
    (v: number) => {
      if (!snapEnabled) return v
      return Math.round(v / snapInterval) * snapInterval
    },
    [snapEnabled, snapInterval],
  )

  // ── Timeline data ─────────────────────────────────────────────────────────
  const { data: items = [] } = useQuery({
    queryKey: ['timeline', projectId],
    queryFn: () => api.listTimeline(projectId),
  })

  const matchMutation = useMutation({
    mutationFn: () => api.matchBroll(projectId, maxBroll > 0 ? maxBroll : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeline', projectId] })
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (itemId: number) => api.deleteTimelineItem(projectId, itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeline', projectId] })
    },
  })

  const reorderMutation = useMutation({
    mutationFn: (reorder: { id: number; position: number }[]) =>
      api.reorderTimeline(projectId, reorder),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeline', projectId] })
    },
  })

  const updateItemMutation = useMutation({
    mutationFn: ({ itemId, data }: { itemId: number; data: Partial<TimelineItem> }) =>
      api.updateTimelineItem(projectId, itemId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeline', projectId] })
    },
  })

  // ── Derived tracks ────────────────────────────────────────────────────────
  const clipAItems = items.filter((i) => i.source_type === 'clip_a')
  const brollItems = items.filter((i) => i.source_type !== 'clip_a')

  const totalWidth = Math.max(duration * pxPerSec, 600)

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleSelect = useCallback(
    (item: TimelineItem) => {
      setSelectedId(item.id)
      onSelectItem(item)
    },
    [onSelectItem],
  )

  const handleDeselect = useCallback(() => {
    setSelectedId(null)
    onSelectItem(null)
  }, [onSelectItem])

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left + (scrollRef.current?.scrollLeft || 0)
    const time = Math.max(0, Math.min(x / pxPerSec, duration))
    onSeek(time)
    handleDeselect()
  }

  // Drag and drop for reordering b-roll
  const handleDragStart = (e: React.DragEvent, item: TimelineItem) => {
    setDragItemId(item.id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(item.id))
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  const handleDrop = (e: React.DragEvent, targetItem: TimelineItem) => {
    e.preventDefault()
    if (dragItemId === null || dragItemId === targetItem.id) return

    const newOrder = [...brollItems].sort((a, b) => a.position - b.position)
    const dragIdx = newOrder.findIndex((i) => i.id === dragItemId)
    const targetIdx = newOrder.findIndex((i) => i.id === targetItem.id)
    if (dragIdx === -1 || targetIdx === -1) return

    const [moved] = newOrder.splice(dragIdx, 1)
    newOrder.splice(targetIdx, 0, moved)

    const reorder = newOrder.map((item, idx) => ({ id: item.id, position: idx }))
    reorderMutation.mutate(reorder)
    setDragItemId(null)
  }

  // Trim change — update the timeline item via API
  const handleTrimChange = useCallback(
    (itemId: number, trimStart: number, trimEnd: number | null) => {
      const item = items.find((i) => i.id === itemId)
      if (!item) return

      const origDuration = item.timeline_end - item.timeline_start
      const origTrimEnd = item.clip_trim_end ?? origDuration
      const origTrimStart = item.clip_trim_start

      const startDelta = trimStart - origTrimStart
      const endDelta = trimEnd !== null ? (trimEnd - origTrimEnd) : 0

      // Adjust timeline_start and timeline_end to match trim
      const newTimelineStart = snapValue(item.timeline_start + startDelta)
      const newTimelineEnd = snapValue(item.timeline_end + endDelta)

      updateItemMutation.mutate({
        itemId,
        data: {
          clip_trim_start: trimStart,
          clip_trim_end: trimEnd,
          timeline_start: Math.max(0, newTimelineStart),
          timeline_end: Math.max(newTimelineStart + 0.5, newTimelineEnd),
        },
      })
    },
    [items, updateItemMutation, snapValue],
  )

  // Speed change
  const handleSpeedChange = useCallback(
    (itemId: number, speed: number) => {
      const item = items.find((i) => i.id === itemId)
      if (!item) return

      // Adjust timeline_end so block width reflects new speed
      const clipDuration =
        (item.clip_trim_end ?? item.timeline_end - item.timeline_start) - item.clip_trim_start
      const newDuration = clipDuration / speed
      const newTimelineEnd = item.timeline_start + newDuration

      updateItemMutation.mutate({
        itemId,
        data: { speed, timeline_end: newTimelineEnd },
      })
    },
    [items, updateItemMutation],
  )

  // ── Tick marks ─────────────────────────────────────────────────────────────
  const ticks: React.ReactNode[] = []
  for (let t = 0; t <= duration; t++) {
    const x = t * pxPerSec
    const isLabel = t % 5 === 0
    ticks.push(
      <div key={t} className="absolute top-0" style={{ left: `${x}px` }}>
        <div
          className={`${isLabel ? 'h-3 bg-[var(--muted-foreground)]' : 'h-1.5 bg-[var(--border)]'}`}
          style={{ width: '1px' }}
        />
        {isLabel && (
          <span className="absolute left-1 top-3 text-[9px] text-[var(--muted-foreground)]">
            {t}s
          </span>
        )}
      </div>,
    )
  }

  // ── Snap grid lines ────────────────────────────────────────────────────────
  const snapGridStyle: React.CSSProperties = snapEnabled
    ? {
        backgroundImage: `repeating-linear-gradient(
          90deg,
          rgba(255,255,255,0.07) 0px,
          rgba(255,255,255,0.07) 1px,
          transparent 1px,
          transparent ${snapInterval * pxPerSec}px
        )`,
        backgroundSize: `${snapInterval * pxPerSec}px 100%`,
      }
    : {}

  const playheadLeft = currentTime * pxPerSec

  return (
    <div className="flex flex-col border-t border-[var(--border)] bg-[var(--card)]">
      {/* ── Toolbar ───────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-1.5">
        <button
          onClick={() => matchMutation.mutate()}
          disabled={matchMutation.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1 text-[11px] font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)] disabled:opacity-50"
        >
          {matchMutation.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          Match B-Roll
        </button>

        {/* B-Roll density slider */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--muted-foreground)]">Density:</span>
          <input
            type="range"
            min={0}
            max={20}
            value={maxBroll}
            onChange={(e) => onMaxBrollChange(parseInt(e.target.value))}
            className="h-1 w-24 cursor-pointer appearance-none rounded-full bg-[var(--muted)] accent-[var(--primary)]"
          />
          <span className="min-w-[28px] text-[10px] text-[var(--muted-foreground)]">
            {maxBroll === 0 ? 'Auto' : maxBroll}
          </span>
        </div>

        {/* ── Snap controls ───────────────────────────────────────────────── */}
        <div className="flex items-center gap-1.5 border-l border-[var(--border)] pl-3">
          <button
            onClick={() => setSnapEnabled((v) => !v)}
            className={`flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition ${
              snapEnabled
                ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }`}
            title="Toggle snap to grid"
          >
            <Magnet size={11} />
            Snap
          </button>

          {snapEnabled && (
            <select
              value={snapInterval}
              onChange={(e) => setSnapInterval(parseFloat(e.target.value) as SnapInterval)}
              className="rounded border border-[var(--border)] bg-[var(--muted)] px-1 py-0.5 text-[10px] text-[var(--foreground)]"
            >
              {SNAP_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}s
                </option>
              ))}
            </select>
          )}
        </div>

        {/* ── Zoom controls ───────────────────────────────────────────────── */}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setPxPerSec((v) => Math.max(20, v - 10))}
            className="rounded p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
            title="Zoom out"
          >
            <ZoomOut size={14} />
          </button>
          <span className="min-w-[36px] text-center text-[10px] text-[var(--muted-foreground)]">
            {pxPerSec}px/s
          </span>
          <button
            onClick={() => setPxPerSec((v) => Math.min(200, v + 10))}
            className="rounded p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
            title="Zoom in"
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </div>

      {/* ── Scrollable timeline area ──────────────────────────────────────── */}
      <div ref={scrollRef} className="overflow-x-auto overflow-y-hidden">
        <div
          className="relative"
          style={{ width: `${totalWidth}px`, minHeight: '120px', ...snapGridStyle }}
        >
          {/* Time ruler */}
          <div className="relative h-6 border-b border-[var(--border)]">{ticks}</div>

          {/* Waveform track — above B-Roll, only when Clip A exists */}
          {hasClipA && (
            <AudioWaveform projectId={projectId} totalWidthPx={totalWidth} />
          )}

          {/* B-Roll track */}
          <div
            className="relative flex h-10 items-stretch gap-0.5 border-b border-[var(--border)] px-0"
            onClick={handleTimelineClick}
            onDragOver={handleDragOver}
          >
            <div className="absolute left-0 top-0 flex h-full w-full">
              {brollItems
                .sort((a, b) => a.timeline_start - b.timeline_start)
                .map((item) => (
                  <div
                    key={item.id}
                    className="absolute h-full"
                    style={{ left: `${item.timeline_start * pxPerSec}px` }}
                    onDrop={(e) => handleDrop(e, item)}
                  >
                    <TimelineBlock
                      item={item}
                      pixelsPerSecond={pxPerSec}
                      isSelected={selectedId === item.id}
                      onSelect={() => handleSelect(item)}
                      onDelete={() => deleteMutation.mutate(item.id)}
                      onReplace={() => onReplace(item)}
                      onDragStart={(e) => handleDragStart(e, item)}
                      onDragEnd={() => setDragItemId(null)}
                      onTrimChange={handleTrimChange}
                      onSpeedChange={handleSpeedChange}
                      snapValue={snapEnabled ? snapValue : undefined}
                    />
                  </div>
                ))}
            </div>
            {/* Track label */}
            <span className="pointer-events-none absolute left-1 top-0.5 text-[9px] font-medium text-green-400/60">
              B-Roll
            </span>
          </div>

          {/* Clip A track */}
          <div
            className="relative flex h-10 items-stretch gap-0.5 px-0"
            onClick={handleTimelineClick}
          >
            <div className="absolute left-0 top-0 flex h-full w-full">
              {clipAItems
                .sort((a, b) => a.timeline_start - b.timeline_start)
                .map((item) => (
                  <div
                    key={item.id}
                    className="absolute h-full"
                    style={{ left: `${item.timeline_start * pxPerSec}px` }}
                  >
                    <TimelineBlock
                      item={item}
                      pixelsPerSecond={pxPerSec}
                      isSelected={selectedId === item.id}
                      onSelect={() => handleSelect(item)}
                      onDelete={() => deleteMutation.mutate(item.id)}
                      onReplace={() => onReplace(item)}
                      onDragStart={(e) => handleDragStart(e, item)}
                      onDragEnd={() => setDragItemId(null)}
                      onTrimChange={handleTrimChange}
                      onSpeedChange={handleSpeedChange}
                      snapValue={snapEnabled ? snapValue : undefined}
                    />
                  </div>
                ))}
            </div>
            {/* Track label */}
            <span className="pointer-events-none absolute left-1 top-0.5 text-[9px] font-medium text-blue-400/60">
              Clip A
            </span>
          </div>

          {/* Subtitle track */}
          {subtitles && subtitles.length > 0 && (
            <div className="relative border-t border-[var(--border)]">
              <span className="pointer-events-none absolute left-1 top-0.5 z-[1] text-[9px] font-medium text-purple-400/60">
                Subs
              </span>
              <SubtitleTrack
                subtitles={subtitles}
                currentTime={currentTime}
                pixelsPerSecond={pxPerSec}
                onSelectSubtitle={onSelectSubtitle ?? (() => {})}
                onEditSubtitleText={onEditSubtitleText}
              />
            </div>
          )}

          {/* Playhead */}
          <div
            className="pointer-events-none absolute top-0 z-10 h-full"
            style={{ left: `${playheadLeft}px`, width: '2px' }}
          >
            <div className="h-full w-full bg-red-500" />
            <div className="absolute -left-1 top-0 h-2 w-2 rounded-full bg-red-500" />
          </div>
        </div>
      </div>
    </div>
  )
}
