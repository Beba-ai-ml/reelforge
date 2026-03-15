import { createContext, useContext, useReducer, useCallback, type Dispatch } from 'react'

// ---- Types ----------------------------------------------------------------

export type ToastType = 'success' | 'error' | 'info' | 'warning'

export interface Toast {
  id: string
  type: ToastType
  message: string
  duration: number
}

type Action =
  | { type: 'ADD'; toast: Toast }
  | { type: 'REMOVE'; id: string }
  | { type: 'CLEAR' }

// ---- Reducer ----------------------------------------------------------------

const MAX_TOASTS = 5

function reducer(state: Toast[], action: Action): Toast[] {
  switch (action.type) {
    case 'ADD': {
      const next = [action.toast, ...state]
      return next.slice(0, MAX_TOASTS)
    }
    case 'REMOVE':
      return state.filter((t) => t.id !== action.id)
    case 'CLEAR':
      return []
    default:
      return state
  }
}

// ---- Context ----------------------------------------------------------------

export interface ToastContextValue {
  toasts: Toast[]
  dispatch: Dispatch<Action>
}

export const ToastContext = createContext<ToastContextValue | null>(null)

// ---- Hook -------------------------------------------------------------------

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export interface ToastAPI {
  success: (message: string, duration?: number) => void
  error: (message: string, duration?: number) => void
  info: (message: string, duration?: number) => void
  warning: (message: string, duration?: number) => void
  dismiss: (id: string) => void
  clear: () => void
}

export function useToast(): { toast: ToastAPI; toasts: Toast[] } {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider')
  }

  const { toasts, dispatch } = ctx

  const add = useCallback(
    (type: ToastType, message: string, duration = 3000) => {
      const id = generateId()
      dispatch({ type: 'ADD', toast: { id, type, message, duration } })
    },
    [dispatch],
  )

  const toast: ToastAPI = {
    success: (message, duration) => add('success', message, duration),
    error: (message, duration) => add('error', message, duration),
    info: (message, duration) => add('info', message, duration),
    warning: (message, duration) => add('warning', message, duration),
    dismiss: (id) => dispatch({ type: 'REMOVE', id }),
    clear: () => dispatch({ type: 'CLEAR' }),
  }

  return { toast, toasts }
}

// ---- Provider state hook (used by ToastProvider) ----------------------------

export function useToastReducer() {
  return useReducer(reducer, [] as Toast[])
}
