import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { randomUUID } from 'node:crypto'
import type { VmProfiles } from '../server/vm.ts'
import { defaultUserSettings } from '../src/domain.ts'
import type { UserSettings } from '../src/domain.ts'

test('image management clears conversation text while preserving works and deletes individual images with confirmation', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: '作品管理验收' } })).json()
  const other = await (await request.post('/api/projects', { data: { title: '独立副本' } })).json()
  const buffer = await sharp(resolve('public/reference-interior.jpg')).resize(320, 240).png().toBuffer()
  const upload = async (name: string) => (await request.post(`/api/projects/${project.id}/uploads`, { multipart: { file: { name, mimeType: 'image/png', buffer } } })).json()
  const source = await upload(`reference-${randomUUID()}.png`)
  const first = await upload(`work-one-${randomUUID()}.png`)
  const second = await upload(`work-two-${randomUUID()}.png`)
  const copy = await (await request.post(`/api/projects/${other.id}/references`, { data: { assetId: source.id } })).json()
  for (let index = 0; index < 12; index++) await request.post(`/api/projects/${project.id}/messages`, { data: { requestId: randomUUID(), text: `历史消息 ${index}`, assetIds: [], ratio: '1:1' } })
  await page.route(`**/api/projects/${project.id}`, async route => {
    const response = await route.fetch()
    if (!response.ok()) return route.fulfill({ response })
    const snapshot = await response.json()
    snapshot.assets = snapshot.assets.map((asset: { id: string }) => [first.id, second.id].includes(asset.id) ? { ...asset, kind: 'generated' } : asset)
    await route.fulfill({ response, json: snapshot })
  })
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/')
  await expect(page.getByText('历史消息 11', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '清空会话', exact: true }).click()
  const clearing = page.getByRole('dialog', { name: '清空会话？', exact: true })
  await clearing.getByRole('button', { name: '取消', exact: true }).click()
  expect((await (await request.get(`/api/projects/${project.id}`)).json()).messages).toHaveLength(10)
  await page.getByRole('button', { name: '清空会话', exact: true }).click()
  await clearing.getByRole('button', { name: '确认清空', exact: true }).click()
  await expect(clearing).not.toBeVisible()
  await expect(page.getByText('历史消息 11', { exact: true })).toHaveCount(0)
  const cleared = await (await request.get(`/api/projects/${project.id}`)).json()
  expect(cleared.messages).toHaveLength(0)
  expect(cleared.assets).toHaveLength(3)
  expect(cleared.page.before).toBeNull()
  await page.reload()
  await page.getByRole('button', { name: '作品集合' }).click()
  const works = page.getByRole('dialog', { name: '作品集合', exact: true })
  await expect(works.getByRole('button', { name: /^查看作品 / })).toHaveCount(2)
  await expect(works.locator('.asset-image-frame').first()).toHaveAttribute('data-state', 'loaded')
  expect(await works.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('works-mobile.png') })
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: 1280, height: 900 })
  expect(await works.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('works-desktop.png') })
  await page.setViewportSize(viewport)
  await works.getByRole('button', { name: `删除作品 ${first.name}`, exact: true }).click()
  const deleting = page.getByRole('dialog', { name: '删除图片？', exact: true })
  await deleting.getByRole('button', { name: '取消', exact: true }).click()
  expect((await request.get(`/api/assets/${first.id}/content`)).status()).toBe(200)
  await works.getByRole('button', { name: `删除作品 ${first.name}`, exact: true }).click()
  await deleting.getByRole('button', { name: '确认删除图片', exact: true }).click()
  await expect(works.getByRole('button', { name: /^查看作品 / })).toHaveCount(1)
  expect((await request.get(`/api/assets/${first.id}/content`)).status()).toBe(404)
  expect((await request.get(`/api/assets/${second.id}/content`)).status()).toBe(200)
  await works.getByRole('button', { name: `查看作品 ${second.name}`, exact: true }).click()
  const viewer = page.getByRole('dialog', { name: second.name, exact: true })
  await viewer.getByRole('button', { name: '删除当前图片', exact: true }).click()
  await deleting.getByRole('button', { name: '取消', exact: true }).click()
  expect(await viewer.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  await viewer.getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('.composer').getByRole('button', { name: '历史参考图' }).click()
  const library = page.getByRole('dialog', { name: '参考图库', exact: true })
  await library.getByLabel('搜索参考图').fill(source.name)
  await library.getByRole('button', { name: `删除参考图 ${source.name}`, exact: true }).click()
  await deleting.getByRole('button', { name: '确认删除图片', exact: true }).click()
  await expect(library.getByRole('button', { name: `选用参考图 ${source.name}`, exact: true })).toHaveCount(0)
  expect((await request.get(`/api/assets/${copy.id}/content`)).status()).toBe(200)
  const latest = await (await request.get(`/api/projects/${project.id}`)).json()
  expect(latest.assets.map((asset: { id: string }) => asset.id)).toEqual([second.id])
  expect((await request.delete(`/api/projects/${project.id}`, { data: { expectedUpdatedAt: latest.project.updatedAt } })).status()).toBe(200)
  expect((await request.get(`/api/assets/${second.id}/content`)).status()).toBe(404)
  expect((await request.get(`/api/assets/${copy.id}/content`)).status()).toBe(200)
})

test('historical references can be searched and reused in image forms and chat across projects', async ({ page, request }, testInfo) => {
  test.setTimeout(60000)
  const original = await (await request.post('/api/projects', { data: { title: '历史参考来源' } })).json()
  const target = await (await request.post('/api/projects', { data: { title: '参考图新作品' } })).json()
  const name = `history-${randomUUID()}.png`
  const buffer = await sharp(resolve('public/reference-interior.jpg')).resize(320, 240).png().toBuffer()
  const source = await (await request.post(`/api/projects/${original.id}/uploads`, { multipart: { file: { name, mimeType: 'image/png', buffer } } })).json()
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), target.id)
  await page.route('**/api/health', route => route.fulfill({ json: { storage: 'ready', agentConfigured: true, agent: 'configured', renderer: 'azure_image2', models: { images: ['gpt-image-2.5-flare'], videos: [] } } }))
  const submitted: Record<string, unknown>[] = []
  await page.route('**/api/projects/*/chat', route => { submitted.push(route.request().postDataJSON()); return route.fulfill({ status: 202, json: { id: randomUUID() } }) })
  let failListing = true
  await page.route('**/api/references', route => failListing ? route.fulfill({ status: 503, json: { error: '参考图库暂时离线' } }) : route.continue())
  await page.goto('/')
  await expect(page.getByLabel('创作需求')).toBeEnabled()
  await page.getByRole('button', { name: '做图片', exact: true }).click()
  const form = page.getByRole('dialog', { name: '做图片', exact: true })
  await form.getByLabel('画面内容').fill('保留空间结构，调整为清晨光线')
  await form.getByRole('button', { name: '历史参考图', exact: true }).click()
  const library = page.getByRole('dialog', { name: '参考图库', exact: true })
  await expect(library.getByRole('alert')).toContainText('暂时离线')
  failListing = false
  await library.getByRole('button', { name: '刷新参考图库' }).click()
  await library.getByLabel('搜索参考图').fill(name)
  await library.getByLabel('参考图来源项目').selectOption(target.id)
  await expect(library.getByText('没有匹配的参考图')).toBeVisible()
  const mobileViewport = page.viewportSize()!
  for (const viewport of [mobileViewport, { width: 700, height: 607 }]) {
    await page.setViewportSize(viewport)
    const panel = (await library.boundingBox())!
    expect(panel.x).toBe(0)
    expect(panel.y).toBe(0)
    expect(panel.width).toBe(viewport.width)
    expect(Math.abs(panel.height - viewport.height)).toBeLessThan(2)
    const search = (await library.locator('.search').boundingBox())!
    const filter = (await library.getByLabel('参考图来源项目').boundingBox())!
    const refresh = (await library.getByRole('button', { name: '刷新参考图库' }).boundingBox())!
    expect(filter.y).toBeGreaterThanOrEqual(search.y + search.height)
    expect(filter.y).toBe(refresh.y)
    expect(filter.x + filter.width).toBeLessThanOrEqual(refresh.x)
    expect(refresh.height).toBeGreaterThanOrEqual(44)
    expect(await library.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
    await page.screenshot({ path: testInfo.outputPath(`reference-empty-${viewport.width}.png`) })
  }
  await page.setViewportSize(mobileViewport)
  await library.getByLabel('参考图来源项目').selectOption(original.id)
  const choice = library.getByRole('button', { name: `选用参考图 ${name}`, exact: true })
  await expect(choice.locator('.asset-image-frame')).toHaveAttribute('data-state', 'loaded')
  expect(await library.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('reference-library-mobile.png') })
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: 1280, height: 900 })
  expect(await library.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  const libraryBox = (await library.boundingBox())!
  expect(Math.abs(libraryBox.x + libraryBox.width / 2 - 640)).toBeLessThan(2)
  expect(libraryBox.y).toBeGreaterThanOrEqual(24)
  expect(libraryBox.y + libraryBox.height).toBeLessThanOrEqual(876)
  await page.screenshot({ path: testInfo.outputPath('reference-library-desktop.png') })
  await page.setViewportSize(viewport)
  await choice.click()
  await expect(library).not.toBeVisible()
  await expect(form.getByAltText('已选参考图')).toBeVisible()
  await expect(form.getByLabel('画面内容')).toHaveValue('保留空间结构，调整为清晨光线')
  const snapshot = await (await request.get(`/api/projects/${target.id}`)).json()
  const copied = snapshot.assets.find((asset: { sourceAssetId: string }) => asset.sourceAssetId === source.id)
  expect(copied.id).not.toBe(source.id)
  await form.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect(form).not.toBeVisible()
  expect(submitted[0]).toMatchObject({ assetIds: [copied.id], directImage: { operation: 'edit', sourceAssetId: copied.id } })
  await page.locator('.composer').getByRole('button', { name: '历史参考图' }).click()
  await library.getByLabel('搜索参考图').fill(name)
  await choice.click()
  await expect(page.getByRole('button', { name: `移除附件 ${name}`, exact: true })).toBeVisible()
  await page.getByLabel('创作需求').fill('根据参考图调整颜色')
  await page.getByRole('button', { name: '提交需求', exact: true }).click()
  await expect.poll(() => submitted.length).toBe(2)
  expect(submitted[1]).toMatchObject({ assetIds: [copied.id] })
  expect((await (await request.get(`/api/projects/${target.id}`)).json()).assets).toHaveLength(1)
})

test('user settings default to Flare, survive reload and isolate accounts', async ({ page }) => {
  let account = 'one'
  let rejectWrite = false
  const settings = new Map<string, UserSettings>()
  await page.addInitScript(() => {
    localStorage.setItem('studio-image-model', 'azure-image2')
    localStorage.setItem('studio-quality', 'medium')
  })
  await page.route('**/api/auth/session', route => route.fulfill({ json: { enabled: false, user: { id: account, name: account, provider: 'local', admin: false } } }))
  await page.route('**/api/health', route => route.fulfill({ json: { storage: 'ready', agentConfigured: true, agent: 'configured', renderer: 'azure_image2', models: { images: ['azure-image2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'], videos: [] } } }))
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PATCH') {
      if (rejectWrite) return route.fulfill({ status: 503, json: { error: 'Offline save failure' } })
      settings.set(account, { ...defaultUserSettings, ...settings.get(account), ...route.request().postDataJSON() })
    }
    await route.fulfill({ json: settings.get(account) ?? defaultUserSettings })
  })
  const openSettings = async () => {
    await page.goto('/')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByLabel('图片模型', { exact: true })).toBeEnabled()
  }
  await openSettings()
  const model = page.getByLabel('图片模型', { exact: true })
  const quality = page.getByLabel('默认质量', { exact: true })
  await expect(model).toHaveValue('gpt-image-2.5-flare')
  await expect(quality).toHaveValue('low')
  await model.selectOption('gpt-image-2.5-sunburst')
  await expect(model).toHaveValue('gpt-image-2.5-sunburst')
  await quality.selectOption('high')
  await expect(quality).toHaveValue('high')
  await page.getByLabel('默认比例', { exact: true }).selectOption('auto')
  await expect(page.getByLabel('默认比例', { exact: true })).toHaveValue('auto')
  await openSettings()
  await expect(page.getByLabel('默认比例', { exact: true })).toHaveValue('auto')
  await expect(model).toHaveValue('gpt-image-2.5-sunburst')
  await expect(quality).toHaveValue('high')
  account = 'two'
  await openSettings()
  await expect(model).toHaveValue('gpt-image-2.5-flare')
  await expect(quality).toHaveValue('low')
  rejectWrite = true
  await model.selectOption('azure-image2')
  await expect(page.getByRole('dialog', { name: '设置', exact: true }).getByRole('alert')).toContainText('设置保存失败')
  await expect(model).toHaveValue('gpt-image-2.5-flare')
  rejectWrite = false
  account = 'one'
  await openSettings()
  await expect(model).toHaveValue('gpt-image-2.5-sunburst')
  await expect(quality).toHaveValue('high')
})

