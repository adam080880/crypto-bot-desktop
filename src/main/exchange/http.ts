export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly retryAfterMs: number | null,
    body: string
  ) {
    super(`HTTP ${status} ${url} ${body.slice(0, 200)}`)
  }
}

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export interface RetryOptions {
  retries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status === 418 || err.status >= 500
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return err.name === 'TimeoutError'
  }
  return true // network errors
}

/** Exponential backoff with full jitter; honours Retry-After on 429/418. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 5, baseDelayMs = 1000, maxDelayMs = 60_000, signal, onRetry } = opts
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (signal?.aborted || attempt >= retries || !isRetryable(err)) throw err
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
      const retryAfter = err instanceof HttpError ? err.retryAfterMs : null
      const delay = retryAfter ?? Math.round(backoff / 2 + Math.random() * (backoff / 2))
      onRetry?.(attempt + 1, err, delay)
      await sleep(delay, signal)
    }
  }
}

export function timeoutSignal(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return outer ? AbortSignal.any([outer, t]) : t
}
