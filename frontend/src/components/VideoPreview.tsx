import { useRef, useState, useEffect, useCallback } from 'react'
import { Play, Pause, Volume2, VolumeX, Maximize2, Minimize2, Columns2 } from 'lucide-react'
import type { Subtitle, TimelineItem } from '@/types'
import KaraokeOverlay from './KaraokeOverlay'

interface Props {
  src: string
  mediaType: 'video' | 'audio'
  outputFormat?: string  // '9:16', '16:9', '1:1'
  onTimeUpdate?: (time: number) => void
  onDurationChange?: (dur: number) => void
  onPlayStateChange?: (playing: boolean) => void
  seekTo?: number | null
  subtitles?: Subtitle[]
  onEditSubtitleText?: (subtitleId: number, newText: string) => void
  timelineItems?: TimelineItem[]
  /** Whether A/B comparison mode is active */
  abActive?: boolean
  /** Callback to toggle A/B mode */
  onABToggle?: () => void
  /** Ref to receive the togglePlay function for external control (e.g. keyboard shortcuts) */
  togglePlayRef?: React.MutableRefObject<(() => void) | null>
}

/** Get container styles for the output format - uses explicit dimensions for portrait */
function getContainerStyle(fmt?: string): React.CSSProperties {
  if (fmt === '16:9') return {}  // landscape: natural width
  if (fmt === '1:1') return { width: '60vh', height: '60vh', maxWidth: '100%' }
  // portrait (9:16): explicit height + computed width avoids aspect-ratio bugs
  return { height: '70vh', width: 'calc(70vh * 9 / 16)', maxWidth: '100%' }
}

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

const SPEEDS = [0.5, 1, 1.5, 2]

/** Audio-only preview: shows current B-Roll clip thumbnail based on playhead */
function AudioPreviewWithBroll({
  mediaRef,
  src,
  playing,
  currentTime,
  timelineItems,
}: {
  mediaRef: React.RefObject<HTMLAudioElement>
  src: string
  playing: boolean
  currentTime: number
  timelineItems?: TimelineItem[]
}) {
  // Find the B-Roll item at the current time (skip clip_a)
  const activeBroll = timelineItems?.find(
    (item) =>
      item.source_type === 'library' &&
      currentTime >= item.timeline_start &&
      currentTime < item.timeline_end,
  )

  const thumbnailUrl = activeBroll?.clip_id
    ? `/api/clips/${activeBroll.clip_id}/thumbnail`
    : null

  const videoUrl = activeBroll?.clip_id
    ? `/api/clips/${activeBroll.clip_id}/file`
    : null

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <audio ref={mediaRef} src={src} />
      {videoUrl ? (
        <BrollVideoPreview
          key={activeBroll!.clip_id!}
          videoUrl={videoUrl}
          thumbnailUrl={thumbnailUrl}
          playing={playing}
        />
      ) : thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt="B-Roll"
          className="absolute inset-0 object-cover"
          style={{ width: '100%', height: '100%' }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[var(--primary)]/20 to-[var(--accent)]/20">
          <div className="text-center">
            <div className="mb-2 text-4xl text-[var(--primary)]">
              {playing ? '...' : '---'}
            </div>
            <p className="text-sm text-[var(--muted-foreground)]">Audio Only</p>
          </div>
        </div>
      )}
    </div>
  )
}

/** Inline B-Roll video player (muted, auto-plays when parent plays) */
function BrollVideoPreview({
  videoUrl,
  thumbnailUrl,
  playing,
}: {
  videoUrl: string
  thumbnailUrl: string | null
  playing: boolean
}) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (playing) {
      void el.play().catch(() => {})
    } else {
      el.pause()
    }
  }, [playing])

  return (
    <video
      ref={ref}
      src={videoUrl}
      poster={thumbnailUrl ?? undefined}
      muted
      loop
      playsInline
      className="absolute inset-0 object-cover"
      style={{ width: '100%', height: '100%' }}
    />
  )
}

