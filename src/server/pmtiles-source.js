import { FetchSource } from 'pmtiles';

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 12_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Adds bounded retries and per-range timeouts around PMTiles' HTTP source.
 * GitHub release storage redirects every byte-range request, so a transient
 * redirect or object-storage failure must not turn into a blank map tile.
 */
export class RetryingFetchSource {
  constructor(url, {
    attempts = DEFAULT_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = {}) {
    this.source = new FetchSource(url);
    this.attempts = attempts;
    this.timeoutMs = timeoutMs;
  }

  getKey() {
    return this.source.getKey();
  }

  async getBytes(offset, length, passedSignal, etag) {
    let lastError;
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const signal = passedSignal
        ? AbortSignal.any([passedSignal, timeoutSignal])
        : timeoutSignal;
      try {
        return await this.source.getBytes(offset, length, signal, etag);
      } catch (error) {
        lastError = error;
        if (passedSignal?.aborted || attempt === this.attempts) throw error;
        await delay(150 * attempt);
      }
    }
    throw lastError;
  }
}
