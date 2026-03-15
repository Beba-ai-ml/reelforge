import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, XCircle, Info, AlertTriangle, X } from 'lucide-react'
import { ToastContext, useToastReducer } from '@/hooks/useToast'
import type { Toast, ToastType } from '@/hooks/useToast'

// ---- Icons per type ---------------------------------------------------------

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle2 size={16} className="shrink-0 text-emerald-400" />,
  error: <XCircle size={16} className="shrink-0 text-red-400" />,
  info: <Info size={16} className="shrink-0 text-blue-400" />,
  warning: <AlertTriangle size={16} className="shrink-0 text-yellow-400" />,
}

const BORDER_COLOR: Record<ToastType, string> = {
  success: 'border-emerald-500/30',
  error: 'border-red-500/30',
  info: 'border-blue-500/30',
  warning: 'border-yellow-500/30',
}

// ---- Individual Toast -------------------------------------------------------

interface ToastItemProps {
  toast: Toast
  onDismiss: (id: string) => void
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const [visible, setVisible] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Slide in on mount
  useEffect(() => {
    // Small delay so the transition actually runs
    const raf = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // Auto-dismiss
  useEffect(() => {
    timerRef.current = setTimeout(() => {
      handleDismiss()
    }, toast.duration)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id, toast.duration])

  function handleDismiss() {
    setVisible(false)
    // Wait for fade-out animation before removing from DOM
    setTimeout(() => onDismiss(toast.id), 300)
  }

  return (
    <div
      role="alert"
      className={`flex w-80 items-start gap-3 rounded-xl border bg-[var(--card)] px-4 py-3 shadow-xl transition-all duration-300 ${BORDER_COLOR[toast.type]} ${
        visible
          ? 'translate-x-0 opacity-100'
          : 'translate-x-10 opacity-0'
      }`}
    >
      {ICONS[toast.type]}
      <p className="flex-1 text-sm text-[var(--foreground)] leading-snug">{toast.message}</p>
      <button
        onClick={handleDismiss}
        className="shrink-0 rounded p-0.5 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  )
}

// ---- Toast Container --------------------------------------------------------

interface ToasterProps {
  children: React.ReactNode
}

export function ToastProvider({ children }: ToasterProps) {
  const [toasts, dispatch] = useToastReducer()

  const dismiss = (id: string) => dispatch({ type: 'REMOVE', id })

  return (
    <ToastContext.Provider value={{ toasts, dispatch }}>
      {children}
      {/* Portal-like fixed container in bottom-right */}
      <div
        aria-live="polite"
        className="fixed bottom-5 right-5 z-50 flex flex-col gap-2"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}