test('image forms submit directly with explicit source and reuse failed request IDs', async ({ page, request }, testInfo) => {
  test.setTimeout(60000)
  const project = await (await request.post('/api/projects', { data: { title: 'Direct image forms' } })).json()
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  let settings = { ...defaultUserSettings }
  await page.route('**/api/settings', route => {
    if (route.request().method() === 'PATCH') settings = { ...settings, ...route.request().postDataJSON() }
    return route.fulfill({ json: settings })
  })
  await page.route('**/api/health', route => route.fulfill({ json: { storage: 'ready', agentConfigured: true, agent: 'configured', renderer: 'azure_image2', models: { images: ['gpt-image-2.5-flare'], videos: [] } } }))
  const submitted: Record<string, unknown>[] = []
  await page.route('**/api/projects/*/chat', async route => {
    submitted.push(route.request().postDataJSON())
    await route.fulfill(submitted.length === 1 ? { status: 503, json: { error: 'Offline response failure' } } : { status: 202, json: { id: randomUUID() } })
  })
  await page.goto('/')
  await expect(page.getByLabel('创作需求')).toBeEnabled()
  const composer = page.locator('form.composer')
  await expect(composer.getByLabel('当前图片模型')).toContainText('GPT Image 2.5 Flare')
  await composer.getByLabel('作图比例').selectOption({ label: '由AI决定' })
  await expect(composer.getByLabel('作图比例')).toHaveValue('auto')
  expect(await composer.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('composer-auto-ratio.png') })
  await composer.getByLabel('作图比例').selectOption('3:4')
  await expect(composer.getByLabel('作图比例')).toHaveValue('3:4')
  const composerRestingHeight = (await composer.getByLabel('创作需求').boundingBox())!.height
  expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(112)
  await page.screenshot({ path: testInfo.outputPath('composer-compact.png') })
  await page.getByLabel('创作需求').fill('保留这个聊天草稿')
  expect((await composer.getByLabel('创作需求').boundingBox())!.height).toBeGreaterThan(composerRestingHeight + 40)
  expect(await composer.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  const sendBox = (await composer.getByRole('button', { name: '提交需求', exact: true }).boundingBox())!
  expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  const ratioBox = (await composer.getByLabel('作图比例').boundingBox())!
  expect(ratioBox.height).toBe(28)
  expect(ratioBox.x + ratioBox.width).toBeLessThanOrEqual(sendBox.x)
  expect(ratioBox.y).toBe(sendBox.y)
  const inputBox = (await composer.getByLabel('创作需求').boundingBox())!
  const modelBox = (await composer.getByLabel('当前图片模型').boundingBox())!
  expect(modelBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height)
  expect(modelBox.y).toBe(ratioBox.y)
  expect(modelBox.height).toBe(28)
  expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(ratioBox.x)
  expect((await composer.locator('.composer-row').boundingBox())!.height).toBe(28)
  await page.screenshot({ path: testInfo.outputPath('composer-focused.png') })
  const composerViewport = page.viewportSize()!
  await page.setViewportSize({ width: 1280, height: 900 })
  expect(await composer.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('composer-desktop.png') })
  await page.setViewportSize(composerViewport)
  await page.getByRole('button', { name: '做图片', exact: true }).click()
  const generation = page.getByRole('dialog', { name: '做图片', exact: true })
  await expect(generation.getByRole('textbox')).toHaveCount(1)
  await expect(generation.getByLabel('风格与用途', { exact: true })).toHaveCount(0)
  await expect(generation.getByLabel('当前图片模型')).toContainText('GPT Image 2.5 Flare')
  await expect(generation.getByLabel('作图比例')).toHaveValue('3:4')
  await generation.getByLabel('作图比例').selectOption('16:9')
  await expect(generation.getByLabel('作图比例')).toHaveValue('16:9')
  const imageParameters = generation.locator('.creation-image-parameters')
  const imageRatioBox = (await generation.getByLabel('作图比例').boundingBox())!
  const imageModelBox = (await generation.getByLabel('当前图片模型').boundingBox())!
  expect((await imageParameters.boundingBox())!.height).toBe(28)
  expect(imageRatioBox.height).toBe(28)
  expect(imageModelBox.y).toBe(imageRatioBox.y)
  expect(imageModelBox.x).toBeGreaterThanOrEqual(imageRatioBox.x + imageRatioBox.width)
  expect(await imageParameters.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(false)
  const prompt = generation.getByLabel('画面内容', { exact: true })
  const restingHeight = (await prompt.boundingBox())!.height
  await prompt.fill('白色背景的一束鲜花')
  expect((await prompt.boundingBox())!.height).toBeGreaterThan(restingHeight + 40)
  const subjectBox = (await prompt.boundingBox())!
  expect((await imageParameters.boundingBox())!.y).toBeGreaterThanOrEqual(subjectBox.y + subjectBox.height)
  const generateButtonBox = (await generation.getByRole('button', { name: '生成图片', exact: true }).boundingBox())!
  const draftButtonBox = (await generation.getByRole('button', { name: '带入草稿', exact: true }).boundingBox())!
  expect(generateButtonBox.y).toBe(draftButtonBox.y)
  expect(draftButtonBox.x).toBeGreaterThan(generateButtonBox.x + generateButtonBox.width)
  expect(generateButtonBox.y + generateButtonBox.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await page.screenshot({ path: testInfo.outputPath('image-brief-focused.png') })
  await page.setViewportSize({ width: 1280, height: 900 })
  expect((await imageParameters.boundingBox())!.height).toBe(28)
  expect((await generation.boundingBox())!.width).toBeLessThanOrEqual(520)
  await page.screenshot({ path: testInfo.outputPath('image-parameters-desktop.png') })
  await page.setViewportSize(composerViewport)
  await generation.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect(generation.getByRole('alert')).toBeVisible()
  await generation.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect(generation).not.toBeVisible()
  expect(submitted).toHaveLength(2)
  expect(submitted[0]).toEqual(submitted[1])
  expect(submitted[0]).toMatchObject({ mode: 'image', imageModel: 'gpt-image-2.5-flare', ratio: '16:9', directImage: { operation: 'generate' }, assetIds: [], videoModel: 'none' })
  expect(submitted[0].text).not.toContain('保留这个聊天草稿')
  expect(submitted[0].text).toBe('请生成一张图片。\n画面内容：白色背景的一束鲜花')
  await expect(page.getByLabel('创作需求')).toHaveValue('保留这个聊天草稿')
  await expect(composer.getByLabel('作图比例')).toHaveValue('16:9')
  await page.locator('input[type=file]').setInputFiles(resolve('public/reference-interior.jpg'))
  await expect(page.getByRole('button', { name: '移除附件 reference-interior.jpg' })).toBeVisible()
  const snapshot = await (await request.get(`/api/projects/${project.id}`)).json()
  const source = snapshot.assets[0]
  await page.getByRole('button', { name: '修改图片', exact: true }).click()
  const editing = page.getByRole('dialog', { name: '修改图片', exact: true })
  await expect(editing.getByLabel('作图比例')).toHaveValue('16:9')
  await editing.getByLabel('作图比例').selectOption({ label: '由AI决定' })
  await expect(editing.getByLabel('作图比例')).toHaveValue('auto')
  await editing.getByLabel('作图比例').selectOption('16:9')
  await editing.getByLabel('修改要求', { exact: true }).fill('把墙面改为浅灰色')
  await expect(editing.getByRole('button', { name: '修改图片', exact: true })).toBeDisabled()
  await editing.getByLabel('项目原图', { exact: true }).selectOption(source.id)
  await editing.getByRole('button', { name: '修改图片', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('direct-image-edit.png') })
  await editing.getByRole('button', { name: '修改图片', exact: true }).click()
  await expect(editing).not.toBeVisible()
  expect(submitted).toHaveLength(3)
  expect(submitted[2]).toMatchObject({ mode: 'image', directImage: { operation: 'edit', sourceAssetId: source.id }, assetIds: [source.id], videoModel: 'none' })
  expect((await (await request.get(`/api/projects/${project.id}`)).json()).messages).toHaveLength(0)
  await composer.getByRole('button', { name: '提交需求', exact: true }).click()
  await expect.poll(() => submitted.length).toBe(4)
  expect(submitted[3]).toMatchObject({ text: '保留这个聊天草稿', ratio: '16:9', imageModel: 'gpt-image-2.5-flare' })
  expect(submitted[3]).not.toHaveProperty('directImage')
})

test('model shoot combines three roles, preserves prompt edits and retries the same direct request', async ({ page, request }, testInfo) => {
  test.setTimeout(90000)
  const project = await (await request.post('/api/projects', { data: { title: '模特试拍验收' } })).json()
  const history = await (await request.post('/api/projects', { data: { title: '商品参考来源' } })).json()
  const photo = await sharp(resolve('public/reference-interior.jpg')).resize(320, 240).png().toBuffer()
  const pose = await (await request.post(`/api/projects/${project.id}/uploads`, { multipart: { file: { name: 'pose-photo.png', mimeType: 'image/png', buffer: photo } } })).json()
  const product = await (await request.post(`/api/projects/${history.id}/uploads`, { multipart: { file: { name: `product-${randomUUID()}.png`, mimeType: 'image/png', buffer: photo } } })).json()
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.route('**/api/health', route => route.fulfill({ json: { storage: 'ready', agentConfigured: true, agent: 'configured', models: { images: ['gpt-image-2.5-flare', 'qwen-image-2.1'], videos: [] } } }))
  const submitted: Record<string, unknown>[] = []
  await page.route('**/api/projects/*/chat', route => {
    submitted.push(route.request().postDataJSON())
    return submitted.length === 1 ? route.fulfill({ status: 503, json: { error: '试拍提交暂时失败' } }) : route.fulfill({ status: 202, json: { id: randomUUID() } })
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: '模特试拍', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '模特试拍', exact: true })
  await expect(dialog.getByRole('button', { name: '合并参考图', exact: true })).toBeDisabled()
  await dialog.getByLabel('模特参考图文件', { exact: true }).setInputFiles({ name: 'model-photo.png', mimeType: 'image/png', buffer: photo })
  await expect(dialog.getByRole('img', { name: '已选模特参考图' })).toBeVisible()
  await dialog.getByLabel('选择姿势参考图', { exact: true }).selectOption(pose.id)
  await dialog.getByRole('button', { name: '从图库选择商品参考图', exact: true }).click()
  const library = page.getByRole('dialog', { name: '参考图库', exact: true })
  await library.getByLabel('搜索参考图').fill(product.name)
  await library.getByRole('button', { name: `选用参考图 ${product.name}`, exact: true }).click()
  await expect(library).toHaveCount(0)
  const snapshot = await (await request.get(`/api/projects/${project.id}`)).json()
  const model = snapshot.assets.find((asset: { name: string }) => asset.name === 'model-photo.png')
  const copy = snapshot.assets.find((asset: { sourceAssetId?: string }) => asset.sourceAssetId === product.id)
  expect(copy.projectId).toBe(project.id)
  expect(copy.id).not.toBe(product.id)
  await dialog.getByRole('button', { name: '合并参考图', exact: true }).click()
  const preview = dialog.getByRole('img', { name: '模特、姿势和商品合并预览' })
  await expect(preview).toBeVisible()
  const board = await preview.evaluate(async (element: HTMLImageElement) => {
    await element.decode()
    const canvas = document.createElement('canvas'); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight
    const context = canvas.getContext('2d')!; context.drawImage(element, 0, 0)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const boardBytes = Buffer.from(board, 'base64')
  expect(boardBytes.length).toBeGreaterThan(10000)
  const dimensions = await sharp(boardBytes).metadata()
  expect([dimensions.width, dimensions.height]).toEqual([2016, 1024])
  for (const left of [16, 688, 1360]) {
    const region = await sharp(boardBytes).extract({ left, top: 60, width: 640, height: 944 }).stats()
    expect(region.channels[0].stdev).toBeGreaterThan(10)
  }
  const prompt = dialog.getByLabel('拍摄提示词', { exact: true })
  await expect(prompt).toHaveValue(/肤色[\s\S]*关节角度[\s\S]*商品外观/)
  const modelType = dialog.getByLabel('模特类型', { exact: true })
  const productType = dialog.getByLabel('商品类别', { exact: true })
  const templates = new Set<string>()
  for (const [modelValue, modelDetail] of [['portrait', '五官比例'], ['hands', '手指长度'], ['feet', '足弓']]) {
    await modelType.selectOption(modelValue)
    for (const [productValue, productDetail] of [['clothes', '领口'], ['shoes', '鞋底'], ['accessories', '镶嵌'], ['stockings', '织纹'], ['props', '功能结构'], ['other', '实际用途']]) {
      await productType.selectOption(productValue)
      const generated = await prompt.inputValue()
      expect(generated).toContain(modelDetail)
      expect(generated).toContain(productDetail)
      expect(generated).toContain('也可以是已有模特穿着、佩戴或持有商品的展示图')
      expect(generated).toContain('将原模特替换为参考图1的模特')
      expect(generated).toContain('最终姿势以参考图2为准')
      if (modelValue !== 'portrait') expect(generated).not.toContain('五官比例')
      if (modelValue === 'hands' && productValue === 'shoes') expect(generated).toContain('不把鞋穿在手上')
      if (modelValue === 'feet' && productValue === 'stockings') expect(generated).toContain('袜尖、脚跟和踝部贴合')
      templates.add(generated)
    }
  }
  expect(templates.size).toBe(18)
  await productType.selectOption('shoes')
  let edited = `${await prompt.inputValue()}\n补充要求：白色摄影棚，柔和侧光。`
  await prompt.fill(edited)
  page.once('dialog', confirmation => confirmation.dismiss())
  await modelType.selectOption('hands')
  await expect(modelType).toHaveValue('feet')
  await expect(prompt).toHaveValue(edited)
  page.once('dialog', confirmation => confirmation.accept())
  await modelType.selectOption('hands')
  await expect(prompt).toHaveValue(/拍摄类型：手模；商品类别：鞋子/)
  edited = `${await prompt.inputValue()}\n补充要求：白色摄影棚，柔和侧光。`
  await prompt.fill(edited)
  await dialog.getByRole('button', { name: '移除姿势参考图', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '生成新作品' })).toBeDisabled()
  await dialog.getByLabel('选择姿势参考图', { exact: true }).selectOption(pose.id)
  await dialog.getByRole('button', { name: '重新合并参考图', exact: true }).click()
  await expect(prompt).toHaveValue(edited)
  await dialog.getByLabel('试拍图片比例').selectOption('auto')
  await dialog.getByLabel('试拍图片比例').selectOption('3:4')
  await dialog.getByLabel('试拍图片模型').selectOption('qwen-image-2.1')
  for (const viewport of [page.viewportSize()!, { width: 700, height: 607 }, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport)
    await dialog.evaluate(element => { element.scrollTop = 0 })
    const categoryBounds = (await dialog.locator('.shoot-categories').boundingBox())!
    const headingBounds = (await dialog.locator('.modal-heading').boundingBox())!
    expect(categoryBounds.y).toBeGreaterThanOrEqual(headingBounds.y + headingBounds.height)
    expect(await dialog.locator('.shoot-categories').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const bounds = (await dialog.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width)
    await page.screenshot({ path: testInfo.outputPath(`shoot-references-${viewport.width}.png`) })
    await preview.scrollIntoViewIfNeeded()
    await page.screenshot({ path: testInfo.outputPath(`shoot-preview-${viewport.width}.png`) })
    await dialog.getByRole('button', { name: '生成新作品' }).scrollIntoViewIfNeeded()
    for (const button of await dialog.locator('.shoot-submit button').all()) {
      const bounds = (await button.boundingBox())!
      expect(bounds.height).toBeGreaterThanOrEqual(44)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1)
    }
  }
  expect(submitted).toHaveLength(0)
  await dialog.getByRole('button', { name: '生成新作品' }).click()
  await expect(dialog.getByRole('alert')).toContainText('暂时失败')
  await dialog.getByRole('button', { name: '生成新作品' }).click()
  await expect(dialog).toHaveCount(0)
  expect(submitted).toHaveLength(2)
  expect(submitted[0]).toEqual(submitted[1])
  expect(submitted[0]).toMatchObject({ text: edited, mode: 'image', ratio: '3:4', imageModel: 'qwen-image-2.1', assetIds: [model.id, pose.id, copy.id], directImage: { operation: 'edit', sourceAssetId: model.id }, videoModel: 'none' })
  await expect(page.getByLabel('创作需求')).toBeVisible()
  expect((await (await request.get(`/api/projects/${project.id}`)).json()).assets).toHaveLength(3)
  expect(errors).toEqual([])
})

test('model shoot exports an interactive 3D pose without a person and prepares a new-project draft', async ({ page, request }, testInfo) => {
  test.setTimeout(90000)
  let hideProjects = true
  await page.route('**/api/projects', route => hideProjects && route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue())
  let submissions = 0
  page.on('request', entry => { if (entry.method() === 'POST' && /\/(chat|messages)$/.test(new URL(entry.url()).pathname)) submissions++ })
  await page.goto('/')
  await page.getByRole('button', { name: '模特试拍', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '模特试拍', exact: true })
  await dialog.getByRole('button', { name: '使用3D人偶姿势' }).click()
  const poseDialog = page.getByRole('dialog', { name: '试拍姿势', exact: true })
  await expect(poseDialog.locator('.pose-viewport')).toHaveAttribute('data-ready', 'true', { timeout: 30000 })
  await expect(poseDialog.getByLabel('人物参考图', { exact: true })).toHaveCount(0)
  await expect(poseDialog.getByRole('button', { name: '使用此姿势' })).toBeEnabled()
  const canvas = poseDialog.locator('canvas')
  const before = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())
  await poseDialog.getByLabel('内置姿势').selectOption('ual1Talking')
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(before)
  for (const viewport of [page.viewportSize()!, { width: 1280, height: 900 }]) {
    await page.setViewportSize(viewport)
    await poseDialog.locator('.pose-viewport').scrollIntoViewIfNeeded()
    const frame = await canvas.evaluate((element: HTMLCanvasElement) => {
      const copy = document.createElement('canvas'); copy.width = element.width; copy.height = element.height
      const context = copy.getContext('2d')!; context.drawImage(element, 0, 0)
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data
      let count = 0, left = copy.width, right = 0, top = copy.height, bottom = 0
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (Math.max(...pixels.subarray(offset, offset + 3)) - Math.min(...pixels.subarray(offset, offset + 3)) < 25) continue
        const horizontal = offset / 4 % copy.width, vertical = Math.floor(offset / 4 / copy.width)
        count++; left = Math.min(left, horizontal); right = Math.max(right, horizontal); top = Math.min(top, vertical); bottom = Math.max(bottom, vertical)
      }
      return { count, left, right, top, bottom, width: copy.width, height: copy.height }
    })
    expect(frame.count).toBeGreaterThan(500)
    expect(frame.left).toBeGreaterThan(1); expect(frame.right).toBeLessThan(frame.width - 1)
    expect(frame.top).toBeGreaterThan(1); expect(frame.bottom).toBeLessThan(frame.height - 1)
    expect(await poseDialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`shoot-pose-${viewport.width}.png`) })
  }
  expect(await page.evaluate(() => localStorage.getItem('qwen-project'))).toBeNull()
  hideProjects = false
  await poseDialog.getByRole('button', { name: '使用此姿势' }).click()
  await expect(poseDialog).toHaveCount(0)
  const projectId = await page.evaluate(() => localStorage.getItem('qwen-project'))
  const snapshot = await (await request.get(`/api/projects/${projectId}`)).json()
  expect(snapshot.project.title).toBe('模特试拍')
  expect(snapshot.assets).toHaveLength(1)
  const poseAsset = snapshot.assets[0]
  const poseBytes = await (await request.get(`/api/assets/${poseAsset.id}/content`)).body()
  expect(poseBytes.length).toBeGreaterThan(10000)
  const posePixels = await sharp(poseBytes).removeAlpha().raw().toBuffer()
  let mannequinPixels = 0, helperPixels = 0
  for (let offset = 0; offset < posePixels.length; offset += 3) {
    const [red, green, blue] = posePixels.subarray(offset, offset + 3)
    if (red > 130 && green > 80 && blue < green - 35) mannequinPixels++
    if (red < 40 && green > 85 && green < 160 && blue > 60 && blue < 140) helperPixels++
  }
  expect(mannequinPixels).toBeGreaterThan(500)
  expect(helperPixels).toBe(0)
  await expect(dialog.getByRole('img', { name: '已选姿势参考图' })).toBeVisible()
  for (const label of ['模特', '商品']) {
    await dialog.getByLabel(`${label}参考图文件`, { exact: true }).setInputFiles(resolve('public/reference-interior.jpg'))
    await expect(dialog.getByRole('img', { name: `已选${label}参考图` })).toBeVisible()
  }
  await dialog.getByRole('button', { name: '合并参考图', exact: true }).click()
  await expect(dialog.getByRole('img', { name: '模特、姿势和商品合并预览' })).toBeVisible()
  await dialog.getByLabel('试拍图片比例').selectOption('9:16')
  await dialog.getByRole('button', { name: '带入对话' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByLabel('创作需求')).toHaveValue(/参考图1[\s\S]*参考图2[\s\S]*参考图3/)
  await expect(page.locator('.composer').getByLabel('作图比例')).toHaveValue('9:16')
  await expect(page.getByRole('button', { name: /^移除附件 / })).toHaveCount(3)
  const latest = await (await request.get(`/api/projects/${projectId}`)).json()
  expect(latest.assets).toHaveLength(3)
  expect(latest.messages).toHaveLength(0)
  expect(latest.runs).toHaveLength(0)
  expect(submissions).toBe(0)
})

