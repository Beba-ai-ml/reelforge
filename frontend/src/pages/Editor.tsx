import { useState, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Mic,
  Subtitles,
  Film,
  Download,
  Loader2,
  AlertCircle,
  Undo2,
  Redo2,
  Keyboard,
  RotateCcw,
  Grid2X2,
  RefreshCw,
} from 'lucide-react'
import { api } from '@/api/client'
import type { Subtitle, TimelineItem, Word, Alternative, Clip } from '@/types'
import VideoPreview from '@/components/VideoPreview'
import SubtitleEditor from '@/components/SubtitleEditor'
import RenderProgress from '@/components/RenderProgress'
import RenderHistory from '@/components/RenderHistory'
import ABComparison from '@/components/ABComparison'
import Timeline from '@/components/Timeline'
import ClipReplacer from '@/components/ClipReplacer'
import EditorLibraryPanel from '@/components/EditorLibraryPanel'
import BackgroundMusicPanel from '@/components/BackgroundMusicPanel'
import KeyboardShortcutsHelp from '@/components/KeyboardShortcutsHelp'
import TranscriptEditor from '@/components/TranscriptEditor'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import { useToast } from '@/hooks/useToast'

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

const statusColor: Record<string, string> = {
  created: 'bg-[var(--muted)] text-[var(--muted-foreground)]',
  uploaded: 'bg-blue-900/40 text-blue-400',
  transcribing: 'bg-yellow-900/40 text-yellow-400',
  transcribed: 'bg-green-900/40 text-green-400',
  rendering: 'bg-purple-900/40 text-purple-400',
  rendered: 'bg-emerald-900/40 text-emerald-400',
  done: 'bg-emerald-900/40 text-emerald-400',
  error: 'bg-red-900/40 text-red-400',
}

