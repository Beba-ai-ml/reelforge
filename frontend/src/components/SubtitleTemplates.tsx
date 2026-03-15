import { useState } from 'react'
import { X, Save, ChevronDown } from 'lucide-react'
import type { SubtitleTemplate } from '@/types'

const STORAGE_KEY = 'reelforge-subtitle-templates'

const BUILTIN_TEMPLATES: SubtitleTemplate[] = [
  {
    id: '__instagram',
    name: 'Instagram Stories',
    karaokeStyle: 'classic',
    preset: 'body',
    fontSize: 72,
    color: '#FFFFFF',
    outlineColor: '#000000',
    highlightColor: '#FACC15',
    positionY: 0.85,
  },
  {
    id: '__tiktok',
    name: 'TikTok',
    karaokeStyle: 'pop',
    preset: 'hook',
    fontSize: 56,
    color: '#FACC15',
    outlineColor: '#000000',
    highlightColor: '#EF4444',
    positionY: 0.5,
  },
  {
    id: '__youtube',
    name: 'YouTube Shorts',
    karaokeStyle: 'typewriter',
    preset: 'body',
    fontSize: 64,
    color: '#FFFFFF',
    outlineColor: '#8B5CF6',
    highlightColor: '#8B5CF6',
    positionY: 0.7,
  },
]

function loadTemplates(): SubtitleTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    return JSON.parse(raw) as SubtitleTemplate[]
  } catch {
    return []
  }
}

function saveTemplates(templates: SubtitleTemplate[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates))
}

interface Props {
  currentKaraokeStyle: string
  currentPreset: string
  currentFontSize: number
  currentColor: string
  currentOutlineColor: string
  currentHighlightColor: string
  currentPositionY: number
  onApply: (template: SubtitleTemplate) => void
}

export default function SubtitleTemplates({
  currentKaraokeStyle,
  currentPreset,
  currentFontSize,
  currentColor,
  currentOutlineColor,
  currentHighlightColor,
  currentPositionY,
  onApply,
}: Props) {
  const [userTemplates, setUserTemplates] = useState<SubtitleTemplate[]>(loadTemplates)
  const [saveDialogOpen, setSaveDialogOpen] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [dropdownOpen, setDropdownOpen] = useState(false)

  const allTemplates = [...BUILTIN_TEMPLATES, ...userTemplates]

  const handleSave = () => {
    const name = newTemplateName.trim()
    if (!name) return
    const template: SubtitleTemplate = {
      id: `user_${Date.now()}`,
      name,
      karaokeStyle: currentKaraokeStyle,
      preset: currentPreset,
      fontSize: currentFontSize,
      color: currentColor,
      outlineColor: currentOutlineColor,
      highlightColor: currentHighlightColor,
      positionY: currentPositionY,
    }
    const updated = [...userTemplates, template]
    setUserTemplates(updated)
    saveTemplates(updated)
    setNewTemplateName('')
    setSaveDialogOpen(false)
  }

  const handleDelete = (id: string) => {
    const updated = userTemplates.filter((t) => t.id !== id)
    setUserTemplates(updated)
    saveTemplates(updated)
  }

  const handleApply = (template: SubtitleTemplate) => {
    onApply(template)
    setDropdownOpen(false)
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="block text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
        Templates
      </label>

      <div className="flex gap-1.5">
        {/* Template select dropdown */}
        <div className="relative flex-1">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex w-full items-center justify-between gap-1 rounded-lg border border-[var(--border)] bg-[var(--muted)] px-2.5 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
          >
            <span>Load template…</span>
            <ChevronDown size={11} />
          </button>

          {dropdownOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 w-full min-w-[180px] rounded-lg border border-[var(--border)] bg-[var(--card)] shadow-lg">
              {allTemplates.length === 0 ? (
                <p className="px-3 py-2 text-[10px] text-[var(--muted-foreground)]">No templates saved</p>
              ) : (
                allTemplates.map((t) => {
                  const isBuiltin = t.id.startsWith('__')
                  return (
                    <div
                      key={t.id}
                      className="flex items-center justify-between px-2 py-1.5 hover:bg-[var(--muted)] transition cursor-pointer group"
                    >
                      <button
                        onClick={() => handleApply(t)}
                        className="flex-1 text-left text-xs text-[var(--foreground)]"
                      >
                        {t.name}
                        {isBuiltin && (
                          <span className="ml-1.5 text-[9px] text-[var(--muted-foreground)]">built-in</span>
                        )}
                      </button>
                      {!isBuiltin && (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(t.id) }}
                          className="ml-1 rounded p-0.5 text-[var(--muted-foreground)] opacity-0 transition group-hover:opacity-100 hover:text-red-400"
                        >
                          <X size={10} />
                        </button>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          )}
        </div>

        {/* Save as Template button */}
        <button
          onClick={() => setSaveDialogOpen(!saveDialogOpen)}
          title="Save current style as template"
          className="flex items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--muted)] px-2.5 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
        >
          <Save size={11} />
          Save
        </button>
      </div>

      {/* Save name input */}
      {saveDialogOpen && (
        <div className="flex gap-1.5">
          <input
            type="text"
            value={newTemplateName}
            onChange={(e) => setNewTemplateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
              if (e.key === 'Escape') setSaveDialogOpen(false)
            }}
            placeholder="Template name…"
            autoFocus
            className="flex-1 rounded border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-xs text-[var(--foreground)] outline-none focus:ring-1 focus:ring-[var(--ring)]"
          />
          <button
            onClick={handleSave}
            disabled={!newTemplateName.trim()}
            className="rounded-lg bg-[var(--primary)] px-2.5 py-1 text-xs text-[var(--primary-foreground)] transition disabled:opacity-40 hover:opacity-90"
          >
            Save
          </button>
          <button
            onClick={() => setSaveDialogOpen(false)}
            className="rounded-lg bg-[var(--muted)] px-2 py-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Backdrop to close dropdown */}
      {dropdownOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
      )}
    </div>
  )
}