test('pose studio renders the final mannequin, changes poses and fits mobile and desktop', async ({ page, request }, testInfo) => {
  test.setTimeout(60000)
  const project = await (await request.post('/api/projects', { data: { title: '姿势调整验收' } })).json()
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: '姿势生图', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '姿势生图', exact: true })
  await expect(dialog.locator('.pose-viewport')).toHaveAttribute('data-ready', 'true', { timeout: 30000 })
  const canvas = dialog.locator('canvas')
  const pixels = () => canvas.evaluate((element: HTMLCanvasElement) => {
    const copy = document.createElement('canvas'); copy.width = element.width; copy.height = element.height
    const context = copy.getContext('2d')!; context.drawImage(element, 0, 0)
    const rgba = context.getImageData(0, 0, copy.width, copy.height).data
    let count = 0; let left = copy.width; let right = 0; let top = copy.height; let bottom = 0
    for (let offset = 0; offset < rgba.length; offset += 4) {
      if (Math.max(rgba[offset], rgba[offset + 1], rgba[offset + 2]) - Math.min(rgba[offset], rgba[offset + 1], rgba[offset + 2]) < 25) continue
      const horizontal = (offset / 4) % copy.width; const vertical = Math.floor(offset / 4 / copy.width)
      count++; left = Math.min(left, horizontal); right = Math.max(right, horizontal); top = Math.min(top, vertical); bottom = Math.max(bottom, vertical)
    }
    return { count, left, right, top, bottom, width: copy.width, height: copy.height, image: copy.toDataURL() }
  })
  const standing = await pixels()
  expect(standing.count).toBeGreaterThan(500)
  await expect(dialog.getByRole('button', { name: '带入生成草稿' })).toBeDisabled()
  const preset = dialog.getByLabel('内置姿势')
  const library = await (await request.get('/pose/presets.json')).json()
  expect(library.poses).toHaveLength(43)
  expect(new Set(library.poses.map((pose: { source: { license: string; pack: string; sha256: string } }) => `${pose.source.license}:${pose.source.pack}:${pose.source.sha256}`))).toEqual(new Set(['CC0-1.0:Universal Animation Library Standard:69591853d817488edaa8fd9bf8fc1d821eaeaf789f8627b3cd23b41c4ed67997']))
  await expect(preset.locator('option')).toHaveCount(44)
  await expect(dialog.getByRole('slider')).toHaveCount(0)
  await expect(dialog.getByLabel('关节', { exact: true })).toHaveCount(0)
  for (const { id } of library.poses) {
    await preset.selectOption(id)
    const sample = await pixels()
    expect(sample.count).toBeGreaterThan(500)
    expect(sample.left).toBeGreaterThan(1); expect(sample.right).toBeLessThan(sample.width - 1)
    expect(sample.top).toBeGreaterThan(1); expect(sample.bottom).toBeLessThan(sample.height - 1)
    if (id !== 'ual1Idle') expect(sample.image).not.toBe(standing.image)
  }
  await preset.selectOption('ual1-A_TPose')
  const coloredPoint = (color: 'green' | 'blue') => canvas.evaluate((element: HTMLCanvasElement, color) => {
    const copy = document.createElement('canvas'); copy.width = element.width; copy.height = element.height
    const context = copy.getContext('2d')!; context.drawImage(element, 0, 0)
    const rgba = context.getImageData(0, 0, copy.width, copy.height).data
    const points: { x: number; y: number }[] = []
    for (let offset = 0; offset < rgba.length; offset += 4) {
      const [red, green, blue] = rgba.subarray(offset, offset + 3)
      if (color === 'green' ? red < 40 && green > 85 && green < 160 && blue > 60 && blue < 140 : blue > 190 && blue - red > 60 && blue - green > 60 && Math.abs(red - green) < 25) points.push({ x: (offset / 4) % copy.width, y: Math.floor(offset / 4 / copy.width) })
    }
    if (!points.length) throw new Error(`Missing ${color} control pixels`)
    const right = Math.max(...points.map(point => point.x))
    const edge = points.filter(point => point.x > right - 3)
    const target = edge[Math.floor(edge.length / 2)]
    const bounds = element.getBoundingClientRect()
    return { x: bounds.x + target.x / copy.width * bounds.width, y: bounds.y + target.y / copy.height * bounds.height }
  }, color)
  const marker = await coloredPoint('green')
  await page.touchscreen.tap(marker.x, marker.y)
  await expect(dialog.locator('.pose-viewport')).toHaveAttribute('data-selected-joint', 'leftHand')
  await expect(dialog.getByRole('status')).toContainText('左手')
  const before = await pixels()
  await page.screenshot({ path: testInfo.outputPath('pose-selected.png') })
  const ring = await coloredPoint('blue')
  if (testInfo.project.name === 'mobile') {
    const touch = await page.context().newCDPSession(page)
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: ring.x, y: ring.y, id: 1 }] })
    for (let step = 1; step <= 10; step++) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: ring.x - step * 2, y: ring.y - step * 3, id: 1 }] })
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await touch.detach()
  } else {
    await page.mouse.move(ring.x, ring.y)
    await page.mouse.down()
    await page.mouse.move(ring.x - 20, ring.y - 30, { steps: 10 })
    await page.mouse.up()
  }
  await expect(preset).toHaveValue('')
  expect((await pixels()).image).not.toBe(before.image)
  await dialog.getByRole('button', { name: '撤销姿势' }).click()
  await expect(preset).toHaveValue('ual1-A_TPose')
  await dialog.getByRole('button', { name: '重做姿势' }).click()
  await expect(preset).toHaveValue('')
  await dialog.getByRole('button', { name: '镜像姿势' }).click()
  await canvas.press('Escape')
  const adjusted = (await pixels()).image
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '姿势生图', exact: true }).click()
  await expect(dialog.locator('.pose-viewport')).toHaveAttribute('data-ready', 'true', { timeout: 30000 })
  expect((await pixels()).image).toBe(adjusted)
  await dialog.getByRole('button', { name: '恢复站立' }).click()
  await dialog.locator('.pose-viewport').scrollIntoViewIfNeeded()
  const bounds = (await canvas.boundingBox())!
  const front = (await pixels()).image
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width / 2 + 65, bounds.y + bounds.height / 2 + 10, { steps: 8 })
  await page.mouse.up()
  expect((await pixels()).image).not.toBe(front)
  await dialog.getByRole('button', { name: '正面全身' }).click()
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport)
    await dialog.locator('.pose-viewport').scrollIntoViewIfNeeded()
    await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(viewport.width - 5)
    const sample = await pixels()
    expect(sample.count).toBeGreaterThan(500)
    expect(sample.left).toBeGreaterThan(2); expect(sample.right).toBeLessThan(sample.width - 2)
    expect(sample.top).toBeGreaterThan(2); expect(sample.bottom).toBeLessThan(sample.height - 2)
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`pose-${viewport.width}.png`) })
  }
  expect(errors).toEqual([])
})

test('pose fullscreen keeps the same editor, fits orientation changes and preserves the form', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: '全屏姿势编辑' } })).json()
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/')
  await page.getByRole('button', { name: '姿势生图', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '姿势生图', exact: true })
  await expect(dialog.locator('.pose-viewport')).toHaveAttribute('data-ready', 'true', { timeout: 30000 })
  const canvas = dialog.locator('canvas')
  await canvas.evaluate(element => element.setAttribute('data-retained-canvas', 'true'))
  await dialog.getByLabel('场景与风格').fill('保留这段场景要求')
  await dialog.getByLabel('人物图片文件').setInputFiles({ name: 'person.png', mimeType: 'image/png', buffer: await sharp({ create: { width: 16, height: 32, channels: 3, background: '#178853' } }).png().toBuffer() })
  await dialog.getByLabel('内置姿势', { exact: true }).selectOption('ual1Talking')
  await dialog.getByRole('button', { name: '全屏编辑', exact: true }).click()
  await expect(dialog.locator('.pose-studio')).toHaveAttribute('data-fullscreen', 'true')
  await expect(dialog.locator('.pose-fields')).toBeHidden()
  await expect(dialog.getByRole('heading', { name: '姿势生图' })).toBeHidden()
  await dialog.getByLabel('内置姿势', { exact: true }).selectOption('ual1-A_TPose')
  for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport)
    await expect(canvas).toHaveCSS('height', `${viewport.height}px`)
    await expect(canvas).toHaveAttribute('data-retained-canvas', 'true')
    const frame = await canvas.evaluate((element: HTMLCanvasElement) => {
      const copy = document.createElement('canvas'); copy.width = element.width; copy.height = element.height
      const context = copy.getContext('2d')!; context.drawImage(element, 0, 0)
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data
      let count = 0; let left = copy.width; let right = 0; let top = copy.height; let bottom = 0
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (Math.max(...pixels.subarray(offset, offset + 3)) - Math.min(...pixels.subarray(offset, offset + 3)) < 25) continue
        const horizontal = (offset / 4) % copy.width; const vertical = Math.floor(offset / 4 / copy.width)
        count++; left = Math.min(left, horizontal); right = Math.max(right, horizontal); top = Math.min(top, vertical); bottom = Math.max(bottom, vertical)
      }
      const bounds = element.getBoundingClientRect()
      return { count, left: left / copy.width * bounds.width, right: right / copy.width * bounds.width, top: top / copy.height * bounds.height, bottom: bottom / copy.height * bounds.height }
    })
    expect(frame.count).toBeGreaterThan(500)
    expect(frame.left).toBeGreaterThan(2); expect(frame.right).toBeLessThan(viewport.width - 2)
    const bar = (await dialog.locator('.pose-viewbar').boundingBox())!
    const tools = (await dialog.getByRole('toolbar', { name: '姿势工具' }).boundingBox())!
    expect(frame.top).toBeGreaterThan(bar.y + bar.height)
    expect(frame.bottom).toBeLessThan(tools.y)
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`pose-fullscreen-${viewport.width}.png`) })
  }
  const beforeOrbit = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())
  await page.mouse.move(80, 110)
  await page.mouse.down()
  await page.mouse.move(135, 135, { steps: 8 })
  await page.mouse.up()
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(beforeOrbit)
  await dialog.getByRole('button', { name: '退出全屏编辑' }).focus()
  await page.keyboard.press('Escape')
  await expect(dialog.locator('.pose-studio')).toHaveAttribute('data-fullscreen', 'false')
  await expect(dialog).toBeVisible()
  await expect(canvas).toHaveAttribute('data-retained-canvas', 'true')
  await expect(dialog.getByLabel('场景与风格')).toHaveValue('保留这段场景要求')
  await expect(dialog.getByRole('img', { name: '已选人物参考图' })).toBeVisible()
  await dialog.getByRole('button', { name: '撤销姿势' }).click()
  await expect(dialog.getByLabel('内置姿势', { exact: true })).toHaveValue('ual1Talking')
  await dialog.getByRole('button', { name: '全屏编辑', exact: true }).click()
  await dialog.getByRole('button', { name: '退出全屏编辑', exact: true }).click()
  await expect(dialog.locator('.pose-fields')).toBeVisible()
})

test('pose reference board preserves both inputs and prepares an explicit edit without generating', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: `姿势参考板-${testInfo.project.name}` } })).json()
  const original = await sharp({ create: { width: 400, height: 600, channels: 3, background: '#178853' } }).png().toBuffer()
  const source = await (await request.post(`/api/projects/${project.id}/uploads`, { multipart: { file: { name: 'person.png', mimeType: 'image/png', buffer: original } } })).json()
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  let submissions = 0
  page.on('request', entry => { if (entry.method() === 'POST' && /\/(chat|messages)$/.test(new URL(entry.url()).pathname)) submissions++ })
  await page.goto('/')
  await page.getByLabel('创作需求').fill('保留已有需求')
  await page.getByRole('button', { name: '姿势生图', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '姿势生图', exact: true })
  await expect(dialog.locator('.pose-viewport')).toHaveAttribute('data-ready', 'true', { timeout: 30000 })
  const canvas = dialog.locator('canvas')
  const bounds = (await canvas.boundingBox())!
  await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } })
  await expect(dialog.locator('.pose-selected')).toBeVisible()
  await dialog.getByLabel('人物参考图', { exact: true }).selectOption(source.id)
  await dialog.getByLabel('场景与风格').fill('自然光，全身照片')
  await dialog.getByRole('button', { name: '带入生成草稿' }).click()
  await expect(dialog).toHaveCount(0)
  const snapshot = await (await request.get(`/api/projects/${project.id}`)).json()
  expect(snapshot.assets).toHaveLength(2)
  expect(snapshot.messages).toHaveLength(0)
  expect(snapshot.runs).toHaveLength(0)
  expect(submissions).toBe(0)
  const board = snapshot.assets.find((asset: { id: string }) => asset.id !== source.id)
  expect([board.width, board.height]).toEqual([1536, 1024])
  const content = await (await request.get(`/api/assets/${board.id}/content`)).body()
  const right = await sharp(content).extract({ left: 1100, top: 400, width: 30, height: 30 }).raw().toBuffer()
  expect(Array.from(right.subarray(0, 3))).toEqual([23, 136, 83])
  const left = await sharp(content).extract({ left: 0, top: 60, width: 768, height: 952 }).stats()
  expect(left.channels[0].stdev).toBeGreaterThan(10)
  const posePixels = await sharp(content).extract({ left: 0, top: 60, width: 768, height: 952 }).removeAlpha().raw().toBuffer()
  let helpers = 0
  for (let offset = 0; offset < posePixels.length; offset += 3) {
    const [red, green, blue] = posePixels.subarray(offset, offset + 3)
    if (red < 40 && green > 85 && green < 160 && blue > 60 && blue < 140) helpers++
    if (blue > 190 && blue - red > 60 && blue - green > 60 && Math.abs(red - green) < 25) helpers++
  }
  expect(helpers).toBe(0)
  expect(await (await request.get(`/api/assets/${source.id}/content`)).body()).toEqual(await sharp(original).png().toBuffer())
  await expect(page.getByLabel('创作需求')).toHaveValue(new RegExp(`保留已有需求[\\s\\S]*左侧 A[\\s\\S]*右侧 B[\\s\\S]*自然光，全身照片[\\s\\S]*原图附件 ID：${board.id}`))
  await page.getByRole('button', { name: '提交需求', exact: true }).click()
  await expect(page.getByRole('article', { name: '你的消息' })).toContainText(`原图附件 ID：${board.id}`)
  expect(submissions).toBe(1)
})

test('pose studio handles model failure and local image upload without creating a project early', async ({ page, request }) => {
  let hideProjects = true
  await page.route('**/api/projects', route => hideProjects && route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue())
  let failModel = true
  await page.route('**/pose/quaternius-original.glb', route => failModel ? route.fulfill({ status: 503 }) : route.continue())
  await page.goto('/')
  await page.getByRole('button', { name: '姿势生图', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '姿势生图', exact: true })
  await expect(dialog.getByRole('button', { name: '重试加载人偶' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '带入生成草稿' })).toBeDisabled()
  failModel = false
  await dialog.getByRole('button', { name: '重试加载人偶' }).click()
  await expect(dialog.locator('.pose-viewport')).toHaveAttribute('data-ready', 'true', { timeout: 30000 })
  const image = await sharp({ create: { width: 16, height: 32, channels: 3, background: '#1658bb' } }).png().toBuffer()
  await dialog.getByLabel('人物图片文件').setInputFiles({ name: 'person.png', mimeType: 'image/png', buffer: image })
  expect(await page.evaluate(() => localStorage.getItem('qwen-project'))).toBeNull()
  hideProjects = false
  await dialog.getByRole('button', { name: '带入生成草稿' }).click()
  await expect(dialog).toHaveCount(0)
  const id = await page.evaluate(() => localStorage.getItem('qwen-project'))
  const snapshot = await (await request.get(`/api/projects/${id}`)).json()
  expect(snapshot.assets).toHaveLength(1)
  expect(snapshot.messages).toHaveLength(0)
  expect(snapshot.project.title).toBe('姿势生图')
})

async function mockFileSharing(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data: ShareData) => Reflect.get(window, 'rejectFileShare') !== true && data.files?.every(file => file instanceof File) })
    Object.defineProperty(navigator, 'share', { configurable: true, value: async (data: ShareData) => {
      if (Reflect.get(window, 'cancelFileShare')) throw new DOMException('Cancelled', 'AbortError')
      const activated = navigator.userActivation.isActive
      const files = await Promise.all((data.files ?? []).map(async file => ({ name: file.name, type: file.type, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) })))
      Reflect.set(window, 'sharedFiles', { files, activated, keys: Object.keys(data) })
    } })
  })
}

test('file forwarding shares original files through a fresh user gesture without private URLs', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: '文件转发' } })).json()
  const image = await sharp({ create: { width: 32, height: 16, channels: 3, background: '#197d65' } }).jpeg().toBuffer()
  const samples = [{ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: image, expectedName: 'photo.png', expectedType: 'image/png' }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('original document'), expectedName: 'notes.txt', expectedType: 'text/plain' }]
  const assets = []
  for (const sample of samples) {
    const response = await request.post(`/api/projects/${project.id}/uploads`, { multipart: { file: sample } })
    expect(response.status()).toBe(201)
    assets.push(await response.json())
  }
  await mockFileSharing(page)
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/')
  const originalURL = page.url()
  for (const [index, sample] of samples.entries()) {
    await openProjectPanel(page, '素材库')
    await page.locator('.asset').filter({ hasText: sample.name }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.locator('.actions').getByRole('button', { name: '转发', exact: true })).toBeVisible()
    const shareButton = dialog.getByRole('button', { name: '转发', exact: true })
    await expect(shareButton).toHaveClass('icon-button')
    await expect(shareButton).toHaveText('')
    await expect(shareButton).toHaveCSS('width', '44px')
    await expect(shareButton).toHaveCSS('height', '44px')
    await expect(shareButton).toHaveCSS('color', 'rgb(111, 123, 115)')
    await expect(dialog.locator(':scope > .asset-share')).toHaveCount(0)
    await dialog.getByRole('button', { name: '转发', exact: true }).click()
    await expect(dialog.getByText('文件已就绪', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => Reflect.get(window, 'sharedFiles'))).toBeUndefined()
    await page.evaluate(() => Reflect.set(window, 'cancelFileShare', true))
    await dialog.getByRole('button', { name: '选择转发应用', exact: true }).click()
    await expect(dialog.getByRole('button', { name: '选择转发应用', exact: true })).toBeEnabled()
    await expect(dialog.getByText('未能打开系统分享，请重试')).toHaveCount(0)
    await page.evaluate(() => Reflect.set(window, 'cancelFileShare', false))
    await page.screenshot({ path: testInfo.outputPath(`share-${index}.png`) })
    await dialog.getByRole('button', { name: '选择转发应用', exact: true }).click()
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'sharedFiles'))).toBeTruthy()
    const original = await (await request.get(`/api/assets/${assets[index].id}/content`)).body()
    expect(await page.evaluate(() => Reflect.get(window, 'sharedFiles'))).toEqual({ files: [{ name: sample.expectedName, type: sample.expectedType, bytes: Array.from(original) }], activated: true, keys: ['files'] })
    expect(page.url()).toBe(originalURL)
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.evaluate(() => Reflect.deleteProperty(window, 'sharedFiles'))
  }
})

test('file forwarding handles unsupported browsers, denied access and cancelled preparation', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { title: '转发失败处理' } })).json()
  const asset = await (await request.post(`/api/projects/${project.id}/uploads`, { multipart: { file: { name: 'document.txt', mimeType: 'text/plain', buffer: Buffer.from('private document') } } })).json()
  await mockFileSharing(page)
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/')
  await openProjectPanel(page, '素材库')
  await page.locator('.asset').click()
  const dialog = page.getByRole('dialog')
  await page.evaluate(() => { Reflect.set(window, 'originalShare', navigator.share); Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }) })
  let reads = 0
  let denied = true
  await page.route(`**/api/assets/${asset.id}/content`, async route => { reads++; if (denied) await route.fulfill({ status: 403, json: { error: 'Forbidden' } }); else await route.continue() })
  await dialog.getByRole('button', { name: '转发', exact: true }).click()
  await expect(dialog.getByText('当前浏览器不支持文件转发', { exact: true })).toBeVisible()
  expect(reads).toBe(0)
  await page.evaluate(() => Object.defineProperty(navigator, 'share', { configurable: true, value: Reflect.get(window, 'originalShare') }))
  await dialog.getByRole('button', { name: '转发', exact: true }).click()
  await expect(dialog.getByText('文件读取失败，请重试', { exact: true })).toBeVisible()
  denied = false
  await page.evaluate(() => Reflect.set(window, 'rejectFileShare', true))
  await dialog.getByRole('button', { name: '转发', exact: true }).click()
  await expect(dialog.getByText('当前浏览器不支持转发此文件类型', { exact: true })).toBeVisible()
  await page.evaluate(() => {
    Reflect.set(window, 'rejectFileShare', false)
    const original = window.fetch.bind(window)
    window.fetch = (input, options) => String(input).endsWith('/content') ? new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => { Reflect.set(window, 'sharePreparationAborted', true); reject(new DOMException('Cancelled', 'AbortError')) }, { once: true })
    }) : original(input, options)
  })
  await dialog.getByRole('button', { name: '转发', exact: true }).click()
  await dialog.getByRole('button', { name: '取消准备转发', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '转发', exact: true })).toBeEnabled()
  expect(await page.evaluate(() => Reflect.get(window, 'sharePreparationAborted'))).toBe(true)
  expect(await page.evaluate(() => Reflect.get(window, 'sharedFiles'))).toBeUndefined()
  await dialog.getByRole('button', { name: '转发', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '取消准备转发', exact: true })).toBeVisible()
  await page.evaluate(() => Reflect.set(window, 'sharePreparationAborted', false))
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'sharePreparationAborted'))).toBe(true)
})

