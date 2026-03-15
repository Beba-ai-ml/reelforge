import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Search,
  Upload,
  Film,
  Image,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Zap,
  Sparkles,
  Tags,
  Trash2,
  CheckSquare,
  Square,
  X,
  Star,
  FolderOpen,
  SortAsc,
} from 'lucide-react'
import { api } from '@/api/client'
import type { Category, Clip, SortOption } from '@/types'
import ClipCard from '@/components/ClipCard'
import ClipDetail from '@/components/ClipDetail'
import ImportDialog from '@/components/ImportDialog'

const PAGE_SIZE = 50
const VIRTUAL_THRESHOLD = 50
const ROW_HEIGHT = 240 // approximate height of a ClipCard row in px
const BUFFER_ROWS = 3

const fmtMinutes = (totalSeconds: number) => {
  const mins = Math.floor(totalSeconds / 60)
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  const rem = mins % 60
  return `${hours}h ${rem}m`
}

function VirtualGrid({
  clips,
  loading,
  hasFilters,
  totalInLibrary,
  onClipClick,
  onImport,
  selectMode,
  selectedIds,
  onToggleSelect,
}: {
  clips: Clip[]
  loading: boolean
  hasFilters: boolean
  totalInLibrary: number
  onClipClick: (id: string) => void
  onImport: () => void
  selectMode?: boolean
  selectedIds?: Set<string>
  onToggleSelect?: (id: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [containerHeight, setContainerHeight] = useState(0)
  const [cols, setCols] = useState(4)

  // Detect column count from container width
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width
      setContainerHeight(entry.contentRect.height)
      // Match grid breakpoints: sm:2 md:3 lg:4
      if (w >= 1024) setCols(4)
      else if (w >= 768) setCols(3)
      else if (w >= 640) setCols(2)
      else setCols(1)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const onScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop)
    }
  }, [])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-4">
        <Loader2 size={24} className="animate-spin text-[var(--primary)]" />
      </div>
    )
  }

  if (clips.length === 0) {
    // Library is completely empty — show onboarding empty state
    if (totalInLibrary === 0 && !hasFilters) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-20 text-center">
          <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl border-2 border-dashed border-[var(--border)] bg-[var(--muted)]">
            <FolderOpen size={36} className="text-[var(--muted-foreground)]" />
          </div>
          <h3 className="mb-2 text-xl font-semibold text-[var(--foreground)]">
            No clips in your library
          </h3>
          <p className="mb-6 max-w-sm text-sm text-[var(--muted-foreground)]">
            Import clips to start building your B-Roll collection
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={onImport}
              className="flex items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)]"
            >
              <Upload size={16} />
              Import Clips
            </button>
          </div>
        </div>
      )
    }
    // Has filters but no results
    return (
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-20 text-center">
        <Film size={48} className="mb-4 text-[var(--muted-foreground)]" />
        <p className="mb-1 text-lg text-[var(--foreground)]">No clips found</p>
        <p className="text-sm text-[var(--muted-foreground)]">
          {hasFilters ? 'Try adjusting your filters.' : 'Import some clips to get started.'}
        </p>
      </div>
    )
  }

  // Below threshold: render everything normally
  const renderClip = (clip: Clip) => (
    <div key={clip.id} className="relative">
      {selectMode && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSelect?.(clip.id) }}
          className="absolute left-2 top-2 z-10 rounded bg-black/60 p-0.5"
        >
          {selectedIds?.has(clip.id) ? (
            <CheckSquare size={18} className="text-[var(--primary)]" />
          ) : (
            <Square size={18} className="text-white/70" />
          )}
        </button>
      )}
      <div className={selectMode && selectedIds?.has(clip.id) ? 'ring-2 ring-[var(--primary)] rounded-lg' : ''}>
        <ClipCard clip={clip} onClick={() => selectMode ? onToggleSelect?.(clip.id) : onClipClick(clip.id)} />
      </div>
    </div>
  )

  if (clips.length <= VIRTUAL_THRESHOLD) {
    return (
      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {clips.map(renderClip)}
        </div>
      </div>
    )
  }

  // Virtual scrolling for large lists
  const totalRows = Math.ceil(clips.length / cols)
  const totalHeight = totalRows * ROW_HEIGHT
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_ROWS)
  const visibleRows = Math.ceil(containerHeight / ROW_HEIGHT) + 2 * BUFFER_ROWS
  const endRow = Math.min(totalRows, startRow + visibleRows)

  const visibleClips: { clip: Clip; index: number }[] = []
  for (let row = startRow; row < endRow; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col
      if (idx < clips.length) {
        visibleClips.push({ clip: clips[idx], index: idx })
      }
    }
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto px-6 py-4"
      onScroll={onScroll}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div
          className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
          style={{
            position: 'absolute',
            top: startRow * ROW_HEIGHT,
            left: 0,
            right: 0,
          }}
        >
          {visibleClips.map(({ clip }) => renderClip(clip))}
        </div>
      </div>
    </div>
  )
}

