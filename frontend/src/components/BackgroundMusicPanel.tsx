import { useRef, useState, useCallback, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Music, Upload, X, Volume2, Play, Pause } from 'lucide-react'
import { api } from '@/api/client'
import type { Project } from '@/types'

interface Props {
  project: Project
}

/**
 * BackgroundMusicPanel — lets the user upload a background music track,
 * adjust its volume, preview it, and remove it.
 */
export default function BackgroundMusicPanel({ project }: Props) {
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [volume, setVolume] = useState<number>(
    project.music_volume !== undefined ? Math.round(project.music_volume * 100) : 30,
  )

  // Cleanup audio element on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current = null
      }
    }
  }, [])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['project', project.id] })
  }

  const uploadMutation = useMutation({
    mutationFn: (file: File) => api.uploadMusic(project.id, file),
    onSuccess: () => invalidate(),
  })

  const volumeMutation = useMutation({
    mutationFn: (vol: number) => api.updateMusicVolume(project.id, vol),
    onSuccess: () => invalidate(),
  })

  const removeMutation = useMutation({
    mutationFn: () => api.removeMusic(project.id),
    onSuccess: () => {
      stopPreview()
      invalidate()
    },
  })

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) uploadMutation.mutate(file)
      // Reset input so same file can be re-selected
      e.target.value = ''
    },
    [uploadMutation],
  )

  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseInt(e.target.value, 10)
      setVolume(val)
      // Update audio preview volume immediately
      if (audioRef.current) audioRef.current.volume = val / 100
    },
    [],
  )

  const handleVolumeCommit = useCallback(() => {
    volumeMutation.mutate(volume / 100)
  }, [volume, volumeMutation])

  const togglePreview = useCallback(() => {
    if (!project.music_path) return

    if (!audioRef.current) {
      const musicFilename = project.music_path.split('/').pop() || ''
      const ext = musicFilename.split('.').pop() || 'mp3'
      audioRef.current = new Audio(
        `/data/projects/${project.id}/music.${ext}`,
      )
      audioRef.current.volume = volume / 100
      audioRef.current.onended = () => setIsPlaying(false)
    }

    if (isPlaying) {
      audioRef.current.pause()
      setIsPlaying(false)
    } else {
      audioRef.current.play().catch(() => setIsPlaying(false))
      setIsPlaying(true)
    }
  }, [isPlaying, project, volume])

  const stopPreview = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current = null
    }
    setIsPlaying(false)
  }, [])

  const musicFilename = project.music_path
    ? project.music_path.split('/').pop() || 'music file'
    : null

  return (
    <div className="flex items-center gap-3 border-t border-[var(--border)] bg-[var(--card)] px-4 py-2">
      <Music size={12} className="shrink-0 text-orange-400/70" />
      <span className="text-[9px] font-medium text-orange-400/70">Music</span>

      {musicFilename ? (
        <>
          {/* Preview play/pause */}
          <button
            onClick={togglePreview}
            className="rounded bg-[var(--muted)] p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
            title={isPlaying ? 'Pause preview' : 'Preview music'}
          >
            {isPlaying ? <Pause size={10} /> : <Play size={10} />}
          </button>

          {/* Filename */}
          <span
            className="max-w-[120px] truncate text-[10px] text-[var(--foreground)]"
            title={musicFilename}
          >
            {musicFilename}
          </span>

          {/* Volume control */}
          <Volume2 size={10} className="text-[var(--muted-foreground)]" />
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            onChange={handleVolumeChange}
            onMouseUp={handleVolumeCommit}
            onTouchEnd={handleVolumeCommit}
            className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-[var(--muted)] accent-orange-500"
            title={`Volume: ${volume}%`}
          />
          <span className="min-w-[28px] text-[10px] text-[var(--muted-foreground)]">{volume}%</span>

          {/* Remove button */}
          <button
            onClick={() => removeMutation.mutate()}
            disabled={removeMutation.isPending}
            className="ml-1 rounded bg-black/40 p-0.5 text-red-400 transition hover:bg-black/60 disabled:opacity-50"
            title="Remove music"
          >
            <X size={10} />
          </button>

          {/* Replace button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="ml-1 rounded bg-[var(--muted)] px-2 py-0.5 text-[9px] text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
          >
            Replace
          </button>
        </>
      ) : (
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
          className="flex items-center gap-1 rounded-lg bg-[var(--muted)] px-2 py-1 text-[10px] text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-50"
        >
          <Upload size={10} />
          {uploadMutation.isPending ? 'Uploading...' : 'Add Music'}
        </button>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept=".mp3,.wav,.m4a,.ogg,.flac,.aac,audio/*"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  )
}
