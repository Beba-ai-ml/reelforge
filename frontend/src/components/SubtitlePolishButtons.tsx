import { useState } from 'react'
import { SpellCheck, Zap, Minimize2, Loader2, Check, X } from 'lucide-react'
import { api } from '@/api/client'
import type { PolishMode, BulkPolishResult } from '@/types'

// ---------------------------------------------------------------------------
// Per-subtitle Polish Buttons
// ---------------------------------------------------------------------------

interface PerSubtitleProps {
  projectId: string
  subtitleId: number
  onApply: (subtitleId: number, newText: string) => void
}

interface PendingPolish {
  mode: PolishMode
  originalText: string
  polishedText: string
}

export function SubtitlePolishButtons({ projectId, subtitleId, onApply }: PerSubtitleProps) {
  const [loading, setLoading] = useState<PolishMode | null>(null)
  const [pending, setPending] = useState<PendingPolish | null>(null)

  const polish = async (mode: PolishMode) => {
    setLoading(mode)
    setPending(null)
    try {
      const result = await api.polishSubtitle(projectId, subtitleId, mode)
      setPending({
        mode,
        originalText: result.original_text,
        polishedText: result.polished_text,
      })
    } catch (err) {
      console.error('Polish failed:', err)
    } finally {
      setLoading(null)
    }
  }

  const apply = () => {
    if (!pending) return
    onApply(subtitleId, pending.polishedText)
    setPending(null)
  }

  const discard = () => setPending(null)

  if (pending) {
    return (
      <div className="mt-1.5 rounded bg-[var(--card)] border border-[var(--border)] p-2 text-[10px]">
        <p className="mb-1 text-[var(--muted-foreground)]">
          <span className="font-medium text-[var(--foreground)]">AI suggestion:</span>
        </p>
        <p className="mb-2 text-sm text-[var(--foreground)]">{pending.polishedText}</p>
        <div className="flex gap-1">
          <button
            onClick={(e) => { e.stopPropagation(); apply() }}
            className="flex items-center gap-1 rounded bg-[var(--primary)] px-2 py-0.5 text-[10px] font-medium text-[var(--primary-foreground)] hover:opacity-90"
          >
            <Check size={10} />
            Apply
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); discard() }}
            className="flex items-center gap-1 rounded bg-[var(--muted)] px-2 py-0.5 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <X size={10} />
            Discard
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-1 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {(
        [
          { mode: 'grammar' as PolishMode, icon: SpellCheck, label: 'Grammar' },
          { mode: 'punchier' as PolishMode, icon: Zap, label: 'Punchy' },
          { mode: 'shorter' as PolishMode, icon: Minimize2, label: 'Short' },
        ] as const
      ).map(({ mode, icon: Icon, label }) => (
        <button
          key={mode}
          title={`AI: ${label}`}
          onClick={() => polish(mode)}
          disabled={loading !== null}
          className="flex items-center gap-0.5 rounded bg-[var(--muted)] px-1.5 py-0.5 text-[9px] text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-40"
        >
          {loading === mode ? (
            <Loader2 size={9} className="animate-spin" />
          ) : (
            <Icon size={9} />
          )}
          {label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bulk Polish Toolbar
// ---------------------------------------------------------------------------

interface BulkPolishToolbarProps {
  projectId: string
  onApplyAll: (results: BulkPolishResult[]) => void
}

export function BulkPolishToolbar({ projectId, onApplyAll }: BulkPolishToolbarProps) {
  const [loading, setLoading] = useState<PolishMode | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [pending, setPending] = useState<{ mode: PolishMode; results: BulkPolishResult[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const bulkPolish = async (mode: PolishMode) => {
    setLoading(mode)
    setProgress('Polishing subtitles...')
    setError(null)
    setPending(null)
    try {
      const result = await api.bulkPolishSubtitles(projectId, mode)
      setProgress(null)
      setPending({ mode, results: result.results })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Bulk polish failed'
      setError(msg)
      setProgress(null)
    } finally {
      setLoading(null)
    }
  }

  const applyAll = () => {
    if (!pending) return
    onApplyAll(pending.results)
    setPending(null)
  }

  const discardAll = () => setPending(null)

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
      <p className="mb-2 text-[10px] font-semibold text-[var(--foreground)]">AI Polish — All Subtitles</p>

      <div className="flex flex-wrap gap-1">
        {(
          [
            { mode: 'grammar' as PolishMode, icon: SpellCheck, label: 'Fix Grammar' },
            { mode: 'punchier' as PolishMode, icon: Zap, label: 'Make Punchier' },
            { mode: 'shorter' as PolishMode, icon: Minimize2, label: 'Shorten All' },
          ] as const
        ).map(({ mode, icon: Icon, label }) => (
          <button
            key={mode}
            onClick={() => bulkPolish(mode)}
            disabled={loading !== null}
            className="flex items-center gap-1 rounded-lg bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-40"
          >
            {loading === mode ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Icon size={12} />
            )}
            {label}
          </button>
        ))}
      </div>

      {progress && (
        <p className="mt-2 text-[10px] text-[var(--muted-foreground)]">{progress}</p>
      )}

      {error && (
        <p className="mt-2 text-[10px] text-red-400">{error}</p>
      )}

      {pending && (
        <div className="mt-2 rounded border border-[var(--border)] bg-[var(--muted)] p-2">
          <p className="mb-1.5 text-[10px] text-[var(--foreground)]">
            <span className="font-medium">{pending.results.length} subtitles</span> polished ({pending.mode}). Apply all?
          </p>
          <div className="flex gap-1">
            <button
              onClick={applyAll}
              className="flex items-center gap-1 rounded bg-[var(--primary)] px-2 py-0.5 text-[10px] font-medium text-[var(--primary-foreground)] hover:opacity-90"
            >
              <Check size={10} />
              Apply All
            </button>
            <button
              onClick={discardAll}
              className="flex items-center gap-1 rounded bg-[var(--card)] px-2 py-0.5 text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              <X size={10} />
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
