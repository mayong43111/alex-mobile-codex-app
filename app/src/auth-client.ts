export type SignedInUser = { id: string; name: string; provider: 'local' | 'entra'; admin?: boolean }
let csrf: string | null = null
export function setCsrf(value: string | null) { csrf = value }
export async function authenticatedFetch(url: string, options?: RequestInit) {
  const headers = new Headers(options?.headers)
  if (csrf && options?.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) headers.set('X-CSRF-Token', csrf)
  const response = await fetch(url, { ...options, headers })
  if (response.status === 401) window.dispatchEvent(new Event('studio-session-expired'))
  return response
}