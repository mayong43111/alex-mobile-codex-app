import { useEffect, useRef, useState } from 'react'
import { Accessibility, Camera, Check, Images, LoaderCircle, RotateCcw, ShoppingBag, Upload, UserRound, X } from 'lucide-react'
import type { Asset, ImageModel, Ratio } from './domain'
import { imageModels, imageModelNames, ratios } from './domain'
import { authenticatedFetch } from './auth-client'
import './ModelShoot.css'

export type ShootRole = 'model' | 'pose' | 'product'
export type ShootReferences = Record<ShootRole, Asset | null>
export type ShootSubmission = { text: string; assetIds: string[]; ratio: Ratio; imageModel: ImageModel }
const roles = [
  { key: 'model', title: '模特参考图', label: 'A / MODEL', Icon: UserRound },
  { key: 'pose', title: '姿势参考图', label: 'B / POSE', Icon: Accessibility },
  { key: 'product', title: '商品参考图', label: 'C / PRODUCT', Icon: ShoppingBag },
] as const

const modelTypes = {
  portrait: { name: '平面模特', identity: '严格保留其面容、五官比例、脸型、发型、年龄特征、肤色、体型与身体比例，不换脸、不美白、不改变种族外观。根据商品选择全身、半身或局部构图；参考图未提供的面部信息不自行补造。', pose: '提取身体姿势、关节角度、手脚位置、朝向、构图与相机视角，由本次拍摄的模特完成这一姿势。' },
  hands: { name: '手模', identity: '以手部及必要的前臂为模特主体。严格保留参考手部的肤色、皮肤纹理、手型、手指长度与粗细、指节、指甲形状和原有甲色，不美白、不替换手型。构图聚焦手部和商品，不因全身姿势参考而额外生成脸部或全身人物。', pose: '仅提取手腕朝向、手指弯曲与关节角度、抓握或接触位置及相关相机视角；忽略与手部展示无关的躯干、腿部和面部。保持正常手指数量与关节结构，避免融合、多指和穿模。' },
  feet: { name: '脚模', identity: '以足部及必要的小腿为模特主体。严格保留参考足部的肤色、皮肤纹理、脚型、足弓、脚趾长度与排列、踝部比例、趾甲形状和原有甲色，不美白、不替换脚型。构图聚焦足部和商品，不因全身姿势参考而额外生成脸部或全身人物。', pose: '仅提取脚踝朝向、脚趾状态、足部关节角度、双脚相对位置、着地与支撑关系及相关相机视角；忽略无关的上身和面部。保持正常脚趾数量与足部结构，避免融合、多趾和穿模。' },
} as const
type ModelType = keyof typeof modelTypes
type ProductType = 'clothes' | 'shoes' | 'accessories' | 'stockings' | 'props' | 'other'
const productTypes: Record<ProductType, { name: string; details: string; display: Record<ModelType, string> }> = {
  clothes: { name: '衣服', details: '重点保留版型、衣长、领口、袖口、缝线、扣件、印花、面料厚度和垂坠感，不改变裁片结构。', display: { portrait: '让模特正常穿着参考服装，衣物贴合体型但不改变剪裁，褶皱和遮挡自然。', hands: '由手部持起、展开或整理服装，展示面料、缝线与款式细节，不把衣服当作手套，不补造全身试穿人物。', feet: '仅在参考服装本身适合腿足部穿着时展示裤脚等局部；其他服装完整摆放在足部旁作商品陈列，不把上衣等错误穿到脚上。' } },
  shoes: { name: '鞋子', details: '重点保留鞋型、鞋头、鞋底、鞋跟、鞋面材质、鞋带、开口、缝线及标识，左右鞋方向正确，不改变鞋底厚度或跟高。', display: { portrait: '让模特正确穿着参考鞋子，足部与鞋腔自然贴合，保持鞋款轮廓，并通过构图清楚展示鞋子。', hands: '由手部自然持握或托起鞋子，展示鞋型与关键细节，不把鞋穿在手上，不凭空加入脚部试穿。', feet: '让参考足部正确穿着鞋子，保持脚型与肤色，脚趾、脚背和后跟与鞋腔贴合，鞋与地面接触自然，不穿透鞋面。' } },
  accessories: { name: '饰品', details: '重点保留饰品尺寸、形状、金属色泽、镶嵌、链节、扣件、刻字及装饰数量，不增删部件。', display: { portrait: '按饰品真实用途佩戴在正确部位，例如耳饰、项链、手链或戒指；构图突出饰品及其佩戴比例。', hands: '戒指和手链按真实用途佩戴；耳饰、项链等由手持或托起展示，不把不适用的饰品强行戴在手指上。', feet: '只有明确为脚链或趾戒的饰品才佩戴于足部；其他饰品摆放在足部旁展示，不将耳饰、项链等改造成足饰。' } },
  stockings: { name: '丝袜', details: '重点保留丝袜颜色、透明度、织纹、光泽、厚薄、长度、袜口、接缝、袜尖与图案；丝袜下面的肤色遵循本次模特外观要求，不借透明材质改变肤色。', display: { portrait: '按参考款式正常穿着丝袜，腿部覆盖范围、袜口位置、拉伸纹理和接缝走向正确，以服饰商品摄影展示整体搭配。', hands: '由手部轻持或适度展开丝袜，展示织纹、透明度和袜口工艺，不把丝袜当作手套，不额外生成腿部试穿。', feet: '让足部和必要的小腿按参考款式正常穿着丝袜，袜尖、脚跟和踝部贴合，织纹拉伸自然；超出局部构图的长袜部分自然延伸，不擅自缩短袜长。' } },
  props: { name: '道具', details: '重点保留道具真实尺寸比例、功能结构、材质、接口、文字图案和使用方向，不添加不存在的功能或配件。', display: { portrait: '按道具实际用途自然持有、使用或在身旁展示，手部接触与受力合理。', hands: '按道具实际用途抓握、操作或托起，手指不能遮住关键功能细节，接触点与受力合理。', feet: '仅在道具实际用途允许时进行足部接触；否则摆放在足部附近，不强行踩踏、夹持或改变道具用途。' } },
  other: { name: '其他', details: '根据参考图识别商品实际用途，保留其独特结构与关键细节，不自行改换品类。', display: { portrait: '依据商品实际用途选择正常穿戴、持有或并置陈列，不臆造不合理的使用方式。', hands: '采用合理的手持、托举或并置陈列，突出手部与商品，不强行穿戴不适用的商品。', feet: '仅对适用于足部的商品采用正常穿戴，其余商品采用并置陈列，不强行穿戴或踩踏。' } },
}

