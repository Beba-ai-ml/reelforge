import { useState, useEffect, useCallback, type RefObject } from 'react'

export function useTimeline(videoRef: RefObject<HTMLVideoElement | HTMLAudioElement | null>) {
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [playbackRate, setPlaybackRateState] = useState(1)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return

    const onTimeUpdate = () => setCurrentTime(el.currentTime)
    const onLoadedMetadata = () => setDuration(el.duration)
    const onEnded = () => setIsPlaying(false)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)

    el.addEventListener('timeupdate', onTimeUpdate)
    el.addEventListener('loadedmetadata', onLoadedMetadata)
    el.addEventListener('ended', onEnded)
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)

    return () => {
      el.removeEventListener('timeupdate', onTimeUpdate)
      el.removeEventListener('loadedmetadata', onLoadedMetadata)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
    }
  }, [videoRef])

  const play = useCallback(() => {
    void videoRef.current?.play()
  }, [videoRef])

  const pause = useCallback(() => {
    videoRef.current?.pause()
  }, [videoRef])

  const seek = useCallback((time: number) => {
    const el = videoRef.current
    if (el) {
      el.currentTime = time
      setCurrentTime(time)
    }
  }, [videoRef])

  const setSpeed = useCallback((rate: number) => {
    const el = videoRef.current
    if (el) {
      el.playbackRate = rate
      setPlaybackRateState(rate)
    }
  }, [videoRef])

  return {
    currentTime,
    isPlaying,
    duration,
    playbackRate,
    play,
    pause,
    seek,
    setSpeed,
  }
}
