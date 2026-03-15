import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Film, Image, Zap, ChevronRight, ChevronLeft, Plus } from 'lucide-react'
import { api } from '@/api/client'
import type { Clip, Category } from '@/types'

interface Props {
  onAddClip: (clip: Clip) => void
}

const fmtDuration = (s: number | null) => {
  if (s == null) return null
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function EditorLibraryPanel({ onAddClip }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState('')

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300)
    return () => clearTimeout(timer)
  }, [search])

  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: api.listCategories,
  })

  const { data: clipsData, isLoading } = useQuery({
    queryKey: ['editor-clips', debouncedSearch, selectedCategory],
    queryFn: () =>
      api.listClips({
        q: debouncedSearch || undefined,
        category: selectedCategory || undefined,
        limit: 30,
      }),
  })

  const clips = clipsData?.items ?? []

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-l border-[var(--border)] bg-[var(--card)] pt-3">
        <button
          onClick={() => setCollapsed(false)}
          className="rounded p-1.5 text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
          title="Show Library"
        >
          <ChevronLeft size={14} />
        </button>
        <span className="mt-2 text-[10px] text-[var(--muted-foreground)] [writing-mode:vertical-lr]">
          Library
        </span>
      </div>
    )
  }

  return (
    <div className="flex w-[250px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--card)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
        <span className="text-xs font-semibold text-[var(--foreground)]">Library</span>
        <button
          onClick={() => setCollapsed(true)}
          className="rounded p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Search */}
      <div className="border-b border-[var(--border)] px-3 py-2">
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search clips..."
            className="w-full rounded border border-[var(--border)] bg-[var(--muted)] py-1.5 pl-7 pr-2 text-[11px] text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:ring-1 focus:ring-[var(--ring)]"
          />
        </div>

        {/* Category filter */}
        <select
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
          className="mt-2 w-full rounded border border-[var(--border)] bg-[var(--muted)] px-2 py-1 text-[11px] text-[var(--foreground)] outline-none"
        >
          <option value="">All categories</option>
          {categories?.map((cat: Category) => (
            <option key={cat.name} value={cat.name}>
              {cat.display_name || cat.name} ({cat.clip_count})
            </option>
          ))}
        </select>
      </div>

      {/* Clip list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--primary)] border-t-transparent" />
          </div>
        )}

        {!isLoading && clips.length === 0 && (
          <p className="px-3 py-6 text-center text-[11px] text-[var(--muted-foreground)]">
            No clips found
          </p>
        )}

        {clips.map((clip: Clip) => (
          <ClipRow key={clip.id} clip={clip} onAdd={() => onAddClip(clip)} />
        ))}
      </div>
    </div>
  )
}

function ClipRow({ clip, onAdd }: { clip: Clip; onAdd: () => void }) {
  const [imgError, setImgError] = useState(false)
  const title = clip.title_en || clip.filename
  const duration = fmtDuration(clip.duration)

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-clip-id', clip.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      className="group flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 transition hover:bg-[var(--muted)]"
    >
      {/* Thumbnail */}
      <div className="h-9 w-14 shrink-0 overflow-hidden rounded bg-[var(--muted)]">
        {clip.thumbnail_path && !imgError ? (
          <img
            src={`/api/clips/${clip.id}/thumbnail`}
            alt={title}
            className="h-full w-full object-cover"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            {clip.type === 'video' ? (
              <Film size={14} className="text-[var(--muted-foreground)]" />
            ) : (
              <Image size={14} className="text-[var(--muted-foreground)]" />
            )}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium text-[var(--foreground)]">{title}</p>
        <div className="flex items-center gap-1.5">
          {duration && (
            <span className="text-[10px] text-[var(--muted-foreground)]">{duration}</span>
          )}
          {clip.category && (
            <span className="rounded bg-[var(--primary)]/15 px-1 py-0.5 text-[9px] font-medium text-[var(--primary)]">
              {clip.category}
            </span>
          )}
          {clip.is_dynamic && <Zap size={10} className="text-yellow-400" />}
        </div>
      </div>

      {/* Add button */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onAdd()
        }}
        className="shrink-0 rounded p-1 text-[var(--muted-foreground)] opacity-0 transition hover:bg-[var(--primary)]/15 hover:text-[var(--primary)] group-hover:opacity-100"
        title="Add at playhead"
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