test('conversation opens at latest, follows updates and respects reading history', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: `滚动验收-${testInfo.project.name}` } })).json()
  const other = await (await request.post('/api/projects', { data: { title: `另一会话-${testInfo.project.name}` } })).json()
  async function append(text: string) {
    expect((await request.post(`/api/projects/${project.id}/messages`, { data: { requestId: crypto.randomUUID(), text, assetIds: [], ratio: '1:1' } })).status()).toBe(202)
    await expect(page.getByText(text, { exact: true })).toHaveCount(1)
  }
  for (let index = 0; index < 12; index++) await request.post(`/api/projects/${project.id}/messages`, { data: { requestId: crypto.randomUUID(), text: `历史消息 ${index}\n${'多行内容\n'.repeat(5)}`, assetIds: [], ratio: '1:1' } })
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/')
  const scroll = page.locator('.conversation-scroll')
  const bottomGap = () => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
  await expect(page.getByRole('status', { name: '已同步', exact: true })).toBeVisible()
  await expect.poll(bottomGap).toBeLessThan(2)
  await append('最新消息\n持续更新\n保持底部')
  await expect.poll(bottomGap).toBeLessThan(2)
  await page.locator('.conversation-turn').last().evaluate(element => { element.style.minHeight = '700px' })
  await expect.poll(bottomGap).toBeLessThan(2)
  await scroll.evaluate(element => { element.scrollTop = 100; element.dispatchEvent(new Event('scroll')) })
  await append('阅读历史时收到的新消息')
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBe(100)
  await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')) })
  await append('回到底部后继续跟随')
  await expect.poll(bottomGap).toBeLessThan(2)
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await page.getByRole('button', { name: other.title, exact: true }).click()
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await page.getByRole('button', { name: project.title, exact: true }).click()
  await expect(page.getByText('回到底部后继续跟随', { exact: true })).toBeVisible()
  await expect.poll(bottomGap).toBeLessThan(2)
  await page.screenshot({ path: testInfo.outputPath('conversation-latest.png') })
})

test('upload cancellation stops the batch and restores the composer', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: '取消批量上传' } })).json()
  await page.addInitScript(id => {
    localStorage.setItem('qwen-project', id)
    const original = window.fetch.bind(window)
    let count = 0
    window.fetch = (input, options) => {
      if (String(input).endsWith('/uploads')) {
        count++
        Reflect.set(window, 'uploadCount', count)
        if (count === 2 || Reflect.get(window, 'holdNextUpload')) return new Promise((_resolve, reject) => {
          Reflect.set(window, 'holdNextUpload', false)
          options!.signal!.addEventListener('abort', () => {
            Reflect.set(window, 'uploadAborted', true)
            reject(new DOMException('Cancelled', 'AbortError'))
          }, { once: true })
        })
      }
      return original(input, options)
    }
  }, project.id)
  await page.goto('/')
  await expect(page.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled()
  await page.locator('input[type=file]').setInputFiles(['first.txt', 'second.txt', 'third.txt'].map(name => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) })))
  await expect(page.getByText('正在上传 2 / 3 · second.txt', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('upload-cancel.png') })
  await page.getByRole('button', { name: '取消上传', exact: true }).click()
  await expect(page.getByRole('button', { name: '取消上传', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('创作需求')).toBeEnabled()
  await expect(page.getByRole('button', { name: '移除附件 first.txt', exact: true })).toBeVisible()
  expect(await page.evaluate(() => ({ count: Reflect.get(window, 'uploadCount'), aborted: Reflect.get(window, 'uploadAborted') }))).toEqual({ count: 2, aborted: true })
  expect((await (await request.get(`/api/projects/${project.id}`)).json()).assets).toHaveLength(1)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.locator('input[type=file]').setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('retry') })
  await expect(page.getByRole('button', { name: '移除附件 retry.txt', exact: true })).toBeVisible()
  await openProjectPanel(page, '素材库')
  await page.evaluate(() => Reflect.set(window, 'holdNextUpload', true))
  await page.locator('input[type=file]').setInputFiles({ name: 'library.txt', mimeType: 'text/plain', buffer: Buffer.from('cancel') })
  await page.getByRole('dialog').getByRole('button', { name: '取消上传', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('button', { name: '上传文件', exact: true })).toBeEnabled()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '修改图片', exact: true }).click()
  const guide = page.getByRole('dialog', { name: '修改图片', exact: true })
  await guide.getByLabel('修改要求', { exact: true }).fill('保留修改要求')
  await guide.getByLabel('上传原图', { exact: true }).setInputFiles(resolve('public/reference-interior.jpg'))
  await page.evaluate(() => Reflect.set(window, 'holdNextUpload', true))
  await guide.getByRole('button', { name: '带入草稿' }).click()
  await guide.getByRole('button', { name: '取消上传', exact: true }).click()
  await expect(guide.getByRole('button', { name: '带入草稿' })).toBeEnabled()
  await expect(guide.getByLabel('修改要求', { exact: true })).toHaveValue('保留修改要求')
  expect((await (await request.get(`/api/projects/${project.id}`)).json()).assets).toHaveLength(2)
})

test('VM failed start refreshes and permits cancelling a fresh retry confirmation', async ({ page }) => {
  const ids: string[] = []
  let operation: Record<string, unknown> | undefined
  await page.route('**/api/vm', route => route.fulfill({ json: { configured: true, name: 'test-gpu', powerState: 'deallocated', gpuReady: false, operation } }))
  await page.route('**/api/vm/actions', route => {
    const body = route.request().postDataJSON()
    ids.push(body.requestId)
    operation = { id: body.requestId, action: 'start', status: 'failed', error: 'AllocationFailed: No capacity' }
    return route.fulfill({ status: 503, json: { error: '容量不足，本次操作失败' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'VM 管理', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'VM 管理' })
  await panel.getByRole('button', { name: '启动', exact: true }).click()
  await panel.getByRole('button', { name: '确认启动', exact: true }).click()
  await expect(panel.getByText('启动 · 失败', { exact: true })).toBeVisible()
  await expect(panel.getByText('AllocationFailed: No capacity', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: '启动', exact: true })).toBeEnabled()
  await panel.getByRole('button', { name: '启动', exact: true }).click()
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  expect(ids).toHaveLength(1)
  await panel.getByRole('button', { name: '启动', exact: true }).click()
  await panel.getByRole('button', { name: '确认启动', exact: true }).click()
  await expect.poll(() => ids.length).toBe(2)
  expect(ids[0]).not.toBe(ids[1])
})

test('all modal layouts keep headers, fields and actions inside the mobile viewport', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: '弹层布局验收' } })).json()
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/')
  async function inspect(name: string) {
    const panel = page.getByRole('dialog')
    await expect(panel).toHaveCount(1)
    await expect(panel).toBeVisible()
    const layout = await panel.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      const close = element.querySelector('.modal-heading button')!.getBoundingClientRect()
      const fields = Array.from(element.querySelectorAll('input:not([type=checkbox]):not([type=file]), select, textarea')).map(field => field.getBoundingClientRect())
      return { fits: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight + 1, noOverflow: element.scrollWidth <= element.clientWidth, closeFits: close.top >= bounds.top && close.bottom <= bounds.bottom && close.width >= 44, fieldsFit: fields.every(field => field.width > 0 && field.left >= bounds.left && field.right <= bounds.right && field.height >= 44) }
    })
    expect(layout, name).toEqual({ fits: true, noOverflow: true, closeFits: true, fieldsFit: true })
    await page.screenshot({ path: testInfo.outputPath(`modal-${name}.png`) })
  }
  const close = () => page.getByRole('button', { name: '关闭', exact: true }).click()
  for (const title of ['设置', 'VM 管理']) {
    await page.getByRole('button', { name: title, exact: true }).click()
    await inspect(title === '设置' ? 'settings' : 'vm')
    await close()
  }
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await inspect('projects')
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await inspect('new-project')
  await close()
  await page.getByRole('button', { name: '重命名项目', exact: true }).click()
  await inspect('rename-project')
  await close()
  await page.locator('input[type=file]').setInputFiles(resolve('public/reference-interior.jpg'))
  await expect(page.getByRole('button', { name: '移除附件 reference-interior.jpg' })).toBeVisible()
  for (const title of ['素材库', '任务记录']) {
    await openProjectPanel(page, title as '素材库' | '任务记录')
    await inspect(title === '素材库' ? 'assets' : 'tasks')
    if (title === '素材库') {
      await page.locator('.asset').first().click()
      await inspect('image-viewer')
    }
    await close()
  }
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await page.getByRole('button', { name: '服务未接入', exact: true }).click()
  await inspect('services')
  await close()
  for (const [title, name] of [['做图片', 'image'], ['修改图片', 'edit'], ['模特试拍', 'model-shoot']]) {
    await page.getByRole('button', { name: '创作引导', exact: true }).click()
    await inspect('guides')
    await page.getByRole('dialog').getByRole('button', { name: title, exact: true }).click()
    await inspect(name)
    await close()
  }
})

test('creation guide creates a project only on confirmation and stays accessible after messages', async ({ page, request }, testInfo) => {
  let hideProjects = true
  await page.route('**/api/projects', route => hideProjects && route.request().method() === 'GET' ? route.fulfill({ json: [] }) : route.continue())
  await page.goto('/')
  await page.getByRole('button', { name: '做图片', exact: true }).click()
  await page.getByRole('textbox', { name: '画面内容' }).fill('取消的草稿')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByLabel('创作需求')).toBeDisabled()
  hideProjects = false
  await page.getByRole('button', { name: '做图片', exact: true }).click()
  await page.getByRole('textbox', { name: '画面内容' }).fill('第一次创作图片')
  await page.getByRole('button', { name: '带入草稿' }).click()
  await expect(page.getByLabel('创作需求')).toHaveValue(/第一次创作图片/)
  const projectId = await page.evaluate(() => localStorage.getItem('qwen-project'))
  const before = await (await request.get(`/api/projects/${projectId}`)).json()
  expect(before.project.title).toBe('第一次创作图片')
  expect(before.messages).toHaveLength(0)
  await page.getByRole('button', { name: '提交需求', exact: true }).click()
  await expect(page.getByRole('article', { name: '你的消息' })).toContainText('请生成一张图片')
  await page.getByLabel('创作需求').fill('新草稿保持不变')
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '项目列表', exact: true }).getByRole('navigation', { name: '创作入口' })).toHaveCount(0)
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  const trigger = page.locator('.composer-row').getByRole('button', { name: '创作引导', exact: true })
  await expect(trigger).toHaveAttribute('title', '创作引导')
  const bounds = await trigger.boundingBox()
  expect(bounds!.width).toBeGreaterThanOrEqual(44)
  expect(bounds!.height).toBeGreaterThanOrEqual(44)
  await trigger.click()
  const guideMenu = page.getByRole('dialog', { name: '创作引导', exact: true })
  await expect(guideMenu.getByRole('navigation').getByRole('button')).toHaveCount(4)
  await expect(guideMenu.getByRole('button', { name: '数字人口播', exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('composer-guides.png') })
  await guideMenu.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByLabel('创作需求')).toHaveValue('新草稿保持不变')
  await trigger.click()
  await guideMenu.getByRole('button', { name: '数字人口播', exact: true }).click()
  await expect(guideMenu).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('创作需求')).toHaveValue('新草稿保持不变')
  await trigger.click()
  await guideMenu.getByRole('button', { name: '做图片', exact: true }).click()
  await expect(guideMenu).toHaveCount(0)
  await page.getByRole('textbox', { name: '画面内容' }).fill('不保存的内容')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByLabel('创作需求')).toHaveValue('新草稿保持不变')
})

test('four creation entries prepare drafts without submitting or changing models', async ({ page, request }, testInfo) => {
  test.setTimeout(60000)
  const project = await (await request.post('/api/projects', { data: { title: '创作入口' } })).json()
  await page.addInitScript(id => { localStorage.setItem('qwen-project', id); localStorage.setItem('studio-video-model', 'none') }, project.id)
  let submissions = 0
  page.on('request', request => { if (request.method() === 'POST' && /\/(chat|messages)$/.test(new URL(request.url()).pathname)) submissions++ })
  await page.goto('/')
  const entries = page.getByRole('navigation', { name: '创作入口' })
  const titles = ['做图片', '修改图片', '姿势生图', '模特试拍']
  await expect(entries.getByRole('button')).toHaveText(titles)
  await expect(page.getByRole('button', { name: /^(做短镜头|写脚本分镜)$/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '姿势生图', exact: true })).toHaveCount(1)
  await expect(page.getByRole('button', { name: '模特试拍', exact: true })).toHaveCount(1)
  async function inspectCards() {
    const boxes = await entries.getByRole('button').evaluateAll(buttons => buttons.map(button => {
      const bounds = button.getBoundingClientRect()
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    }))
    expect(boxes).toHaveLength(4)
    expect(boxes[0].y).toBe(boxes[1].y)
    expect(boxes[2].y).toBe(boxes[3].y)
    expect(boxes[2].y).toBeGreaterThanOrEqual(boxes[0].y + boxes[0].height)
    expect(boxes[2].x).toBe(boxes[0].x)
    expect(boxes[3].x).toBe(boxes[1].x)
    for (const box of boxes) {
      expect(Math.abs(box.width - boxes[0].width)).toBeLessThan(1)
      expect(box.height).toBeGreaterThanOrEqual(58)
    }
  }
  await inspectCards()
  expect(await page.locator('.conversation-scroll').evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return bounds.left === 0 && bounds.right === innerWidth
  })).toBe(true)
  const layout = await page.evaluate(() => {
    const composer = document.querySelector('.composer')!.getBoundingClientRect()
    const buttons = Array.from(document.querySelectorAll('.welcome .creation-entries button')).map(element => element.getBoundingClientRect())
    const reference = document.querySelector('.sample img')!.getBoundingClientRect()
    return { buttonsFit: buttons.every(rect => rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= composer.top && rect.height >= 44), referenceVisible: composer.top - reference.top, composerFits: composer.bottom <= innerHeight }
  })
  expect(layout.buttonsFit).toBe(true)
  expect(layout.referenceVisible).toBeGreaterThan(24)
  expect(layout.composerFits).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('creation-entries.png') })
  const viewport = page.viewportSize()!
  await page.setViewportSize({ width: 1280, height: 900 })
  await inspectCards()
  await page.screenshot({ path: testInfo.outputPath('creation-entries-desktop.png') })
  await page.setViewportSize(viewport)
  await page.getByLabel('创作需求').fill('保留已有草稿')
  for (const [title, label, text] of [['做图片', '画面内容', '清晨花束']]) {
    await entries.getByRole('button', { name: title, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: title, exact: true })
    await expect(dialog.getByRole('button', { name: '带入草稿' })).toBeDisabled()
    await dialog.getByRole('textbox', { name: label }).fill(text)
    await dialog.getByRole('button', { name: '带入草稿' }).click()
    await expect(page.getByLabel('创作需求')).toHaveValue(new RegExp(text))
    await expect(page.getByLabel('创作需求')).toHaveValue(/保留已有草稿/)
  }
  for (const fromGuide of [false, true]) {
    for (const title of ['姿势生图', '模特试拍']) {
      if (fromGuide) {
        await page.locator('.composer-row').getByRole('button', { name: '创作引导', exact: true }).click()
        await expect(entries.getByRole('button')).toHaveText(titles)
        await inspectCards()
        await expect(page.getByRole('button', { name: /^(做短镜头|写脚本分镜)$/ })).toHaveCount(0)
        await page.screenshot({ path: testInfo.outputPath('creation-guide-entries.png') })
      }
      await entries.getByRole('button', { name: title, exact: true }).click()
      const panel = page.getByRole('dialog', { name: title, exact: true })
      await expect(panel).toBeVisible()
      await expect(page.getByRole('dialog', { name: '创作引导', exact: true })).toHaveCount(0)
      await panel.getByRole('button', { name: '关闭', exact: true }).click()
      await expect(page.getByLabel('创作需求')).toHaveValue(/保留已有草稿/)
    }
  }
  expect(submissions).toBe(0)
  expect(await page.evaluate(() => localStorage.getItem('studio-video-model'))).toBe('none')
  expect((await (await request.get(`/api/projects/${project.id}`)).json()).messages).toHaveLength(0)
  expect(await entries.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test('image editing entry requires an explicit source and preserves existing attachments', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: '原图选择' } })).json()
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/')
  await page.locator('input[type=file]').setInputFiles(resolve('public/reference-interior.jpg'))
  await expect(page.getByRole('button', { name: '移除附件 reference-interior.jpg' })).toBeVisible()
  const snapshot = await (await request.get(`/api/projects/${project.id}`)).json()
  const source = snapshot.assets[0]
  await page.getByRole('button', { name: '修改图片', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '修改图片', exact: true })
  await dialog.getByLabel('修改要求', { exact: true }).fill('把墙面改成浅灰色')
  await expect(dialog.getByRole('button', { name: '带入草稿' })).toBeDisabled()
  await dialog.getByRole('combobox', { name: '项目原图' }).selectOption(source.id)
  await expect(dialog.getByRole('img', { name: '已选原图' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('creation-edit.png') })
  await dialog.getByRole('button', { name: '带入草稿' }).scrollIntoViewIfNeeded()
  const headerLayout = await dialog.evaluate(element => {
    const panel = element.getBoundingClientRect()
    const header = element.querySelector('.modal-heading')!.getBoundingClientRect()
    const close = element.querySelector('button[aria-label="关闭"]')!
    const bounds = close.getBoundingClientRect()
    return { headerVisible: header.top >= panel.top && header.bottom <= innerHeight, closeReachable: close.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)) }
  })
  expect(headerLayout.headerVisible).toBe(true)
  expect(headerLayout.closeReachable).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('creation-edit-scrolled.png') })
  await dialog.getByRole('button', { name: '带入草稿' }).click()
  await expect(page.getByLabel('创作需求')).toHaveValue(new RegExp(`原图附件 ID：${source.id}`))
  await expect(page.getByRole('button', { name: '移除附件 reference-interior.jpg' })).toHaveCount(1)
  await page.getByRole('button', { name: '修改图片', exact: true }).click()
  await dialog.getByLabel('上传原图', { exact: true }).setInputFiles(resolve('public/reference-still-life.jpg'))
  await dialog.getByLabel('修改要求', { exact: true }).fill('增加自然光')
  await dialog.getByRole('button', { name: '带入草稿' }).click()
  await expect(page.getByRole('button', { name: '移除附件 reference-still-life.jpg' })).toBeVisible()
  await expect(page.getByRole('button', { name: '移除附件 reference-interior.jpg' })).toBeVisible()
  expect((await (await request.get(`/api/projects/${project.id}`)).json()).messages).toHaveLength(0)
})