export default function Editor() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { toast } = useToast()

  // -------------------------------------------------------------------------
  // UI state
  // -------------------------------------------------------------------------
  const [isRendering, setIsRendering] = useState(false)
  const [showDraft, setShowDraft] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [mediaDuration, setMediaDuration] = useState(0)
  const [seekTarget, setSeekTarget] = useState<number | null>(null)
  const [selectedItem, setSelectedItem] = useState<TimelineItem | null>(null)
  const [replacingItem, setReplacingItem] = useState<TimelineItem | null>(null)
  const [selectedSubtitleId, setSelectedSubtitleId] = useState<number | null>(null)
  const [maxBroll, setMaxBroll] = useState(0) // 0 = auto
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)
  const [abActive, setAbActive] = useState(false)
  const [isVideoPlaying, setIsVideoPlaying] = useState(false)
  const [activeLanguage, setActiveLanguage] = useState('en')
  // Flip this after a render completes to trigger RenderHistory refetch
  const [renderHistoryTrigger, setRenderHistoryTrigger] = useState(false)

  // Error tracking for retry buttons
  const [transcribeError, setTranscribeError] = useState<string | null>(null)
  const [renderError, setRenderError] = useState<string | null>(null)
  const [subtitlesError, setSubtitlesError] = useState<string | null>(null)

  // Ref to control VideoPreview play/pause from keyboard shortcuts
  const isPlayingRef = useRef(false)
  const videoSeekFnRef = useRef<((delta: number) => void) | null>(null)
  const videoToggleFnRef = useRef<(() => void) | null>(null)

  // -------------------------------------------------------------------------
  // Undo / Redo
  // -------------------------------------------------------------------------
  const undoRedo = useUndoRedo()

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------
  const { data: project, isLoading: projectLoading } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId!),
    enabled: !!projectId,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      if (status === 'transcribing' || status === 'rendering') return 2000
      return false
    },
  })

  const { data: transcriptData } = useQuery({
    queryKey: ['transcript', projectId],
    queryFn: () => api.getTranscript(projectId!),
    enabled:
      !!projectId &&
      (project?.status === 'transcribed' ||
        project?.status === 'done' ||
        project?.status === 'rendered'),
  })

  const { data: subtitles, refetch: refetchSubtitles } = useQuery({
    queryKey: ['subtitles', projectId, activeLanguage],
    queryFn: () => api.listSubtitles(projectId!, activeLanguage),
    enabled: !!projectId,
  })

  const { data: timelineItems } = useQuery({
    queryKey: ['timeline', projectId],
    queryFn: () => api.listTimeline(projectId!),
    enabled: !!projectId,
  })

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------
  const transcribeMutation = useMutation({
    mutationFn: () => api.transcribe(projectId!),
    onMutate: () => setTranscribeError(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
    },
    onError: (err: Error) => {
      setTranscribeError(err.message ?? 'Transcription failed')
    },
  })

  const generateSubsMutation = useMutation({
    mutationFn: () => api.generateSubtitles(projectId!),
    onMutate: () => setSubtitlesError(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      void refetchSubtitles()
    },
    onError: (err: Error) => {
      setSubtitlesError(err.message ?? 'Subtitle generation failed')
    },
  })

  const renderMutation = useMutation({
    mutationFn: (draft: boolean) => api.triggerRender(projectId!, draft),
    onMutate: () => setRenderError(null),
    onSuccess: () => {
      setIsRendering(true)
      queryClient.invalidateQueries({ queryKey: ['project', projectId] })
      // Trigger RenderHistory to refetch after render completes
      setRenderHistoryTrigger((v) => !v)
    },
    onError: (err: Error) => {
      setRenderError(err.message ?? 'Render failed')
    },
  })

  const updateSubtitleMutation = useMutation({
    mutationFn: ({ subtitleId, data }: { subtitleId: number; data: Record<string, unknown> }) =>
      api.updateSubtitle(projectId!, subtitleId, data),
    onSuccess: () => void refetchSubtitles(),
  })

  const deleteSubtitleMutation = useMutation({
    mutationFn: (subtitleId: number) => api.deleteSubtitle(projectId!, subtitleId),
    onSuccess: () => void refetchSubtitles(),
  })

  const updateTimelineItemMutation = useMutation({
    mutationFn: ({ itemId, data }: { itemId: number; data: Partial<TimelineItem> }) =>
      api.updateTimelineItem(projectId!, itemId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeline', projectId] })
      setReplacingItem(null)
    },
  })

  const addTimelineItemMutation = useMutation({
    mutationFn: (item: Partial<TimelineItem>) => api.addTimelineItem(projectId!, item),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeline', projectId] })
    },
  })

  const deleteTimelineItemMutation = useMutation({
    mutationFn: (itemId: number) => api.deleteTimelineItem(projectId!, itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['timeline', projectId] })
    },
  })

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------
  const handleAddClip = useCallback(
    (clip: Clip) => {
      const nextPosition = timelineItems?.length ?? 0
      addTimelineItemMutation.mutate({
        clip_id: clip.id,
        source_type: 'library',
        position: nextPosition,
        timeline_start: currentTime,
        timeline_end: currentTime + (clip.duration ?? 5),
        clip_trim_start: 0,
        clip_trim_end: clip.duration ?? 5,
        speed: 1,
        transition_in: 'cut',
        transition_duration: 0,
      })
    },
    [currentTime, addTimelineItemMutation, timelineItems],
  )

  const handleSeek = useCallback((time: number) => {
    setSeekTarget(time)
    setCurrentTime(time)
  }, [])

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time)
    setSeekTarget(null)
  }, [])

  const handleSelectItem = useCallback(
    (item: TimelineItem | null) => {
      setSelectedItem(item)
      if (item) {
        handleSeek(item.timeline_start)
      }
    },
    [handleSeek],
  )

  const handleReplace = useCallback((item: TimelineItem) => {
    setReplacingItem(item)
  }, [])

  const handleSelectSubtitle = useCallback(
    (sub: Subtitle) => {
      setSelectedSubtitleId(sub.id)
      handleSeek(sub.start_time)
    },
    [handleSeek],
  )

  const handleEditSubtitleText = useCallback(
    (subtitleId: number, newText: string) => {
      const prev = subtitles?.find((s) => s.id === subtitleId)
      if (!prev) return

      updateSubtitleMutation.mutate({ subtitleId, data: { text: newText } })

      undoRedo.pushAction({
        type: 'subtitle-text-edit',
        description: `Edit subtitle text`,
        undo: async () => {
          await api.updateSubtitle(projectId!, subtitleId, { text: prev.text })
          await refetchSubtitles()
        },
        redo: async () => {
          await api.updateSubtitle(projectId!, subtitleId, { text: newText })
          await refetchSubtitles()
        },
      })
    },
    [updateSubtitleMutation, undoRedo, projectId, subtitles, refetchSubtitles],
  )

  const handleAlternativeSelect = useCallback(
    (alt: Alternative) => {
      if (!replacingItem) return
      updateTimelineItemMutation.mutate({
        itemId: replacingItem.id,
        data: { clip_id: alt.clip.id, source_type: 'library' },
      })
    },
    [replacingItem, updateTimelineItemMutation],
  )

  // Delete the currently selected item (keyboard shortcut handler)
  const handleDeleteSelected = useCallback(() => {
    if (selectedSubtitleId !== null) {
      const sub = subtitles?.find((s) => s.id === selectedSubtitleId)
      if (!sub) return

      deleteSubtitleMutation.mutate(selectedSubtitleId)
      setSelectedSubtitleId(null)

      undoRedo.pushAction({
        type: 'subtitle-delete',
        description: `Delete subtitle`,
        undo: async () => {
          await api.createSubtitle(projectId!, {
            text: sub.text,
            start_time: sub.start_time,
            end_time: sub.end_time,
            style: sub.style,
            position_x: sub.position_x,
            position_y: sub.position_y,
            font_size: sub.font_size ?? undefined,
            color: sub.color,
          })
          await refetchSubtitles()
        },
        redo: async () => {
          await api.deleteSubtitle(projectId!, sub.id)
          await refetchSubtitles()
        },
      })
    } else if (selectedItem !== null) {
      const item = selectedItem
      deleteTimelineItemMutation.mutate(item.id)
      setSelectedItem(null)

      undoRedo.pushAction({
        type: 'timeline-delete',
        description: `Delete timeline item`,
        undo: async () => {
          await api.addTimelineItem(projectId!, {
            clip_id: item.clip_id,
            source_type: item.source_type,
            position: item.position,
            timeline_start: item.timeline_start,
            timeline_end: item.timeline_end,
            clip_trim_start: item.clip_trim_start,
            clip_trim_end: item.clip_trim_end ?? undefined,
            speed: item.speed,
            transition_in: item.transition_in,
            transition_duration: item.transition_duration,
          })
          queryClient.invalidateQueries({ queryKey: ['timeline', projectId] })
        },
        redo: async () => {
          await api.deleteTimelineItem(projectId!, item.id)
          queryClient.invalidateQueries({ queryKey: ['timeline', projectId] })
        },
      })
    }
  }, [
    selectedSubtitleId,
    selectedItem,
    subtitles,
    deleteSubtitleMutation,
    deleteTimelineItemMutation,
    undoRedo,
    projectId,
    refetchSubtitles,
    queryClient,
  ])

  // Video control helpers used by keyboard shortcuts
  const handleTogglePlay = useCallback(() => {
    videoToggleFnRef.current?.()
  }, [])

  const handleKeySeek = useCallback(
    (delta: number) => {
      handleSeek(Math.max(0, currentTime + delta))
    },
    [currentTime, handleSeek],
  )

  const handleSave = useCallback(() => {
    toast.success('Project saved automatically')
  }, [toast])

  // -------------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------------
  useKeyboardShortcuts({
    togglePlay: handleTogglePlay,
    seekBackward: (s) => handleKeySeek(-s),
    seekForward: (s) => handleKeySeek(s),
    undo: () => void undoRedo.undo(),
    redo: () => void undoRedo.redo(),
    save: handleSave,
    deleteSelected: handleDeleteSelected,
    showHelp: () => setShowShortcutsHelp((v) => !v),
  })

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------
  if (projectLoading || !project) {
    return (
      <div className="flex h-[80vh] items-center justify-center">
        <Loader2 size={28} className="animate-spin text-[var(--primary)]" />
      </div>
    )
  }

  const hasTranscript =
    project.status === 'transcribed' ||
    project.status === 'done' ||
    project.status === 'rendered' ||
    !!transcriptData?.transcript
  const hasSubtitles = subtitles && subtitles.length > 0
  const isTranscribing = project.status === 'transcribing'
  const hasClip = !!project.clip_a_path
  const hasDraft = !!project.draft_path
  const hasOutput = !!project.output_path
  const effectiveDuration = mediaDuration || project.duration || 30
  const isError = project.status === 'error'

  // Build media preview URL
  let mediaSrc = ''
  let mediaType: 'video' | 'audio' = 'video'
  if (showDraft && hasDraft) {
    mediaSrc = `/data/projects/${projectId}/draft.mp4`
  } else if (hasClip) {
    const ext = project.clip_a_path!.split('.').pop() || 'mp4'
    mediaSrc = `/data/projects/${projectId}/input.${ext}`
    mediaType = project.clip_a_type?.startsWith('audio') ? 'audio' : 'video'
  }

  const transcriptWords: Word[] = transcriptData?.transcript ?? []

  return (
    <div className="flex h-[calc(100vh-49px)] flex-col">
      {/* ------------------------------------------------------------------ */}
      {/* Top bar                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex items-center gap-4 border-b border-[var(--border)] px-6 py-3">
        <button
          onClick={() => navigate('/')}
          className="rounded p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
        >
          <ArrowLeft size={18} />
        </button>
        <h2 className="text-sm font-semibold text-[var(--foreground)]">{project.name}</h2>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusColor[project.status] ?? statusColor.created}`}
        >
          {project.status}
        </span>
        {project.duration != null && (
          <span className="text-xs text-[var(--muted-foreground)]">
            {fmtTime(project.duration)}
          </span>
        )}
        <span className="text-xs text-[var(--muted-foreground)]">{project.output_format}</span>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Undo / Redo buttons */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => void undoRedo.undo()}
            disabled={!undoRedo.canUndo}
            title={undoRedo.undoDescription ? `Undo: ${undoRedo.undoDescription}` : 'Nothing to undo'}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-30"
          >
            <Undo2 size={13} />
            <span className="hidden sm:inline">Undo</span>
          </button>
          <button
            onClick={() => void undoRedo.redo()}
            disabled={!undoRedo.canRedo}
            title={undoRedo.redoDescription ? `Redo: ${undoRedo.redoDescription}` : 'Nothing to redo'}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-30"
          >
            <Redo2 size={13} />
            <span className="hidden sm:inline">Redo</span>
          </button>
        </div>

        {/* Keyboard shortcuts help button */}
        <button
          onClick={() => setShowShortcutsHelp(true)}
          title="Keyboard shortcuts (?)"
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--muted-foreground)] transition hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        >
          <Keyboard size={13} />
          <span className="hidden sm:inline">Shortcuts</span>
        </button>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Main content                                                        */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Preview + Right panel */}
        <div className="flex flex-1 overflow-hidden">
          {/* Preview column */}
          <div className="flex w-[60%] flex-col border-r border-[var(--border)] p-6">
            {hasClip ? (
              <>
                <ABComparison
                  currentSrc={mediaSrc}
                  projectId={projectId!}
                  hasRender={hasDraft || hasOutput}
                  active={abActive}
                  onToggle={() => setAbActive((v) => !v)}
                  isPlaying={isVideoPlaying}
                  currentTime={currentTime}
                >
                  <VideoPreview
                    src={mediaSrc}
                    mediaType={mediaType}
                    outputFormat={project.output_format}
                    onTimeUpdate={handleTimeUpdate}
                    onDurationChange={setMediaDuration}
                    onPlayStateChange={setIsVideoPlaying}
                    seekTo={seekTarget}
                    subtitles={subtitles}
                    onEditSubtitleText={handleEditSubtitleText}
                    timelineItems={timelineItems}
                    abActive={abActive}
                    onABToggle={() => setAbActive((v) => !v)}
                    togglePlayRef={videoToggleFnRef}
                  />
                </ABComparison>
                {hasDraft && !abActive && (
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => setShowDraft(false)}
                      className={`rounded-lg px-3 py-1 text-xs transition ${
                        !showDraft
                          ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                          : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                      }`}
                    >
                      Original
                    </button>
                    <button
                      onClick={() => setShowDraft(true)}
                      className={`rounded-lg px-3 py-1 text-xs transition ${
                        showDraft
                          ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                          : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
                      }`}
                    >
                      Draft Preview
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <div className="text-center">
                  <AlertCircle size={36} className="mx-auto mb-3 text-[var(--muted-foreground)]" />
                  <p className="text-sm text-[var(--muted-foreground)]">No media uploaded yet</p>
                </div>
              </div>
            )}

            {/* Render progress + history */}
            <div className="mt-auto flex flex-col gap-2 pt-4">
              <RenderProgress projectId={projectId!} isRendering={isRendering} />
              <RenderHistory projectId={projectId!} refetchTrigger={renderHistoryTrigger} />
            </div>
          </div>

          {/* Right: Transcript + Subtitles + Replace panel */}
          <div className="flex w-[40%] flex-col overflow-y-auto p-6">
            {/* Replacer panel (shown when replacing) */}
            {replacingItem && (
              <div className="mb-4">
                <ClipReplacer
                  projectId={projectId!}
                  itemId={replacingItem.id}
                  onSelect={handleAlternativeSelect}
                  onClose={() => setReplacingItem(null)}
                />
              </div>
            )}

            {/* Selected item info */}
            {selectedItem && !replacingItem && (
              <div className="mb-4 rounded-lg border border-[var(--border)] bg-[var(--muted)] p-3">
                <p className="mb-1 text-xs font-medium text-[var(--muted-foreground)]">
                  Selected Item
                </p>
                <p className="text-sm text-[var(--foreground)]">
                  {selectedItem.source_type === 'clip_a'
                    ? 'Clip A'
                    : selectedItem.source_path?.split('/').pop() || `Item ${selectedItem.id}`}
                </p>
                <p className="text-[10px] text-[var(--muted-foreground)]">
                  {fmtTime(selectedItem.timeline_start)} -{' '}
                  {fmtTime(selectedItem.timeline_end)} | Type: {selectedItem.source_type}
                </p>
              </div>
            )}

            <h3 className="mb-4 text-sm font-semibold text-[var(--foreground)]">
              Transcript & Subtitles
            </h3>

            {/* ------------------------------------------------------------ */}
            {/* Error state with retry buttons (Feature 5)                    */}
            {/* ------------------------------------------------------------ */}
            {isError && (
              <div className="mb-4 flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-900/20 px-3 py-2">
                <AlertCircle size={14} className="shrink-0 text-red-400" />
                <p className="text-xs text-red-400">An error occurred. Check the status above.</p>
                <button
                  onClick={() => transcribeMutation.mutate()}
                  disabled={transcribeMutation.isPending}
                  className="ml-auto flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-red-400 transition hover:bg-red-900/40"
                  title="Retry transcription"
                >
                  <RotateCcw size={11} className={transcribeMutation.isPending ? 'animate-spin' : ''} />
                  Retry Transcribe
                </button>
              </div>
            )}

            {/* Transcription error (inline) */}
            {transcribeError && !isError && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-900/20 px-3 py-2">
                <AlertCircle size={12} className="shrink-0 text-red-400" />
                <p className="flex-1 text-xs text-red-400">{transcribeError}</p>
                <button
                  onClick={() => transcribeMutation.mutate()}
                  disabled={transcribeMutation.isPending}
                  className="flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-900/40"
                >
                  <RotateCcw size={10} className={transcribeMutation.isPending ? 'animate-spin' : ''} />
                  Retry
                </button>
              </div>
            )}

            {/* ------------------------------------------------------------ */}
            {/* No transcript yet (empty state)                               */}
            {/* ------------------------------------------------------------ */}
            {!hasTranscript && !isTranscribing && (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <Mic size={32} className="mb-3 text-[var(--muted-foreground)]" />
                <p className="mb-1 text-sm text-[var(--foreground)]">No transcript yet</p>
                <p className="mb-4 text-xs text-[var(--muted-foreground)]">
                  Transcribe your media to generate subtitles
                </p>
                <button
                  onClick={() => transcribeMutation.mutate()}
                  disabled={!hasClip || transcribeMutation.isPending}
                  className="flex items-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)] disabled:opacity-50"
                >
                  {transcribeMutation.isPending ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Mic size={14} />
                  )}
                  Transcribe
                </button>
              </div>
            )}

            {/* Transcribing state */}
            {isTranscribing && (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <Loader2 size={28} className="mb-3 animate-spin text-[var(--primary)]" />
                <p className="text-sm text-[var(--foreground)]">Transcribing...</p>
                <p className="text-xs text-[var(--muted-foreground)]">This may take a moment</p>
              </div>
            )}

            {/* ------------------------------------------------------------ */}
            {/* Transcript ready, no subtitles yet (Feature 3 + Feature 4)   */}
            {/* ------------------------------------------------------------ */}
            {hasTranscript && !hasSubtitles && !isTranscribing && (
              <div>
                {/* TranscriptEditor (Feature 3) replaces the plain read-only block */}
                {transcriptWords.length > 0 ? (
                  <TranscriptEditor
                    words={transcriptWords}
                    onRegenerateSubtitles={() => generateSubsMutation.mutate()}
                    isRegenerating={generateSubsMutation.isPending}
                  />
                ) : null}

                {/* Feature 4: Empty state for subtitles when transcript exists */}
                <div className="flex flex-col items-center rounded-lg border border-dashed border-[var(--border)] py-8 text-center">
                  <Subtitles size={28} className="mb-2 text-[var(--muted-foreground)]" />
                  <p className="mb-1 text-sm font-medium text-[var(--foreground)]">
                    No subtitles generated
                  </p>
                  <p className="mb-4 text-xs text-[var(--muted-foreground)]">
                    Click below to create subtitles from the transcript
                  </p>

                  {/* Subtitle generation error + retry (Feature 5) */}
                  {subtitlesError && (
                    <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-900/20 px-3 py-2">
                      <AlertCircle size={12} className="shrink-0 text-red-400" />
                      <p className="text-xs text-red-400">{subtitlesError}</p>
                      <button
                        onClick={() => generateSubsMutation.mutate()}
                        disabled={generateSubsMutation.isPending}
                        className="ml-1 flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-900/40"
                      >
                        <RotateCcw size={10} className={generateSubsMutation.isPending ? 'animate-spin' : ''} />
                        Retry
                      </button>
                    </div>
                  )}

                  <button
                    onClick={() => generateSubsMutation.mutate()}
                    disabled={generateSubsMutation.isPending}
                    className="flex items-center justify-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)] disabled:opacity-50"
                  >
                    {generateSubsMutation.isPending ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Subtitles size={14} />
                    )}
                    Generate Subtitles
                  </button>
                </div>
              </div>
            )}

            {/* ------------------------------------------------------------ */}
            {/* Subtitles list (with transcript editor accessible above)      */}
            {/* ------------------------------------------------------------ */}
            {hasSubtitles && (
              <div className="flex flex-col gap-4">
                {/* TranscriptEditor stays available when subtitles exist too */}
                {transcriptWords.length > 0 && (
                  <TranscriptEditor
                    words={transcriptWords}
                    onRegenerateSubtitles={() => generateSubsMutation.mutate()}
                    isRegenerating={generateSubsMutation.isPending}
                  />
                )}

                {/* Regenerate All button */}
                <div className="flex items-center justify-end">
                  <button
                    onClick={() => {
                      if (window.confirm('This will delete all current subtitles and regenerate them from the transcript. Continue?')) {
                        generateSubsMutation.mutate()
                      }
                    }}
                    disabled={generateSubsMutation.isPending}
                    className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition hover:border-[var(--primary)] hover:text-white disabled:opacity-50"
                  >
                    {generateSubsMutation.isPending ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RefreshCw size={12} />
                    )}
                    Regenerate All Subtitles
                  </button>
                </div>

                <SubtitleEditor
                  subtitles={subtitles}
                  projectId={projectId!}
                  currentTime={currentTime}
                  selectedSubtitleId={selectedSubtitleId}
                  onSelectSubtitle={handleSelectSubtitle}
                  onRefetch={() => void refetchSubtitles()}
                  onUpdate={(subtitleId, data) =>
                    updateSubtitleMutation.mutate({ subtitleId, data })
                  }
                  activeLanguage={activeLanguage}
                  onLanguageChange={setActiveLanguage}
                />
              </div>
            )}
          </div>
        </div>

        {/* Library panel */}
        <EditorLibraryPanel onAddClip={handleAddClip} />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Timeline                                                            */}
      {/* ------------------------------------------------------------------ */}
      <Timeline
        projectId={projectId!}
        duration={effectiveDuration}
        currentTime={currentTime}
        subtitles={subtitles}
        maxBroll={maxBroll}
        onMaxBrollChange={setMaxBroll}
        onSeek={handleSeek}
        onSelectItem={handleSelectItem}
        onReplace={handleReplace}
        onSelectSubtitle={handleSelectSubtitle}
        onEditSubtitleText={handleEditSubtitleText}
        hasClipA={hasClip}
      />
      {project && <BackgroundMusicPanel project={project} />}

      {/* Feature 4: Timeline empty state — rendered inside Timeline itself is not ideal,
          so we render a banner here when timeline has no b-roll items */}
      {timelineItems !== undefined && timelineItems.filter((i) => i.source_type !== 'clip_a').length === 0 && (
        <div className="flex items-center justify-center gap-3 border-t border-[var(--border)] bg-[var(--card)] px-6 py-3">
          <Grid2X2 size={14} className="text-[var(--muted-foreground)]" />
          <p className="text-xs text-[var(--muted-foreground)]">
            No B-Roll clips yet — click{' '}
            <strong className="text-[var(--foreground)]">Match B-Roll</strong> to auto-fill or
            drag clips from the Library panel.
          </p>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Bottom bar                                                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex items-center justify-between border-t border-[var(--border)] px-6 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={() => transcribeMutation.mutate()}
            disabled={!hasClip || isTranscribing || transcribeMutation.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-40"
          >
            {isTranscribing || transcribeMutation.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Mic size={12} />
            )}
            Transcribe
          </button>

          <button
            onClick={() => generateSubsMutation.mutate()}
            disabled={!hasTranscript || generateSubsMutation.isPending}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--muted)] px-3 py-1.5 text-xs text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] disabled:opacity-40"
          >
            {generateSubsMutation.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Subtitles size={12} />
            )}
            Generate Subtitles
          </button>

          {/* Feature 4: Subtitles empty state (not transcribed) — inline hint */}
          {!hasTranscript && !hasSubtitles && !isTranscribing && (
            <span className="text-[10px] text-[var(--muted-foreground)]">
              Transcribe first to generate subtitles
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Render error + retry (Feature 5) */}
          {renderError && (
            <div className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-900/20 px-3 py-1.5">
              <AlertCircle size={12} className="text-red-400" />
              <span className="text-xs text-red-400">{renderError}</span>
              <button
                onClick={() => renderMutation.mutate(true)}
                disabled={renderMutation.isPending}
                className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300"
              >
                <RotateCcw size={10} className={renderMutation.isPending ? 'animate-spin' : ''} />
                Retry
              </button>
            </div>
          )}

          <button
            onClick={() => renderMutation.mutate(true)}
            disabled={!hasSubtitles || renderMutation.isPending || project.status === 'rendering'}
            className="flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)] disabled:opacity-40"
          >
            {renderMutation.isPending ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Film size={12} />
            )}
            Render Draft
          </button>

          {(hasDraft || hasOutput) && (
            <a
              href={`/api/projects/${projectId}/render/download`}
              className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-500"
            >
              <Download size={12} />
              Download
            </a>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Keyboard shortcuts help modal (Feature 1)                          */}
      {/* ------------------------------------------------------------------ */}
      {showShortcutsHelp && (
        <KeyboardShortcutsHelp onClose={() => setShowShortcutsHelp(false)} />
      )}
    </div>
  )
}
