import { useState, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Upload, Loader2, Film, Clock, X, Copy, Download, FileUp, ChevronDown } from 'lucide-react'
import { api } from '@/api/client'
import type { Project } from '@/types'
import ProjectSetup from '@/components/ProjectSetup'

// ---- Helpers ----------------------------------------------------------------

const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const fmtDuration = (s: number | null) => {
  if (s == null) return '--:--'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

const statusColor: Record<string, string> = {
  draft: 'bg-gray-800/40 text-gray-400',
  created: 'bg-gray-800/40 text-gray-400',
  uploaded: 'bg-blue-900/40 text-blue-400',
  transcribing: 'bg-yellow-900/40 text-yellow-400',
  transcribed: 'bg-green-900/40 text-green-400',
  editing: 'bg-blue-900/40 text-blue-400',
  rendering: 'bg-orange-900/40 text-orange-400',
  rendered: 'bg-emerald-900/40 text-emerald-400',
  done: 'bg-emerald-900/40 text-emerald-400',
  error: 'bg-red-900/40 text-red-400',
}

// ---- Sort / Filter types ----------------------------------------------------

type SortOption = 'created_desc' | 'created_asc' | 'name_asc' | 'name_desc' | 'status' | 'updated_desc'
type StatusFilter = 'all' | 'draft' | 'uploaded' | 'transcribed' | 'rendered' | 'error'

const SORT_LABELS: Record<SortOption, string> = {
  created_desc: 'Newest first',
  created_asc: 'Oldest first',
  name_asc: 'Name A–Z',
  name_desc: 'Name Z–A',
  status: 'Status',
  updated_desc: 'Last modified',
}

const STATUS_FILTERS: StatusFilter[] = ['all', 'draft', 'uploaded', 'transcribed', 'rendered', 'error']

// Map filter label → statuses that match it
const STATUS_MATCH: Record<StatusFilter, string[]> = {
  all: [],
  draft: ['draft', 'created'],
  uploaded: ['uploaded'],
  transcribed: ['transcribed', 'transcribing', 'editing'],
  rendered: ['rendered', 'rendering', 'done'],
  error: ['error'],
}

// ---- Project Card -----------------------------------------------------------

interface ProjectCardProps {
  project: Project
  onOpen: (p: Project) => void
  onDuplicate: (id: string) => void
  onExport: (id: string) => void
  onDelete: (id: string) => void
}

function ProjectCard({ project: p, onOpen, onDuplicate, onExport, onDelete }: ProjectCardProps) {
  return (
    <div
      onClick={() => onOpen(p)}
      className="group cursor-pointer overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] transition hover:border-[var(--primary)]/40"
    >
      {/* Thumbnail */}
      <div className="aspect-video w-full overflow-hidden bg-gradient-to-br from-[var(--muted)] to-[var(--card)]">
        {p.thumbnail_path ? (
          <img
            src={api.getProjectThumbnail(p.id)}
            alt={p.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Film size={32} className="text-[var(--muted-foreground)]/30" />
          </div>
        )}
      </div>

      <div className="p-4">
        <div className="mb-3 flex items-start justify-between">
          <h3 className="text-sm font-semibold text-[var(--foreground)] group-hover:text-[var(--primary)]">
            {p.name}
          </h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColor[p.status] ?? statusColor.draft}`}
          >
            {p.status}
          </span>
        </div>

        <div className="flex items-center gap-4 text-xs text-[var(--muted-foreground)]">
          <span className="flex items-center gap-1">
            <Clock size={12} />
            {fmtDuration(p.duration)}
          </span>
          <span>{p.output_format}</span>
          <span>{fmtDate(p.created_at)}</span>
        </div>

        {p.subtitle_count != null && p.subtitle_count > 0 && (
          <p className="mt-2 text-xs text-[var(--muted-foreground)]">
            {p.subtitle_count} subtitles
          </p>
        )}

        <div className="mt-3 flex justify-end gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); onDuplicate(p.id) }}
            title="Duplicate"
            className="rounded p-1 text-[var(--muted-foreground)] opacity-0 transition hover:text-[var(--primary)] group-hover:opacity-100"
          >
            <Copy size={14} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onExport(p.id) }}
            title="Export"
            className="rounded p-1 text-[var(--muted-foreground)] opacity-0 transition hover:text-[var(--primary)] group-hover:opacity-100"
          >
            <Download size={14} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(p.id) }}
            title="Delete"
            className="rounded p-1 text-[var(--muted-foreground)] opacity-0 transition hover:text-[var(--destructive)] group-hover:opacity-100"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

// ---- Empty State ------------------------------------------------------------

interface EmptyStateProps {
  onCreate: () => void
}

function EmptyState({ onCreate }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-[var(--muted)]">
        <Film size={36} className="text-[var(--muted-foreground)]" />
      </div>
      <h3 className="mb-2 text-lg font-semibold text-[var(--foreground)]">No projects yet</h3>
      <p className="mb-6 max-w-xs text-sm text-[var(--muted-foreground)]">
        Create your first reel to get started. Upload a clip, add subtitles, and export in minutes.
      </p>
      <button
        onClick={onCreate}
        className="flex items-center gap-2 rounded-lg bg-[var(--primary)] px-5 py-2.5 text-sm font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)]"
      >
        <Plus size={16} />
        Create Project
      </button>
    </div>
  )
}

// ---- Project Grid -----------------------------------------------------------

interface ProjectGridProps {
  projects: Project[]
  onOpen: (p: Project) => void
  onDuplicate: (id: string) => void
  onExport: (id: string) => void
  onDelete: (id: string) => void
}

function ProjectGrid({ projects, onOpen, onDuplicate, onExport, onDelete }: ProjectGridProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {projects.map((p) => (
        <ProjectCard
          key={p.id}
          project={p}
          onOpen={onOpen}
          onDuplicate={onDuplicate}
          onExport={onExport}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}

// ---- Main Dashboard ---------------------------------------------------------

export default function Dashboard() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [showCreate, setShowCreate] = useState(false)
  const [uploadTarget, setUploadTarget] = useState<Project | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  // Sort + filter state
  const [sortBy, setSortBy] = useState<SortOption>('created_desc')
  const [filterStatus, setFilterStatus] = useState<StatusFilter>('all')

  const { data: projects, isLoading } = useQuery({
    queryKey: ['projects'],
    queryFn: api.listProjects,
  })

  const deleteMutation = useMutation({
    mutationFn: api.deleteProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setDeleteConfirm(null)
    },
  })

  const duplicateMutation = useMutation({
    mutationFn: api.duplicateProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  const importMutation = useMutation({
    mutationFn: api.importProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
  })

  // Sorted + filtered list (all client-side)
  const processedProjects = useMemo(() => {
    if (!projects) return []

    // 1. Filter
    const filtered =
      filterStatus === 'all'
        ? projects
        : projects.filter((p) => STATUS_MATCH[filterStatus].includes(p.status))

    // 2. Sort
    const sorted = [...filtered].sort((a, b) => {
      switch (sortBy) {
        case 'created_desc':
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        case 'created_asc':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        case 'name_asc':
          return a.name.localeCompare(b.name)
        case 'name_desc':
          return b.name.localeCompare(a.name)
        case 'status':
          return a.status.localeCompare(b.status)
        case 'updated_desc':
          return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        default:
          return 0
      }
    })

    return sorted
  }, [projects, sortBy, filterStatus])

  // Recent projects: top 3 by updated_at (only shown when >3 total)
  const recentProjects = useMemo(() => {
    if (!projects || projects.length <= 3) return []
    return [...projects]
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 3)
  }, [projects])

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result as string)
        importMutation.mutate(data)
      } catch {
        // invalid JSON
      }
    }
    reader.readAsText(file)
  }

  const handleCreated = (project: Project) => {
    queryClient.invalidateQueries({ queryKey: ['projects'] })
    setShowCreate(false)
    setUploadTarget(project)
  }

  const handleOpen = useCallback(
    (p: Project) => {
      if (p.clip_a_path) {
        navigate(`/editor/${p.id}`)
      } else {
        setUploadTarget(p)
      }
    },
    [navigate],
  )

  const handleUpload = useCallback(
    async (file: File) => {
      if (!uploadTarget) return
      setUploading(true)
      try {
        await api.uploadClipA(uploadTarget.id, file)
        queryClient.invalidateQueries({ queryKey: ['projects'] })
        navigate(`/editor/${uploadTarget.id}`)
      } catch {
        setUploading(false)
      }
    },
    [uploadTarget, navigate, queryClient],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragActive(false)
      const file = e.dataTransfer.files[0]
      if (file) void handleUpload(file)
    },
    [handleUpload],
  )

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void handleUpload(file)
  }

  const isEmpty = !isLoading && projects && projects.length === 0

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      {/* Header row */}
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-semibold text-[var(--foreground)]">Projects</h2>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--foreground)] transition hover:border-[var(--primary)]/40">
            <FileUp size={16} />
            Import
            <input
              type="file"
              accept=".json"
              onChange={handleImportFile}
              className="hidden"
            />
          </label>
          <button
            onClick={() => setShowCreate(true)}
            className="flex items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)]"
          >
            <Plus size={16} />
            New Project
          </button>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-[var(--primary)]" />
        </div>
      )}

      {/* Empty state */}
      {isEmpty && <EmptyState onCreate={() => setShowCreate(true)} />}

      {/* Sort / filter controls — only when projects exist */}
      {!isLoading && projects && projects.length > 0 && (
        <>
          {/* Controls row */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            {/* Status filter chips */}
            <div className="flex flex-wrap items-center gap-1.5">
              {STATUS_FILTERS.map((s) => (
                <button
                  key={s}
                  onClick={() => setFilterStatus(s)}
                  className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition ${
                    filterStatus === s
                      ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                      : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>

            {/* Sort dropdown */}
            <div className="relative">
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                className="appearance-none cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--card)] py-1.5 pl-3 pr-8 text-xs text-[var(--foreground)] transition hover:border-[var(--primary)]/40 focus:outline-none"
              >
                {(Object.entries(SORT_LABELS) as [SortOption, string][]).map(([val, label]) => (
                  <option key={val} value={val}>
                    {label}
                  </option>
                ))}
              </select>
              <ChevronDown
                size={12}
                className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
              />
            </div>
          </div>

          {/* Recent section — only when there are >3 projects */}
          {recentProjects.length > 0 && (
            <section className="mb-8">
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                Recent Projects
              </h3>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {recentProjects.map((p) => (
                  <div
                    key={p.id}
                    className="rounded-xl border border-[var(--border)] bg-[var(--muted)]/30"
                  >
                    <ProjectCard
                      project={p}
                      onOpen={handleOpen}
                      onDuplicate={(id) => duplicateMutation.mutate(id)}
                      onExport={(id) => api.exportProject(id)}
                      onDelete={(id) => setDeleteConfirm(id)}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Main project grid (sorted + filtered) */}
          {processedProjects.length > 0 ? (
            <>
              {recentProjects.length > 0 && (
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                  All Projects
                </h3>
              )}
              <ProjectGrid
                projects={processedProjects}
                onOpen={handleOpen}
                onDuplicate={(id) => duplicateMutation.mutate(id)}
                onExport={(id) => api.exportProject(id)}
                onDelete={(id) => setDeleteConfirm(id)}
              />
            </>
          ) : (
            /* No results for current filter */
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm text-[var(--muted-foreground)]">
                No projects match the current filter.
              </p>
              <button
                onClick={() => setFilterStatus('all')}
                className="mt-3 text-xs text-[var(--primary)] hover:underline"
              >
                Clear filter
              </button>
            </div>
          )}
        </>
      )}

      {/* Create Dialog */}
      {showCreate && (
        <ProjectSetup onCreated={handleCreated} onCancel={() => setShowCreate(false)} />
      )}

      {/* Upload Dialog */}
      {uploadTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-[var(--foreground)]">
                Upload Media - {uploadTarget.name}
              </h2>
              <button
                onClick={() => setUploadTarget(null)}
                className="rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                <X size={20} />
              </button>
            </div>

            {uploading ? (
              <div className="flex flex-col items-center py-10">
                <Loader2 size={32} className="mb-3 animate-spin text-[var(--primary)]" />
                <p className="text-sm text-[var(--muted-foreground)]">Uploading...</p>
              </div>
            ) : (
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragActive(true)
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                className={`flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed px-6 py-12 transition ${
                  dragActive
                    ? 'border-[var(--primary)] bg-[var(--primary)]/5'
                    : 'border-[var(--border)] hover:border-[var(--muted-foreground)]'
                }`}
              >
                <Upload size={36} className="mb-3 text-[var(--muted-foreground)]" />
                <p className="mb-1 text-sm text-[var(--foreground)]">
                  Drag & drop your video or audio file
                </p>
                <p className="mb-4 text-xs text-[var(--muted-foreground)]">
                  MP4, MOV, MP3, WAV supported
                </p>
                <label className="cursor-pointer rounded-lg bg-[var(--muted)] px-4 py-2 text-sm text-[var(--foreground)] transition hover:bg-[var(--border)]">
                  Browse Files
                  <input
                    type="file"
                    accept="video/*,audio/*"
                    onChange={handleFileInput}
                    className="hidden"
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-2xl">
            <h3 className="mb-2 text-sm font-semibold text-[var(--foreground)]">Delete Project?</h3>
            <p className="mb-5 text-sm text-[var(--muted-foreground)]">
              This action cannot be undone. All project data will be permanently deleted.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="rounded-lg px-3 py-1.5 text-sm text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                Cancel
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteConfirm)}
                disabled={deleteMutation.isPending}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--destructive)] px-3 py-1.5 text-sm font-medium text-white transition hover:bg-[var(--destructive)]/80 disabled:opacity-50"
              >
                {deleteMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
