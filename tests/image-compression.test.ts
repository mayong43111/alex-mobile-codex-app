import test from 'node:test'
import assert from 'node:assert/strict'
import { compressImage } from '../src/image-compression.js'
import { imageLimits } from '../src/shared.js'

function canvasFixture(results: (Blob | null)[]) {
  const calls: { type?: string; quality?: number }[] = []
  let backgroundFilled = false
  const context = {
    fillStyle: '', globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    save() {}, restore() {},
    fillRect() {
      assert.equal(context.globalCompositeOperation, 'destination-over')
      assert.equal(context.fillStyle, '#fff')
      backgroundFilled = true
    },
  }
  const canvas = {
    width: 2048, height: 1536,
    getContext: () => context,
    toBlob(callback: BlobCallback, type?: string, quality?: number) {
      calls.push({ type, quality })
      callback(results.shift() ?? null)
    },
  }
  return { canvas, calls, filled: () => backgroundFilled }
}

test('compression accepts mobile PNG fallback without requiring WebP encoding', async () => {
  const png = new Blob(['png'], { type: 'image/png' })
  const f = canvasFixture([png])
  assert.equal(await compressImage(f.canvas, 0.85), png)
  assert.equal(f.calls.length, 1)
  assert.equal(f.filled(), false)
})

test('oversized PNG fallback uses JPEG at the chosen quality with a white background', async () => {
  const png = new Blob([new Uint8Array(imageLimits.uploadBytes + 1)], { type: 'image/png' })
  const jpeg = new Blob(['jpeg'], { type: 'image/jpeg' })
  const f = canvasFixture([png, jpeg])
  assert.equal(await compressImage(f.canvas, 0.65), jpeg)
  assert.deepEqual(f.calls, [{ type: 'image/webp', quality: 0.65 }, { type: 'image/jpeg', quality: 0.65 }])
  assert.equal(f.filled(), true)
})

test('WebP and JPEG uploads still enforce the exact size limit and encoding failures surface', async () => {
  const webp = new Blob([new Uint8Array(imageLimits.uploadBytes)], { type: 'image/webp' })
  assert.equal(await compressImage(canvasFixture([webp]).canvas, 0.85), webp)
  const oversized = new Uint8Array(imageLimits.uploadBytes + 1)
  await assert.rejects(compressImage(canvasFixture([new Blob([oversized], { type: 'image/webp' })]).canvas, 0.85), /超过 2MB/)
  await assert.rejects(compressImage(canvasFixture([null, new Blob([oversized], { type: 'image/jpeg' })]).canvas, 0.85), /超过 2MB/)
  await assert.rejects(compressImage(canvasFixture([null, null]).canvas, 0.85), /图片压缩失败/)
})
