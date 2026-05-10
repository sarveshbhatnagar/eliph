export type ApiClient = ReturnType<typeof createClient>

export function createClient(apiUrl: string, apiKey: string) {
  async function request<T = unknown>(method: string, path: string, body?: object): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.status === 204) return null as T
    const data = await res.json()
    if (!res.ok) throw new Error((data as any).error ?? `HTTP ${res.status}`)
    return data as T
  }

  return { request }
}
