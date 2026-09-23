import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { resolve } from 'node:path'
import sharp from 'sharp'

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
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: '下载图片' }).click()
  expect((await download).suggestedFilename()).toMatch(/\.png$/)
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
  await page.screenshot({ path: testInfo.outputPath('resend-confirmation.png') })
  await confirmation.getByRole('button', { name: '清理并重新发送' }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(page.locator('.user-message')).toHaveCount(2)
  await expect(page.getByText('应该清理的后文', { exact: true })).toHaveCount(0)
  await expect(page.getByText('保留的前文', { exact: true })).toBeVisible()
  await expect(page.getByLabel('创作需求')).toHaveValue('还没有发送的草稿')
  await page.reload()
  await expect(page.locator('.user-message')).toHaveCount(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await openProjectPanel(page, '任务记录')
  await expect(page.locator('.task')).toHaveCount(2)
  await expect(page.getByText('应该清理的后文', { exact: true })).toHaveCount(0)
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
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(replyText)
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
    : route.fulfill({ status: 204 }))
  await page.goto('/')
  await page.evaluate(id => localStorage.setItem('qwen-project', id), project.id)
  await page.reload()
  await expect(page.locator('video')).toBeVisible()
  await expect(page.locator('video')).toHaveAttribute('controls', '')
  await expect(page.locator('video')).toHaveAttribute('playsinline', '')
  await expect(page.getByRole('link', { name: '下载视频' })).toHaveAttribute('href', `/api/assets/${assetId}/content?download=1`)
  await expect(page.getByText('MiniMax H3 · 5.17 秒')).toBeVisible()
  await openProjectPanel(page, '素材库')
  await page.locator('.asset').click()
  await expect(page.getByRole('dialog').locator('video')).toBeVisible()
  await expect(page.getByRole('button', { name: '放大', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '用作参考' })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('video-viewer.png') })
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