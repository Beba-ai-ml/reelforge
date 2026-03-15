import { useState, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  X,
  Loader2,
  Trash2,
  Sparkles,
  Tag,
  Film,
  Image,
  Zap,
  ExternalLink,
} from 'lucide-react'
import { api } from '@/api/client'
import type { Clip, Category, ClipSegment } from '@/types'

interface Props {
  clipId: string
  onClose: () => void
  onDeleted?: () => void
}

const fmtDuration = (s: number | null) => {
  if (s == null) return '--:--'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

const fmtSegTime = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = (s % 60).toFixed(1)
  return `${m}:${sec.padStart(4, '0')}`
}

export default function ClipDetail({ clipId, onClose, onDeleted }: Props) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  const { data: clip, isLoading } = useQuery({
    queryKey: ['clip', clipId],
    queryFn: () => api.getClip(clipId),
  })

  const { data: usageData } = useQuery({
    queryKey: ['clip-usage', clipId],
    queryFn: () => api.getClipUsage(clipId),
  })

  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: api.listCategories,
  })

  // Editable fields
  const [editTitle, setEditTitle] = useState<string | null>(null)
  const [editCategory, setEditCategory] = useState<string | null>(null)
  const [editTags, setEditTags] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)

  const updateMutation = useMutation({
    mutationFn: (data: Partial<Clip>) => api.updateClip(clipId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clip', clipId] })
      queryClient.invalidateQueries({ queryKey: ['clips'] })
      setEditTitle(null)
      setEditCategory(null)
      setEditTags(null)
    },
  })

  const [analyzeRunning, setAnalyzeRunning] = useState(false)
  const analyzeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const analyzeMutation = useMutation({
    mutationFn: () => api.analyzeClip(clipId),
    onSuccess: () => {
      // Analysis runs in background — start polling for completion
      setAnalyzeRunning(true)
    },
  })

  // Poll clip data while analysis is running to detect when it's done
  useEffect(() => {
    if (!analyzeRunning) {
      if (analyzeTimerRef.current) {
        clearInterval(analyzeTimerRef.current)
        analyzeTimerRef.current = null
      }
      return
    }
    analyzeTimerRef.current = setInterval(async () => {
      try {
        const fresh = await api.getClip(clipId)
        if (fresh.title_en) {
          // Analysis is done — refresh everything
          setAnalyzeRunning(false)
          queryClient.invalidateQueries({ queryKey: ['clip', clipId] })
          queryClient.invalidateQueries({ queryKey: ['clips'] })
          queryClient.invalidateQueries({ queryKey: ['library-stats'] })
        }
      } catch { /* ignore */ }
    }, 2000)
    return () => {
      if (analyzeTimerRef.current) {
        clearInterval(analyzeTimerRef.current)
        analyzeTimerRef.current = null
      }
    }
  }, [analyzeRunning, clipId, queryClient])

  const categorizeMutation = useMutation({
    mutationFn: () => api.categorizeClip(clipId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clip', clipId] })
      queryClient.invalidateQueries({ queryKey: ['clips'] })
      queryClient.invalidateQueries({ queryKey: ['categories'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteClip(clipId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clips'] })
      queryClient.invalidateQueries({ queryKey: ['categories'] })
      queryClient.invalidateQueries({ queryKey: ['library-stats'] })
      onDeleted?.()
      onClose()
    },
  })

  if (isLoading || !clip) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-8 py-6">
          <Loader2 size={20} className="animate-spin text-[var(--primary)]" />
          <span className="text-sm text-[var(--muted-foreground)]">Loading clip...</span>
        </div>
      </div>
    )
  }

  const title = clip.title_en || clip.filename
  let parsedTags: string[] = []
  try {
    if (clip.tags) parsedTags = JSON.parse(clip.tags)
  } catch {
    // tags not valid JSON, ignore
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
          <div className="flex items-center gap-3">
            {clip.type === 'video' ? (
              <Film size={18} className="text-[var(--primary)]" />
            ) : (
              <Image size={18} className="text-[var(--primary)]" />
            )}
            <h2 className="text-lg font-semibold text-[var(--foreground)]">{title}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body - scrollable */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid gap-6 md:grid-cols-2">
            {/* Left: Media */}
            <div>
              {clip.type === 'video' ? (
                <video
                  src={`/api/clips/${clip.id}/file`}
                  controls
                  className="w-full rounded-lg bg-black"
                  poster={clip.thumbnail_path ? `/api/clips/${clip.id}/thumbnail` : undefined}
                />
              ) : (
                <img
                  src={`/api/clips/${clip.id}/file`}
                  alt={title}
                  className="w-full rounded-lg bg-[var(--muted)] object-contain"
                />
              )}

              {/* Metadata */}
              <div className="mt-4 grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-[var(--muted)] px-3 py-2">
                  <p className="text-[10px] uppercase text-[var(--muted-foreground)]">Duration</p>
                  <p className="text-sm font-medium text-[var(--foreground)]">{fmtDuration(clip.duration)}</p>
                </div>
                <div className="rounded-lg bg-[var(--muted)] px-3 py-2">
                  <p className="text-[10px] uppercase text-[var(--muted-foreground)]">Type</p>
                  <p className="text-sm font-medium text-[var(--foreground)]">{clip.type}</p>
                </div>
                {clip.fps != null && (
                  <div className="rounded-lg bg-[var(--muted)] px-3 py-2">
                    <p className="text-[10px] uppercase text-[var(--muted-foreground)]">FPS</p>
                    <p className="text-sm font-medium text-[var(--foreground)]">{clip.fps}</p>
                  </div>
                )}
                {clip.width != null && clip.height != null && (
                  <div className="rounded-lg bg-[var(--muted)] px-3 py-2">
                    <p className="text-[10px] uppercase text-[var(--muted-foreground)]">Resolution</p>
                    <p className="text-sm font-medium text-[var(--foreground)]">{clip.width}x{clip.height}</p>
                  </div>
                )}
                <div className="rounded-lg bg-[var(--muted)] px-3 py-2">
                  <p className="text-[10px] uppercase text-[var(--muted-foreground)]">Dynamic</p>
                  <p className="flex items-center gap-1 text-sm font-medium text-[var(--foreground)]">
                    {clip.is_dynamic ? (
                      <>
                        <Zap size={12} className="text-yellow-400" /> Yes
                      </>
                    ) : (
                      'No'
                    )}
                  </p>
                </div>
                <div className="rounded-lg bg-[var(--muted)] px-3 py-2">
                  <p className="text-[10px] uppercase text-[var(--muted-foreground)]">Focus</p>
                  <p className="text-sm font-medium text-[var(--foreground)]">
                    {clip.focus_x.toFixed(2)}, {clip.focus_y.toFixed(2)}
                  </p>
                </div>
              </div>
            </div>

            {/* Right: Details + Edit */}
            <div className="flex flex-col gap-4">
              {/* Title */}
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                  Title (EN)
                </label>
                {editTitle !== null ? (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--muted)] px-3 py-1.5 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-[var(--ring)]"
                      autoFocus
                    />
                    <button
                      onClick={() => updateMutation.mutate({ title_en: editTitle })}
                      disabled={updateMutation.isPending}
                      className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] hover:bg-[var(--accent)]"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditTitle(null)}
                      className="rounded-lg px-2 py-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <p
                    onClick={() => setEditTitle(clip.title_en || '')}
                    className="cursor-pointer rounded-lg border border-transparent px-3 py-1.5 text-sm text-[var(--foreground)] transition hover:border-[var(--border)] hover:bg-[var(--muted)]"
                  >
                    {clip.title_en || <span className="italic text-[var(--muted-foreground)]">Click to set title</span>}
                  </p>
                )}
              </div>

              {/* Polish title */}
              {clip.title_pl && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                    Title (PL)
                  </label>
                  <p className="text-sm text-[var(--foreground)]">{clip.title_pl}</p>
                </div>
              )}

              {/* Summary */}
              {(clip.summary_en || clip.summary_pl) && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                    Summary
                  </label>
                  <p className="text-sm leading-relaxed text-[var(--foreground)]">
                    {clip.summary_en || clip.summary_pl}
                  </p>
                </div>
              )}

              {/* Category */}
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                  Category
                </label>
                {editCategory !== null ? (
                  <div className="flex gap-2">
                    <select
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value)}
                      className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--muted)] px-3 py-1.5 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-[var(--ring)]"
                    >
                      <option value="">Uncategorized</option>
                      {categories?.map((cat: Category) => (
                        <option key={cat.name} value={cat.name}>
                          {cat.display_name || cat.name}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => updateMutation.mutate({ category: editCategory || null })}
                      disabled={updateMutation.isPending}
                      className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] hover:bg-[var(--accent)]"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditCategory(null)}
                      className="rounded-lg px-2 py-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <p
                    onClick={() => setEditCategory(clip.category || '')}
                    className="cursor-pointer rounded-lg border border-transparent px-3 py-1.5 text-sm text-[var(--foreground)] transition hover:border-[var(--border)] hover:bg-[var(--muted)]"
                  >
                    {clip.category ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Tag size={12} className="text-[var(--primary)]" />
                        {clip.category}
                      </span>
                    ) : (
                      <span className="italic text-[var(--muted-foreground)]">Click to set category</span>
                    )}
                  </p>
                )}
              </div>

              {/* Tags */}
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
                  Tags
                </label>
                {editTags !== null ? (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={editTags}
                      onChange={(e) => setEditTags(e.target.value)}
                      placeholder="tag1, tag2, tag3"
                      className="flex-1 rounded-lg border border-[var(--border)] bg-[var(--muted)] px-3 py-1.5 text-sm text-[var(--foreground)] outline-none focus:ring-2 focus:ring-[var(--ring)]"
                    />
                    <button
                      onClick={() => {
                        const tagsArr = editTags.split(',').map((t) => t.trim()).filter(Boolean)
                        updateMutation.mutate({ tags: JSON.stringify(tagsArr) })
                      }}
                      disabled={updateMutation.isPending}
                      className="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] hover:bg-[var(--accent)]"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditTags(null)}
                      className="rounded-lg px-2 py-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div
                    onClick={() => setEditTags(parsedTags.join(', '))}
                    className="cursor-pointer rounded-lg border border-transparent px-3 py-1.5 transition hover:border-[var(--border)] hover:bg-[var(--muted)]"
                  >
                    {parsedTags.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {parsedTags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-[var(--muted)] px-2 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)]"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm italic text-[var(--muted-foreground)]">Click to add tags</span>
                    )}
                  </div>
                )}
              </div>

              {/* Segments */}
              {clip.segments && clip.segments.length > 0 && (
                <div>
                  <label className="mb-2 block text-xs font-medium text-[var(--muted-foreground)]">
                    Segments ({clip.segments.length})
                  </label>
                  <div className="max-h-48 space-y-1 overflow-y-auto">
                    {clip.segments.map((seg: ClipSegment) => (
                      <div
                        key={seg.id}
                        className="rounded-lg bg-[var(--muted)] px-3 py-2"
                      >
                        <div className="flex items-center gap-2 text-[10px] font-medium text-[var(--primary)]">
                          <span>{fmtSegTime(seg.start_time)}</span>
                          <span className="text-[var(--muted-foreground)]">-</span>
                          <span>{fmtSegTime(seg.end_time)}</span>
                        </div>
                        {seg.description_en && (
                          <p className="mt-0.5 text-xs text-[var(--foreground)]">
                            {seg.description_en}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Usage tracking */}
              <div>
                <label className="mb-2 block text-xs font-medium text-[var(--muted-foreground)]">
                  Project Usage
                </label>
                {usageData === undefined ? (
                  <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                    <Loader2 size={12} className="animate-spin" />
                    Loading...
                  </div>
                ) : usageData.usage_count === 0 ? (
                  <p className="text-xs italic text-[var(--muted-foreground)]">
                    Not used in any project
                  </p>
                ) : (
                  <div className="space-y-1">
                    <p className="text-xs text-[var(--muted-foreground)]">
                      Used in {usageData.usage_count} project{usageData.usage_count !== 1 ? 's' : ''}
                    </p>
                    <div className="max-h-32 space-y-1 overflow-y-auto">
                      {usageData.projects.map((proj) => (
                        <button
                          key={proj.id}
                          onClick={() => {
                            onClose()
                            navigate(`/editor/${proj.id}`)
                          }}
                          className="flex w-full items-center gap-1.5 rounded-lg bg-[var(--muted)] px-3 py-1.5 text-left text-xs text-[var(--foreground)] transition hover:bg-[var(--accent)]"
                        >
                          <ExternalLink size={11} className="shrink-0 text-[var(--primary)]" />
                          <span className="truncate">{proj.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer - actions */}
        <div className="flex items-center justify-between border-t border-[var(--border)] px-6 py-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => analyzeMutation.mutate()}
              disabled={analyzeMutation.isPending || analyzeRunning}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-50"
            >
              {analyzeMutation.isPending || analyzeRunning ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Sparkles size={12} />
              )}
              {analyzeRunning ? 'Analyzing...' : 'Analyze (AI)'}
            </button>
            <button
              onClick={() => categorizeMutation.mutate()}
              disabled={categorizeMutation.isPending}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-50"
            >
              {categorizeMutation.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Tag size={12} />
              )}
              Categorize
            </button>
          </div>

          <div>
            {deleteConfirm ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-[var(--muted-foreground)]">Delete clip?</span>
                <button
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                  className="flex items-center gap-1 rounded-lg bg-[var(--destructive)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--destructive)]/80 disabled:opacity-50"
                >
                  {deleteMutation.isPending && <Loader2 size={12} className="animate-spin" />}
                  Confirm
                </button>
                <button
                  onClick={() => setDeleteConfirm(false)}
                  className="rounded-lg px-2 py-1.5 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setDeleteConfirm(true)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--destructive)]"
              >
                <Trash2 size={12} />
                Delete
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