test('conversational avatar submits literal narration through chat and restores final and intermediate assets', async ({ page, request }, testInfo) => {
  await mockFileSharing(page)
  const project = await (await request.post('/api/projects', { data: { title: '数字人口播测试' } })).json()
  const buffer = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#197d65' } }).png().toBuffer()
  const source = await (await request.post(`/api/projects/${project.id}/uploads`, { multipart: { file: { name: 'host.png', mimeType: 'image/png', buffer } } })).json()
  const snapshot = await (await request.get(`/api/projects/${project.id}`)).json()
  const now = new Date().toISOString()
  const finalId = crypto.randomUUID(), clipId = crypto.randomUUID(), tailId = crypto.randomUUID(), messageId = crypto.randomUUID(), assistantId = crypto.randomUUID()
  const text = '使用所附主播图制作完整口播，逐字文案：大家好。<break/> 保留原文。使用晓晓，并保存分段和尾帧。'
  let submissions = 0
  let legacySubmissions = 0
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.route('**/api/health', route => route.fulfill({ json: { storage: 'ready', agentConfigured: true, agent: 'configured', renderer: 'azure_image2' } }))
  await page.route(`**/api/projects/${project.id}/avatar-jobs`, route => { legacySubmissions++; return route.abort() })
  await page.route(`**/api/projects/${project.id}/chat`, route => {
    const body = route.request().postDataJSON()
    expect(body.text).toBe(text)
    expect(body.assetIds).toEqual([source.id])
    submissions++
    return route.fulfill({ status: 202, json: { id: finalId } })
  })
  await page.route(`**/api/projects/${project.id}`, route => route.fulfill({ json: submissions ? {
    ...snapshot,
    runs: [{ id: finalId, projectId: project.id, messageId, assistantId, avatarJobId: finalId, assetId: finalId, processedAssetIds: [clipId, tailId], status: 'completed', stage: 'video', createdAt: now, input: { text, mode: 'auto', ratio: '16:9' } }],
    messages: [{ id: messageId, projectId: project.id, role: 'user', text, assetIds: [source.id], createdAt: now }, { id: assistantId, projectId: project.id, role: 'assistant', text: '完整口播已完成。', assetIds: [clipId, tailId, finalId], createdAt: now }],
    assets: [...snapshot.assets, ...[{ id: finalId, name: '完整口播.mp4', mediaType: 'video' }, { id: clipId, name: '口播第01段.mp4', mediaType: 'video' }, { id: tailId, sourceAssetId: clipId, name: '第01段尾帧.png', mediaType: 'image' }].map(asset => ({ ...asset, projectId: project.id, kind: 'generated', model: 'sadtalker', provider: 'openmontage', width: 64, height: 64, duration: 3.52, bytes: 100, createdAt: now }))],
  } : snapshot }))
  for (const id of [finalId, clipId, tailId]) await page.route(`**/api/assets/${id}/content*`, route => route.fulfill(route.request().url().includes('thumbnail=1') || id === tailId ? { body: buffer, contentType: 'image/png' } : { body: Buffer.from('video-share-fixture'), contentType: 'video/mp4' }))
  await page.goto('/')
  await page.getByRole('button', { name: '数字人口播', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '创作需求' })).toHaveValue(/先确认文案/)
  expect(submissions).toBe(0)
  await openProjectPanel(page, '素材库')
  await page.locator('.asset').click()
  await page.getByRole('button', { name: '用作参考', exact: true }).click()
  await page.getByRole('textbox', { name: '创作需求' }).fill(text)
  await page.getByRole('button', { name: '提交需求', exact: true }).click()
  await expect(page.getByLabel('完整口播.mp4', { exact: true })).toBeVisible()
  await expect(page.getByLabel('口播第01段.mp4', { exact: true })).toBeVisible()
  await expect(page.getByText('MiniMax H3', { exact: true })).toHaveCount(0)
  await page.locator('.video-result').filter({ has: page.getByLabel('完整口播.mp4', { exact: true }) }).getByRole('button', { name: '转发', exact: true }).click()
  await page.getByRole('button', { name: '选择转发应用', exact: true }).click()
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'sharedFiles'))).toMatchObject({ files: [{ name: '完整口播.mp4', type: 'video/mp4' }], activated: true })
  await page.getByText('第 1 段尾帧', { exact: true }).click()
  await expect(page.getByLabel('口播第01段.mp4', { exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: '第01段尾帧.png', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('avatar-conversation.png') })
  await page.reload()
  await expect(page.getByLabel('完整口播.mp4', { exact: true })).toBeVisible()
  await expect(page.getByLabel('口播第01段.mp4', { exact: true })).toBeVisible()
  expect(submissions).toBe(1)
  expect(legacySubmissions).toBe(0)
})

for (const outcome of ['cancelled', 'completed'] as const) test(`narration progressively updates the conversation and project through ${outcome}`, async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: `分段进度-${outcome}` } })).json()
  const now = new Date().toISOString()
  const runId = crypto.randomUUID(), messageId = crypto.randomUUID(), assistantId = crypto.randomUUID(), scriptId = crypto.randomUUID()
  const clipIds = [crypto.randomUUID(), crypto.randomUUID()], tailIds = [crypto.randomUUID(), crypto.randomUUID()]
  const segments = [{ text: '先看合同主体与岗位。', continueFromPrevious: false }, { text: '再看工资与工时。', continueFromPrevious: true }]
  const image = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#197d65' } }).png().toBuffer()
  let phase = 'script', status = 'running', segment = 0, clipCount = 0, stopRequested = false, stopCalls = 0, revision = 0
  const script = { id: scriptId, projectId: project.id, name: '口播分段剧本.md', mediaType: 'file', mimeType: 'text/markdown', hasThumbnail: false, kind: 'generated', bytes: 80, width: 0, height: 0, createdAt: now }
  const media = clipIds.flatMap((id, index) => [{ id, name: `第${index + 1}段.mp4`, mediaType: 'video', narration: segments[index].text }, { id: tailIds[index], sourceAssetId: id, name: `第${index + 1}段尾帧.png`, mediaType: 'image' }]).map(asset => ({ ...asset, projectId: project.id, kind: 'generated', model: 'sadtalker', width: 160, height: 90, bytes: 100, duration: 3.5, createdAt: now }))
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.route('**/api/health', route => route.fulfill({ json: { storage: 'ready', agentConfigured: true, agent: 'configured' } }))
  await page.route(`**/api/projects/${project.id}`, route => route.fulfill({ json: {
    project, threadId: null, jobs: [],
    messages: [{ id: messageId, projectId: project.id, text: '按确认的两段剧本制作口播', role: 'user', assetIds: [], createdAt: now }, { id: assistantId, projectId: project.id, text: '剧本已保存。', role: 'assistant', assetIds: [scriptId, ...media.slice(0, clipCount * 2).map(asset => asset.id)], createdAt: now }],
    runs: [{ id: runId, projectId: project.id, messageId, assistantId, avatarJobId: runId, status, stage: 'video', createdAt: now, input: { text: '制作口播', mode: 'auto', ratio: '16:9' }, processedAssetIds: media.slice(0, clipCount * 2).map(asset => asset.id), assetId: status === 'completed' ? runId : undefined, narration: { segments, scriptAssetId: scriptId, stopRequested, progress: { phase, segment, updatedAt: now } } }],
    assets: [script, ...media.slice(0, clipCount * 2), ...(status === 'completed' ? [{ ...media[0], id: runId, name: '完整口播.mp4' }] : [])],
  } }))
  for (const id of [...clipIds, ...tailIds, runId]) await page.route(`**/api/assets/${id}/content*`, route => route.fulfill(route.request().url().includes('thumbnail=1') || tailIds.includes(id) ? { body: image, contentType: 'image/png' } : { body: Buffer.from('video-fixture'), contentType: 'video/mp4' }))
  await page.route(`**/api/assets/${scriptId}/content*`, route => route.fulfill({ body: '# 分段剧本', contentType: 'text/markdown' }))
  await page.route(`**/api/agent-runs/${runId}/stop`, route => { stopCalls++; stopRequested = true; return route.fulfill({ json: { status: 'running' } }) })
  const sync = async () => { await request.patch(`/api/projects/${project.id}`, { data: { title: `进度-${outcome}-${++revision}` } }) }
  await page.goto('/')
  const progress = page.getByRole('status', { name: '口播制作进度' })
  await expect(progress).toContainText('分段剧本已保存')
  await expect(page.getByText(segments[0].text, { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '下载分段剧本' })).toHaveAttribute('href', `/api/assets/${scriptId}/content?download=1`)
  await expect(page.locator('.run-progress')).not.toHaveAttribute('open')
  phase = 'speech'; segment = 1
  await sync()
  await expect(progress).toContainText('第 1 段配音中')
  phase = 'rendering'; segment = 2; clipCount = 1
  await sync()
  await expect(progress).toContainText('第 2 段视频生成中')
  await expect(page.getByLabel('第1段.mp4', { exact: true })).toBeVisible()
  await expect(page.getByLabel('完整口播.mp4', { exact: true })).toHaveCount(0)
  await progress.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.narration-timeline video, .narration-heading')].every(element => element.getBoundingClientRect().right <= innerWidth))).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('narration-first-clip.png') })
  if (outcome === 'cancelled') {
    await page.getByRole('button', { name: '停止当前回复' }).click()
    await expect(progress).toContainText('正在停止后续步骤')
    await expect(page.getByRole('button', { name: '停止当前回复' })).toBeDisabled()
    await page.reload()
    await expect(progress).toContainText('正在停止后续步骤')
    status = 'cancelled'; phase = 'stopped'
    await sync()
    await expect(progress).toContainText('后续步骤已停止')
    await expect(page.getByRole('button', { name: '停止当前回复' })).toHaveCount(0)
    expect(stopCalls).toBe(1)
  } else {
    clipCount = 2; phase = 'stitching'
    await sync()
    await expect(progress).toContainText('正在拼接整片')
    await expect(page.getByLabel('第2段.mp4', { exact: true })).toBeVisible()
    phase = 'completed'
    await sync()
    await expect(progress).toContainText('整片已生成，正在入库')
    await expect(page.getByLabel('完整口播.mp4', { exact: true })).toHaveCount(0)
    status = 'completed'
    await sync()
    await expect(progress).toContainText('整片已保存')
    await expect(page.getByLabel('完整口播.mp4', { exact: true })).toBeVisible()
    expect(stopCalls).toBe(0)
  }
  await page.reload()
  await expect(progress).toContainText(`已保存 ${clipCount} / 2 段`)
  await expect(page.getByLabel('第1段.mp4', { exact: true })).toBeVisible()
  await openProjectPanel(page, '素材库')
  await expect(page.locator('.asset')).toHaveCount(1 + clipCount * 2 + (outcome === 'completed' ? 1 : 0))
  await expect(page.getByText('口播分段剧本.md', { exact: true })).toBeVisible()
})

for (const outcome of ['completed', 'cancelled']) test(`story text states update without reading media through ${outcome}`, async ({ page, request }) => {
  await page.route('**/*', route => ['image', 'media'].includes(route.request().resourceType()) || route.request().url().includes('/api/assets/') ? route.abort() : route.fallback())
  const project = await (await request.post('/api/projects', { data: { title: '故事文字验收' } })).json()
  const runId = crypto.randomUUID(), messageId = crypto.randomUUID(), assistantId = crypto.randomUUID(), scriptId = crypto.randomUUID()
  const clipIds = Array.from({ length: 8 }, () => crypto.randomUUID())
  const now = new Date().toISOString()
  let phase = 'script', status = 'running', count = 0, stopRequested = false, revision = 0
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.route('**/api/health', route => route.fulfill({ json: { storage: 'ready', agentConfigured: true, agent: 'configured' } }))
  await page.route(`**/api/projects/${project.id}`, route => route.fulfill({ json: {
    project, jobs: [], threadId: null,
    messages: [{ id: messageId, projectId: project.id, role: 'user', text: '制作40秒竖屏故事', assetIds: [], createdAt: now }, { id: assistantId, projectId: project.id, role: 'assistant', text: '分镜已确定', assetIds: [], createdAt: now }],
    runs: [{ id: runId, projectId: project.id, messageId, assistantId, status, stage: 'video', createdAt: now, input: { mode: 'auto', videoModel: 'minimax-h3', ratio: '9:16' }, assetId: status === 'completed' ? runId : undefined, processedAssetIds: clipIds.slice(0, count), story: { title: '迟到的明信片', scriptAssetId: scriptId, segments: clipIds.map((_, index) => ({ text: `镜头${index + 1}剧情`, prompt: 'fixture' })), clipIds, phase, segment: count + 1, stopRequested } }],
    assets: [...clipIds.slice(0, count), ...(status === 'completed' ? [runId] : [])].map((id, index) => ({ id, projectId: project.id, name: id === runId ? '完整故事.mp4' : `故事第${index + 1}段.mp4`, kind: 'generated', mediaType: 'video', model: 'minimax-h3', hasThumbnail: false, width: 576, height: 1024, duration: id === runId ? 41.4 : 5.17, bytes: 100, createdAt: now })),
  } }))
  await page.route(`**/api/agent-runs/${runId}/stop`, route => { stopRequested = true; return route.fulfill({ json: { status: 'running' } }) })
  const sync = async () => { await request.patch(`/api/projects/${project.id}`, { data: { title: `故事-${++revision}` } }) }
  await page.goto('/')
  const progress = page.getByRole('status', { name: '故事制作进度' })
  await expect(progress).toContainText('故事分镜已保存')
  await expect(page.getByText('镜头8剧情', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '下载故事分镜' })).toHaveAttribute('href', `/api/assets/${scriptId}/content?download=1`)
  count = 1; phase = 'rendering'; await sync()
  await expect(progress).toContainText('第 2 段视频生成中')
  await expect(page.locator('.narration-timeline .video-result')).toHaveCount(1)
  if (outcome === 'cancelled') {
    await page.getByRole('button', { name: '停止当前回复' }).click()
    await expect(progress).toContainText('正在停止后续步骤')
    await expect(page.getByRole('button', { name: '停止当前回复' })).toBeDisabled()
    status = 'cancelled'; phase = 'stopped'; await sync()
    await expect(progress).toContainText('后续步骤已停止')
  } else {
    count = 8; phase = 'stitching'; await sync()
    await expect(progress).toContainText('正在拼接整片')
    phase = 'completed'; await sync()
    await expect(progress).toContainText('整片已生成，正在入库')
    status = 'completed'; await sync()
    await expect(progress).toContainText('整片已保存')
  }
  await page.reload()
  await expect(progress).toContainText(`已保存 ${count} / 8 段`)
  await expect(page.getByRole('button', { name: '停止当前回复' })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('avatar entry only prepares conversation and never replaces an existing draft', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { title: '未配置数字人' } })).json()
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/')
  await page.getByRole('button', { name: '数字人口播', exact: true }).click()
  const draft = page.getByRole('textbox', { name: '创作需求' })
  await expect(draft).toBeFocused()
  await expect(draft).toHaveValue(/先确认文案/)
  await draft.fill('先讨论法律口播，不生成。')
  await page.getByRole('button', { name: '创作引导', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '数字人口播', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(draft).toHaveValue('先讨论法律口播，不生成。')
  const snapshot = await (await request.get(`/api/projects/${project.id}`)).json()
  expect(snapshot.messages).toHaveLength(0)
})

test('composer follows the iPhone keyboard visual viewport and its scroll offset', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: '键盘定位' } })).json()
  await page.addInitScript(projectId => {
    localStorage.setItem('qwen-project', projectId)
    const viewport = new EventTarget()
    Object.assign(viewport, { height: innerHeight, offsetTop: 0, scale: 1 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
  }, project.id)
  await page.goto('/')
  const input = page.getByRole('textbox', { name: '创作需求' })
  await input.fill('修改这张照片')
  for (const [height, offsetTop, event] of [[300, 120, 'resize'], [300, 40, 'scroll'], [280, 60, 'resize'], [568, 0, 'resize']] as const) {
    await page.evaluate(({ height, offsetTop, event }) => {
      Object.assign(window.visualViewport!, { height, offsetTop })
      window.visualViewport!.dispatchEvent(new Event(event))
    }, { height, offsetTop, event })
    await expect.poll(() => page.locator('.studio').evaluate(element => Math.round(element.getBoundingClientRect().top))).toBe(offsetTop)
    const bounds = await input.boundingBox()
    expect(bounds!.y).toBeGreaterThanOrEqual(offsetTop)
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(offsetTop + height)
    const send = await page.locator('.composer .send').boundingBox()
    expect(send!.y + send!.height).toBeLessThanOrEqual(offsetTop + height)
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('修改这张照片')
    if (offsetTop === 40) await page.screenshot({ path: testInfo.outputPath('keyboard-viewport.png') })
  }
})

async function openProjectPanel(page: Page, name: '素材库' | '任务记录') {
  if (await page.getByRole('dialog').count()) await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await page.getByRole('button', { name: name === '任务记录' ? /^任务记录/ : name, exact: name !== '任务记录' }).click()
  await expect(page.getByRole('dialog', { name, exact: true })).toBeVisible()
}

test('project deletion requires confirmation and removes the selected project', async ({ page, request }, testInfo) => {
  const title = `待删除-${testInfo.project.name}`
  const project = await (await request.post('/api/projects', { data: { title } })).json()
  await page.goto('/')
  await page.evaluate(id => localStorage.setItem('qwen-project', id), project.id)
  await page.reload()
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await expect(page.locator('.sidebar-bottom')).toHaveCount(0)
  await expect(page.getByText('研究工作空间', { exact: true })).toHaveCount(0)
  await expect(page.getByText('本地单用户', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: `删除项目 ${title}`, exact: true }).click()
  await expect(page.getByRole('dialog', { name: '删除项目？' })).toBeVisible()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  expect((await request.get(`/api/projects/${project.id}`)).status()).toBe(200)
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await page.getByRole('button', { name: `删除项目 ${title}`, exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('delete-project.png') })
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect((await request.get(`/api/projects/${project.id}`)).status()).toBe(404)
  await page.reload()
  await expect(page.getByRole('button', { name: `删除项目 ${title}`, exact: true })).toHaveCount(0)
})

