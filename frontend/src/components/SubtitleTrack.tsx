import { useState, useRef, useEffect } from 'react'
import type { Subtitle } from '@/types'

interface Props {
  subtitles: Subtitle[]
  pixelsPerSecond: number
  currentTime: number
  onSelectSubtitle?: (sub: Subtitle) => void
  onEditSubtitleText?: (subtitleId: number, newText: string) => void
}

export default function SubtitleTrack({ subtitles, pixelsPerSecond, currentTime, onSelectSubtitle, onEditSubtitleText }: Props) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editText, setEditText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId !== null && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  const handleSave = (subtitleId: number) => {
    const trimmed = editText.trim()
    if (trimmed && onEditSubtitleText) {
      onEditSubtitleText(subtitleId, trimmed)
    }
    setEditingId(null)
    setEditText('')
  }

  return (
    <>
      {subtitles
        .sort((a, b) => a.start_time - b.start_time)
        .map((sub) => {
          const duration = sub.end_time - sub.start_time
          const width = Math.max(duration * pixelsPerSecond, 20)
          const left = sub.start_time * pixelsPerSecond
          const isActive = currentTime >= sub.start_time && currentTime <= sub.end_time
          const isEditing = editingId === sub.id

          return (
            <div
              key={sub.id}
              className={`absolute flex h-full cursor-pointer items-center overflow-hidden rounded border px-1 transition ${
                isActive
                  ? 'border-yellow-400/60 bg-yellow-600/40'
                  : 'border-yellow-500/20 bg-yellow-600/20'
              }`}
              style={{ left: `${left}px`, width: `${width}px` }}
              onClick={(e) => {
                e.stopPropagation()
                onSelectSubtitle?.(sub)
              }}
              onDoubleClick={(e) => {
                e.stopPropagation()
                if (onEditSubtitleText) {
                  setEditingId(sub.id)
                  setEditText(sub.text)
                }
              }}
              title={sub.text}
            >
              {isEditing ? (
                <input
                  ref={inputRef}
                  type="text"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleSave(sub.id)
                    }
                    if (e.key === 'Escape') {
                      setEditingId(null)
                      setEditText('')
                    }
                  }}
                  onBlur={() => handleSave(sub.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full bg-transparent text-[9px] text-yellow-100 outline-none"
                />
              ) : (
                <span className="truncate text-[9px] text-yellow-200/80">{sub.text}</span>
              )}
            </div>
          )
        })}
    </>
  )
}
