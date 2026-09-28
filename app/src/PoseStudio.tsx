import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { ArrowRight, Expand, FlipHorizontal2, ImagePlus, LoaderCircle, Maximize, Redo2, RotateCcw, Shrink, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { Asset } from './domain'
import { authenticatedFetch } from './auth-client'
import { PoseScene, poseReferenceBoard } from './pose-scene'
import type { PoseAngles, PosePlacement, PosePreset } from './pose-scene'
import './PoseStudio.css'

export type PoseDraft = { angles: PoseAngles | null; presetId: string; placement?: PosePlacement; rotation?: number }
const emptyPoseDraft = (): PoseDraft => ({ angles: null, presetId: 'ual1Idle' })

export default function PoseStudio({ assets, value, onChange, onPrepare }: {
  assets: Asset[]
  value: PoseDraft
  onChange: (value: PoseDraft) => void
  onPrepare: (board: File, prompt: string, signal: AbortSignal) => Promise<void>
}) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<PoseScene | null>(null)
  const [presets, setPresets] = useState<PosePreset[]>([])
  const [ready, setReady] = useState(false)
  const [revision, setRevision] = useState(0)
  const [loadError, setLoadError] = useState('')
  const [selectedJoint, setSelectedJoint] = useState<string | null>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const fullscreenButton = useRef<HTMLButtonElement>(null)
  const [past, setPast] = useState<PoseDraft[]>([])
  const [future, setFuture] = useState<PoseDraft[]>([])
  const [sourceId, setSourceId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const images = assets.filter(asset => (asset.mediaType ?? 'image') === 'image')
  const selectedPreset = presets.find(preset => preset.id === value.presetId)
  const placement = value.placement ?? selectedPreset?.placement
  const rotation = value.rotation ?? selectedPreset?.rotation
  const commitPose = useEffectEvent((angles: PoseAngles) => change({ presetId: '', angles, placement, rotation }))

  useEffect(() => {
    const abort = new AbortController()
    let active = true
    let engine: PoseScene | undefined
    void (async () => {
      try {
        engine = new PoseScene(host.current!, angles => commitPose(angles), setSelectedJoint)
        scene.current = engine
        const response = await fetch('/pose/presets.json', { signal: abort.signal })
        if (!response.ok) throw new Error('姿势库加载失败')
        const data: { poses: PosePreset[] } = await response.json()
        await engine.load()
        if (!active) return
        setPresets(data.poses)
        setReady(true)
      } catch (failure) { if (active) setLoadError(failure instanceof Error ? failure.message : '无法加载三维人偶，请确认浏览器支持 WebGL') }
    })()
    return () => { active = false; abort.abort(); engine?.dispose(); scene.current = null; controller.current?.abort() }
  }, [revision])

  useEffect(() => {
    if (ready) scene.current?.apply(value.angles ?? selectedPreset!.joints, placement, rotation, !value.angles)
  }, [ready, value, selectedPreset, placement, rotation])

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  useEffect(() => { if (ready) scene.current?.setEditingEnabled(!busy) }, [ready, busy])

  const angles = value.angles ?? presets.find(preset => preset.id === value.presetId)?.joints ?? {}
  function change(next: PoseDraft) {
    setPast(previous => [...previous.slice(-39), value]); setFuture([]); onChange(next)
  }
  function undo() {
    if (!past.length) return
    setFuture(previous => [...previous, value]); onChange(past.at(-1)!); setPast(previous => previous.slice(0, -1))
  }
  function redo() {
    if (!future.length) return
    setPast(previous => [...previous, value]); onChange(future.at(-1)!); setFuture(previous => previous.slice(0, -1))
  }
  function mirror() {
    const mirrored: PoseAngles = {}
    for (const [name, rotation] of Object.entries(angles)) {
      const opposite = name.startsWith('left') ? name.replace('left', 'right') : name.startsWith('right') ? name.replace('right', 'left') : name
      mirrored[opposite] = [rotation[0], -rotation[1], -rotation[2]]
    }
    change({ presetId: '', angles: mirrored, placement, rotation: rotation ? -rotation : 0 })
  }
  async function prepare() {
    if (!ready || busy || (!file && !sourceId)) return
    const abort = new AbortController()
    controller.current = abort
    setBusy(true); setError('')
    try {
      let person: Blob
      if (file) person = file
      else {
        const response = await authenticatedFetch(`/api/assets/${sourceId}/content`, { signal: abort.signal })
        if (!response.ok) throw new Error('人物参考图读取失败，请重新选择')
        person = await response.blob()
      }
      abort.signal.throwIfAborted()
      const board = await poseReferenceBoard(scene.current!.capture(), person)
      abort.signal.throwIfAborted()
      await onPrepare(board, prompt.trim(), abort.signal)
    } catch (failure) {
      if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '参考板准备失败')
    } finally { if (controller.current === abort) { controller.current = null; setBusy(false) } }
  }

  return <div className="pose-studio" data-fullscreen={fullscreen} onKeyDown={event => {
    if (event.key !== 'Escape' || !fullscreen || (selectedJoint && event.target instanceof HTMLCanvasElement)) return
    event.stopPropagation()
    setFullscreen(false)
    fullscreenButton.current?.focus()
  }}>
    <section className="pose-editor" aria-label="姿势编辑区">
    <div className="pose-viewbar">
      <label className="pose-preset"><span>姿势</span><select aria-label="内置姿势" value={value.presetId} disabled={!ready || busy} onChange={event => change({ presetId: event.target.value, angles: null })}><option value="" disabled>自定义姿势</option>{[...new Set(presets.map(preset => preset.folder))].map(folder => <optgroup key={folder} label={folder}>{presets.filter(preset => preset.folder === folder).map(preset => <option value={preset.id} key={preset.id}>{preset.name}</option>)}</optgroup>)}</select></label>
      <button ref={fullscreenButton} type="button" className="icon-button pose-fullscreen" title={fullscreen ? '退出全屏编辑' : '全屏编辑'} aria-label={fullscreen ? '退出全屏编辑' : '全屏编辑'} aria-pressed={fullscreen} disabled={busy} onClick={() => setFullscreen(previous => !previous)}>{fullscreen ? <Shrink size={20} /> : <Expand size={20} />}</button>
    </div>
    <div className="pose-viewport" ref={host} data-ready={ready}>
      {ready && selectedJoint && <span className="pose-selected" role="status">{selectedJoint}</span>}
      {!ready && <div className="pose-loading" role="status">{loadError ? <><span>{loadError}</span><button type="button" className="icon-button" aria-label="重试加载人偶" title="重试加载人偶" onClick={() => { setReady(false); setLoadError(''); setRevision(previous => previous + 1) }}><RotateCcw size={20} /></button></> : <><LoaderCircle size={22} className="spin" />加载人偶</>}</div>}
    </div>
    <div className="pose-toolbar" role="toolbar" aria-label="姿势工具">
      <div className="pose-toolgroup" role="group" aria-label="姿势操作">
      <button type="button" className="icon-button" title="撤销姿势" aria-label="撤销姿势" disabled={!ready || busy || !past.length} onClick={undo}><Undo2 size={19} /></button>
      <button type="button" className="icon-button" title="重做姿势" aria-label="重做姿势" disabled={!ready || busy || !future.length} onClick={redo}><Redo2 size={19} /></button>
      <button type="button" className="icon-button" title="镜像姿势" aria-label="镜像姿势" disabled={!ready || busy} onClick={mirror}><FlipHorizontal2 size={19} /></button>
      <button type="button" className="icon-button" title="恢复站立" aria-label="恢复站立" disabled={!ready || busy} onClick={() => change(emptyPoseDraft())}><RotateCcw size={19} /></button>
      </div>
      <div className="pose-toolgroup pose-camera-tools" role="group" aria-label="镜头操作">
      <button type="button" className="icon-button" title="正面全身" aria-label="正面全身" disabled={!ready || busy} onClick={() => scene.current?.home()}><Maximize size={19} /></button>
      <button type="button" className="icon-button" title="拉近镜头" aria-label="拉近镜头" disabled={!ready || busy} onClick={() => scene.current?.zoom(0.85)}><ZoomIn size={19} /></button>
      <button type="button" className="icon-button" title="拉远镜头" aria-label="拉远镜头" disabled={!ready || busy} onClick={() => scene.current?.zoom(1.15)}><ZoomOut size={19} /></button>
      </div>
    </div>
    </section>
    <div className="pose-fields" hidden={fullscreen}>
      <h3>生成参考</h3>
      <div className="pose-source">
        <label>人物参考图<select aria-label="人物参考图" disabled={busy} value={sourceId} onChange={event => { setSourceId(event.target.value); setFile(null); setPreview(''); setError('') }}><option value="">{file ? file.name : '选择项目图片'}</option>{images.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
        <button type="button" className="icon-button" title="上传人物参考图" aria-label="上传人物参考图" disabled={busy} onClick={() => input.current?.click()}><ImagePlus size={21} /></button>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" aria-label="人物图片文件" hidden onChange={event => {
          const selected = event.target.files?.[0]
          event.target.value = ''
          if (!selected) return
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(selected.type) || !selected.size || selected.size > 64 * 1024 * 1024) { setError('请选择不超过 64 MB 的 PNG、JPEG 或 WebP 图片'); return }
          setSourceId(''); setFile(selected); setPreview(URL.createObjectURL(selected)); setError('')
        }} />
      </div>
      {(preview || sourceId) && <img className="pose-person" alt="已选人物参考图" src={preview || `/api/assets/${sourceId}/content?thumbnail=1`} />}
      <label>场景与风格<textarea rows={2} maxLength={2000} placeholder="例如：街头摄影，自然光，保留人物服装" value={prompt} disabled={busy} onChange={event => setPrompt(event.target.value)} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="pose-submit"><button type="button" className="primary" disabled={!ready || busy || (!file && !sourceId)} onClick={() => void prepare()}>{busy ? <LoaderCircle size={18} className="spin" /> : <ArrowRight size={18} />}{busy ? '正在准备参考板' : '带入生成草稿'}</button>{busy && <button type="button" className="icon-button" title="取消准备" aria-label="取消准备" onClick={() => controller.current?.abort()}><X size={20} /></button>}</div>
    </div>
  </div>
}