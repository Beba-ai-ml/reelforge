import { useRef, useState, useCallback, useEffect } from 'react'
import { X, Replace, Film, Image, ChevronDown } from 'lucide-react'
import type { TimelineItem } from '@/types'

const sourceColors: Record<string, string> = {
  clip_a: 'bg-blue-600/30 border-blue-500/40',
  library: 'bg-green-600/30 border-green-500/40',
  custom: 'bg-orange-600/30 border-orange-500/40',
}

const fmtDuration = (s: number) => {
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2]

interface TrimTooltip {
  value: number
  edge: 'left' | 'right'
}

interface Props {
  item: TimelineItem
  pixelsPerSecond: number
  isSelected: boolean
  onSelect: () => void
  onDelete: () => void
  onReplace: () => void
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: (e: React.DragEvent) => void
  /** Called when trim or speed changes — parent saves to API */
  onTrimChange?: (itemId: number, trimStart: number, trimEnd: number | null) => void
  onSpeedChange?: (itemId: number, speed: number) => void
  /** Snap function — snaps a value to the nearest grid interval */
  snapValue?: (v: number) => number
}

export default function TimelineBlock({
  item,
  pixelsPerSecond,
  isSelected,
  onSelect,
  onDelete,
  onReplace,
  onDragStart,
  onDragEnd,
  onTrimChange,
  onSpeedChange,
  snapValue,
}: Props) {
  const blockRef = useRef<HTMLDivElement>(null)

  // Effective duration = timeline span
  const duration = item.timeline_end - item.timeline_start
  const width = Math.max(duration * pixelsPerSecond, 40)
  const colorClass = sourceColors[item.source_type] || sourceColors.custom
  const label =
    item.source_type === 'clip_a'
      ? 'Clip A'
      : item.clip_title || item.source_path?.split('/').pop() || `Item ${item.id}`

  const TypeIcon = item.clip_type === 'image' ? Image : Film

  // ─── Speed dropdown ───────────────────────────────────────────────────────

  const [speedOpen, setSpeedOpen] = useState(false)
  const speedRef = useRef<HTMLDivElement>(null)

  // Close speed dropdown on outside click
  useEffect(() => {
    if (!speedOpen) return
    const handler = (e: MouseEvent) => {
      if (speedRef.current && !speedRef.current.contains(e.target as Node)) {
        setSpeedOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [speedOpen])

  const handleSpeedSelect = useCallback(
    (speed: number) => {
      setSpeedOpen(false)
      onSpeedChange?.(item.id, speed)
    },
    [item.id, onSpeedChange],
  )

  // ─── Trim drag ───────────────────────────────────────────────────────────

  const [trimTooltip, setTrimTooltip] = useState<TrimTooltip | null>(null)

  // We store mutable drag state in a ref to avoid stale closures in event handlers
  const trimDrag = useRef<{
    edge: 'left' | 'right'
    startX: number
    origTrimStart: number
    origTrimEnd: number | null
    origDuration: number
  } | null>(null)

  const snap = useCallback(
    (v: number) => (snapValue ? snapValue(v) : v),
    [snapValue],
  )

  const onTrimMouseDown = useCallback(
    (e: React.MouseEvent, edge: 'left' | 'right') => {
      e.stopPropagation()
      e.preventDefault()

      trimDrag.current = {
        edge,
        startX: e.clientX,
        origTrimStart: item.clip_trim_start,
        origTrimEnd: item.clip_trim_end,
        origDuration: duration,
      }

      const onMouseMove = (ev: MouseEvent) => {
        const drag = trimDrag.current
        if (!drag) return

        const dx = ev.clientX - drag.startX
        const dt = dx / pixelsPerSecond

        if (drag.edge === 'left') {
          // Moving left handle: adjusts trim start (increase = trim more from start)
          const newTrimStart = Math.max(0, snap(drag.origTrimStart + dt))
          const newDuration = Math.max(0.5, drag.origDuration - dt)
          const displayVal = newTrimStart
          setTrimTooltip({ value: displayVal, edge: 'left' })
        } else {
          // Moving right handle: adjusts trim end (decrease = trim more from end)
          const origTrimEnd = drag.origTrimEnd ?? drag.origDuration
          const newTrimEnd = Math.max(
            drag.origTrimStart + 0.5,
            snap(origTrimEnd + dt),
          )
          setTrimTooltip({ value: newTrimEnd, edge: 'right' })
        }
      }

      const onMouseUp = (ev: MouseEvent) => {
        const drag = trimDrag.current
        if (!drag) return

        const dx = ev.clientX - drag.startX
        const dt = dx / pixelsPerSecond

        let newTrimStart = drag.origTrimStart
        let newTrimEnd = drag.origTrimEnd

        if (drag.edge === 'left') {
          newTrimStart = Math.max(0, snap(drag.origTrimStart + dt))
        } else {
          const origTrimEnd = drag.origTrimEnd ?? drag.origDuration
          newTrimEnd = Math.max(
            drag.origTrimStart + 0.5,
            snap(origTrimEnd + dt),
          )
        }

        trimDrag.current = null
        setTrimTooltip(null)

        onTrimChange?.(item.id, newTrimStart, newTrimEnd)

        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    },
    [item, duration, pixelsPerSecond, snap, onTrimChange],
  )

  const currentSpeed = item.speed || 1

  return (
    <div
      ref={blockRef}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      className={`group relative flex h-full cursor-pointer flex-col justify-center overflow-visible rounded border px-2 transition select-none ${colorClass} ${
        isSelected ? 'ring-2 ring-[var(--primary)]' : ''
      }`}
      style={{ width: `${width}px`, minWidth: '40px' }}
    >
      {/* ── Left trim handle ──────────────────────────────────────────────── */}
      <div
        className="absolute left-0 top-0 z-20 flex h-full w-2 cursor-col-resize items-center justify-center opacity-0 transition group-hover:opacity-100"
        onMouseDown={(e) => onTrimMouseDown(e, 'left')}
        title="Drag to trim start"
      >
        <div className="h-4/5 w-1 rounded-full bg-white/60" />
        {trimTooltip?.edge === 'left' && (
          <div className="absolute -top-5 left-0 rounded bg-black/80 px-1 py-0.5 text-[9px] text-white whitespace-nowrap">
            {trimTooltip.value.toFixed(2)}s
          </div>
        )}
      </div>

      {/* ── Right trim handle ─────────────────────────────────────────────── */}
      <div
        className="absolute right-0 top-0 z-20 flex h-full w-2 cursor-col-resize items-center justify-center opacity-0 transition group-hover:opacity-100"
        onMouseDown={(e) => onTrimMouseDown(e, 'right')}
        title="Drag to trim end"
      >
        <div className="h-4/5 w-1 rounded-full bg-white/60" />
        {trimTooltip?.edge === 'right' && (
          <div className="absolute -top-5 right-0 rounded bg-black/80 px-1 py-0.5 text-[9px] text-white whitespace-nowrap">
            {trimTooltip.value.toFixed(2)}s
          </div>
        )}
      </div>

      {/* ── Trimmed-away hatching at edges ────────────────────────────────── */}
      {item.clip_trim_start > 0 && (
        <div
          className="pointer-events-none absolute left-0 top-0 h-full"
          style={{
            width: '4px',
            background:
              'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.15) 2px, rgba(255,255,255,0.15) 4px)',
          }}
        />
      )}
      {item.clip_trim_end !== null && (
        <div
          className="pointer-events-none absolute right-0 top-0 h-full"
          style={{
            width: '4px',
            background:
              'repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(255,255,255,0.15) 2px, rgba(255,255,255,0.15) 4px)',
          }}
        />
      )}

      {/* ── Clip label + type icon ─────────────────────────────────────────── */}
      <span className="flex items-center gap-1 truncate text-[11px] font-medium text-[var(--foreground)]">
        {item.source_type === 'library' && (
          <TypeIcon size={10} className="shrink-0 text-[var(--muted-foreground)]" />
        )}
        {label}
      </span>

      {/* ── Duration + speed indicator ────────────────────────────────────── */}
      <span className="flex items-center gap-1 text-[10px] text-[var(--muted-foreground)]">
        {fmtDuration(duration)}
        {currentSpeed !== 1 && (
          <span className="rounded bg-black/30 px-0.5 text-[8px] text-yellow-300">
            {currentSpeed}x
          </span>
        )}
      </span>

      {/* ── Hover actions ─────────────────────────────────────────────────── */}
      <div className="absolute right-0.5 top-0.5 flex gap-0.5 opacity-0 transition group-hover:opacity-100">
        {/* Speed dropdown trigger */}
        <div ref={speedRef} className="relative">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setSpeedOpen((v) => !v)
            }}
            className="flex items-center rounded bg-black/50 px-0.5 py-0.5 text-[8px] text-white transition hover:bg-black/70"
            title="Speed"
          >
            {currentSpeed}x
            <ChevronDown size={8} />
          </button>

          {speedOpen && (
            <div className="absolute right-0 top-full z-50 mt-0.5 rounded border border-[var(--border)] bg-[var(--popover)] py-0.5 shadow-lg">
              {SPEED_OPTIONS.map((s) => (
                <button
                  key={s}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleSpeedSelect(s)
                  }}
                  className={`block w-full px-3 py-0.5 text-left text-[11px] transition hover:bg-[var(--muted)] ${
                    s === currentSpeed ? 'text-[var(--primary)] font-medium' : 'text-[var(--foreground)]'
                  }`}
                >
                  {s}x
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation()
            onReplace()
          }}
          className="rounded bg-black/50 p-0.5 text-white transition hover:bg-black/70"
          title="Replace"
        >
          <Replace size={10} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          className="rounded bg-black/50 p-0.5 text-red-400 transition hover:bg-black/70"
          title="Delete"
        >
          <X size={10} />
        </button>
      </div>
    </div>
  )
}
