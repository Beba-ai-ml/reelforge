import { useQuery } from '@tanstack/react-query'
import { X, Loader2 } from 'lucide-react'
import { api } from '@/api/client'
import type { Alternative } from '@/types'

interface Props {
  projectId: string
  itemId: number
  onSelect: (alt: Alternative) => void
  onClose: () => void
}

export default function ClipReplacer({ projectId, itemId, onSelect, onClose }: Props) {
  const { data: alternatives, isLoading } = useQuery({
    queryKey: ['alternatives', projectId, itemId],
    queryFn: () => api.getAlternatives(projectId, itemId),
  })

  return (
    <div className="flex flex-col rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-lg">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2">
        <h4 className="text-xs font-semibold text-[var(--foreground)]">AI Suggestions</h4>
        <button
          onClick={onClose}
          className="rounded p-0.5 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
        >
          <X size={14} />
        </button>
      </div>

      <div className="max-h-[400px] overflow-y-auto p-2">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-[var(--primary)]" />
          </div>
        )}

        {!isLoading && alternatives && alternatives.length === 0 && (
          <p className="py-4 text-center text-xs text-[var(--muted-foreground)]">
            No alternatives found
          </p>
        )}

        {alternatives?.map((alt, i) => (
          <button
            key={alt.clip.id}
            onClick={() => onSelect(alt)}
            className="mb-1 flex w-full items-start gap-3 rounded-lg p-2 text-left transition hover:bg-[var(--muted)]"
          >
            {/* Thumbnail placeholder */}
            <div className="flex h-10 w-14 flex-shrink-0 items-center justify-center rounded bg-gradient-to-br from-green-600/30 to-green-800/30">
              <span className="text-[10px] font-bold text-green-400">#{i + 1}</span>
            </div>
            <div className="flex-1 overflow-hidden">
              <div className="flex items-center gap-2">
                <span className="truncate text-xs font-medium text-[var(--foreground)]">
                  {alt.clip.title_en || alt.clip.filename}
                </span>
                <span className="flex-shrink-0 rounded bg-[var(--primary)]/20 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--primary)]">
                  {Math.round(alt.score * 100)}%
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[10px] text-[var(--muted-foreground)]">
                {alt.reason}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