export default function Library() {
  const queryClient = useQueryClient()

  // Filters
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<'all' | 'video' | 'image'>('all')
  const [dynamicOnly, setDynamicOnly] = useState(false)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [sortBy, setSortBy] = useState<SortOption>('date_newest')
  const [offset, setOffset] = useState(0)

  // UI state
  const [showImport, setShowImport] = useState(false)
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeProgress, setAnalyzeProgress] = useState<{
    current: number; total: number; current_clip: string; success: number; failed: number; cancelling?: boolean
  } | null>(null)
  const [categorizing, setCategorizing] = useState(false)
  const [selectedClipIds, setSelectedClipIds] = useState<Set<string>>(new Set())
  const [selectMode, setSelectMode] = useState(false)
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const analyzeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const toggleClipSelection = useCallback((id: string) => {
    setSelectedClipIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedClipIds(new Set())
    setSelectMode(false)
  }, [])

  const searchInputRef = useRef<HTMLInputElement>(null)

  // Poll analysis progress while analyzing
  useEffect(() => {
    if (!analyzing) {
      if (analyzeIntervalRef.current) {
        clearInterval(analyzeIntervalRef.current)
        analyzeIntervalRef.current = null
      }
      return
    }
    const poll = async () => {
      try {
        const p = await api.getAnalyzeProgress()
        if (p.status === 'done' || p.status === 'cancelled' || p.status === 'idle') {
          setAnalyzeProgress(p.status === 'idle' ? null : { current: p.current, total: p.total, current_clip: '', success: p.success, failed: p.failed })
          setAnalyzing(false)
          // Auto-refresh clip list, categories, and stats
          queryClient.invalidateQueries({ queryKey: ['clips'] })
          queryClient.invalidateQueries({ queryKey: ['categories'] })
          queryClient.invalidateQueries({ queryKey: ['library-stats'] })
        } else if (p.status === 'cancelling') {
          // Still running current clip — show "Cancelling..." but keep progress bar
          setAnalyzeProgress({ current: p.current, total: p.total, current_clip: p.current_clip, success: p.success, failed: p.failed, cancelling: true })
          queryClient.invalidateQueries({ queryKey: ['clips'] })
        } else {
          setAnalyzeProgress({ current: p.current, total: p.total, current_clip: p.current_clip, success: p.success, failed: p.failed, cancelling: false })
          // Also refresh periodically so new titles appear as clips get analyzed
          queryClient.invalidateQueries({ queryKey: ['clips'] })
        }
      } catch { /* ignore */ }
    }
    poll()
    analyzeIntervalRef.current = setInterval(poll, 1500)
    return () => {
      if (analyzeIntervalRef.current) {
        clearInterval(analyzeIntervalRef.current)
        analyzeIntervalRef.current = null
      }
    }
  }, [analyzing])

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search)
      setOffset(0)
    }, 300)
    return () => clearTimeout(timer)
  }, [search])

  // Reset offset when filters change
  useEffect(() => {
    setOffset(0)
  }, [selectedCategory, typeFilter, dynamicOnly, favoritesOnly, sortBy])

  // Queries
  const { data: stats } = useQuery({
    queryKey: ['library-stats'],
    queryFn: api.getLibraryStats,
  })

  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: api.listCategories,
  })

  const { data: clipsData, isLoading: clipsLoading } = useQuery({
    queryKey: ['clips', debouncedSearch, selectedCategory, typeFilter, dynamicOnly, offset],
    queryFn: () =>
      api.listClips({
        q: debouncedSearch || undefined,
        category: selectedCategory || undefined,
        type: typeFilter === 'all' ? undefined : typeFilter,
        is_dynamic: dynamicOnly || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
  })

  // Apply client-side favorites filter and sort
  const allClips = clipsData?.items ?? []
  const filteredClips = favoritesOnly ? allClips.filter((c) => c.is_favorite) : allClips
  const clips = [...filteredClips].sort((a, b) => {
    switch (sortBy) {
      case 'date_newest': {
        const da = new Date(a.imported_at || a.created_at).getTime()
        const db2 = new Date(b.imported_at || b.created_at).getTime()
        return db2 - da
      }
      case 'date_oldest': {
        const da = new Date(a.imported_at || a.created_at).getTime()
        const db2 = new Date(b.imported_at || b.created_at).getTime()
        return da - db2
      }
      case 'name_az': {
        const na = (a.title_en || a.filename).toLowerCase()
        const nb = (b.title_en || b.filename).toLowerCase()
        return na.localeCompare(nb)
      }
      case 'name_za': {
        const na = (a.title_en || a.filename).toLowerCase()
        const nb = (b.title_en || b.filename).toLowerCase()
        return nb.localeCompare(na)
      }
      default:
        return 0
    }
  })
  const total = clipsData?.total ?? 0
  const from = total > 0 ? offset + 1 : 0
  const to = Math.min(offset + PAGE_SIZE, total)
  const hasNext = offset + PAGE_SIZE < total
  const hasPrev = offset > 0

  return (
    <div className="flex h-[calc(100vh-49px)] flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
        <div className="flex items-center gap-4">
          <h2 className="text-xl font-semibold text-[var(--foreground)]">B-Roll Library</h2>
          {stats && (
            <div className="flex items-center gap-3 text-xs text-[var(--muted-foreground)]">
              <span className="flex items-center gap-1">
                <Film size={12} />
                {stats.total_clips} clips
              </span>
              <span>{stats.total_categories} categories</span>
              <span>{fmtMinutes(stats.total_duration)}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {analyzing && analyzeProgress ? (
            <div className="flex items-center gap-3">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin text-[var(--primary)]" />
                  <span className="text-xs text-[var(--foreground)]">
                    {analyzeProgress.cancelling ? 'Cancelling...' : `Analyzing ${analyzeProgress.current}/${analyzeProgress.total}`}
                  </span>
                  <span className="text-[10px] text-green-400">{analyzeProgress.success} ok</span>
                  {analyzeProgress.failed > 0 && (
                    <span className="text-[10px] text-red-400">{analyzeProgress.failed} failed</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-40 overflow-hidden rounded-full bg-[var(--muted)]">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${analyzeProgress.cancelling ? 'bg-red-500' : 'bg-[var(--primary)]'}`}
                      style={{ width: `${analyzeProgress.total > 0 ? (analyzeProgress.current / analyzeProgress.total) * 100 : 0}%` }}
                    />
                  </div>
                  {analyzeProgress.cancelling ? (
                    <span className="text-[10px] text-red-400">finishing current clip...</span>
                  ) : analyzeProgress.current_clip ? (
                    <span className="max-w-[120px] truncate text-[10px] text-[var(--muted-foreground)]">
                      {analyzeProgress.current_clip}
                    </span>
                  ) : null}
                </div>
              </div>
              <button
                onClick={async () => {
                  try { await api.cancelAnalyze() } catch { /* ignore */ }
                }}
                disabled={analyzeProgress.cancelling}
                className="rounded-lg border border-red-800 bg-red-900/30 px-2.5 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-900/50 disabled:opacity-50"
              >
                {analyzeProgress.cancelling ? 'Stopping...' : 'Stop'}
              </button>
            </div>
          ) : (
            <button
              onClick={async () => {
                setAnalyzing(true)
                setAnalyzeProgress(null)
                try {
                  await api.analyzeAllUnanalyzed()
                } catch { /* background task started */ }
              }}
              disabled={analyzing}
              className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-sm font-medium text-[var(--foreground)] transition hover:bg-[var(--accent)] disabled:opacity-50"
            >
              <Sparkles size={16} />
              Analyze All
            </button>
          )}
          <button
            onClick={async () => {
              setCategorizing(true)
              try {
                const res = await api.categorizeAllUncategorized()
                if (res.status === 'nothing_to_categorize') {
                  // Nothing to do — all clips already categorized or none analyzed
                }
              } catch { /* background task started */ }
              // Wait a bit for background task then refresh
              setTimeout(() => {
                setCategorizing(false)
                queryClient.invalidateQueries({ queryKey: ['clips'] })
                queryClient.invalidateQueries({ queryKey: ['categories'] })
                queryClient.invalidateQueries({ queryKey: ['library-stats'] })
              }, 2000)
            }}
            disabled={categorizing || analyzing}
            className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-sm font-medium text-[var(--foreground)] transition hover:bg-[var(--accent)] disabled:opacity-50"
          >
            {categorizing ? <Loader2 size={16} className="animate-spin" /> : <Tags size={16} />}
            Categorize All
          </button>
          <button
            onClick={() => setShowImport(true)}
            className="flex items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)]"
          >
            <Upload size={16} />
            Import
          </button>
        </div>
      </div>

      {/* Content: sidebar + main */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar - categories */}
        <div className="w-[220px] shrink-0 overflow-y-auto border-r border-[var(--border)] p-3">
          <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
            Categories
          </p>
          <button
            onClick={() => setSelectedCategory(null)}
            className={`mb-0.5 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition ${
              selectedCategory === null
                ? 'bg-[var(--primary)]/15 text-[var(--primary)]'
                : 'text-[var(--foreground)] hover:bg-[var(--muted)]'
            }`}
          >
            <span>All</span>
            {stats && (
              <span className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)]">
                {stats.total_clips}
              </span>
            )}
          </button>
          {categories?.map((cat: Category) => (
            <button
              key={cat.name}
              onClick={() => setSelectedCategory(cat.name)}
              className={`mb-0.5 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition ${
                selectedCategory === cat.name
                  ? 'bg-[var(--primary)]/15 text-[var(--primary)]'
                  : 'text-[var(--foreground)] hover:bg-[var(--muted)]'
              }`}
            >
              <span className="truncate">{cat.display_name || cat.name}</span>
              <span className="ml-2 shrink-0 rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)]">
                {cat.clip_count}
              </span>
            </button>
          ))}
        </div>

        {/* Main content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Search + filter bar */}
          <div className="border-b border-[var(--border)] px-6 py-3">
            <div className="flex items-center gap-4">
              {/* Search input */}
              <div className="relative flex-1">
                <Search
                  size={16}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
                />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search clips..."
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--muted)] py-2 pl-9 pr-3 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:ring-2 focus:ring-[var(--ring)]"
                />
              </div>

              {/* Type filter chips */}
              <div className="flex items-center gap-1.5">
                {(['all', 'video', 'image'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTypeFilter(t)}
                    className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      typeFilter === t
                        ? 'bg-[var(--primary)]/15 text-[var(--primary)]'
                        : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                    }`}
                  >
                    {t === 'video' && <Film size={12} />}
                    {t === 'image' && <Image size={12} />}
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>

              {/* Dynamic toggle */}
              <button
                onClick={() => setDynamicOnly(!dynamicOnly)}
                className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  dynamicOnly
                    ? 'bg-yellow-900/40 text-yellow-400'
                    : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                }`}
              >
                <Zap size={12} />
                Dynamic
              </button>

              {/* Favorites toggle */}
              <button
                onClick={() => setFavoritesOnly(!favoritesOnly)}
                className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  favoritesOnly
                    ? 'bg-yellow-900/40 text-yellow-400'
                    : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                }`}
                title="Show favorites only"
              >
                <Star size={12} className={favoritesOnly ? 'fill-yellow-400' : ''} />
                Favorites
              </button>

              {/* Sort dropdown */}
              <div className="flex items-center gap-1">
                <SortAsc size={12} className="text-[var(--muted-foreground)]" />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortOption)}
                  className="rounded-lg border border-[var(--border)] bg-[var(--muted)] py-1.5 pl-2 pr-6 text-xs text-[var(--foreground)] outline-none focus:ring-2 focus:ring-[var(--ring)]"
                >
                  <option value="date_newest">Date (newest)</option>
                  <option value="date_oldest">Date (oldest)</option>
                  <option value="name_az">Name A-Z</option>
                  <option value="name_za">Name Z-A</option>
                </select>
              </div>

              {/* Select mode toggle */}
              <button
                onClick={() => {
                  if (selectMode) clearSelection()
                  else setSelectMode(true)
                }}
                className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  selectMode
                    ? 'bg-[var(--primary)]/15 text-[var(--primary)]'
                    : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                }`}
              >
                <CheckSquare size={12} />
                Select
              </button>
            </div>

            {/* Selection action bar */}
            {selectMode && (
              <div className="mt-2 flex items-center gap-3">
                <span className="text-xs text-[var(--muted-foreground)]">
                  {selectedClipIds.size} selected
                </span>
                {selectedClipIds.size > 0 && (
                  <button
                    onClick={async () => {
                      if (!confirm(`Delete ${selectedClipIds.size} clip(s)? This cannot be undone.`)) return
                      setBulkDeleting(true)
                      try {
                        await api.deleteClipsBulk(Array.from(selectedClipIds))
                        queryClient.invalidateQueries({ queryKey: ['clips'] })
                        queryClient.invalidateQueries({ queryKey: ['categories'] })
                        queryClient.invalidateQueries({ queryKey: ['library-stats'] })
                        clearSelection()
                      } catch { /* ignore */ }
                      setBulkDeleting(false)
                    }}
                    disabled={bulkDeleting}
                    className="flex items-center gap-1 rounded-lg bg-red-900/30 px-3 py-1.5 text-xs font-medium text-red-400 transition hover:bg-red-900/50 disabled:opacity-50"
                  >
                    {bulkDeleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    Delete {selectedClipIds.size}
                  </button>
                )}
                <button
                  onClick={clearSelection}
                  className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  <X size={12} />
                  Cancel
                </button>
              </div>
            )}
          </div>

          {/* Grid */}
          <VirtualGrid
            clips={clips}
            loading={clipsLoading}
            hasFilters={!!(debouncedSearch || selectedCategory || typeFilter !== 'all' || dynamicOnly || favoritesOnly)}
            totalInLibrary={clipsData?.total ?? 0}
            onClipClick={(id) => setSelectedClipId(id)}
            onImport={() => setShowImport(true)}
            selectMode={selectMode}
            selectedIds={selectedClipIds}
            onToggleSelect={toggleClipSelection}
          />

          {/* Pagination */}
          {total > 0 && (
            <div className="flex items-center justify-between border-t border-[var(--border)] px-6 py-3">
              <span className="text-xs text-[var(--muted-foreground)]">
                {from}-{to} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  disabled={!hasPrev}
                  className="flex items-center gap-1 rounded-lg bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-40"
                >
                  <ChevronLeft size={14} />
                  Previous
                </button>
                <button
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  disabled={!hasNext}
                  className="flex items-center gap-1 rounded-lg bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-40"
                >
                  Next
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Import Dialog */}
      {showImport && <ImportDialog onClose={() => setShowImport(false)} />}

      {/* Clip Detail */}
      {selectedClipId && (
        <ClipDetail
          clipId={selectedClipId}
          onClose={() => setSelectedClipId(null)}
          onDeleted={() => setSelectedClipId(null)}
        />
      )}
    </div>
  )
}
