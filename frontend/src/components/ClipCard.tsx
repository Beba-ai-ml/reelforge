import { useState, useRef, useEffect, useCallback } from 'react'
import { Film, Image, Zap, Star } from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { Clip } from '@/types'

interface Props {
  clip: Clip
  onClick?: () => void
}

const fmtDuration = (s: number | null) => {
  if (s == null) return null
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

const fmtRelativeDate = (dateStr: string | null): string | null => {
  if (!dateStr) return null
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return null
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`
  // Fall back to formatted date
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function ClipCard({ clip, onClick }: Props) {
  const queryClient = useQueryClient()
  const [imgError, setImgError] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [videoLoaded, setVideoLoaded] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const duration = fmtDuration(clip.duration)
  const title = clip.title_en || clip.filename
  const isVideo = clip.type === 'video'
  const relativeDate = fmtRelativeDate(clip.imported_at || clip.created_at)

  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Pause video when hover ends
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!isHovered) {
      video.pause()
      video.currentTime = 0
    }
  }, [isHovered])

  // Play video once it has enough data to start (triggered by onCanPlay)
  const handleCanPlay = useCallback(() => {
    if (isHovered && videoRef.current) {
      videoRef.current.play().catch(() => { /* autoplay blocked */ })
    }
  }, [isHovered])

  const handleMouseEnter = useCallback(() => setIsHovered(true), [])
  const handleMouseLeave = useCallback(() => {
    setIsHovered(false)
    setVideoLoaded(false)
  }, [])

  const favoriteMutation = useMutation({
    mutationFn: () => api.toggleFavorite(clip.id),
    onSuccess: (data) => {
      // Optimistic update — invalidate so the list refreshes with new is_favorite
      queryClient.setQueryData<unknown>(['clip', clip.id], (old: unknown) => {
        if (!old || typeof old !== 'object') return old
        return { ...(old as Record<string, unknown>), is_favorite: data.is_favorite }
      })
      queryClient.invalidateQueries({ queryKey: ['clips'] })
    },
  })

  const handleFavoriteClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    favoriteMutation.mutate()
  }

  return (
    <div
      ref={cardRef}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="group cursor-pointer overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] transition hover:border-[var(--primary)]/60"
    >
      {/* Thumbnail */}
      <div className="relative aspect-video overflow-hidden bg-[var(--muted)]">
        {clip.thumbnail_path && !imgError && isVisible ? (
          <>
            {!imgLoaded && (
              <div className="absolute inset-0 bg-gradient-to-br from-[var(--muted)] to-[var(--card)]" />
            )}
            <img
              src={`/api/clips/${clip.id}/thumbnail`}
              alt={title}
              className={`h-full w-full object-cover transition group-hover:scale-105 ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
              onLoad={() => setImgLoaded(true)}
              onError={() => setImgError(true)}
            />
          </>
        ) : clip.thumbnail_path && !imgError && !isVisible ? (
          <div className="h-full w-full bg-gradient-to-br from-[var(--muted)] to-[var(--card)]" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-[var(--muted)] to-[var(--card)]">
            {clip.type === 'video' ? (
              <Film size={32} className="text-[var(--muted-foreground)]" />
            ) : (
              <Image size={32} className="text-[var(--muted-foreground)]" />
            )}
          </div>
        )}

        {/* Hover video preview (video clips only) */}
        {isVideo && isHovered && (
          <video
            ref={videoRef}
            src={`/api/clips/${clip.id}/file`}
            muted
            loop
            playsInline
            preload="auto"
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ${videoLoaded ? 'opacity-100' : 'opacity-0'}`}
            onLoadedData={() => setVideoLoaded(true)}
            onCanPlay={handleCanPlay}
          />
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 transition group-hover:opacity-100">
          <div className="p-3">
            <p className="mb-1 line-clamp-1 text-sm font-medium text-white">{title}</p>
            <div className="flex items-center gap-2">
              {duration && (
                <span className="text-xs text-zinc-300">{duration}</span>
              )}
              <span className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] font-medium uppercase text-white">
                {clip.type}
              </span>
            </div>
          </div>
        </div>

        {/* Duration badge (always visible, hides on hover when overlay shows) */}
        {duration && (
          <div className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white opacity-100 transition group-hover:opacity-0">
            {duration}
          </div>
        )}

        {/* Favorite star button */}
        <button
          onClick={handleFavoriteClick}
          title={clip.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
          className={`absolute right-2 top-2 rounded p-1 transition ${
            clip.is_favorite
              ? 'text-yellow-400 opacity-100'
              : 'text-white/70 opacity-0 group-hover:opacity-100'
          } hover:text-yellow-400`}
        >
          <Star
            size={16}
            className={clip.is_favorite ? 'fill-yellow-400' : ''}
          />
        </button>
      </div>

      {/* Bottom info */}
      <div className="flex items-center gap-2 px-3 py-2">
        {clip.category && (
          <span className="rounded-full bg-[var(--primary)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--primary)]">
            {clip.category}
          </span>
        )}
        {clip.is_dynamic && (
          <Zap size={12} className="text-yellow-400" />
        )}
        <span className="line-clamp-1 text-[11px] text-[var(--muted-foreground)]">
          {title}
        </span>
        {relativeDate && (
          <span className="ml-auto shrink-0 text-[10px] text-[var(--muted-foreground)]/60">
            {relativeDate}
          </span>
        )}
      </div>
    </div>
  )
}
