import { useRef, useState, useCallback, useEffect } from 'react'
import { Columns2 } from 'lucide-react'

interface Props {
  /** The current live preview src (passed straight through to the left <video>) */
  currentSrc: string
  /** Project ID used to build the render download URL */
  projectId: string
  /** Whether a rendered file actually exists for this project */
  hasRender: boolean
  /** Whether the component is in comparison mode */
  active: boolean
  /** Toggle callback */
  onToggle: () => void
  /** Children = the original left-side preview (rendered by parent) */
  children: React.ReactNode
  /** Whether the left video is currently playing */
  isPlaying?: boolean
  /** Current playback time of the left video (seconds) */
  currentTime?: number
}

/**
 * A/B split-screen comparison.
 *
 * When `active` is true this component wraps its children (left = "Current") and
 * renders a second <video> on the right (last rendered file).  Both panels keep
 * their playback in sync via cross-video timeupdate mirroring.
 *
 * The divider between panels can be dragged left/right to give more space to
 * either side.
 */
export default function ABComparison({
  projectId,
  hasRender,
  active,
  onToggle,
  children,
  isPlaying,
  currentTime: parentTime,
}: Props) {
  // Divider position as percentage (50 = center)
  const [dividerPct, setDividerPct] = useState(50)
  const containerRef = useRef<HTMLDivElement>(null)
  const rightVideoRef = useRef<HTMLVideoElement>(null)
  const isDragging = useRef(false)

  const renderDownloadUrl = `/api/projects/${projectId}/render/download`

  // ---- Divider drag ----
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const pct = Math.min(80, Math.max(20, ((e.clientX - rect.left) / rect.width) * 100))
      setDividerPct(pct)
    }
    const onMouseUp = () => { isDragging.current = false }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  // Reset divider when toggling off
  useEffect(() => {
    if (!active) setDividerPct(50)
  }, [active])

  // Sync right video play/pause with left video
  useEffect(() => {
    const el = rightVideoRef.current
    if (!el || !active) return
    if (isPlaying) {
      void el.play().catch(() => {})
    } else {
      el.pause()
    }
  }, [isPlaying, active])

  // Sync right video currentTime with left video
  useEffect(() => {
    const el = rightVideoRef.current
    if (!el || !active || parentTime === undefined) return
    // Only seek if the difference is significant to avoid constant micro-seeks
    if (Math.abs(el.currentTime - parentTime) > 0.5) {
      el.currentTime = parentTime
    }
  }, [parentTime, active])

  // ---- Toggle button (always rendered) ----
  const toggleBtn = (
    <button
      onClick={onToggle}
      title={active ? 'Exit A/B Comparison' : 'A/B Compare with Last Render'}
      className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-medium transition ${
        active
          ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
          : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
      }`}
    >
      <Columns2 size={11} />
      A/B
    </button>
  )

  if (!active) {
    return (
      <>
        {children}
        <div className="mt-2 flex justify-end">{toggleBtn}</div>
      </>
    )
  }

  // ---- Split view ----
  return (
    <div className="flex flex-col gap-2">
      {/* Split container */}
      <div
        ref={containerRef}
        className="relative flex overflow-hidden rounded-lg"
        style={{ minHeight: '200px' }}
      >
        {/* Left panel: Current */}
        <div
          className="relative overflow-hidden"
          style={{ width: `${dividerPct}%` }}
        >
          {/* Label */}
          <div className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            Current (A)
          </div>
          {children}
        </div>

        {/* Draggable divider */}
        <div
          className="relative z-20 flex w-1 shrink-0 cursor-col-resize items-center justify-center bg-[var(--primary)]"
          onMouseDown={onMouseDown}
        >
          <div className="h-8 w-1 rounded-full bg-white/80" />
        </div>

        {/* Right panel: Last Render */}
        <div
          className="relative overflow-hidden bg-black"
          style={{ width: `${100 - dividerPct}%` }}
        >
          <div className="pointer-events-none absolute left-2 top-2 z-10 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            Last Render (B)
          </div>

          {hasRender ? (
            <video
              ref={rightVideoRef}
              src={renderDownloadUrl}
              className="absolute inset-0 h-full w-full object-contain bg-black"
              playsInline
              muted
              controls={false}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center p-4">
              <p className="text-center text-xs text-[var(--muted-foreground)]">
                No previous render to compare
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Controls row: A/B toggle */}
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-[var(--muted-foreground)]">
          Drag the divider to resize panels
        </p>
        {toggleBtn}
      </div>
    </div>
  )
}
