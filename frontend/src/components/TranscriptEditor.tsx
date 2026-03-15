import { useState, useRef, useEffect } from 'react'
import { Edit2, X, RefreshCw, AlertTriangle } from 'lucide-react'
import type { Word } from '@/types'

interface Props {
  words: Word[]
  onRegenerateSubtitles: () => void
  isRegenerating: boolean
}

function wordsToText(words: Word[]): string {
  return words.map((w) => w.word).join(' ')
}

export default function TranscriptEditor({ words, onRegenerateSubtitles, isRegenerating }: Props) {
  const [isEditing, setIsEditing] = useState(false)
  const [editedText, setEditedText] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const rawText = wordsToText(words)

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [editedText])

  function handleEditClick() {
    setEditedText(rawText)
    setIsEditing(true)
    setShowConfirm(false)
  }

  function handleCancel() {
    setIsEditing(false)
    setEditedText('')
    setShowConfirm(false)
  }

  function handleRegenerate() {
    setShowConfirm(true)
  }

  function handleConfirmRegenerate() {
    setShowConfirm(false)
    setIsEditing(false)
    setEditedText('')
    onRegenerateSubtitles()
  }

  function handleCancelConfirm() {
    setShowConfirm(false)
  }

  // --- Confirm dialog ---
  if (showConfirm) {
    return (
      <div className="rounded-lg border border-yellow-500/30 bg-yellow-900/20 p-4">
        <div className="mb-3 flex items-start gap-2">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-yellow-400" />
          <p className="text-sm text-[var(--foreground)]">
            This will replace all current subtitles with a freshly generated set. Continue?
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleConfirmRegenerate}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)]"
          >
            <RefreshCw size={12} />
            Yes, Regenerate
          </button>
          <button
            onClick={handleCancelConfirm}
            className="rounded-lg bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // --- Edit mode ---
  if (isEditing) {
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--muted)] p-3">
        <p className="mb-2 text-xs font-medium text-[var(--muted-foreground)]">
          Edit Transcript
        </p>
        <textarea
          ref={textareaRef}
          value={editedText}
          onChange={(e) => setEditedText(e.target.value)}
          className="w-full resize-none rounded border border-[var(--border)] bg-[var(--background)] p-2 font-mono text-sm leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--primary)]"
          rows={8}
          spellCheck={false}
        />
        <div className="mt-2 flex gap-2">
          <button
            onClick={handleRegenerate}
            disabled={isRegenerating || editedText.trim() === ''}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)] disabled:opacity-50"
          >
            <RefreshCw size={12} className={isRegenerating ? 'animate-spin' : ''} />
            Regenerate Subtitles
          </button>
          <button
            onClick={handleCancel}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
          >
            <X size={12} />
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // --- View mode ---
  return (
    <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--muted)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-[var(--muted-foreground)]">Raw Transcript</p>
        <button
          onClick={handleEditClick}
          className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-[var(--muted-foreground)] transition hover:bg-[var(--border)] hover:text-[var(--foreground)]"
          title="Edit transcript text"
        >
          <Edit2 size={10} />
          Edit
        </button>
      </div>
      <p className="text-sm leading-relaxed text-[var(--foreground)]">{rawText}</p>
    </div>
  )
}
