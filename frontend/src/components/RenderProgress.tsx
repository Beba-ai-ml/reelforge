import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, Loader2, Film, CheckCircle2, AlertCircle } from 'lucide-react'
import { api } from '@/api/client'

interface Props {
  projectId: string
  isRendering: boolean
}

interface WsProgress {
  progress: number
  stage: string
  eta_seconds: number | null
}

export default function RenderProgress({ projectId, isRendering }: Props) {
  const [wsProgress, setWsProgress] = useState<WsProgress | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  // WebSocket connection
  const connectWs = useCallback(() => {
    if (!isRendering) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const ws = new WebSocket(`${protocol}//${host}/api/projects/${projectId}/render/ws`)

    ws.onopen = () => setWsConnected(true)
    ws.onmessage = (event) => {
      try {
        const data: WsProgress = JSON.parse(event.data)
        setWsProgress(data)
      } catch { /* ignore parse errors */ }
    }
    ws.onclose = () => setWsConnected(false)
    ws.onerror = () => setWsConnected(false)

    wsRef.current = ws
  }, [projectId, isRendering])

  useEffect(() => {
    connectWs()
    return () => {
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [connectWs])

  // Reset WS progress when render stops
  useEffect(() => {
    if (!isRendering) {
      setWsProgress(null)
      setWsConnected(false)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [isRendering])

  // HTTP polling fallback when WebSocket is not connected
  const { data: status } = useQuery({
    queryKey: ['render-status', projectId],
    queryFn: () => api.getRenderStatus(projectId),
    refetchInterval: isRendering && !wsConnected ? 2000 : false,
    enabled: isRendering && !wsConnected,
  })

  if (!isRendering && !status && !wsProgress) return null

  const renderStatus = status?.status ?? 'unknown'
  const isDone = renderStatus === 'done' || renderStatus === 'completed' || renderStatus === 'rendered' || wsProgress?.stage === 'done'
  const isFailed = renderStatus === 'failed' || renderStatus === 'error'
  const isInProgress = !isDone && !isFailed && (isRendering || renderStatus === 'rendering' || renderStatus === 'processing')

  const progressPct = wsProgress ? Math.round(wsProgress.progress * 100) : null
  const stage = wsProgress?.stage ?? null
  const eta = wsProgress?.eta_seconds

  const fmtEta = (seconds: number) => {
    if (seconds < 60) return `${Math.round(seconds)}s`
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
  }

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          {isInProgress && (
            <>
              <Loader2 size={18} className="animate-spin text-[var(--primary)]" />
              <div className="flex-1">
                <p className="text-sm font-medium text-[var(--foreground)]">
                  Rendering{progressPct !== null ? ` - ${progressPct}%` : '...'}
                </p>
                <p className="text-xs text-[var(--muted-foreground)]">
                  {stage && stage !== 'encoding' && stage !== 'done' ? stage : 'Processing'}
                  {eta != null && eta > 0 ? ` - ETA ${fmtEta(eta)}` : ''}
                </p>
              </div>
            </>
          )}

          {isDone && (
            <>
              <CheckCircle2 size={18} className="text-green-500" />
              <div className="flex-1">
                <p className="text-sm font-medium text-[var(--foreground)]">Render Complete</p>
                <p className="text-xs text-[var(--muted-foreground)]">Your reel is ready</p>
              </div>
              <a
                href={`/api/projects/${projectId}/render/download`}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-sm font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)]"
              >
                <Download size={14} />
                Download
              </a>
            </>
          )}

          {isFailed && (
            <>
              <AlertCircle size={18} className="text-[var(--destructive)]" />
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">Render Failed</p>
                <p className="text-xs text-[var(--muted-foreground)]">Check logs for details</p>
              </div>
            </>
          )}

          {!isInProgress && !isDone && !isFailed && isRendering && (
            <>
              <Film size={18} className="text-[var(--primary)]" />
              <div>
                <p className="text-sm font-medium text-[var(--foreground)]">Starting render...</p>
                <p className="text-xs text-[var(--muted-foreground)]">Preparing pipeline</p>
              </div>
            </>
          )}
        </div>

        {/* Progress bar */}
        {isInProgress && progressPct !== null && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--muted)]">
            <div
              className="h-full rounded-full bg-[var(--primary)] transition-all duration-300 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
      </div>
    </div>
  )
}
