import { FetchSource } from 'pmtiles';

const DEFAULT_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_DELAY_MS = 120;
const DEFAULT_MAX_DELAY_MS = 1_500;
const DEFAULT_MAX_RANGE_BYTES = 16 * 1024 * 1024;
const DEFAULT_CIRCUIT_FAILURES = 6;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 15_000;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('The PMTiles range request was aborted.');
  error.name = 'AbortError';
  return error;
}

function delay(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer.unref?.();
  }).finally(() => signal?.removeEventListener?.('abort', () => {}));
}

function errorStatus(error) {
  const direct = Number(error?.status || error?.statusCode);
  if (Number.isSafeInteger(direct)) return direct;
  const match = /(?:http|status|response)\D+(\d{3})/i.exec(String(error?.message || ''));
  return match ? Number(match[1]) : null;
}

export function isRetryableUpstreamError(error) {
  if (!error) return true;
  if (error.name === 'AbortError') return true;
  const status = errorStatus(error);
  if (status === null) return true;
  if ([408, 409, 425, 429].includes(status)) return true;
  return status >= 500;
}

function validateSourceUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('PMTiles sources must use HTTP or HTTPS.');
  }
  return url.href;
}

/**
 * Adds bounded retries, per-range timeouts, and a small circuit breaker around
 * PMTiles HTTP reads. GitHub release storage redirects every byte-range request,
 * so transient CDN failures must not become blank map tiles or unbounded retry
 * storms. Permanent 4xx responses fail immediately.
 */
export class RetryingFetchSource {
  constructor(url, {
    attempts = DEFAULT_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    maxRangeBytes = DEFAULT_MAX_RANGE_BYTES,
    circuitFailures = DEFAULT_CIRCUIT_FAILURES,
    circuitCooldownMs = DEFAULT_CIRCUIT_COOLDOWN_MS,
    source = null,
    now = () => Date.now(),
    random = Math.random
  } = {}) {
    const sourceUrl = validateSourceUrl(url);
    this.source = source || new FetchSource(sourceUrl);
    this.attempts = boundedInteger(attempts, DEFAULT_ATTEMPTS, 1, 8);
    this.timeoutMs = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 250, 60_000);
    this.baseDelayMs = boundedInteger(baseDelayMs, DEFAULT_BASE_DELAY_MS, 0, 5_000);
    this.maxDelayMs = boundedInteger(maxDelayMs, DEFAULT_MAX_DELAY_MS, this.baseDelayMs, 30_000);
    this.maxRangeBytes = boundedInteger(maxRangeBytes, DEFAULT_MAX_RANGE_BYTES, 1_024, 64 * 1024 * 1024);
    this.circuitFailures = boundedInteger(circuitFailures, DEFAULT_CIRCUIT_FAILURES, 2, 50);
    this.circuitCooldownMs = boundedInteger(circuitCooldownMs, DEFAULT_CIRCUIT_COOLDOWN_MS, 1_000, 300_000);
    this.now = now;
    this.random = random;
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    this.totalRequests = 0;
    this.totalRetries = 0;
    this.totalFailures = 0;
  }

  getKey() {
    return this.source.getKey();
  }

  getHealthSnapshot() {
    return {
      key: this.getKey(),
      totalRequests: this.totalRequests,
      totalRetries: this.totalRetries,
      totalFailures: this.totalFailures,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpen: this.now() < this.circuitOpenUntil,
      circuitOpenUntil: this.circuitOpenUntil || null
    };
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
  }

  recordFailure() {
    this.totalFailures += 1;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.circuitFailures) {
      this.circuitOpenUntil = this.now() + this.circuitCooldownMs;
    }
  }

  async getBytes(offset, length, passedSignal, etag) {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new RangeError('PMTiles byte offsets must be non-negative safe integers.');
    }
    if (!Number.isSafeInteger(length) || length <= 0 || length > this.maxRangeBytes) {
      throw new RangeError(`PMTiles range length must be between 1 and ${this.maxRangeBytes} bytes.`);
    }
    if (passedSignal?.aborted) throw abortError(passedSignal);
    if (this.now() < this.circuitOpenUntil) {
      const error = new Error(`PMTiles upstream circuit is open for ${this.getKey()}.`);
      error.code = 'OCCUMED_UPSTREAM_CIRCUIT_OPEN';
      error.retryAfterMs = this.circuitOpenUntil - this.now();
      throw error;
    }

    this.totalRequests += 1;
    let lastError;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const signal = passedSignal
        ? AbortSignal.any([passedSignal, timeoutSignal])
        : timeoutSignal;
      try {
        const result = await this.source.getBytes(offset, length, signal, etag);
        const byteLength = Number(result?.data?.byteLength);
        if (!Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > this.maxRangeBytes) {
          const error = new Error(`PMTiles upstream returned an invalid ${byteLength || 0}-byte range.`);
          error.code = 'OCCUMED_INVALID_RANGE_RESPONSE';
          throw error;
        }
        this.recordSuccess();
        return result;
      } catch (error) {
        lastError = error;
        if (passedSignal?.aborted) throw abortError(passedSignal);
        const retryable = isRetryableUpstreamError(error);
        if (!retryable || attempt === this.attempts) break;
        this.totalRetries += 1;
        const exponential = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** (attempt - 1)));
        const jitter = 0.75 + (Math.max(0, Math.min(1, Number(this.random()) || 0)) * 0.5);
        await delay(Math.round(exponential * jitter), passedSignal);
      }
    }

    this.recordFailure();
    const wrapped = new Error(`PMTiles range request failed for ${this.getKey()} after bounded retries.`, {
      cause: lastError
    });
    wrapped.code = lastError?.code || 'OCCUMED_UPSTREAM_RANGE_FAILED';
    wrapped.status = errorStatus(lastError);
    throw wrapped;
  }
}
