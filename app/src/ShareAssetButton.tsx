import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Share2, X } from 'lucide-react'
import { authenticatedFetch } from './auth-client'
import { assetContentType, assetExtension } from './domain'
import type { Asset } from './domain'

type ShareAsset = Pick<Asset, 'id' | 'name' | 'mediaType' | 'mimeType' | 'storageExtension'>

export function ShareAssetButton({ asset }: { asset: ShareAsset }) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])

  async function prepare() {
    if (request.current) return
    if (!window.isSecureContext || !navigator.share || !navigator.canShare) {
      setMessage('当前浏览器不支持文件转发')
      return
    }
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setMessage('正在准备文件')
    try {
      const response = await authenticatedFetch(`/api/assets/${asset.id}/content`, { signal: controller.signal })
      if (!response.ok) throw new Error(response.status === 401 ? '登录已过期' : '文件读取失败，请重试')
      const maximum = 64 * 1024 * 1024
      if (Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error('文件过大，无法转发') }
      const blob = await response.blob()
      controller.signal.throwIfAborted()
      if (!blob.size || blob.size > maximum) throw new Error('文件为空或过大，无法转发')
      const filename = asset.mediaType === 'file' || asset.storageExtension === 'bin' ? asset.name : `${asset.name.replace(/\.[^.]+$/, '')}.${assetExtension(asset)}`
      const prepared = new File([blob], filename, { type: assetContentType(asset) })
      if (!navigator.canShare({ files: [prepared] })) throw new Error('当前浏览器不支持转发此文件类型')
      setFile(prepared); setMessage('文件已就绪')
    } catch (failure) {
      if (!controller.signal.aborted) setMessage(failure instanceof Error ? failure.message : '文件准备失败，请重试')
    } finally {
      if (controller.signal.aborted) setMessage('')
      request.current = null; setBusy(false)
    }
  }

  async function share() {
    if (!file || busy) return
    setBusy(true); setMessage('')
    try {
      await navigator.share({ files: [file] })
      setFile(null)
    } catch (failure) {
      if (!(failure instanceof Error && failure.name === 'AbortError')) setMessage('未能打开系统分享，请重试')
    } finally { setBusy(false) }
  }

  const label = file ? '选择转发应用' : '转发'
  return <div className="asset-share">
    <button type="button" className="icon-button" disabled={busy} aria-label={label} title={label} onClick={() => { if (file) void share(); else void prepare() }}>{busy ? <LoaderCircle size={19} className="spin" /> : <Share2 size={19} />}</button>
    {busy && !file && <button type="button" className="icon-button" aria-label="取消准备转发" title="取消准备转发" onClick={() => request.current?.abort()}><X size={18} /></button>}
    {message && <span className="share-status" role="status">{message}</span>}
  </div>
}