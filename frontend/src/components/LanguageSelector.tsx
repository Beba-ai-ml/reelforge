import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Globe, Plus, Loader2, ChevronDown } from 'lucide-react'
import { api } from '@/api/client'

interface Props {
  projectId: string
  selectedLanguage: string
  onLanguageChange: (lang: string) => void
}

const SUPPORTED_LANGUAGES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pl: 'Polish',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
}

export default function LanguageSelector({ projectId, selectedLanguage, onLanguageChange }: Props) {
  const [addOpen, setAddOpen] = useState(false)
  const [targetLang, setTargetLang] = useState('es')
  const [translateStatus, setTranslateStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  const queryClient = useQueryClient()

  const { data: langsData } = useQuery({
    queryKey: ['subtitle-languages', projectId],
    queryFn: () => api.listSubtitleLanguages(projectId),
    staleTime: 10_000,
  })

  const availableLanguages = langsData?.languages ?? ['en']

  const translateMutation = useMutation({
    mutationFn: () => api.translateSubtitles(projectId, targetLang, 'en'),
    onMutate: () => {
      setTranslateStatus('loading')
      setErrorMsg('')
    },
    onSuccess: (data) => {
      setTranslateStatus('done')
      queryClient.invalidateQueries({ queryKey: ['subtitle-languages', projectId] })
      queryClient.invalidateQueries({ queryKey: ['subtitles', projectId] })
      onLanguageChange(data.target_language)
      setTimeout(() => {
        setAddOpen(false)
        setTranslateStatus('idle')
      }, 1200)
    },
    onError: (err: Error) => {
      setTranslateStatus('error')
      setErrorMsg(err.message || 'Translation failed')
    },
  })

  const unavailableLanguages = Object.keys(SUPPORTED_LANGUAGES).filter(
    (lang) => !availableLanguages.includes(lang) && lang !== 'en'
  )

  return (
    <div className="mb-2 flex flex-col gap-2">
      {/* Language tabs */}
      <div className="flex items-center gap-1">
        <Globe size={13} className="shrink-0 text-[var(--muted-foreground)]" />
        <div className="flex flex-wrap gap-1">
          {availableLanguages.map((lang) => (
            <button
              key={lang}
              onClick={() => onLanguageChange(lang)}
              className={`rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide transition ${
                selectedLanguage === lang
                  ? 'bg-[var(--primary)] text-[var(--primary-foreground)]'
                  : 'bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
              }`}
            >
              {SUPPORTED_LANGUAGES[lang] ?? lang.toUpperCase()}
            </button>
          ))}
          <button
            onClick={() => setAddOpen((v) => !v)}
            title="Add language"
            className="flex items-center gap-0.5 rounded px-2 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] bg-[var(--muted)]"
          >
            <Plus size={11} />
            Add
            <ChevronDown size={11} className={`transition-transform ${addOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {/* Add language dialog */}
      {addOpen && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
          <p className="mb-2 text-[10px] font-semibold text-[var(--foreground)]">
            Translate subtitles to another language
          </p>
          <p className="mb-2 text-[10px] text-[var(--muted-foreground)]">
            AI will translate all English subtitles. Translation is approximate.
          </p>

          <div className="flex items-center gap-2">
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              disabled={translateStatus === 'loading'}
              className="flex-1 rounded border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-xs text-[var(--foreground)] outline-none focus:ring-1 focus:ring-[var(--ring)]"
            >
              {unavailableLanguages.length === 0 ? (
                <option value="" disabled>All languages added</option>
              ) : (
                unavailableLanguages.map((lang) => (
                  <option key={lang} value={lang}>
                    {SUPPORTED_LANGUAGES[lang]}
                  </option>
                ))
              )}
            </select>
            <button
              onClick={() => translateMutation.mutate()}
              disabled={translateStatus === 'loading' || unavailableLanguages.length === 0}
              className="flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-[var(--primary-foreground)] transition hover:opacity-90 disabled:opacity-40"
            >
              {translateStatus === 'loading' ? (
                <>
                  <Loader2 size={12} className="animate-spin" />
                  Translating...
                </>
              ) : translateStatus === 'done' ? (
                'Done!'
              ) : (
                'Translate'
              )}
            </button>
          </div>

          {translateStatus === 'error' && (
            <p className="mt-1.5 text-[10px] text-red-400">{errorMsg}</p>
          )}
          {translateStatus === 'done' && (
            <p className="mt-1.5 text-[10px] text-green-400">
              Subtitles translated successfully.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
