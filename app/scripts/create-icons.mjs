import { mkdir } from 'node:fs/promises'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Aperture } from 'lucide-react'
import sharp from 'sharp'

await mkdir('public/icons', { recursive: true })
for (const size of [180, 192, 512]) {
  const symbolSize = Math.round(size * 0.58)
  const symbol = renderToStaticMarkup(createElement(Aperture, { size: symbolSize, color: '#ffffff', strokeWidth: 1.5 }))
  await sharp({ create: { width: size, height: size, channels: 4, background: '#087f6b' } })
    .composite([{ input: Buffer.from(symbol), gravity: 'center' }]).png().toFile(`public/icons/icon-${size}.png`)
}