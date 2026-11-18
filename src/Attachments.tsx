import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { imageLimits } from './shared'
import type { AttachmentInfo, UserInfo } from './shared'

interface PreparedImage { file: File; image: HTMLImageElement; url: string; width: number; height: number }
export function ImageAttachments({ user, value, onChange, inputRef, disabled, onBusyChange, onError }: {
  user: UserInfo; value: AttachmentInfo[]; onChange: (images: AttachmentInfo[]) => void
  inputRef: RefObject<HTMLInputElement | null>; disabled: boolean
  onBusyChange: (busy: boolean) => void; onError: (message: string) => void
}) {
  const [queue, setQueue] = useState<File[]>([])
  const [prepared, setPrepared] = useState<PreparedImage>()
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState(0)
  const [quality, setQuality] = useState(85)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { onBusyChange(Boolean(queue.length || uploading)) }, [queue.length, uploading, onBusyChange])
  useEffect(() => {
    const file = queue[0]
    if (!file) { setPrepared(undefined); return }
    let active = true
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      if (!active) return
      if (image.naturalWidth * image.naturalHeight > 40 * 1024 * 1024) {
        setError('原图超过 4000 万像素，请先在本机缩小。')
        return
      }
      const ratio = Math.min(1, imageLimits.maxEdge / Math.max(image.naturalWidth, image.naturalHeight))
      const width = Math.max(1, Math.round(image.naturalWidth * ratio))
      const height = Math.max(1, Math.round(image.naturalHeight * ratio))
      setPrepared({ file, image, url, width, height }); setWidth(width); setHeight(height); setQuality(85); setError('')
    }
    image.onerror = () => { if (active) setError('无法读取图片，请使用有效的 JPEG、PNG 或 WebP 文件。') }
    image.src = url
    return () => { active = false; URL.revokeObjectURL(url) }
  }, [queue])
  function choose(files: FileList | null) {
    if (!files?.length) return
    const list = [...files]
    if (value.length + list.length > imageLimits.maxAttachments) { onError('每条消息最多添加 6 张图片。'); return }
    const invalid = list.find(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > imageLimits.originalBytes || !file.size)
    if (invalid) {
      onError(invalid.size > imageLimits.originalBytes ? `${invalid.name} 超过 20MB，无法添加。` : `${invalid.name} 不是受支持的静态图片。`)
      return
    }
    setQueue(list); setError('')
  }
  function resize(value: number, axis: 'width' | 'height') {
    if (!prepared) return
    const ratio = prepared.image.naturalWidth / prepared.image.naturalHeight
    const max = axis === 'width' ? Math.min(imageLimits.maxEdge, prepared.image.naturalWidth, imageLimits.maxEdge * ratio)
      : Math.min(imageLimits.maxEdge, prepared.image.naturalHeight, imageLimits.maxEdge / ratio)
    const size = Math.max(1, Math.min(Math.round(value || 1), Math.floor(max)))
    setWidth(axis === 'width' ? size : Math.max(1, Math.round(size * ratio)))
    setHeight(axis === 'height' ? size : Math.max(1, Math.round(size / ratio)))
  }
  async function upload() {
    if (!prepared || uploading) return
    setUploading(true); setError('')
    try {
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('浏览器无法处理图片。')
      context.drawImage(prepared.image, 0, 0, width, height)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(result => result ? resolve(result) : reject(new Error('图片压缩失败。')), 'image/webp', quality / 100))
      if (blob.type !== 'image/webp') throw new Error('浏览器不支持 WebP 压缩，请升级浏览器后重试。')
      if (blob.size > imageLimits.uploadBytes) throw new Error(`压缩后 ${(blob.size / 1024 / 1024).toFixed(2)}MB，仍超过 2MB；请降低分辨率或质量。`)
      const response = await fetch(`/api/attachments?name=${encodeURIComponent(prepared.file.name)}`, {
        method: 'POST', headers: { 'Content-Type': 'image/webp', 'X-CSRF-Token': user.csrf }, body: blob,
      })
      if (!response.ok) {
        const result: { error?: string } = await response.json()
        throw new Error(result.error || `上传失败（HTTP ${response.status}）`)
      }
      const image: AttachmentInfo = await response.json()
      if (!mounted.current) return
      onChange([...value, image]); setQueue(files => files.slice(1)); setPrepared(undefined)
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : '图片上传失败。') }
    finally { if (mounted.current) setUploading(false) }
  }
  return <>
    <input ref={inputRef} className="file-input" type="file" accept="image/jpeg,image/png,image/webp" multiple disabled={disabled || Boolean(queue.length)}
      aria-label="选择图片" onChange={event => { choose(event.currentTarget.files); event.currentTarget.value = '' }} />
    {value.length > 0 && <div className="attachment-list">{value.map(image => <div className="attachment-chip" key={image.id}>
      <a href={image.url} target="_blank" rel="noreferrer noopener" title={`${image.name} · ${image.width}×${image.height}`}><img src={image.url} alt={image.name} /></a>
      <button type="button" className="icon" aria-label={`移除 ${image.name}`} disabled={disabled || Boolean(queue.length)} onClick={() => onChange(value.filter(item => item.id !== image.id))}><span className="codicon codicon-close" aria-hidden="true" /></button>
    </div>)}</div>}
    {queue.length > 0 && <div className="overlay image-overlay">
      <section className="sheet image-sheet" role="dialog" aria-modal="true" aria-label="调整图片">
        <div className="sheet-heading"><h2>调整图片</h2><button type="button" className="icon" aria-label="取消图片上传" disabled={uploading} onClick={() => { setQueue([]); setError('') }}><span className="codicon codicon-close" aria-hidden="true" /></button></div>
        {prepared && <>
          <img className="resize-preview" src={prepared.url} alt={prepared.file.name} />
          <div className="image-details">{prepared.file.name} · {prepared.image.naturalWidth}×{prepared.image.naturalHeight}</div>
          <div className="resolution-fields"><label>宽度<input type="number" min={1} max={2048} value={width} disabled={uploading} onChange={event => resize(event.currentTarget.valueAsNumber, 'width')} /></label>
            <span aria-hidden="true">×</span><label>高度<input type="number" min={1} max={2048} value={height} disabled={uploading} onChange={event => resize(event.currentTarget.valueAsNumber, 'height')} /></label></div>
          <label className="quality-field">质量 {quality}%<input aria-label="压缩质量" type="range" min={40} max={95} value={quality} disabled={uploading} onChange={event => setQuality(event.currentTarget.valueAsNumber)} /></label>
          <p className="compression-notice">将保持比例压缩为 {width}×{height} WebP，移除定位等元数据。超过 2MB 时需继续调小；原图不变。</p>
        </>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="actions"><button type="button" disabled={uploading} onClick={() => { setQueue([]); setError('') }}>取消</button>
          <button type="button" className="primary" disabled={!prepared || uploading} onClick={() => { void upload() }}>{uploading ? '上传中…' : '压缩并上传'}</button></div>
      </section>
    </div>}
  </>
}
