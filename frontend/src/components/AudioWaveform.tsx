import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'

interface Props {
  projectId: string
  totalWidthPx: number
}

/**
 * AudioWaveform — renders Clip A's audio as a waveform image above the B-Roll track.
 *
 * The waveform PNG is generated server-side by FFmpeg and cached.
 * It scales horizontally to match totalWidthPx so waveform aligns with timeline.
 */
export default function AudioWaveform({ projectId, totalWidthPx }: Props) {
  const { data: url, isLoading, isError } = useQuery({
    queryKey: ['waveform', projectId],
    queryFn: async () => {
      // Verify the endpoint is reachable (HEAD-like check via GET)
      const res = await fetch(api.getWaveformUrl(projectId))
      if (!res.ok) throw new Error('Waveform not available')
      // Return the stable URL (the image itself)
      return api.getWaveformUrl(projectId)
    },
    retry: false,
    staleTime: Infinity,
  })

  if (isLoading) {
    return (
      <div
        className="relative flex items-center border-b border-[var(--border)] bg-[var(--muted)]"
        style={{ height: '32px', width: `${totalWidthPx}px` }}
      >
        <span className="pointer-events-none absolute left-1 top-0.5 text-[9px] font-medium text-violet-400/60">
          Waveform
        </span>
        <div className="ml-14 text-[9px] text-[var(--muted-foreground)]">Loading...</div>
      </div>
    )
  }

  if (isError || !url) {
    return null
  }

  return (
    <div
      className="relative border-b border-[var(--border)] overflow-hidden"
      style={{ height: '32px', width: `${totalWidthPx}px` }}
    >
      <span className="pointer-events-none absolute left-1 top-0.5 z-[1] text-[9px] font-medium text-violet-400/60">
        Wave
      </span>
      {/* Waveform image stretched to match timeline width */}
      <img
        src={url}
        alt="Audio waveform"
        className="absolute inset-0 h-full opacity-70"
        style={{ width: `${totalWidthPx}px`, objectFit: 'fill' }}
        draggable={false}
      />
    </div>
  )
}
