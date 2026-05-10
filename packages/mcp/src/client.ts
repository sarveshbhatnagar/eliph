export type ApiClient = ReturnType<typeof createClient>

export function createClient(apiUrl: string, apiKey: string) {
  async function request<T = unknown>(method: string, path: string, body?: object): Promise<T> {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 204) return null as T
    const data = await res.json()
    if (!res.ok) throw new Error((data as any).error ?? `HTTP ${res.status}`)
    return data as T
  }

  return { request }
}
