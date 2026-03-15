import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, ChevronDown, ChevronRight, History } from 'lucide-react'
import { api } from '@/api/client'
import type { RenderHistoryEntry } from '@/types'

interface Props {
  projectId: string
  /** When true the history is refetched (pass isRendering transition to trigger refresh) */
  refetchTrigger?: boolean
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return '—'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(sec: number | null): string {
  if (sec === null) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function HistoryRow({ entry, projectId }: { entry: RenderHistoryEntry; projectId: string }) {
  const downloadUrl = api.getRenderHistoryDownloadUrl(projectId, entry.id)

  return (
    <div className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--muted)]/40 px-3 py-2">
      <div className="flex-1 min-w-0">
        <p className="truncate text-xs font-medium text-[var(--foreground)]">
          {formatDate(entry.timestamp)}
        </p>
        <p className="text-[10px] text-[var(--muted-foreground)]">
          {entry.format} &middot; {formatDuration(entry.duration_sec)} &middot; {formatBytes(entry.file_size_bytes)}
        </p>
      </div>
      <a
        href={downloadUrl}
        download={entry.filename}
        className="flex shrink-0 items-center gap-1 rounded bg-[var(--primary)] px-2 py-1 text-[10px] font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)]"
        title={`Download ${entry.filename}`}
      >
        <Download size={11} />
        DL
      </a>
    </div>
  )
}

export default function RenderHistory({ projectId, refetchTrigger }: Props) {
  const [open, setOpen] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['render-history', projectId, refetchTrigger],
    queryFn: () => api.getRenderHistory(projectId),
    enabled: !!projectId,
    // Refetch when refetchTrigger changes (i.e., after a render completes)
    staleTime: 0,
  })

  const entries = data?.entries ?? []

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)]">
      {/* Collapsible header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm font-medium text-[var(--foreground)] transition hover:bg-[var(--muted)]/50"
      >
        <History size={14} className="shrink-0 text-[var(--muted-foreground)]" />
        <span className="flex-1">Render History</span>
        {entries.length > 0 && (
          <span className="rounded-full bg-[var(--muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)]">
            {entries.length}
          </span>
        )}
        {open ? (
          <ChevronDown size={14} className="shrink-0 text-[var(--muted-foreground)]" />
        ) : (
          <ChevronRight size={14} className="shrink-0 text-[var(--muted-foreground)]" />
        )}
      </button>

      {/* Content */}
      {open && (
        <div className="border-t border-[var(--border)] px-4 py-3">
          {isLoading ? (
            <p className="text-center text-xs text-[var(--muted-foreground)]">Loading...</p>
          ) : entries.length === 0 ? (
            <p className="text-center text-xs text-[var(--muted-foreground)]">No render history yet</p>
          ) : (
            <div className="flex flex-col gap-2">
              {entries.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} projectId={projectId} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
