import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { resolve } from 'node:path'

async function openProjectPanel(page: Page, name: '素材库' | '任务记录') {
  if (await page.getByRole('dialog').count()) await page.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '项目列表', exact: true }).click()
  await page.getByRole('button', { name: name === '任务记录' ? /^任务记录/ : name, exact: name !== '任务记录' }).click()
  await expect(page.getByRole('dialog', { name, exact: true })).toBeVisible()
}

test('PWA manifest, icons and network-only worker protect private content', async ({ page, context, request }) => {
  await page.goto('/')
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest')
  const manifest = await (await request.get('/manifest.webmanifest')).json()
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
  await expect(page.getByRole('button', { name: '移除参考图 reference-interior.jpg' })).toBeVisible()
  await page.getByLabel('创作需求').fill('保留室内结构，增加窗边自然光。')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('图片比例').selectOption('4:3')
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
  await expect(page.getByRole('button', { name: '移除参考图 静物与光.jpg' })).toBeVisible()
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
  let submitCount = 0
  let runStatus = 'completed'
  const progress = [{ id: 'reasoning:1', label: 'Codex 推理摘要', detail: '这是测试夹具的公开摘要。', createdAt: now }]
  await page.route('**/api/health', route => route.fulfill({ json: { storage: 'ready', agentConfigured: true, agent: 'configured', renderer: 'azure_image2', openmontage: 'installed' } }))
  await page.route(`**/api/projects/${project.id}`, route => route.fulfill({ json: { project, threadId, jobs: [],
    messages: submitted ? [{ id: messageId, projectId: project.id, text: '手机对话测试', assetIds: [], createdAt: now, role: 'user' },
      { id: assistantId, projectId: project.id, text: '测试夹具中的助手回复', assetIds: [runId], createdAt: now, role: 'assistant' }] : [],
    assets: submitted ? [{ id: runId, projectId: project.id, name: 'Azure-test.png', kind: 'generated', provider: 'azure', model: 'gpt-image-2', width: 1024, height: 1024 }] : [],
    runs: submitted ? [{ id: runId, projectId: project.id, messageId, assistantId, threadId, status: runStatus, stage: 'image', reply: '测试夹具中的助手回复', createdAt: now,
      input: { mode: 'image', text: '手机对话测试', ratio: '1:1' }, progress }] : [],
  } }))
  await page.route(`**/api/assets/${runId}/content*`, route => route.fulfill({ path: resolve('public/reference-interior.jpg'), contentType: 'image/jpeg' }))
  await page.route(`**/api/projects/${project.id}/chat`, async route => {
    const body = route.request().postDataJSON()
    expect(body.mode).toBe(expectedMode)
    expect(body.ratio).toBe(expectedRatio)
    expect(body.assetIds).toBeUndefined()
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
  await expect(page.getByRole('article', { name: '你的消息' })).toBeVisible()
  expect(await page.locator('.messages').evaluate(element => {
    const user = element.querySelector('.user-message')!.getBoundingClientRect()
    const assistant = element.querySelector('.assistant-message')!.getBoundingClientRect()
    const image = element.querySelector('.assistant-message img')!.getBoundingClientRect()
    return user.left > assistant.left && Math.abs(user.right - assistant.right) < 2 && image.width > 200 && image.right <= assistant.right
  })).toBe(true)
  const process = page.locator('.run-progress')
  await expect(process).not.toHaveAttribute('open')
  await expect(process.getByText('这是测试夹具的公开摘要。')).not.toBeVisible()
  await process.locator('summary').click()
  await expect(process.getByText('这是测试夹具的公开摘要。')).toBeVisible()
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
  await expect(page.getByText('Azure 生成', { exact: true })).toBeVisible()
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
  await page.getByLabel('图片比例').selectOption('2:3')
  await expect(page.locator('.image-cost')).toContainText('1张 · 低质量 · 按量计费')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(page.getByLabel('创作需求')).toHaveValue('请生成一张透明玻璃杯的图片')
  expectedRatio = '2:3'
  await page.getByRole('button', { name: '提交需求' }).click()
  await expect.poll(() => submitCount).toBe(2)
  await expect(page.getByLabel('创作需求')).toHaveValue('')
  runStatus = 'running'
  await request.patch(`/api/projects/${project.id}`, { data: { title: '运行中输入区测试' } })
  await expect(page.getByRole('button', { name: '停止当前回复' })).toBeVisible()
  for (const size of [{ width: 320, height: 568 }, { width: 390, height: 420 }]) {
    await page.setViewportSize(size)
    await page.getByLabel('创作需求').fill('较长的图片需求，需要保留编辑空间。\n'.repeat(10))
    await expect.poll(() => page.evaluate(() => {
      const composer = document.querySelector('.composer')!.getBoundingClientRect()
      const body = document.querySelector('.conversation-scroll')!.getBoundingClientRect()
      const attachment = document.querySelector('[aria-label="上传参考图"]')!.getBoundingClientRect()
      const stop = document.querySelector('[aria-label="停止当前回复"]')!.getBoundingClientRect()
      const send = document.querySelector('.send')!.getBoundingClientRect()
      return body.height >= window.innerHeight - 260 && body.bottom <= composer.top && composer.bottom <= window.innerHeight && attachment.right <= stop.left && stop.right <= send.left && send.right <= composer.right && stop.height >= 44 && document.documentElement.scrollWidth <= window.innerWidth
    })).toBe(true)
  }
  await page.screenshot({ path: testInfo.outputPath('creation-modes-running.png') })
  await page.getByLabel('创作需求').fill('')
  await expect.poll(() => page.getByLabel('创作需求').evaluate(element => element.getBoundingClientRect().height)).toBe(60)
})