test('VM configurations can be corrected, added and selected without stale confirmations', async ({ page }, testInfo) => {
  let catalog: VmProfiles = { revision: randomUUID(), canManage: true, profiles: [{ id: randomUUID(), label: 'Old GPU', subscription: randomUUID(), resourceGroup: 'example-gpu', name: 'deleted-vm', comfyUrl: 'http://10.30.0.4:8188' }] }
  const actions: string[] = []
  await page.route('**/api/vm/profiles', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON()
      expect(body.revision).toBe(catalog.revision)
      catalog = { ...catalog, revision: randomUUID(), profiles: [...catalog.profiles, { ...body.profile, id: randomUUID() }] }
    }
    await route.fulfill({ json: catalog })
  })
  await page.route('**/api/vm/profiles/*', async route => {
    const body = route.request().postDataJSON()
    expect(route.request().method()).toBe('PUT')
    expect(body.revision).toBe(catalog.revision)
    const id = route.request().url().split('/').at(-1)
    catalog = { ...catalog, revision: randomUUID(), profiles: catalog.profiles.map(profile => profile.id === id ? { ...body.profile, id } : profile) }
    await route.fulfill({ json: catalog })
  })
  await page.route('**/api/vm?*', async route => {
    const profile = catalog.profiles.find(item => item.id === new URL(route.request().url()).searchParams.get('profileId'))!
    await route.fulfill(profile.name === 'deleted-vm' ? { status: 503, json: { error: 'VM deleted-vm 不存在，请检查订阅、资源组和实例名称。' } } : { json: { configured: true, name: profile.name, powerState: 'deallocated', gpuReady: false } })
  })
  await page.route('**/api/vm/actions', async route => {
    const body = route.request().postDataJSON()
    expect(body.revision).toBe(catalog.revision)
    const target = catalog.profiles.find(profile => profile.id === body.profileId)!
    expect(body.confirmedName).toBe(target.name)
    actions.push(target.id)
    await route.fulfill({ status: 202, json: { configured: true, name: target.name, powerState: 'running', gpuReady: false } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'VM 管理', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'VM 管理' })
  await expect(panel.getByRole('alert')).toContainText('不存在')
  await expect(panel.locator('.vm-identity')).toContainText('deleted-vm')
  await panel.getByRole('button', { name: '编辑 VM 配置', exact: true }).click()
  await panel.getByLabel('配置名称', { exact: true }).fill('Corrected GPU')
  await panel.getByLabel('VM 名称', { exact: true }).fill('corrected-vm')
  await panel.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(panel.locator('.vm-identity')).toContainText('corrected-vm')
  await panel.getByRole('button', { name: '新增 VM 配置', exact: true }).click()
  await panel.getByLabel('配置名称', { exact: true }).fill('Second GPU with a long configuration label for small screens')
  await panel.getByLabel('订阅 ID', { exact: true }).fill(randomUUID())
  await panel.getByLabel('资源组', { exact: true }).fill('example-second-gpu-resource-group')
  await panel.getByLabel('VM 名称', { exact: true }).fill('second-gpu-with-a-long-instance-name')
  await panel.getByLabel('ComfyUI 私网地址', { exact: true }).fill('http://10.31.0.4:8188')
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('vm-config-form.png') })
  await panel.getByRole('button', { name: '保存配置', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'VM 配置' })).toHaveValue(catalog.profiles[1].id)
  await panel.getByRole('button', { name: '启动', exact: true }).click()
  await panel.getByRole('combobox', { name: 'VM 配置' }).selectOption(catalog.profiles[0].id)
  await expect(panel.getByRole('button', { name: '确认启动', exact: true })).toHaveCount(0)
  await panel.getByRole('button', { name: '启动', exact: true }).click()
  await panel.getByRole('button', { name: '确认启动', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('运行中')
  expect(actions).toEqual([catalog.profiles[0].id])
  await panel.getByRole('combobox', { name: 'VM 配置' }).selectOption(catalog.profiles[1].id)
  await page.reload()
  await page.getByRole('button', { name: 'VM 管理', exact: true }).click()
  await expect(panel.getByRole('combobox', { name: 'VM 配置' })).toHaveValue(catalog.profiles[1].id)
  await expect(panel.locator('.vm-identity')).toContainText('second-gpu-with-a-long-instance-name')
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('vm-config-selected.png') })
  await page.setViewportSize({ width: 1280, height: 800 })
  expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('vm-config-wide.png') })
})

test('VM configuration editing is hidden for ordinary users', async ({ page }) => {
  const profile = { id: randomUUID(), label: 'GPU', subscription: randomUUID(), resourceGroup: 'example-gpu', name: 'test-vm', comfyUrl: 'http://10.30.0.4:8188' }
  await page.route('**/api/vm/profiles', route => route.fulfill({ json: { revision: randomUUID(), profiles: [profile], canManage: false } }))
  await page.route('**/api/vm?*', route => route.fulfill({ json: { configured: true, name: profile.name, powerState: 'deallocated', gpuReady: false } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'VM 管理', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'VM 管理' })
  await expect(panel.getByRole('combobox', { name: 'VM 配置' })).toBeVisible()
  await expect(panel.getByRole('button', { name: '新增 VM 配置' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '编辑 VM 配置' })).toHaveCount(0)
  await expect(panel.getByRole('button', { name: '启动', exact: true })).toBeEnabled()
})

test('VM controls require explicit confirmation and show operation state', async ({ page }, testInfo) => {
  let actions = 0
  let power = 'deallocated'
  await page.route('**/api/vm', route => route.fulfill({ json: { configured: true, name: 'test-gpu', powerState: power, gpuReady: power === 'running' } }))
  await page.route('**/api/vm/actions', route => {
    const body = route.request().postDataJSON()
    expect(body.confirmedName).toBe('test-gpu')
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.action).toBe(actions === 0 ? 'start' : 'deallocate')
    actions++
    power = body.action === 'start' ? 'running' : 'deallocated'
    return route.fulfill({ status: 202, json: { configured: true, name: 'test-gpu', powerState: power, gpuReady: power === 'running', operation: { id: body.requestId, action: body.action, status: 'succeeded' } } })
  })
  await page.goto('/')
  const vmEntry = page.locator('.topbar').getByRole('button', { name: 'VM 管理', exact: true })
  await expect(vmEntry).toHaveText('')
  await expect(vmEntry).toHaveAttribute('title', 'VM 管理')
  await vmEntry.click()
  const panel = page.getByRole('dialog', { name: 'VM 管理' })
  await expect(panel.getByRole('status')).toContainText('计算计费已停止')
  await expect(panel.getByRole('button', { name: '重启', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('vm-stopped.png') })
  await panel.getByRole('button', { name: '启动', exact: true }).click()
  expect(actions).toBe(0)
  await expect(panel.getByText(/启动后按实际运行时间计费/)).toBeVisible()
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  expect(actions).toBe(0)
  await panel.getByRole('button', { name: '启动', exact: true }).click()
  await panel.getByRole('button', { name: '确认启动', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('运行中')
  await panel.getByRole('button', { name: '关闭并解除分配', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('vm-confirmation.png') })
  await panel.getByRole('button', { name: '确认关闭并解除分配', exact: true }).click()
  await expect(panel.getByRole('status')).toContainText('已解除分配')
  expect(actions).toBe(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('VM panel blocks uncertain operations and retains action errors on refresh', async ({ page }, testInfo) => {
  let operationStatus = 'pending'
  let powerState = 'starting'
  let reads = 0
  let actions = 0
  await page.route('**/api/vm', route => {
    reads++
    return route.fulfill({ json: { configured: true, name: 'test-gpu-with-a-long-instance-name', powerState, gpuReady: false, operation: { id: 'test-operation', action: 'start', status: operationStatus } } })
  })
  await page.route('**/api/vm/actions', route => {
    actions++
    return route.fulfill({ status: 409, json: { error: 'GPU 有运行或排队任务，不能关闭或重启。' } })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'VM 管理', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'VM 管理' })
  await expect(panel.getByText('启动 · 执行中', { exact: true })).toBeVisible()
  await expect(panel.locator('.vm-controls button:enabled')).toHaveCount(0)
  operationStatus = 'unknown'
  powerState = 'running'
  await panel.getByRole('button', { name: '刷新 VM 状态' }).click()
  await expect(panel.getByText(/结果待核实，禁止重复操作/)).toBeVisible()
  await expect(panel.locator('.vm-controls button:enabled')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('vm-unknown.png') })
  operationStatus = 'failed'
  await panel.getByRole('button', { name: '刷新 VM 状态' }).click()
  await expect(panel.getByText('启动 · 失败', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: '重启', exact: true }).click()
  await panel.getByRole('button', { name: '确认重启', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('GPU 有运行或排队任务')
  const previousReads = reads
  await panel.getByRole('button', { name: '刷新 VM 状态' }).click()
  await expect.poll(() => reads).toBeGreaterThan(previousReads)
  await expect(panel.getByRole('button', { name: '刷新 VM 状态' })).toBeEnabled()
  await expect(panel.getByRole('alert')).toContainText('GPU 有运行或排队任务')
  expect(actions).toBe(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('mixed uploads enter the library and chat submits only selected asset IDs', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: '多文件上传' } })).json()
  const submitted: { assetIds: string[]; text: string }[] = []
  await page.route('**/api/health', route => route.fulfill({ json: { storage: 'ready', agentConfigured: true, agent: 'configured', renderer: 'azure_image2', models: { images: ['azure-image2'], videos: [] } } }))
  await page.route(`**/api/projects/${project.id}/chat`, async route => {
    const body = route.request().postDataJSON()
    expect(Object.keys(body).sort()).toEqual(['requestId', 'text', 'assetIds', 'ratio', 'quality', 'mode', 'imageModel', 'videoModel'].sort())
    expect(JSON.stringify(body)).not.toContain('PRIVATE_FILE_CONTENT')
    submitted.push(body)
    const result = await request.post(`/api/projects/${project.id}/messages`, { data: { requestId: body.requestId, text: body.text, assetIds: body.assetIds, ratio: body.ratio } })
    expect(result.status()).toBe(202)
    await route.fulfill({ status: 202, json: await result.json() })
  })
  await page.goto('/')
  await page.evaluate(id => localStorage.setItem('qwen-project', id), project.id)
  await page.reload()
  const image = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#16785d' } }).png().toBuffer()
  const clip = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 64; canvas.height = 64
    const context = canvas.getContext('2d')!
    const stream = canvas.captureStream(24)
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' })
    const chunks: Blob[] = []
    const recording = new Promise<Blob>(resolve => {
      recorder.ondataavailable = event => chunks.push(event.data)
      recorder.onstop = () => resolve(new Blob(chunks))
    })
    recorder.start()
    for (let frame = 0; frame < 20; frame++) {
      context.fillStyle = frame % 2 ? '#16785d' : '#f4c943'
      context.fillRect(0, 0, 64, 64)
      await new Promise(requestAnimationFrame)
    }
    recorder.stop()
    const bytes = await (await recording).arrayBuffer()
    stream.getTracks().forEach(track => track.stop())
    return Array.from(new Uint8Array(bytes))
  }))
  const text = Buffer.from('PRIVATE_FILE_CONTENT')
  await page.locator('input[type=file]').setInputFiles([
    { name: '照片.png', mimeType: 'image/png', buffer: image },
    { name: '视频.webm', mimeType: 'video/webm', buffer: clip },
    { name: '资料.txt', mimeType: 'text/plain', buffer: text },
  ])
  await expect(page.getByRole('button', { name: '移除附件 资料.txt', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '上传文件', exact: true })).toBeEnabled()
  const snapshot = await (await request.get(`/api/projects/${project.id}`)).json()
  expect(snapshot.assets).toHaveLength(3)
  expect(submitted).toHaveLength(0)
  await page.getByRole('button', { name: '移除附件 资料.txt', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('mixed-attachments.png') })
  await page.getByRole('button', { name: '提交需求', exact: true }).click()
  await expect.poll(() => submitted.length).toBe(1)
  expect(submitted[0].text).toBe('已上传附件。')
  expect(submitted[0].assetIds).toEqual(snapshot.assets.filter((asset: { name: string }) => asset.name !== '资料.txt').map((asset: { id: string }) => asset.id))
  await expect(page.locator('.attachments')).toHaveCount(0)
  await expect(page.locator('.user-message')).toContainText('视频.webm')
  await openProjectPanel(page, '素材库')
  await expect(page.locator('.asset')).toHaveCount(3)
  await page.screenshot({ path: testInfo.outputPath('mixed-library.png') })
  await page.locator('.asset').filter({ hasText: '资料.txt' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: '下载文件', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('资料.txt')
  await page.getByRole('button', { name: '附加到对话', exact: true }).click()
  await page.getByLabel('创作需求').fill('已上传一份资料')
  await page.getByRole('button', { name: '提交需求', exact: true }).click()
  await expect.poll(() => submitted.length).toBe(2)
  expect(submitted[1].assetIds).toEqual([snapshot.assets.find((asset: { name: string }) => asset.name === '资料.txt').id])
  await expect(page.locator('.attachments')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.message-file')).toHaveCount(2)
  await page.locator('.message-file').filter({ hasText: '视频.webm' }).click()
  const video = page.getByRole('dialog').locator('video')
  await expect(video).toHaveAttribute('src', /\/api\/assets\/.+\/content$/)
  await video.evaluate(element => { const media = element as HTMLVideoElement; media.muted = true; return media.play() })
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
  expect(await video.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBe(64)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('PWA manifest, icons and network-only worker protect private content', async ({ page, context, request }) => {
  await page.goto('/')
  await expect(page).toHaveTitle('Codex Studio · 创作工作台')
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Codex Studio')
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest')
  const manifest = await (await request.get('/manifest.webmanifest')).json()
  expect(manifest.name).toBe('Codex Studio')
  expect(manifest.short_name).toBe('Codex Studio')
  expect(manifest.display).toBe('standalone')
  expect(manifest.start_url).toBe('/')
  for (const size of [180, 192, 512]) {
    expect(await page.evaluate(async iconSize => {
      const image = new Image()
      image.src = `/icons/icon-${iconSize}.png`
      await image.decode()
      return [image.naturalWidth, image.naturalHeight]
    }, size)).toEqual([size, size])
  }
  await page.evaluate(() => navigator.serviceWorker.ready)
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  expect(await page.evaluate(() => caches.keys())).toEqual([])
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByText('当前离线，请连接网络后重试。')).toBeVisible()
  expect(await page.evaluate(() => fetch('/api/projects').then(() => false).catch(() => true))).toBe(true)
  expect(await page.evaluate(() => caches.keys())).toEqual([])
  await context.setOffline(false)
  await page.getByRole('link', { name: '重新连接' }).click()
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
})

test('create, upload, submit, persist, cancel, reuse and download', async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await page.getByLabel('项目名称').fill(`测试工作台-${testInfo.project.name}`)
  await page.getByRole('button', { name: '保存项目' }).click()
  await expect(page.getByLabel('创作需求')).toBeEnabled()
  await expect(page.getByRole('status', { name: '已同步', exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true })
  await page.locator('input[type=file]').setInputFiles(resolve('public/reference-interior.jpg'))
  await expect(page.getByRole('button', { name: '移除附件 reference-interior.jpg' })).toBeVisible()
  await page.getByLabel('创作需求').fill('保留室内结构，增加窗边自然光。')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('默认比例').selectOption('4:3')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '提交需求' }).click()
  await expect(page.getByText('已保存 · 等待服务接入')).toBeVisible()
  await page.reload()
  await expect(page.getByText('保留室内结构，增加窗边自然光。', { exact: true })).toBeVisible()
  await expect(page.locator('.message')).toHaveCount(1)
  await openProjectPanel(page, '任务记录')
  await expect(page.locator('.task')).toHaveCount(1)
  await page.getByRole('button', { name: '取消任务' }).click()
  await expect(page.locator('.badge')).toHaveText('已取消')
  await page.getByRole('button', { name: '重新编辑需求' }).click()
  await expect(page.getByLabel('创作需求')).toHaveValue('保留室内结构，增加窗边自然光。')
  await openProjectPanel(page, '素材库')
  await expect(page.locator('.asset')).toHaveCount(1)
  await page.locator('.asset').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect.poll(() => page.locator('.zoom-content img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await page.getByRole('button', { name: '放大', exact: true }).click()
  await page.getByRole('button', { name: '重置缩放' }).click()
  const workspaceUrl = page.url()
  const imageDownload = page.getByRole('link', { name: '下载图片' })
  await expect(imageDownload).toHaveAttribute('download', '')
  await expect(imageDownload).toHaveAttribute('target', '_blank')
  await expect(imageDownload).toHaveAttribute('rel', 'noopener noreferrer')
  const download = page.waitForEvent('download')
  await imageDownload.click()
  expect((await download).suggestedFilename()).toMatch(/\.png$/)
  expect(page.url()).toBe(workspaceUrl)
  await expect(page.getByRole('dialog')).toBeVisible()
  await imageDownload.evaluate(element => element.removeAttribute('download'))
  await page.context().route('**/api/assets/*/content?download=1', async route => {
    const response = await route.fetch()
    const headers = { ...response.headers() }
    delete headers['content-disposition']
    await route.fulfill({ response, headers })
  })
  const opened = page.waitForEvent('popup')
  await imageDownload.click()
  const preview = await opened
  await preview.waitForLoadState()
  expect(preview.url()).toContain('/content?download=1')
  expect(await preview.evaluate(() => window.opener === null)).toBe(true)
  expect(page.url()).toBe(workspaceUrl)
  await expect(page.getByRole('dialog')).toBeVisible()
  await preview.close()
  await page.context().unroute('**/api/assets/*/content?download=1')
  await page.screenshot({ path: testInfo.outputPath('viewer.png'), fullPage: true })
  await page.getByRole('button', { name: '用作参考' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByLabel('创作需求')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(pageErrors).toEqual([])
})

test('resend selected message confirms truncation and preserves earlier conversation and draft', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: `重发-${testInfo.project.name}` } })).json()
  for (const text of ['保留的前文', '需要重发的消息', '应该清理的后文']) await request.post(`/api/projects/${project.id}/messages`, { data: { requestId: crypto.randomUUID(), text, assetIds: [], ratio: '1:1' } })
  await page.goto('/')
  await page.evaluate(id => localStorage.setItem('qwen-project', id), project.id)
  await page.reload()
  await expect(page.locator('.user-message')).toHaveCount(3)
  await page.getByLabel('创作需求').fill('还没有发送的草稿')
  const target = page.getByRole('article', { name: '你的消息' }).filter({ hasText: '需要重发的消息' })
  await target.getByRole('button', { name: '重新发送此消息' }).click()
  const confirmation = page.getByRole('dialog', { name: '重新发送这条消息？' })
  await expect(confirmation).toContainText('无法撤销')
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.user-message')).toHaveCount(3)
  await target.getByRole('button', { name: '重新发送此消息' }).click()
  await expect(confirmation.getByLabel('编辑重发消息')).toHaveValue('需要重发的消息')
  await confirmation.getByLabel('编辑重发消息').fill('修改后重新发送的消息')
  await page.screenshot({ path: testInfo.outputPath('resend-confirmation.png') })
  await confirmation.getByRole('button', { name: '清理并重新发送' }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(page.locator('.user-message')).toHaveCount(2)
  await expect(page.getByText('应该清理的后文', { exact: true })).toHaveCount(0)
  await expect(page.getByText('保留的前文', { exact: true })).toBeVisible()
  await expect(page.getByText('修改后重新发送的消息', { exact: true })).toBeVisible()
  await expect(page.getByLabel('创作需求')).toHaveValue('还没有发送的草稿')
  await page.reload()
  await expect(page.locator('.user-message')).toHaveCount(2)
  await expect(page.getByText('修改后重新发送的消息', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await openProjectPanel(page, '任务记录')
  await expect(page.locator('.task')).toHaveCount(2)
  await expect(page.getByText('应该清理的后文', { exact: true })).toHaveCount(0)
})

test('history loads ten messages at a time and preserves the scroll anchor', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: '分页测试' } })).json()
  for (let index = 0; index < 25; index++) await request.post(`/api/projects/${project.id}/messages`, { data: { requestId: randomUUID(), text: `历史消息 ${index}\n${'分页测试内容。'.repeat(15)}`, assetIds: [], ratio: '1:1' } })
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/')
  await expect(page.locator('.user-message')).toHaveCount(10)
  await page.getByLabel('创作需求').fill('新消息仍保留十条窗口')
  await page.getByRole('button', { name: '提交需求' }).click()
  await expect(page.locator('.message-text').filter({ hasText: '新消息仍保留十条窗口' })).toBeVisible()
  await expect(page.locator('.user-message')).toHaveCount(10)
  const scroll = page.locator('.conversation-scroll')
  const original = page.locator('.user-message').first()
  const text = await original.locator('.message-text').textContent()
  await scroll.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
  await expect(page.locator('.user-message')).toHaveCount(20)
  await expect.poll(() => scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(100)
  await expect(page.locator('.message-text').filter({ hasText: text! })).toHaveCount(1)
  await scroll.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
  await expect(page.locator('.user-message')).toHaveCount(26)
  await expect(page.getByRole('button', { name: '加载更早消息' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('history-mobile.png') })
  await page.setViewportSize({ width: 1280, height: 800 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('history-desktop.png') })
  await page.reload()
  await expect(page.locator('.user-message')).toHaveCount(10)
})

test('page boundary keeps an orphan assistant reply and loads process only when opened', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { title: '分页边界' } })).json()
  const now = new Date().toISOString()
  const runId = randomUUID(), assistantId = randomUUID(), hiddenUserId = randomUUID()
  const messages = [{ id: assistantId, projectId: project.id, role: 'assistant', text: '页首助手回复', assetIds: [], createdAt: now },
    ...Array.from({ length: 9 }, (_, index) => ({ id: randomUUID(), projectId: project.id, role: 'user', text: `后续消息 ${index}`, assetIds: [], createdAt: now }))]
  let processRequests = 0
  await page.route(`**/api/projects/${project.id}`, route => route.fulfill({ json: {
    project, messages, assets: [], jobs: [], threadId: null, page: { before: assistantId, tailId: messages.at(-1)!.id },
    runs: [{ id: runId, projectId: project.id, messageId: hiddenUserId, assistantId, status: 'completed', stage: 'codex', reply: '页首助手回复', input: { text: '尚未加载的用户消息' }, createdAt: now, updatedAt: now }],
  } }))
  await page.route(`**/api/agent-runs/${runId}/progress`, route => {
    processRequests++
    return route.fulfill({ json: [{ id: 'codex:raw', label: 'SDK event', detail: '{"event":"original"}', createdAt: now }] })
  })
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/')
  await expect(page.locator('.user-message')).toHaveCount(9)
  await expect(page.locator('.assistant-message')).toHaveCount(1)
  await expect(page.locator('.markdown-reply')).toHaveText('页首助手回复')
  expect(processRequests).toBe(0)
  await page.getByLabel('处理过程').click()
  await expect(page.locator('.run-progress pre')).toHaveText('{"event":"original"}')
  expect(processRequests).toBe(1)
  await page.getByLabel('处理过程').click()
  await expect(page.locator('.run-progress pre')).toHaveCount(0)
})

