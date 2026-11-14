import { logger } from "./logger";

export interface RetryOptions {
  label: string;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (err: any) => boolean;
}

export function extractRetryAfterMs(err: any): number | undefined {
  const tgRetryAfter = err?.parameters?.retry_after;
  if (typeof tgRetryAfter === "number" && tgRetryAfter > 0) {
    return tgRetryAfter * 1000;
  }
  const msg = String(err?.message || "");
  const match = msg.match(/retry after (\d+)/i);
  if (match) {
    return Number(match[1]) * 1000;
  }
  return undefined;
}

export function isTransientError(err: any): boolean {
  if (!err) return false;
  const code = err?.status || err?.statusCode || err?.error_code || err?.code;
  if ([408, 429, 500, 502, 503, 504].includes(Number(code))) {
    return true;
  }
  if (
    ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"].includes(
      String(code)
    )
  ) {
    return true;
  }
  const msg = String(err?.message || err || "").toLowerCase();
  if (
    msg.includes("api_key_invalid") ||
    msg.includes("permission_denied") ||
    msg.includes("unauthorized") ||
    msg.includes("bad request") ||
    msg.includes("400") ||
    msg.includes("401") ||
    msg.includes("403")
  ) {
    return false;
  }
  return (
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("retry after") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("unavailable") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("fetch failed") ||
    msg.includes("network") ||
    msg.includes("timeout")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 600;
  const maxDelayMs = options.maxDelayMs ?? 12000;
  const checkRetry = options.shouldRetry ?? isTransientError;

  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (err: any) {
      lastError = err;
      const canRetry = attempt < maxAttempts && checkRetry(err);
      if (!canRetry) {
        throw err;
      }

      const retryAfterMs = extractRetryAfterMs(err);
      const exponential = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      const jitter = Math.floor(Math.random() * 250);
      const delayMs = Math.min((retryAfterMs ?? exponential) + jitter, maxDelayMs);

      logger.warn(`Retrying transient failure for "${options.label}"`, {
        attempt,
        maxAttempts,
        delayMs,
        error: err?.message || String(err),
      });

      await sleep(delayMs);
    }
  }

  throw lastError;
}
