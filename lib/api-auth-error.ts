const MAX_AUTH_ERROR_BYTES = 64 * 1024
const AUTH_ERROR_READ_TIMEOUT_MS = 250

async function readBoundedBody(response: Response): Promise<string | undefined> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUTH_ERROR_BYTES) return undefined
  if (!response.body) return ""

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_AUTH_ERROR_BYTES) {
            void reader.cancel().catch(() => {})
            return undefined
          }
          chunks.push(value)
        }

        const body = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          body.set(chunk, offset)
          offset += chunk.byteLength
        }
        return new TextDecoder().decode(body)
      })(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          void reader.cancel().catch(() => {})
          resolve(undefined)
        }, AUTH_ERROR_READ_TIMEOUT_MS)
      })
    ])
  } catch {
    return undefined
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function hasTokenExpiredCode(value: unknown): boolean {
  let current = value
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return false
    const record = current as Record<string, unknown>
    if (record.code === "token_expired") return true
    current = record.error ?? record.detail
  }
  return false
}

export async function isTokenExpiredResponse(response: Response): Promise<boolean> {
  if (response.status !== 401) return false
  if (response.headers.get("x-openai-ide-error-code")?.trim().toLowerCase() === "token_expired") return true
  if (response.headers.get("x-openai-ide-root-error-code")?.trim().toLowerCase() === "token_expired") return true

  const raw = await readBoundedBody(response.clone())
  if (!raw) return false
  try {
    return hasTokenExpiredCode(JSON.parse(raw))
  } catch {
    return false
  }
}
