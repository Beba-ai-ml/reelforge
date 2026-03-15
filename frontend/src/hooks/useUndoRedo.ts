import { useState, useCallback, useRef } from 'react'

export interface UndoRedoAction {
  type: string
  description: string
  undo: () => Promise<void>
  redo: () => Promise<void>
}

const MAX_HISTORY = 50

export interface UndoRedoAPI {
  pushAction: (action: UndoRedoAction) => void
  undo: () => Promise<void>
  redo: () => Promise<void>
  canUndo: boolean
  canRedo: boolean
  undoDescription: string | null
  redoDescription: string | null
  clear: () => void
}

export function useUndoRedo(): UndoRedoAPI {
  // Use refs for stacks to avoid stale closures inside undo/redo callbacks
  const undoStackRef = useRef<UndoRedoAction[]>([])
  const redoStackRef = useRef<UndoRedoAction[]>([])

  // Mirror to state so consumers can re-render on changes
  const [undoCount, setUndoCount] = useState(0)
  const [redoCount, setRedoCount] = useState(0)
  const [undoDesc, setUndoDesc] = useState<string | null>(null)
  const [redoDesc, setRedoDesc] = useState<string | null>(null)

  const syncState = useCallback(() => {
    const u = undoStackRef.current
    const r = redoStackRef.current
    setUndoCount(u.length)
    setRedoCount(r.length)
    setUndoDesc(u.length > 0 ? u[u.length - 1].description : null)
    setRedoDesc(r.length > 0 ? r[r.length - 1].description : null)
  }, [])

  const pushAction = useCallback(
    (action: UndoRedoAction) => {
      // Add to undo stack, trim to MAX_HISTORY
      undoStackRef.current = [
        ...undoStackRef.current.slice(-(MAX_HISTORY - 1)),
        action,
      ]
      // Clear redo stack whenever a new action is pushed
      redoStackRef.current = []
      syncState()
    },
    [syncState],
  )

  const undo = useCallback(async () => {
    const stack = undoStackRef.current
    if (stack.length === 0) return

    const action = stack[stack.length - 1]
    undoStackRef.current = stack.slice(0, -1)
    redoStackRef.current = [...redoStackRef.current, action]
    syncState()

    await action.undo()
  }, [syncState])

  const redo = useCallback(async () => {
    const stack = redoStackRef.current
    if (stack.length === 0) return

    const action = stack[stack.length - 1]
    redoStackRef.current = stack.slice(0, -1)
    undoStackRef.current = [...undoStackRef.current, action]
    syncState()

    await action.redo()
  }, [syncState])

  const clear = useCallback(() => {
    undoStackRef.current = []
    redoStackRef.current = []
    syncState()
  }, [syncState])

  return {
    pushAction,
    undo,
    redo,
    canUndo: undoCount > 0,
    canRedo: redoCount > 0,
    undoDescription: undoDesc,
    redoDescription: redoDesc,
    clear,
  }
}
