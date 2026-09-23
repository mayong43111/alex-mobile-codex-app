self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()) })
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate' || url.origin !== self.location.origin || !['/', '/index.html'].includes(url.pathname)) return
  event.respondWith(fetch(event.request, { cache: 'no-store' }).catch(() => new Response(
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Studio</title><body style="font-family:sans-serif;padding:32px;color:#262c2a"><h1>Codex Studio</h1><p>当前离线，请连接网络后重试。</p><a href="/">重新连接</a></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  )))
})