function defaultPrompt(modelType: ModelType, productType: ProductType, references: ShootReferences) {
  const model = modelTypes[modelType], product = productTypes[productType]
  const ids = [...new Set(roles.flatMap(role => references[role.key] ? [references[role.key]!.id] : []))]
  const reference = (role: ShootRole) => `参考图${ids.indexOf(references[role]!.id) + 1}`
  const modelRule = references.model ? `${reference('model')}：模特外观的唯一来源。${model.identity}不采用其他参考图中人物的外貌或肤色。` : '未指定模特参考：依据用户补充要求和拍摄类型安排模特，不声称保留未提供的模特身份。'
  const poseRule = references.pose ? `${reference('pose')}：提供姿势与视角。${model.pose}除该图同时承担的模特或商品角色外，不复制姿势图人物的外貌、肤色或服装；如果是3D人偶，不复制人偶材质、关节标记或控制器。` : '未指定姿势参考：依据商品实际用途和用户补充要求安排自然合理的展示姿势，可参考商品图的穿戴关系。'
  const replacement = references.model ? references.model.id === references.product?.id ? '此图同时提供模特外观，保留该模特身份。' : `若有原模特，只提取商品及合理的穿戴关系，将原模特替换为${reference('model')}的模特，不继承原模特的脸、肤色、手型、脚型、指甲或体型。` : '模特外观按用户要求安排，不固定继承商品图原模特的身份。'
  const productReference = `商品参考图既可以是纯商品图，也可以是已有模特穿着、佩戴或持有商品的展示图，无需先去除原模特。${replacement}${references.pose ? `最终姿势以${reference('pose')}为准。` : ''}保持可见商品细节，对遮挡部位谨慎处理，不借补全遮挡擅自改款。`
  const productRule = references.product ? `${reference('product')}：商品外观的唯一来源。严格保留商品品类、款式、轮廓、结构、配色、材质、纹理、图案、细节与可见标识，不更换款式，不虚构配件，不改变商品设计。${product.details}${productReference}` : '未指定商品参考：依据用户补充要求和已提供图片确定商品，不声称复刻未提供的具体款式。'
  const mapping = roles.filter(role => references[role.key]).map(role => `${role.title}：${reference(role.key)}`).join('；')
  return `请使用全部${ids.length}张已提供的参考图拍摄一张新的真实感商品模特照片，另存为新作品，不覆盖任何原图。\n拍摄类型：${model.name}；商品类别：${product.name}。\n角色对应：${mapping}。同一张图可以承担多个角色，各角色要求分别生效。\n\n${modelRule}\n${poseRule}\n${productRule}\n\n展示方式：${product.display[modelType]}接触、尺寸比例和遮挡符合真实物理关系，关键商品细节清晰可辨。\n\n输出一张完整摄影成片，光线与阴影统一，皮肤质感自然，保持正常人体结构。不输出拼图、参考板、标签、额外人物或新增文字。`
}

