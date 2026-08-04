// Generic retry-with-backoff for transient rate-limit errors from either the
// Base44 entities API or the Polymarket Data API. Both have been observed to
// throw "Rate limit exceeded" under sustained batch-processing load.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 4,
  baseDelayMs = 800
): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const message = String(err?.message || err);
      if (!/rate limit/i.test(message) || i === attempts - 1) throw err;
      await sleep(baseDelayMs * 2 ** i);
    }
  }
  throw lastErr;
}
