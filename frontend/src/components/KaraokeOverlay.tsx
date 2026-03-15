import { useMemo, useState, useRef, useEffect } from 'react'
import type { Subtitle, KaraokeStyle, Word } from '@/types'

interface KaraokeOverlayProps {
  subtitle: Subtitle | null
  currentTime: number
  karaokeStyle?: KaraokeStyle
  fontSize?: number
  color?: string
  outlineColor?: string
  highlightColor?: string
  positionX?: number
  positionY?: number
  onEditText?: (subtitleId: number, newText: string) => void
}

export default function KaraokeOverlay({
  subtitle,
  currentTime,
  karaokeStyle = 'classic',
  fontSize = 48,
  color = '#FFFFFF',
  outlineColor = '#000000',
  highlightColor = '#8b5cf6',
  positionX = 0.5,
  positionY = 0.7,
  onEditText,
}: KaraokeOverlayProps) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const words = useMemo<Word[] | null>(() => {
    if (!subtitle?.words_json) return null
    try {
      return JSON.parse(subtitle.words_json) as Word[]
    } catch {
      return null
    }
  }, [subtitle?.words_json])

  // Reset editing when subtitle changes
  useEffect(() => {
    setEditing(false)
  }, [subtitle?.id])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editing])

  if (!subtitle) return null

  const shadow = `-1px -1px 0 ${outlineColor}, 1px -1px 0 ${outlineColor}, -1px 1px 0 ${outlineColor}, 1px 1px 0 ${outlineColor}, 0 0 6px ${outlineColor}`

  const justifyMap = positionX <= 0.33 ? 'flex-start' : positionX >= 0.66 ? 'flex-end' : 'center'

  const containerStyle: React.CSSProperties = {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: 'none',
    display: 'flex',
    justifyContent: justifyMap,
    alignItems: positionY <= 0.33 ? 'flex-start' : positionY >= 0.66 ? 'flex-end' : 'center',
    padding: '16px',
  }

  const textContainerStyle: React.CSSProperties = {
    maxWidth: '90%',
    textAlign: 'center',
    fontSize: `${fontSize}px`,
    fontFamily: "'Montserrat', system-ui, sans-serif",
    fontWeight: 'bold',
    textShadow: shadow,
    lineHeight: 1.4,
    marginTop: positionY <= 0.33 ? `${positionY * 100}%` : undefined,
    marginBottom: positionY >= 0.66 ? `${(1 - positionY) * 100}%` : undefined,
    pointerEvents: 'auto',
    cursor: onEditText ? 'pointer' : 'default',
  }

  const handleClick = () => {
    if (!onEditText) return
    setEditValue(subtitle.text)
    setEditing(true)
  }

  const handleSave = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== subtitle.text && onEditText) {
      onEditText(subtitle.id, trimmed)
    }
    setEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSave()
    }
    if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <div style={containerStyle}>
        <div style={{ ...textContainerStyle, pointerEvents: 'auto' }}>
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSave}
            style={{
              fontSize: `${Math.min(fontSize, 24)}px`,
              fontFamily: 'system-ui, sans-serif',
              color,
              textShadow: shadow,
              background: 'rgba(0,0,0,0.7)',
              border: '1px solid var(--primary)',
              borderRadius: '4px',
              padding: '4px 8px',
              outline: 'none',
              width: '100%',
              textAlign: 'center',
            }}
          />
        </div>
      </div>
    )
  }

  if (!words) {
    return (
      <div style={containerStyle}>
        <div style={textContainerStyle} onClick={handleClick}>
          <span style={{ color }}>{subtitle.text}</span>
        </div>
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      <div style={textContainerStyle} onClick={handleClick}>
        {words.map((w, i) => (
          <WordSpan
            key={i}
            word={w}
            index={i}
            currentTime={currentTime}
            karaokeStyle={karaokeStyle}
            defaultColor={color}
            highlightColor={highlightColor}
          />
        ))}
      </div>
    </div>
  )
}

interface WordSpanProps {
  word: Word
  index: number
  currentTime: number
  karaokeStyle: KaraokeStyle
  defaultColor: string
  highlightColor: string
}

function WordSpan({ word, currentTime, karaokeStyle, defaultColor, highlightColor }: WordSpanProps) {
  const isPast = currentTime > word.end
  const isActive = currentTime >= word.start && currentTime <= word.end
  const isFuture = currentTime < word.start

  const style: React.CSSProperties = {
    display: 'inline-block',
    whiteSpace: 'pre',
  }

  switch (karaokeStyle) {
    case 'normal': {
      style.color = isActive ? highlightColor : defaultColor
      style.transition = 'none'
      break
    }
    case 'classic': {
      style.color = isActive ? highlightColor : defaultColor
      style.opacity = isPast ? 0.7 : 1
      style.transition = 'color 0.1s ease'
      break
    }
    case 'pop': {
      style.color = isActive ? highlightColor : defaultColor
      style.opacity = isPast ? 0.7 : 1
      style.transform = isActive ? 'scale(1.25)' : 'scale(1)'
      style.fontWeight = isActive ? 'bold' : 'normal'
      style.transition = 'transform 0.15s ease-out, color 0.1s'
      break
    }
    case 'typewriter': {
      style.color = isActive ? highlightColor : defaultColor
      style.opacity = isFuture ? 0 : 1
      style.transition = 'opacity 0.2s ease-in'
      break
    }
    case 'bounce': {
      style.color = isActive ? highlightColor : defaultColor
      style.animation = isActive ? 'karaoke-bounce 0.3s ease-in-out' : 'none'
      break
    }
  }

  return <span style={style}>{word.word} </span>
}