export default function VideoPreview({ src, mediaType, outputFormat, onTimeUpdate, onDurationChange, onPlayStateChange, seekTo, subtitles, onEditSubtitleText, timelineItems, abActive, onABToggle, togglePlayRef }: Props) {
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Sync isFullscreen state with native fullscreenchange events (e.g. user presses ESC)
  useEffect(() => {
    const handleFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFsChange)
    return () => document.removeEventListener('fullscreenchange', handleFsChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return
    if (isFullscreen) {
      void document.exitFullscreen()
    } else {
      void containerRef.current.requestFullscreen()
    }
  }, [isFullscreen])

  useEffect(() => {
    const el = mediaRef.current
    if (!el) return

    const onTime = () => {
      setCurrentTime(el.currentTime)
      onTimeUpdate?.(el.currentTime)
    }
    const onMeta = () => {
      setDuration(el.duration)
      onDurationChange?.(el.duration)
    }
    const onEnded = () => {
      setPlaying(false)
      onPlayStateChange?.(false)
    }

    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('ended', onEnded)

    return () => {
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('ended', onEnded)
    }
  }, [src])

  useEffect(() => {
    const el = mediaRef.current
    if (!el || seekTo === undefined || seekTo === null) return
    el.currentTime = seekTo
    setCurrentTime(seekTo)
  }, [seekTo])

  const togglePlay = useCallback(() => {
    const el = mediaRef.current
    if (!el) return
    if (playing) {
      el.pause()
    } else {
      void el.play()
    }
    const next = !playing
    setPlaying(next)
    onPlayStateChange?.(next)
  }, [playing, onPlayStateChange])

  // Expose togglePlay to parent via ref
  useEffect(() => {
    if (togglePlayRef) {
      togglePlayRef.current = togglePlay
    }
  }, [togglePlay, togglePlayRef])

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = mediaRef.current
    if (!el) return
    const time = parseFloat(e.target.value)
    el.currentTime = time
    setCurrentTime(time)
  }

  const handleSpeed = (rate: number) => {
    const el = mediaRef.current
    if (el) el.playbackRate = rate
    setSpeed(rate)
  }

  const handleVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = mediaRef.current
    const v = parseFloat(e.target.value)
    if (el) {
      el.volume = v
      el.muted = false
    }
    setVolume(v)
    setMuted(false)
  }

  const toggleMute = () => {
    const el = mediaRef.current
    if (el) el.muted = !muted
    setMuted(!muted)
  }

  // Find current subtitle for overlay
  const currentSub = subtitles?.find(
    (s) => currentTime >= s.start_time && currentTime <= s.end_time,
  ) ?? null

  return (
    <div className="flex flex-col gap-3">
      {/* Media element + subtitle overlay — wrapped in containerRef for fullscreen */}
      <div
        ref={containerRef}
        className="relative mx-auto overflow-hidden rounded-lg bg-black"
        style={isFullscreen ? { width: '100vw', height: '100vh', maxWidth: 'none', borderRadius: 0 } : getContainerStyle(outputFormat)}
      >
        {mediaType === 'video' ? (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            src={src}
            className="absolute inset-0 object-cover"
            style={{ width: '100%', height: '100%' }}
            playsInline
          />
        ) : (
          <AudioPreviewWithBroll
            mediaRef={mediaRef as React.RefObject<HTMLAudioElement>}
            src={src}
            playing={playing}
            currentTime={currentTime}
            timelineItems={timelineItems}
          />
        )}

        <KaraokeOverlay
          key={currentSub ? `${currentSub.id}-${currentSub.font_size}-${currentSub.color}-${currentSub.outline_color}-${currentSub.highlight_color}` : 'none'}
          subtitle={currentSub}
          currentTime={currentTime}
          karaokeStyle={currentSub?.karaoke_style}
          fontSize={currentSub?.font_size ?? undefined}
          color={currentSub?.color ?? undefined}
          outlineColor={currentSub?.outline_color ?? undefined}
          highlightColor={currentSub?.highlight_color ?? undefined}
          positionX={currentSub?.position_x}
          positionY={currentSub?.position_y}
          onEditText={onEditSubtitleText}
        />
      </div>

      {/* Controls row 1: play + seek + time */}
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--primary)] text-[var(--primary-foreground)] transition hover:bg-[var(--accent)]"
        >
          {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
        </button>

        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={currentTime}
          onChange={handleSeek}
          className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-[var(--muted)] accent-[var(--primary)]"
        />

        <span className="min-w-[70px] shrink-0 text-right text-xs text-[var(--muted-foreground)]">
          {fmtTime(currentTime)} / {fmtTime(duration)}
        </span>
      </div>

      {/* Controls row 2: speed + volume + fullscreen + A/B */}
      <div className="flex items-center gap-3">
        {/* Speed buttons */}
        <div className="flex items-center gap-1">
          {SPEEDS.map((rate) => (
            <button
              key={rate}
              onClick={() => handleSpeed(rate)}
              className={`rounded px-2 py-0.5 text-[10px] font-medium transition ${
                speed === rate
                  ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                  : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
              }`}
            >
              {rate}x
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* A/B Comparison toggle */}
        {onABToggle && (
          <button
            onClick={onABToggle}
            title={abActive ? 'Exit A/B Comparison' : 'Compare with Last Render'}
            className={`flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium transition ${
              abActive
                ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }`}
          >
            <Columns2 size={11} />
            A/B
          </button>
        )}

        {/* Fullscreen toggle */}
        <button
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          className="rounded p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
        >
          {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>

        {/* Volume */}
        <div className="flex items-center gap-2">
          <button
            onClick={toggleMute}
            className="rounded p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
          >
            {muted || volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={handleVolume}
            className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-[var(--muted)] accent-[var(--primary)]"
          />
        </div>
      </div>
    </div>
  )
}
