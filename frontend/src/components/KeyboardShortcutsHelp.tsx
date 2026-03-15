import { X, Keyboard } from 'lucide-react'

interface ShortcutRow {
  keys: string[]
  description: string
}

const SHORTCUTS: ShortcutRow[] = [
  { keys: ['Space'], description: 'Play / Pause' },
  { keys: ['J'], description: 'Seek backward 5 seconds' },
  { keys: ['K'], description: 'Seek forward 5 seconds' },
  { keys: ['←'], description: 'Seek backward 1 second' },
  { keys: ['→'], description: 'Seek forward 1 second' },
  { keys: ['Ctrl', 'Z'], description: 'Undo last action' },
  { keys: ['Ctrl', 'Shift', 'Z'], description: 'Redo last undone action' },
  { keys: ['Ctrl', 'S'], description: 'Save (show confirmation)' },
  { keys: ['D'], description: 'Delete selected timeline item / subtitle' },
  { keys: ['Del'], description: 'Delete selected timeline item / subtitle' },
  { keys: ['?'], description: 'Show / hide this help panel' },
]

interface Props {
  onClose: () => void
}

export default function KeyboardShortcutsHelp({ onClose }: Props) {
  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Dialog */}
      <div
        className="relative w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--card)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="mb-5 flex items-center gap-2">
          <Keyboard size={18} className="text-[var(--primary)]" />
          <h2 className="text-base font-semibold text-[var(--foreground)]">Keyboard Shortcuts</h2>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Shortcut list */}
        <div className="space-y-2">
          {SHORTCUTS.map((row) => (
            <div
              key={row.description}
              className="flex items-center justify-between gap-4 rounded-lg px-2 py-1.5 hover:bg-[var(--muted)]"
            >
              <span className="text-sm text-[var(--foreground)]">{row.description}</span>
              <div className="flex shrink-0 items-center gap-1">
                {row.keys.map((k, i) => (
                  <kbd
                    key={i}
                    className="rounded border border-[var(--border)] bg-[var(--muted)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--muted-foreground)]"
                  >
                    {k}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-4 text-[10px] text-[var(--muted-foreground)]">
          Shortcuts are disabled while typing in text fields.
        </p>
      </div>
    </div>
  )
}
