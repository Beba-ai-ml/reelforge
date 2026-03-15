import { useEffect, useCallback } from 'react'

export type ShortcutActions = {
  togglePlay?: () => void
  seekBackward?: (seconds: number) => void
  seekForward?: (seconds: number) => void
  undo?: () => void
  redo?: () => void
  save?: () => void
  deleteSelected?: () => void
  showHelp?: () => void
}

function isInputFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    (el as HTMLElement).isContentEditable
  )
}

export function useKeyboardShortcuts(actions: ShortcutActions) {
  const handler = useCallback(
    (e: KeyboardEvent) => {
      // Never intercept when typing in a text field
      if (isInputFocused()) return

      const key = e.key
      const ctrl = e.ctrlKey || e.metaKey
      const shift = e.shiftKey

      // Ctrl+Shift+Z — redo
      if (ctrl && shift && (key === 'Z' || key === 'z')) {
        e.preventDefault()
        actions.redo?.()
        return
      }

      // Ctrl+Z — undo
      if (ctrl && !shift && key === 'z') {
        e.preventDefault()
        actions.undo?.()
        return
      }

      // Ctrl+S — save
      if (ctrl && key === 's') {
        e.preventDefault()
        actions.save?.()
        return
      }

      // No modifier shortcuts
      if (ctrl || e.altKey) return

      switch (key) {
        case ' ':
          e.preventDefault()
          actions.togglePlay?.()
          break
        case 'j':
        case 'J':
          e.preventDefault()
          actions.seekBackward?.(5)
          break
        case 'k':
        case 'K':
          e.preventDefault()
          actions.seekForward?.(5)
          break
        case 'ArrowLeft':
          e.preventDefault()
          actions.seekBackward?.(1)
          break
        case 'ArrowRight':
          e.preventDefault()
          actions.seekForward?.(1)
          break
        case 'd':
        case 'D':
        case 'Delete':
          e.preventDefault()
          actions.deleteSelected?.()
          break
        case '?':
          e.preventDefault()
          actions.showHelp?.()
          break
        default:
          break
      }
    },
    [actions],
  )

  useEffect(() => {
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [handler])
}
