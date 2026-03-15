import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Plus, Loader2, X } from 'lucide-react'
import { api } from '@/api/client'
import type { Project } from '@/types'

interface Props {
  onCreated: (project: Project) => void
  onCancel: () => void
}

const FORMAT_OPTIONS = [
  { value: '9:16', label: '9:16 (Reel)' },
  { value: '16:9', label: '16:9 (Landscape)' },
  { value: '1:1', label: '1:1 (Square)' },
]

export default function ProjectSetup({ onCreated, onCancel }: Props) {
  const [name, setName] = useState('')
  const [format, setFormat] = useState('9:16')

  const createMutation = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), output_format: format }),
    onSuccess: (project) => onCreated(project),
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    createMutation.mutate()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-2xl"
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">New Project</h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <X size={20} />
          </button>
        </div>

        <label className="mb-1 block text-sm text-[var(--muted-foreground)]">Project Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Reel"
          autoFocus
          className="mb-4 w-full rounded-lg border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:ring-2 focus:ring-[var(--ring)]"
        />

        <label className="mb-2 block text-sm text-[var(--muted-foreground)]">Output Format</label>
        <div className="mb-5 flex gap-3">
          {FORMAT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setFormat(opt.value)}
              className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                format === opt.value
                  ? 'border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--primary)]'
                  : 'border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--muted-foreground)]'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {createMutation.isError && (
          <p className="mb-3 text-sm text-[var(--destructive)]">
            {(createMutation.error as Error).message}
          </p>
        )}

        <button
          type="submit"
          disabled={!name.trim() || createMutation.isPending}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)] disabled:opacity-50"
        >
          {createMutation.isPending ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Plus size={16} />
          )}
          Create Project
        </button>
      </form>
    </div>
  )
}