function savedCategories(key: string): { modelType: ModelType; productType: ProductType } {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    return { modelType: Object.hasOwn(modelTypes, value?.modelType) ? value.modelType : 'portrait', productType: Object.hasOwn(productTypes, value?.productType) ? value.productType : 'clothes' }
  } catch { return { modelType: 'portrait', productType: 'clothes' } }
}

async function referencePreview(references: { asset: Asset; label: string }[], signal: AbortSignal) {
  const bitmaps: ImageBitmap[] = []
  try {
    for (const { asset } of references) {
      const response = await authenticatedFetch(`/api/assets/${asset.id}/content`, { signal })
      if (!response.ok) throw new Error('参考图读取失败，请重新选择')
      bitmaps.push(await createImageBitmap(await response.blob()))
      signal.throwIfAborted()
    }
    const canvas = document.createElement('canvas')
    canvas.width = references.length * 672; canvas.height = 1024
    const context = canvas.getContext('2d')
    if (!context) throw new Error('浏览器无法合并参考图')
    context.fillStyle = '#f1f4f2'; context.fillRect(0, 0, canvas.width, canvas.height)
    for (const [index, bitmap] of bitmaps.entries()) {
      const left = index * 672
      context.fillStyle = '#ffffff'; context.fillRect(left + 8, 48, 656, 968)
      const scale = Math.min(640 / bitmap.width, 944 / bitmap.height)
      const width = bitmap.width * scale, height = bitmap.height * scale
      context.drawImage(bitmap, left + (672 - width) / 2, 60 + (944 - height) / 2, width, height)
      context.fillStyle = '#263b30'; context.font = '20px sans-serif'
      context.fillText(references[index].label, left + 16, 31)
    }
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('无法导出合并预览')), 'image/png'))
    signal.throwIfAborted()
    return URL.createObjectURL(blob)
  } finally { bitmaps.forEach(bitmap => bitmap.close()) }
}

