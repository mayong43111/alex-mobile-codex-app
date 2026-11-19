import { imageLimits } from './shared'

type CompressionCanvas = Pick<HTMLCanvasElement, 'width' | 'height' | 'toBlob'> & {
  getContext(contextId: '2d'): Pick<CanvasRenderingContext2D, 'save' | 'restore' | 'fillRect' | 'fillStyle' | 'globalCompositeOperation'> | null
}

export async function compressImage(canvas: CompressionCanvas, quality: number): Promise<Blob> {
  const encode = (type: string) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, quality))
  const webp = await encode('image/webp')
  if (webp?.type === 'image/webp' && webp.size) return checkSize(webp)
  // Browsers without WebP encoding commonly return PNG instead.
  if (webp?.type === 'image/png' && webp.size && webp.size <= imageLimits.uploadBytes) return webp
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法处理图片。')
  context.save()
  context.globalCompositeOperation = 'destination-over'
  context.fillStyle = '#fff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.restore()
  const jpeg = await encode('image/jpeg')
  if (jpeg?.size && ['image/jpeg', 'image/png'].includes(jpeg.type)) return checkSize(jpeg)
  throw new Error('图片压缩失败，请更换图片后重试。')
}

function checkSize(blob: Blob) {
  if (blob.size > imageLimits.uploadBytes) throw new Error(`压缩后 ${(blob.size / 1024 / 1024).toFixed(2)}MB，仍超过 2MB；请降低分辨率或质量。`)
  return blob
}