test('sample reference is real, uploaded explicitly, and not a generated result', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await page.getByLabel('项目名称').fill(`参考验证-${testInfo.project.name}`)
  await page.getByRole('button', { name: '保存项目' }).click()
  await page.getByRole('button', { name: '静物与光' }).click()
  await expect(page.getByLabel('创作需求')).toHaveValue(/参考这张图片/)
  await expect(page.getByRole('button', { name: '移除附件 静物与光.jpg' })).toBeVisible()
  await openProjectPanel(page, '素材库')
  await expect(page.locator('.asset')).toHaveCount(1)
  await expect.poll(() => page.locator('.asset img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0)
  await page.screenshot({ path: testInfo.outputPath('gallery.png'), fullPage: true })
  await openProjectPanel(page, '任务记录')
  await expect(page.getByRole('heading', { name: '暂无任务' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('remote changes sync and long titles fit a narrow screen', async ({ page, request }, testInfo) => {
  const created = await request.post('/api/projects', { data: { title: `同步测试-${testInfo.project.name}` } })
  const project = await created.json()
  await page.goto('/')
  await page.evaluate(id => localStorage.setItem('qwen-project', id), project.id)
  await page.reload()
  await expect(page.getByRole('status', { name: '已同步', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '重命名项目' }).click()
  await page.getByLabel('项目名称').fill('超长项目名称'.repeat(12))
  await page.getByRole('button', { name: '保存项目' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await request.post(`/api/projects/${project.id}/messages`, { data: { requestId: crypto.randomUUID(), text: '来自另一页面的需求', assetIds: [], ratio: '1:1' } })
  await expect(page.getByText('来自另一页面的需求', { exact: true })).toBeVisible()
  await page.setViewportSize({ width: 320, height: 740 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const headerFits = await page.evaluate(() => {
    const title = document.querySelector('.breadcrumb')!.getBoundingClientRect()
    const menu = document.querySelector('.topbar>.icon-button')!.getBoundingClientRect()
    return menu.right <= title.left && title.right <= window.innerWidth
  })
  expect(headerFits).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('narrow.png'), fullPage: true })
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await page.getByRole('button', { name: '服务未接入', exact: true }).click()
  await expect(page.getByText('SQLite 已连接', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.route('**/api/health', route => route.fulfill({ status: 503, json: { error: 'Offline' } }))
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await page.getByRole('button', { name: '服务未接入', exact: true }).click()
  await expect(page.getByText('连接失败', { exact: true })).toBeVisible()
})

test('phone navigation and composer remain reachable in reduced viewport height', async ({ page, request }, testInfo) => {
  const created = await request.post('/api/projects', { data: { title: '手机布局' } })
  const project = await created.json()
  await page.goto('/')
  await page.evaluate(id => localStorage.setItem('qwen-project', id), project.id)
  await page.reload()
  await expect(page.getByLabel('创作需求')).toBeEnabled()
  await expect(page.locator('.sidebar, .inspector')).toHaveCount(0)
  for (const size of [{ width: 320, height: 568 }, { width: 430, height: 932 }, { width: 390, height: 420 }]) {
    await page.setViewportSize(size)
    await page.getByLabel('创作需求').fill('手机输入测试')
    await expect.poll(() => page.evaluate(() => {
      const composer = document.querySelector('.composer')!.getBoundingClientRect()
      const send = document.querySelector('.send')!.getBoundingClientRect()
      const body = document.querySelector('.conversation-scroll')!.getBoundingClientRect()
      const header = document.querySelector('.topbar')!.getBoundingClientRect()
      return header.height <= 54 && header.bottom <= body.top && body.bottom <= composer.top && composer.bottom <= window.innerHeight && composer.height >= 110 && composer.height <= 125 && body.height >= window.innerHeight - 190 && send.height >= 44 && document.documentElement.scrollWidth <= window.innerWidth
    })).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('phone-reduced-height.png') })
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await page.getByLabel('项目名称').fill('小屏项目')
  await page.getByRole('button', { name: '保存项目' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Azure 2.5 and T4 model selection persists and detailed image errors remain visible', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: 'Azure 图片模型' } })).json()
  const models = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'qwen-image-2.1-t4', 'qwen-image-2.1-t4-turbo']
  const now = new Date().toISOString()
  const messageId = crypto.randomUUID()
  const assistantId = crypto.randomUUID()
  const detail = 'Azure image edit HTTP 400; code=invalid_request_error; param=size; message=Unsupported size; apim-request-id=request-123; no automatic retry'
  const submissions: string[] = []
  await page.route('**/api/health', route => route.fulfill({ json: { storage: 'ready', agentConfigured: true, agent: 'configured', renderer: 'azure_image2', models: { images: ['azure-image2', ...models], videos: [] } } }))
  await page.route(`**/api/projects/${project.id}`, route => route.fulfill({ json: {
    project, threadId: null, jobs: [], assets: [],
    messages: [{ id: messageId, projectId: project.id, text: '修改图片', assetIds: [], role: 'user', createdAt: now }, { id: assistantId, projectId: project.id, text: '正在修改', assetIds: [], role: 'assistant', createdAt: now }],
    runs: [{ id: crypto.randomUUID(), projectId: project.id, messageId, assistantId, status: 'failed', stage: 'image', reply: '正在修改', error: detail, createdAt: now, input: { text: '修改图片', mode: 'auto', ratio: '1:1', imageModel: models[0] } }],
  } }))
  await page.route(`**/api/projects/${project.id}/chat`, async route => {
    submissions.push(route.request().postDataJSON().imageModel)
    await route.fulfill({ status: 202, json: { id: crypto.randomUUID() } })
  })
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/')
  await expect(page.getByText(detail, { exact: true }).first()).toBeVisible()
  for (const imageModel of models) {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const select = page.getByLabel('图片模型')
    await expect(select.locator('option')).toHaveCount(6)
    await expect(select.locator('option[value="qwen-image-2.1"]')).toHaveJSProperty('disabled', true)
    await select.selectOption(imageModel)
    await page.screenshot({ path: testInfo.outputPath(`${imageModel}-mobile.png`) })
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByLabel('创作需求').fill('修改图片颜色')
    await page.getByRole('button', { name: '提交需求', exact: true }).click()
    await expect(page.getByLabel('创作需求')).toHaveValue('')
    expect(submissions.at(-1)).toBe(imageModel)
    await page.reload()
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await expect(page.getByLabel('图片模型')).toHaveValue(imageModel)
    await page.getByRole('button', { name: '关闭', exact: true }).click()
  }
  expect(submissions).toEqual(models)
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.screenshot({ path: testInfo.outputPath('image-models-desktop.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('composer sends with Enter and inserts a newline with Control Enter without sending IME input', async ({ page, request }) => {
  const project = await (await request.post('/api/projects', { data: { title: '消息键盘操作' } })).json()
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/')
  const input = page.getByRole('textbox', { name: '创作需求', exact: true })
  const submissions: string[] = []
  page.on('request', outgoing => {
    if (outgoing.method() === 'POST' && outgoing.url().endsWith(`/projects/${project.id}/messages`)) submissions.push(outgoing.postDataJSON().text)
  })
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await input.fill('第一行第二行')
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(3, 3))
  await input.press('Control+Enter')
  await expect(input).toHaveValue('第一行\n第二行')
  expect(await input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(4)
  await input.evaluate(element => {
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, keyCode: 229 }))
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, repeat: true }))
  })
  await expect(input).toHaveValue('第一行\n第二行')
  expect(submissions).toEqual([])
  const sent = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/projects/${project.id}/messages`))
  await input.press('Enter')
  expect((await sent).ok()).toBe(true)
  await expect(input).toHaveValue('')
  expect(submissions).toEqual(['第一行\n第二行'])
  await input.fill('字'.repeat(6000))
  await input.press('Control+Enter')
  await expect(input).toHaveValue('字'.repeat(6000))
  await input.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, 2))
  await input.press('Control+Enter')
  await expect(input).toHaveValue(`\n${'字'.repeat(5998)}`)
  expect(submissions).toHaveLength(1)
})

test('image frames remain visible while downloading and after failure', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: '图片加载边框' } })).json()
  const now = new Date().toISOString()
  const imageId = crypto.randomUUID()
  const failedId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  const assistantId = crypto.randomUUID()
  let releaseImage!: () => void
  const imageReady = new Promise<void>(resolve => { releaseImage = resolve })
  await page.route(`**/api/projects/${project.id}`, route => route.fulfill({ json: {
    project, threadId: null, jobs: [],
    messages: [
      { id: messageId, projectId: project.id, text: '图片参考', assetIds: [failedId], createdAt: now, role: 'user' },
      { id: assistantId, projectId: project.id, text: '图片已生成', assetIds: [imageId], createdAt: now, role: 'assistant' },
    ],
    assets: [imageId, failedId].map(id => ({ id, projectId: project.id, name: `${id}.png`, width: 640, height: 480, kind: 'generated' })),
    runs: [{ id: imageId, projectId: project.id, messageId, assistantId, status: 'completed', stage: 'image', reply: '图片已生成', createdAt: now, input: { text: '图片参考', mode: 'auto', ratio: '1:1' } }],
  } }))
  await page.route(`**/api/assets/${imageId}/content*`, async route => {
    await imageReady
    await route.fulfill({ path: resolve('public/reference-interior.jpg'), contentType: 'image/jpeg' })
  })
  await page.route(`**/api/assets/${failedId}/content*`, route => route.abort())
  await page.addInitScript(id => localStorage.setItem('qwen-project', id), project.id)
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  try {
    const frame = page.locator('.assistant-message .asset-image-frame')
    await expect(frame.getByRole('status', { name: '图片加载中' })).toBeVisible()
    await expect(page.locator('.user-message').getByRole('status', { name: '图片加载失败' })).toBeVisible()
    await expect(frame).toHaveCSS('border-top-width', '1px')
    const before = await frame.boundingBox()
    expect(before!.height).toBeGreaterThan(100)
    await page.screenshot({ path: testInfo.outputPath('image-loading-mobile.png') })
    await frame.click()
    const viewer = page.getByRole('dialog')
    await expect(viewer.getByRole('status', { name: '图片加载中' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('image-viewer-loading.png') })
    releaseImage()
    await expect(viewer.locator('.asset-image-frame')).toHaveAttribute('data-state', 'loaded')
    await expect(viewer.getByRole('img')).toBeVisible()
    await viewer.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(frame).toHaveAttribute('data-state', 'loaded')
    await expect(frame.getByRole('status')).toHaveCount(0)
    expect((await frame.boundingBox())!.height).toBeCloseTo(before!.height, 0)
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.screenshot({ path: testInfo.outputPath('image-loaded-desktop.png') })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally { releaseImage() }
})

test('image loading stays visible after reply, resend sits inside bubble, and replies can be copied', async ({ page, context, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: '生成状态测试' } })).json()
  const now = new Date().toISOString()
  const runId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  const assistantId = crypto.randomUUID()
  let status = 'running'
  let stage = 'image'
  let showReply = true
  const replyText = '正在为你生成图片。\n保留这段回复的换行。'
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.route(`**/api/projects/${project.id}`, route => route.fulfill({ json: {
    project, threadId: null, jobs: [],
    messages: [{ id: messageId, projectId: project.id, text: '请生成图片', assetIds: [], createdAt: now, role: 'user' }, ...(showReply ? [{ id: assistantId, projectId: project.id, text: replyText, assetIds: status === 'completed' ? [runId] : [], createdAt: now, role: 'assistant' }] : [])],
    assets: status === 'completed' ? [{ id: runId, projectId: project.id, name: 'test.png', width: 1024, height: 1024, kind: 'generated' }] : [],
    runs: [{ id: runId, projectId: project.id, messageId, assistantId, status, stage, reply: showReply ? replyText : '', createdAt: now, input: { text: '请生成图片', mode: 'auto', ratio: '1:1' } }],
  } }))
  await page.route(`**/api/assets/${runId}/content*`, route => route.fulfill({ path: resolve('public/reference-interior.jpg'), contentType: 'image/jpeg' }))
  await page.goto('/')
  await page.evaluate(id => localStorage.setItem('qwen-project', id), project.id)
  await page.reload()
  const assistant = page.getByRole('article', { name: 'Codex 回复' })
  const pending = page.getByRole('status', { name: '图片生成中' })
  await expect(assistant.getByRole('status', { name: '图片生成中' })).toBeVisible()
  await expect(assistant.locator('.run-progress')).toHaveCount(1)
  await expect(page.locator('.user-message .run-progress')).toHaveCount(0)
  await expect(page.locator('.user-message .message-actions time')).toHaveCount(1)
  await expect(page.locator('.run-progress')).not.toHaveAttribute('open')
  await expect(pending.locator('.spin')).toBeVisible()
  await expect(page.getByRole('status', { name: '当前图片任务' })).toBeInViewport()
  const resend = page.getByRole('button', { name: '重新发送此消息' })
  expect(await resend.evaluate(button => {
    const bubble = button.closest('.message-content')!.getBoundingClientRect()
    const bounds = button.getBoundingClientRect()
    const text = button.closest('.message-content')!.querySelector('.message-text')!.getBoundingClientRect()
    return bounds.top >= text.bottom && bounds.right <= bubble.right && bubble.right - bounds.right <= 14 && bounds.bottom <= bubble.bottom && bubble.bottom - bounds.bottom <= 6 && bounds.width >= 44
  })).toBe(true)
  expect(await assistant.locator('.reply-actions').evaluate(footer => {
    const bounds = footer.getBoundingClientRect()
    const timestamp = footer.querySelector('time')!.getBoundingClientRect()
    const button = footer.querySelector('button')!.getBoundingClientRect()
    return timestamp.left === bounds.left && timestamp.right <= button.left && button.right === bounds.right && button.bottom === bounds.bottom && button.width >= 44 && button.height >= 44
  })).toBe(true)
  await expect(assistant.locator('.reply-actions time')).toHaveAttribute('datetime', now)
  await assistant.getByRole('button', { name: '复制回复', exact: true }).click()
  await expect(assistant.getByRole('button', { name: '已复制回复' })).toBeVisible()
  expect((await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n')).toBe(replyText)
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Permission denied') } })
  await assistant.getByRole('button', { name: '已复制回复' }).click()
  await expect(assistant.getByText('复制失败，请重试或长按选择文字')).toBeVisible()
  await pending.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('image-pending-actions.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 420 })
  await page.getByLabel('创作需求').fill('多行草稿\n'.repeat(8))
  await expect(page.getByRole('status', { name: '当前图片任务' })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('image-pending-keyboard.png'), fullPage: true })
  await page.setViewportSize(testInfo.project.use.viewport!)
  await page.reload()
  await expect(pending).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  const sync = async () => { await request.patch(`/api/projects/${project.id}`, { data: { title: `状态-${status}-${showReply}-${stage}` } }) }
  for (const terminal of ['failed', 'cancelled', 'interrupted']) {
    status = terminal
    await sync()
    await expect(pending).toHaveCount(0)
    await expect(page.getByRole('status', { name: '当前图片任务' })).toHaveCount(0)
    await expect(assistant.locator('.image-outcome')).toHaveText({ failed: '图片生成失败', cancelled: '图片生成已停止', interrupted: '图片生成结果待核实' }[terminal]!)
  }
  status = 'running'; showReply = false
  await sync()
  await expect(pending).toBeVisible()
  await expect(assistant).toHaveCount(1)
  await expect(assistant.getByRole('button', { name: '复制回复' })).toHaveCount(0)
  showReply = true; stage = 'codex'
  await sync()
  await expect(assistant).toBeVisible()
  await expect(pending).toHaveCount(0)
  stage = 'image'
  await sync()
  await expect(assistant.getByRole('status', { name: '图片生成中' })).toBeVisible()
  status = 'completed'
  await sync()
  await expect(pending).toHaveCount(0)
  await expect(assistant.locator('img')).toBeVisible()
  await expect(assistant.locator('.image-outcome')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('image-completed-actions.png'), fullPage: true })
})

test('video results use playback and download controls instead of image zoom', async ({ page, request }, testInfo) => {
  await mockFileSharing(page)
  const project = await (await request.post('/api/projects', { data: { title: '视频展示回归' } })).json()
  const assetId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  const assistantId = crypto.randomUUID()
  const now = new Date().toISOString()
  await page.route(`**/api/projects/${project.id}`, route => route.fulfill({ json: {
    project, threadId: null, jobs: [],
    runs: [{ id: assetId, projectId: project.id, messageId, assistantId, status: 'completed', stage: 'video', createdAt: now, input: { text: '视频测试', mode: 'auto', ratio: '3:2', videoModel: 'minimax-h3' } }],
    messages: [{ id: messageId, projectId: project.id, role: 'user', text: '视频测试', assetIds: [], createdAt: now }, { id: assistantId, projectId: project.id, role: 'assistant', text: '视频测试夹具', assetIds: [assetId], createdAt: now }],
    assets: [{ id: assetId, projectId: project.id, name: 'fixture.mp4', kind: 'generated', mediaType: 'video', provider: 'comfyui', model: 'minimax-h3', width: 832, height: 480, duration: 124 / 24, fps: 24 }],
  } }))
  await page.route(`**/api/assets/${assetId}/content*`, route => route.request().url().includes('thumbnail=1')
    ? route.fulfill({ path: resolve('public/reference-interior.jpg'), contentType: 'image/jpeg' })
    : route.fulfill({ body: Buffer.from('video-share-fixture'), contentType: 'video/mp4' }))
  await page.goto('/')
  await page.evaluate(id => localStorage.setItem('qwen-project', id), project.id)
  await page.reload()
  await expect(page.locator('video')).toBeVisible()
  await expect(page.locator('video')).toHaveAttribute('controls', '')
  await expect(page.locator('video')).toHaveAttribute('playsinline', '')
  await expect(page.getByRole('link', { name: '下载视频' })).toHaveAttribute('href', `/api/assets/${assetId}/content?download=1`)
  await expect(page.getByText('MiniMax H3 · 5.17 秒')).toBeVisible()
  await page.getByRole('button', { name: '转发', exact: true }).click()
  await page.getByRole('button', { name: '选择转发应用', exact: true }).click()
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'sharedFiles'))).toEqual({ files: [{ name: 'fixture.mp4', type: 'video/mp4', bytes: Array.from(Buffer.from('video-share-fixture')) }], activated: true, keys: ['files'] })
  await openProjectPanel(page, '素材库')
  await page.locator('.asset').click()
  await expect(page.getByRole('dialog').locator('video')).toBeVisible()
  await expect(page.getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '用作参考' })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('video-viewer.png') })
  await page.getByRole('dialog').getByRole('button', { name: '转发', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('button', { name: '选择转发应用', exact: true })).toBeVisible()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
})

test('application login switches private users and provides admin account controls', async ({ page }, testInfo) => {
  let signedIn = false
  const user = { id: 'fixture-admin', name: '测试管理员', provider: 'entra', admin: true }
  const accounts: { id: string; name: string; username: string }[] = []
  await page.route('**/api/auth/session', route => route.fulfill({ json: { enabled: true, entra: true, user: signedIn ? user : null, csrf: signedIn ? 'test-csrf' : null } }))
  await page.route('**/api/auth/login', async route => {
    expect(route.request().postDataJSON()).toEqual({ username: 'test-admin', password: 'test-only-password' })
    signedIn = true
    await route.fulfill({ json: { user, csrf: 'test-csrf' } })
  })
  await page.route('**/api/auth/logout', async route => {
    expect(route.request().headers()['x-csrf-token']).toBe('test-csrf')
    signedIn = false
    await route.fulfill({ json: { signedOut: true } })
  })
  await page.route('**/api/projects', route => route.fulfill({ json: [] }))
  await page.route('**/api/auth/users', async route => {
    if (route.request().method() === 'POST') {
      expect(route.request().headers()['x-csrf-token']).toBe('test-csrf')
      const body = route.request().postDataJSON()
      expect(body.password).toBe('test-account-password')
      accounts.push({ id: 'new-local', name: body.name, username: body.username })
      await route.fulfill({ json: accounts[0] })
    } else await route.fulfill({ json: accounts })
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '使用 Microsoft Entra ID 登录' })).toHaveAttribute('href', '/api/auth/entra')
  await expect(page.getByLabel('密码', { exact: true })).toHaveAttribute('type', 'password')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('application-login.png') })
  await page.getByLabel('账号', { exact: true }).fill('test-admin')
  await page.getByLabel('密码', { exact: true }).fill('test-only-password')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.locator('.studio')).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByText('测试管理员', { exact: true })).toBeVisible()
  await page.locator('.local-accounts summary').click()
  await page.getByLabel('账号', { exact: true }).fill('new-local')
  await page.getByLabel('显示名称').fill('新用户')
  await page.getByLabel('新密码').fill('test-account-password')
  await page.getByRole('button', { name: '创建账号', exact: true }).click()
  await expect(page.getByText('账号已保存')).toBeVisible()
  await expect(page.getByLabel('新密码')).toHaveValue('')
  expect(await page.locator('.modal').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await expect(page.locator('.studio')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible()
  await expect(page.getByText('测试管理员', { exact: true })).toHaveCount(0)
})

test('configured chat displays assistant, Azure assets and run history', async ({ page, request }, testInfo) => {
  const project = await (await request.post('/api/projects', { data: { title: '会话界面测试' } })).json()
  const now = new Date().toISOString()
  const runId = crypto.randomUUID()
  const messageId = crypto.randomUUID()
  const assistantId = crypto.randomUUID()
  const threadId = crypto.randomUUID()
  let submitted = false
  const expectedMode = 'auto'
  let expectedRatio = '1:1'
  let expectedImageModel = 'azure-image2'
  let expectedQuality = 'low'
  let expectedVideoModel = 'none'
  let submitCount = 0
  let runStatus = 'completed'
  const markdownReply = ['测试夹具中的助手回复', '', '## 输出方案', '', '**重点**与 *说明* 和 `inline_code`。', '', '1. 第一项', '2. 第二项', '   - 子项', '', '> 保留原图', '', '- [x] 已完成', '- [ ] 待确认', '', '| 尺寸 | 格式 | 用途 | 备注 |', '| --- | --- | --- | --- |', '| 1536 | PNG | 下载 | 原图不变 |', '', '```js', `const example = "${'long-code-'.repeat(25)}"`, '```', '', '[官方文档](https://example.com/docs)', '', '[危险链接](javascript:alert%281%29)', '', '<script>window.markdownInjected = true</script>', '', '![外部图片](https://example.com/private-tracker.png)'].join('\n')
  const progress = [{ id: 'reasoning:1', label: 'Codex 推理摘要', detail: '这是测试夹具的公开摘要。', createdAt: now }]
  const rawEvent = JSON.stringify({ type: 'item.completed', item: { id: 'tool-1', type: 'mcp_tool_call', arguments: { assetId: 'fixture' }, result: { content: [{ type: 'text', text: `${'original-text\n'.repeat(550)}UNTRUNCATED-END` }] } } }, null, 2)
  progress.push({ id: 'codex:1', label: 'item.completed', detail: rawEvent, createdAt: now })
  await page.route('**/api/health', route => route.fulfill({ json: { storage: 'ready', agentConfigured: true, agent: 'configured', renderer: 'azure_image2', openmontage: 'installed', models: { images: ['azure-image2', 'qwen-image-2.1'], videos: ['minimax-h3'] } } }))
  await page.route(`**/api/projects/${project.id}`, route => route.fulfill({ json: { project, threadId, jobs: [],
    messages: submitted ? [{ id: messageId, projectId: project.id, text: '手机对话测试', assetIds: [], createdAt: now, role: 'user' },
      { id: assistantId, projectId: project.id, text: markdownReply, assetIds: [runId], createdAt: now, role: 'assistant' }] : [],
    assets: submitted ? [{ id: runId, projectId: project.id, name: 'Azure-test.png', kind: 'generated', provider: 'azure', model: 'gpt-image-2', width: 1024, height: 1024 }] : [],
    runs: submitted ? [{ id: runId, projectId: project.id, messageId, assistantId, threadId, status: runStatus, stage: 'image', reply: '测试夹具中的助手回复', createdAt: now,
      input: { mode: 'image', text: '手机对话测试', ratio: '1:1' }, progress }] : [],
  } }))
  await page.route(`**/api/assets/${runId}/content*`, route => route.fulfill({ path: resolve('public/reference-interior.jpg'), contentType: 'image/jpeg' }))
  await page.route(`**/api/projects/${project.id}/chat`, async route => {
    const body = route.request().postDataJSON()
    expect(body.mode).toBe(expectedMode)
    expect(body.ratio).toBe(expectedRatio)
    expect(body.imageModel).toBe(expectedImageModel)
    expect(body.quality).toBe(expectedQuality)
    expect(body.videoModel).toBe(expectedVideoModel)
    expect(body.assetIds).toEqual([])
    submitted = true
    submitCount += 1
    await route.fulfill({ status: 202, json: { id: runId } })
  })
  await page.goto('/')
  await page.evaluate(id => localStorage.setItem('qwen-project', id), project.id)
  await page.reload()
  await expect(page.getByRole('group', { name: '创作模式' })).toHaveCount(0)
  await expect(page.locator('.topbar').getByRole('button', { name: '设置', exact: true })).toBeVisible()
  expect(await page.locator('.send').evaluate(element => getComputedStyle(element, '::before').width)).toBe('32px')
  await page.getByLabel('创作需求').fill('手机对话测试')
  await page.getByRole('button', { name: '提交需求' }).click()
  await expect(page.locator('.assistant-message')).toContainText('测试夹具中的助手回复')
  const markdown = page.locator('.markdown-reply')
  await expect(markdown.getByRole('heading', { name: '输出方案', level: 2 })).toBeVisible()
  await expect(markdown.locator('strong')).toHaveText('重点')
  await expect(markdown.locator('em')).toHaveText('说明')
  await expect(markdown.locator('ol > li')).toHaveCount(2)
  await expect(markdown.locator('ol ul > li')).toHaveText('子项')
  await expect(markdown.locator('blockquote')).toHaveText('保留原图')
  await expect(markdown.getByRole('checkbox').first()).toBeChecked()
  await expect(markdown.getByRole('checkbox').first()).toBeDisabled()
  await expect(markdown.locator('pre code')).toContainText('const example')
  await expect(markdown.getByRole('table')).toHaveCount(1)
  await expect(markdown.getByRole('link', { name: '官方文档' })).toHaveAttribute('rel', 'noopener noreferrer')
  await expect(markdown.getByRole('link', { name: '危险链接' })).toHaveCount(0)
  await expect(markdown.locator('script, img')).toHaveCount(0)
  expect(await markdown.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await markdown.screenshot({ path: testInfo.outputPath('markdown-reply.png') })
  await expect(page.getByRole('article', { name: '你的消息' })).toBeVisible()
  expect(await page.locator('.messages').evaluate(element => {
    const user = element.querySelector('.user-message')!.getBoundingClientRect()
    const assistant = element.querySelector('.assistant-message')!.getBoundingClientRect()
    const image = element.querySelector('.assistant-message img')!.getBoundingClientRect()
    return user.left > assistant.left && Math.abs(user.right - assistant.right) < 2 && image.width > 200 && image.right <= assistant.right
  })).toBe(true)
  const process = page.locator('.run-progress')
  await expect(process).not.toHaveAttribute('open')
  await expect(process.locator('pre')).not.toBeVisible()
  await expect(process.getByText('这是测试夹具的公开摘要。')).not.toBeVisible()
  await process.locator('summary').click()
  await expect(process.getByText('这是测试夹具的公开摘要。')).toBeVisible()
  expect(await process.locator('pre').textContent()).toBe(rawEvent)
  await expect(process.locator('pre')).toContainText('UNTRUNCATED-END')
  progress.push({ id: 'image-start', label: 'OpenMontage 正在调用 Azure image2', detail: 'long-detail-'.repeat(40), createdAt: now })
  await request.patch(`/api/projects/${project.id}`, { data: { title: '过程更新测试' } })
  await expect(process.getByText('OpenMontage 正在调用 Azure image2')).toBeVisible()
  await expect(process).toHaveAttribute('open', '')
  expect(await process.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('process-expanded.png') })
  await page.reload()
  await expect(page.locator('.assistant-message')).toBeVisible()
  await expect(process).not.toHaveAttribute('open')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByText(`会话 ${threadId.slice(-8)}`)).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '项目视图' })).toHaveCount(0)
  await page.getByLabel('创作需求').fill('查看素材时保留草稿')
  await openProjectPanel(page, '素材库')
  await expect(page.getByText(/^azure 生成$/i)).toBeVisible()
  await page.locator('.asset').click()
  await expect(page.getByText(/azure \/ gpt-image-2/)).toBeVisible()
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByLabel('创作需求')).toHaveValue('查看素材时保留草稿')
  await openProjectPanel(page, '任务记录')
  await expect(page.locator('.agent-task')).toContainText('已完成')
  await expect(page.getByRole('heading', { name: '暂无任务' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('agent-runs.png') })
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByLabel('创作需求')).toHaveValue('查看素材时保留草稿')
  await page.getByLabel('创作需求').fill('请生成一张透明玻璃杯的图片')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('默认比例').selectOption('2:3')
  await expect(page.getByLabel('默认质量')).toHaveValue('low')
  await expect(page.locator('.image-cost')).toHaveCount(0)
  await expect(page.getByText('视频模型未启用', { exact: true })).toHaveCount(0)
  await page.getByLabel('默认质量').selectOption('high')
  expectedQuality = 'high'
  await page.getByLabel('图片模型').selectOption('qwen-image-2.1')
  await page.getByLabel('视频模型').selectOption('minimax-h3')
  await expect(page.getByLabel('图片模型')).toHaveValue('qwen-image-2.1')
  await page.screenshot({ path: testInfo.outputPath('model-options.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expectedImageModel = 'qwen-image-2.1'
  expectedVideoModel = 'minimax-h3'
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByLabel('创作需求')).toHaveValue('请生成一张透明玻璃杯的图片')
  expectedRatio = '2:3'
  await page.getByRole('button', { name: '提交需求' }).click()
  await expect.poll(() => submitCount).toBe(2)
  await expect(page.getByLabel('创作需求')).toHaveValue('')
  await page.reload()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByLabel('图片模型')).toHaveValue('qwen-image-2.1')
  await expect(page.getByLabel('默认比例')).toHaveValue('2:3')
  await expect(page.getByLabel('默认质量')).toHaveValue('high')
  await expect(page.getByLabel('视频模型')).toHaveValue('minimax-h3')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  runStatus = 'running'
  await request.patch(`/api/projects/${project.id}`, { data: { title: '运行中输入区测试' } })
  await expect(page.getByRole('button', { name: '停止当前回复' })).toBeVisible()
  await expect(page.getByRole('button', { name: '停止当前回复' })).toHaveCSS('color', 'rgb(181, 46, 53)')
  await expect(page.getByRole('button', { name: '停止当前回复' }).locator('svg')).toHaveCSS('fill', 'rgb(181, 46, 53)')
  for (const size of [{ width: 320, height: 568 }, { width: 390, height: 420 }]) {
    await page.setViewportSize(size)
    await page.getByLabel('创作需求').fill('较长的图片需求，需要保留编辑空间。\n'.repeat(10))
    await expect.poll(() => page.evaluate(() => {
      const composer = document.querySelector('.composer')!.getBoundingClientRect()
      const body = document.querySelector('.conversation-scroll')!.getBoundingClientRect()
      const attachment = document.querySelector('[aria-label="上传文件"]')!.getBoundingClientRect()
      const stop = document.querySelector('[aria-label="停止当前回复"]')!.getBoundingClientRect()
      const send = document.querySelector('.send')!.getBoundingClientRect()
      return body.height >= window.innerHeight - 260 && body.bottom <= composer.top && composer.bottom <= window.innerHeight && attachment.right <= stop.left && stop.right <= send.left && send.right <= composer.right && stop.height >= 44 && document.documentElement.scrollWidth <= window.innerWidth
    })).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('creation-modes-running.png') })
  await page.getByLabel('创作需求').fill('')
  await expect.poll(() => page.getByLabel('创作需求').evaluate(element => element.getBoundingClientRect().height)).toBe(60)
})