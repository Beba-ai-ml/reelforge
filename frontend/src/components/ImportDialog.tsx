import { useState, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Upload, FolderOpen, Loader2, Check, AlertCircle } from 'lucide-react'
import { api } from '@/api/client'

interface Props {
  onClose: () => void
}

const fmtSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function ImportDialog({ onClose }: Props) {
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'upload' | 'folder'>('upload')

  // Upload state
  const [files, setFiles] = useState<File[]>([])
  const [dragActive, setDragActive] = useState(false)

  // Folder state
  const [folderPath, setFolderPath] = useState('')
  const [recursive, setRecursive] = useState(false)

  const uploadMutation = useMutation({
    mutationFn: (filesToUpload: File[]) => api.uploadClipsBulk(filesToUpload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clips'] })
      queryClient.invalidateQueries({ queryKey: ['categories'] })
      queryClient.invalidateQueries({ queryKey: ['library-stats'] })
      setFiles([])
    },
  })

  const folderMutation = useMutation({
    mutationFn: ({ path, rec }: { path: string; rec: boolean }) => api.importFolder(path, rec),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['clips'] })
      queryClient.invalidateQueries({ queryKey: ['categories'] })
      queryClient.invalidateQueries({ queryKey: ['library-stats'] })
    },
  })

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragActive(false)
    const dropped = Array.from(e.dataTransfer.files).filter(
      (f) => f.type.startsWith('video/') || f.type.startsWith('image/')
    )
    setFiles((prev) => [...prev, ...dropped])
  }, [])

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files ? Array.from(e.target.files) : []
    setFiles((prev) => [...prev, ...selected])
  }

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-lg rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
          <h2 className="text-lg font-semibold text-[var(--foreground)]">Import Clips</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[var(--border)]">
          <button
            onClick={() => setTab('upload')}
            className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition ${
              tab === 'upload'
                ? 'border-b-2 border-[var(--primary)] text-[var(--primary)]'
                : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }`}
          >
            <Upload size={14} />
            Upload Files
          </button>
          <button
            onClick={() => setTab('folder')}
            className={`flex items-center gap-2 px-6 py-3 text-sm font-medium transition ${
              tab === 'folder'
                ? 'border-b-2 border-[var(--primary)] text-[var(--primary)]'
                : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }`}
          >
            <FolderOpen size={14} />
            Import Folder
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {tab === 'upload' && (
            <div>
              {/* Drop zone */}
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragActive(true)
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={handleDrop}
                className={`flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed px-6 py-10 transition ${
                  dragActive
                    ? 'border-[var(--primary)] bg-[var(--primary)]/5'
                    : 'border-[var(--border)] hover:border-[var(--muted-foreground)]'
                }`}
              >
                <Upload size={32} className="mb-3 text-[var(--muted-foreground)]" />
                <p className="mb-1 text-sm text-[var(--foreground)]">
                  Drag & drop video or image files
                </p>
                <p className="mb-4 text-xs text-[var(--muted-foreground)]">
                  MP4, MOV, AVI, JPG, PNG, WebP supported
                </p>
                <label className="cursor-pointer rounded-lg bg-[var(--muted)] px-4 py-2 text-sm text-[var(--foreground)] transition hover:bg-[var(--border)]">
                  Browse Files
                  <input
                    type="file"
                    accept="video/*,image/*"
                    multiple
                    onChange={handleFileInput}
                    className="hidden"
                  />
                </label>
              </div>

              {/* File list */}
              {files.length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-medium text-[var(--muted-foreground)]">
                    {files.length} file{files.length !== 1 ? 's' : ''} selected
                  </p>
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {files.map((f, i) => (
                      <div
                        key={`${f.name}-${i}`}
                        className="flex items-center justify-between rounded bg-[var(--muted)] px-3 py-1.5"
                      >
                        <span className="mr-3 truncate text-xs text-[var(--foreground)]">
                          {f.name}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="whitespace-nowrap text-[10px] text-[var(--muted-foreground)]">
                            {fmtSize(f.size)}
                          </span>
                          <button
                            onClick={() => removeFile(i)}
                            className="rounded p-0.5 text-[var(--muted-foreground)] hover:text-[var(--destructive)]"
                          >
                            <X size={12} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Upload result */}
              {uploadMutation.isSuccess && (
                <div className="mt-3 flex items-center gap-2 text-sm text-emerald-400">
                  <Check size={14} />
                  Upload complete
                </div>
              )}
              {uploadMutation.isError && (
                <div className="mt-3 flex items-center gap-2 text-sm text-[var(--destructive)]">
                  <AlertCircle size={14} />
                  {(uploadMutation.error as Error).message}
                </div>
              )}

              {/* Upload button */}
              <button
                onClick={() => uploadMutation.mutate(files)}
                disabled={files.length === 0 || uploadMutation.isPending}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)] disabled:opacity-50"
              >
                {uploadMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Upload size={14} />
                )}
                Upload All
              </button>
            </div>
          )}

          {tab === 'folder' && (
            <div>
              <label className="mb-1 block text-sm text-[var(--muted-foreground)]">
                Directory Path
              </label>
              <input
                type="text"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                placeholder="/home/user/videos/broll"
                className="mb-3 w-full rounded-lg border border-[var(--border)] bg-[var(--muted)] px-3 py-2 text-sm text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)] focus:ring-2 focus:ring-[var(--ring)]"
              />

              <label className="mb-4 flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={recursive}
                  onChange={(e) => setRecursive(e.target.checked)}
                  className="rounded border-[var(--border)] bg-[var(--muted)]"
                />
                <span className="text-sm text-[var(--foreground)]">Scan subdirectories recursively</span>
              </label>

              {/* Folder import result */}
              {folderMutation.isSuccess && folderMutation.data && (
                <div className="mb-3 rounded-lg border border-[var(--border)] bg-[var(--muted)] p-3">
                  <p className="mb-1 text-sm font-medium text-[var(--foreground)]">Import Complete</p>
                  <div className="flex gap-4 text-xs text-[var(--muted-foreground)]">
                    <span className="text-emerald-400">{folderMutation.data.imported} imported</span>
                    <span>{folderMutation.data.skipped} skipped</span>
                    {folderMutation.data.errors > 0 && (
                      <span className="text-[var(--destructive)]">{folderMutation.data.errors} errors</span>
                    )}
                  </div>
                </div>
              )}
              {folderMutation.isError && (
                <div className="mb-3 flex items-center gap-2 text-sm text-[var(--destructive)]">
                  <AlertCircle size={14} />
                  {(folderMutation.error as Error).message}
                </div>
              )}

              <button
                onClick={() => folderMutation.mutate({ path: folderPath.trim(), rec: recursive })}
                disabled={!folderPath.trim() || folderMutation.isPending}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] transition hover:bg-[var(--accent)] disabled:opacity-50"
              >
                {folderMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <FolderOpen size={14} />
                )}
                Import
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