export default function ModelShoot({ assets, references, onChange, onUpload, onLibrary, onPose, onGenerate, onDraft, onBusyChange, initialRatio, initialModel, availableModels, disabled, preferencesKey }: {
  assets: Asset[]
  references: ShootReferences
  onChange: (role: ShootRole, asset: Asset | null) => void
  onUpload: (file: File, signal: AbortSignal) => Promise<Asset>
  onLibrary: (role: ShootRole) => void
  onPose: () => void
  onGenerate: (input: ShootSubmission) => Promise<void>
  onDraft: (input: ShootSubmission) => Promise<void>
  onBusyChange: (busy: boolean) => void
  initialRatio: Ratio
  initialModel: ImageModel
  availableModels: ImageModel[]
  disabled: boolean
  preferencesKey: string
}) {
  const [ratio, setRatio] = useState(initialRatio)
  const [imageModel, setImageModel] = useState(initialModel)
  const [modelType, setModelType] = useState<ModelType>(() => savedCategories(preferencesKey).modelType)
  const [productType, setProductType] = useState<ProductType>(() => savedCategories(preferencesKey).productType)
  const [prompt, setPrompt] = useState('')
  const [generatedPrompt, setGeneratedPrompt] = useState('')
  const [preview, setPreview] = useState('')
  const [preparedKey, setPreparedKey] = useState('')
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const files = useRef<Partial<Record<ShootRole, HTMLInputElement | null>>>({})
  const selected = roles.map(role => references[role.key])
  const selectedAssets = selected.filter((asset): asset is Asset => asset !== null)
  const hasReferences = selectedAssets.length > 0
  const selectionKey = JSON.stringify(selected.map(asset => asset ? [asset.id, asset.hash] : null))
  const prepared = preparedKey === selectionKey && !!preview
  const locked = disabled || !!pending
  const projectImages = assets.filter(asset => (asset.mediaType ?? 'image') === 'image')
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])
  useEffect(() => () => controller.current?.abort(), [])

  function confirmPromptReplacement() {
    return !preparedKey || prompt === generatedPrompt || window.confirm('重新生成提示词将替换你已编辑的内容。是否继续？')
  }

  function changeCategories(nextModel: ModelType, nextProduct: ProductType) {
    if (nextModel === modelType && nextProduct === productType) return
    if (!confirmPromptReplacement()) return
    setModelType(nextModel); setProductType(nextProduct)
    try { localStorage.setItem(preferencesKey, JSON.stringify({ modelType: nextModel, productType: nextProduct })) } catch {}
    if (preparedKey) {
      const next = defaultPrompt(nextModel, nextProduct, references)
      setPrompt(next); setGeneratedPrompt(next)
    }
  }

  async function perform(label: string, operation: (signal: AbortSignal) => Promise<void>) {
    if (locked || controller.current) return
    const abort = new AbortController()
    controller.current = abort
    setPending(label); setError(''); onBusyChange(true)
    try { await operation(abort.signal) }
    catch (failure) { if (!abort.signal.aborted) setError(failure instanceof Error ? failure.message : '操作失败，请重试') }
    finally { controller.current = null; setPending(''); onBusyChange(false) }
  }

  async function prepare() {
    if (!hasReferences) return
    await perform('正在合并参考图', async signal => {
      const url = await referencePreview(roles.flatMap(role => references[role.key] ? [{ asset: references[role.key]!, label: role.label }] : []), signal)
      setPreview(url); setPreparedKey(selectionKey)
      const next = defaultPrompt(modelType, productType, references)
      setPrompt(previous => !previous || previous === generatedPrompt ? next : previous)
      setGeneratedPrompt(next)
    })
  }

  async function submit(draft: boolean) {
    if (!hasReferences || !prepared || !prompt.trim()) return
    await perform(draft ? '正在带入对话' : '正在提交生图', async () => {
      const input = { text: prompt.trim(), assetIds: [...new Set(selectedAssets.map(asset => asset.id))], ratio, imageModel }
      if (draft) await onDraft(input)
      else await onGenerate(input)
    })
  }

  return <div className="model-shoot">
    <div className="shoot-settings shoot-categories">
      <label>模特类型<select aria-label="模特类型" value={modelType} disabled={locked} onChange={event => changeCategories(event.target.value as ModelType, productType)}>{(Object.keys(modelTypes) as ModelType[]).map(value => <option key={value} value={value}>{modelTypes[value].name}</option>)}</select></label>
      <label>商品类别<select aria-label="商品类别" value={productType} disabled={locked} onChange={event => changeCategories(modelType, event.target.value as ProductType)}>{(Object.keys(productTypes) as ProductType[]).map(value => <option key={value} value={value}>{productTypes[value].name}</option>)}</select></label>
    </div>
    <div className="shoot-references">
      {roles.map(({ key, title, Icon }, index) => <section className="shoot-reference" key={key} aria-label={title}>
        <h3><Icon size={17} /><span>{index + 1}. {title}</span>{references[key] && <button type="button" className="icon-button" title={`移除${title}`} aria-label={`移除${title}`} disabled={locked} onClick={() => onChange(key, null)}><X size={16} /></button>}</h3>
        <div className="shoot-reference-body">
          <div className="shoot-reference-preview">{references[key] ? <img src={`/api/assets/${references[key].id}/content?thumbnail=1`} alt={`已选${title}`} /> : <Icon size={28} />}</div>
          <div className="shoot-reference-controls">
            <select aria-label={`选择${title}`} value={references[key]?.id ?? ''} disabled={locked} onChange={event => onChange(key, projectImages.find(asset => asset.id === event.target.value) ?? null)}><option value="">选择项目图片</option>{projectImages.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select>
            <div className="shoot-reference-actions">
              <button type="button" className="icon-button" title={`上传${title}`} aria-label={`上传${title}`} disabled={locked} onClick={() => files.current[key]?.click()}><Upload size={19} /></button>
              <button type="button" className="icon-button" title={`从图库选择${title}`} aria-label={`从图库选择${title}`} disabled={locked} onClick={() => onLibrary(key)}><Images size={19} /></button>
              {key === 'pose' && <button type="button" className="icon-button" title="使用3D人偶姿势" aria-label="使用3D人偶姿势" disabled={locked} onClick={onPose}><Accessibility size={20} /></button>}
            </div>
            <input ref={element => { files.current[key] = element }} type="file" accept="image/png,image/jpeg,image/webp" aria-label={`${title}文件`} hidden onChange={event => {
              const file = event.target.files?.[0]; event.target.value = ''
              if (!file) return
              void perform(`正在上传${title}`, async signal => {
                if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 64 * 1024 * 1024) throw new Error('请选择不超过64 MB的PNG、JPEG或WebP图片')
                onChange(key, await onUpload(file, signal))
              })
            }} />
          </div>
        </div>
      </section>)}
    </div>
    <button type="button" className="shoot-prepare" disabled={locked || !hasReferences} onClick={() => void prepare()}>{prepared ? <Check size={18} /> : <Images size={18} />}{prepared ? '重新合并参考图' : '合并参考图'}</button>
    {prepared && <section className="shoot-composition" aria-label="合并参考图预览"><img src={preview} alt="模特、姿势和商品合并预览" /></section>}
    <section className="shoot-prompt">
      <div className="shoot-section-heading"><label htmlFor="shoot-prompt">拍摄提示词</label><button type="button" className="icon-button" title="重置拍摄提示词" aria-label="重置拍摄提示词" disabled={locked || !prepared} onClick={() => { if (confirmPromptReplacement()) { const next = defaultPrompt(modelType, productType, references); setPrompt(next); setGeneratedPrompt(next) } }}><RotateCcw size={17} /></button></div>
      <textarea id="shoot-prompt" aria-label="拍摄提示词" rows={9} maxLength={6000} value={prompt} disabled={locked || !prepared} onChange={event => setPrompt(event.target.value)} />
    </section>
    <div className="shoot-settings">
      <label>图片比例<select aria-label="试拍图片比例" value={ratio} disabled={locked} onChange={event => setRatio(event.target.value as Ratio)}>{ratios.map(value => <option key={value} value={value}>{value === 'auto' ? '由AI决定' : value}</option>)}</select></label>
      <label>图片模型<select aria-label="试拍图片模型" value={imageModel} disabled={locked} onChange={event => setImageModel(event.target.value as ImageModel)}>{imageModels.map(model => <option key={model} value={model} disabled={!availableModels.includes(model)}>{imageModelNames[model]}{availableModels.includes(model) ? '' : ' · 未就绪'}</option>)}</select></label>
    </div>
    {error && <p role="alert" className="form-error">{error}</p>}
    {pending && <p role="status" className="shoot-status"><LoaderCircle size={16} className="spin" />{pending}</p>}
    <div className="shoot-submit"><button type="button" disabled={locked || !prepared || !prompt.trim()} onClick={() => void submit(true)}>带入对话</button><button type="button" className="primary" disabled={locked || !prepared || !prompt.trim() || !availableModels.includes(imageModel)} onClick={() => void submit(false)}><Camera size={18} />生成新作品</button></div>
  </div>
}