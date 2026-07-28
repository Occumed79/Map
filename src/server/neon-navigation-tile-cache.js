import postgres from 'postgres';

const DEFAULT_MAX_ZOOM = 6;
const DEFAULT_QUERY_TIMEOUT_MS = 1_500;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_BYTES_PER_SHARD = 48 * 1024 * 1024;
const DEFAULT_PRUNE_EVERY_WRITES = 64;
const MAX_DATABASE_SHARDS = 8;
const TABLE_NAME = 'occumed_navigation_tile_cache';

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function safeDatabaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return null;
    if (!url.hostname || !url.username || !url.pathname || url.pathname === '/') return null;
    return raw;
  } catch {
    return null;
  }
}

export function collectNavigationDatabaseUrls(env = process.env) {
  const seen = new Set();
  const entries = [];
  for (let slot = 1; slot <= MAX_DATABASE_SHARDS; slot += 1) {
    const value = safeDatabaseUrl(env[`NAV_DATABASE_URL_${slot}`]);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    entries.push({ slot, url: value });
  }
  return entries;
}

export function navigationTileShardIndex(key, shardCount) {
  if (!Number.isSafeInteger(shardCount) || shardCount <= 0) return -1;
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % shardCount;
}

function timeoutAfter(milliseconds, label) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out.`);
      error.code = 'OCCUMED_NAV_CACHE_TIMEOUT';
      reject(error);
    }, milliseconds);
    timer.unref?.();
  });
}

async function withinTimeout(task, milliseconds, label) {
  return Promise.race([task, timeoutAfter(milliseconds, label)]);
}

class PostgresNavigationShard {
  constructor({
    slot,
    url,
    queryTimeoutMs,
    retryDelayMs,
    maxBytes,
    pruneEveryWrites,
    now,
    logger
  }) {
    this.slot = slot;
    this.queryTimeoutMs = queryTimeoutMs;
    this.retryDelayMs = retryDelayMs;
    this.maxBytes = maxBytes;
    this.pruneEveryWrites = pruneEveryWrites;
    this.now = now;
    this.logger = logger;
    this.initialization = null;
    this.initialized = false;
    this.disabledUntil = 0;
    this.writeCount = 0;
    this.lastErrorCode = null;
    this.metrics = {
      hits: 0,
      misses: 0,
      writes: 0,
      errors: 0,
      prunes: 0
    };
    this.sql = postgres(url, {
      max: 1,
      prepare: false,
      connect_timeout: 5,
      idle_timeout: 20,
      max_lifetime: 60 * 30,
      onnotice: () => {}
    });
  }

  available() {
    return this.now() >= this.disabledUntil;
  }

  recordError(error, operation) {
    this.metrics.errors += 1;
    this.disabledUntil = this.now() + this.retryDelayMs;
    this.lastErrorCode = String(error?.code || error?.name || 'UNKNOWN').slice(0, 80);
    this.logger?.warn?.(JSON.stringify({
      level: 'warn',
      type: 'navigation-cache-error',
      shard: this.slot,
      operation,
      code: this.lastErrorCode
    }));
  }

  async initialize() {
    if (this.initialized) return true;
    if (!this.available()) return false;
    if (this.initialization) return this.initialization;

    this.initialization = withinTimeout(
      this.sql.unsafe(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
          tileset_version text NOT NULL,
          z smallint NOT NULL CHECK (z BETWEEN 0 AND ${DEFAULT_MAX_ZOOM}),
          x integer NOT NULL CHECK (x >= 0),
          y integer NOT NULL CHECK (y >= 0),
          tile bytea NOT NULL,
          byte_length integer NOT NULL CHECK (byte_length = octet_length(tile)),
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (tileset_version, z, x, y)
        );
        CREATE INDEX IF NOT EXISTS ${TABLE_NAME}_created_at_idx
          ON ${TABLE_NAME} (created_at);
      `),
      this.queryTimeoutMs * 4,
      `Navigation cache shard ${this.slot} initialization`
    )
      .then(() => {
        this.initialized = true;
        this.disabledUntil = 0;
        this.lastErrorCode = null;
        return true;
      })
      .catch((error) => {
        this.recordError(error, 'initialize');
        return false;
      })
      .finally(() => {
        this.initialization = null;
      });

    return this.initialization;
  }

  async get(tilesetVersion, zoom, x, y) {
    if (!(await this.initialize())) return null;
    try {
      const rows = await withinTimeout(
        this.sql`
          SELECT tile
          FROM ${this.sql(TABLE_NAME)}
          WHERE tileset_version = ${tilesetVersion}
            AND z = ${zoom}
            AND x = ${x}
            AND y = ${y}
          LIMIT 1
        `,
        this.queryTimeoutMs,
        `Navigation cache shard ${this.slot} read`
      );
      const tile = rows?.[0]?.tile;
      if (!tile) {
        this.metrics.misses += 1;
        return null;
      }
      this.metrics.hits += 1;
      return Buffer.from(tile);
    } catch (error) {
      this.recordError(error, 'read');
      return null;
    }
  }

  async set(tilesetVersion, zoom, x, y, value) {
    if (!(await this.initialize())) return false;
    const tile = Buffer.from(value);
    try {
      await withinTimeout(
        this.sql`
          INSERT INTO ${this.sql(TABLE_NAME)} (
            tileset_version, z, x, y, tile, byte_length, created_at
          ) VALUES (
            ${tilesetVersion}, ${zoom}, ${x}, ${y}, ${tile}, ${tile.byteLength}, now()
          )
          ON CONFLICT (tileset_version, z, x, y)
          DO UPDATE SET
            tile = EXCLUDED.tile,
            byte_length = EXCLUDED.byte_length,
            created_at = now()
        `,
        this.queryTimeoutMs,
        `Navigation cache shard ${this.slot} write`
      );
      this.metrics.writes += 1;
      this.writeCount += 1;
      this.disabledUntil = 0;
      this.lastErrorCode = null;
      if (this.writeCount % this.pruneEveryWrites === 0) {
        void this.prune(tilesetVersion);
      }
      return true;
    } catch (error) {
      this.recordError(error, 'write');
      return false;
    }
  }

  async prune(tilesetVersion) {
    if (!this.initialized || !this.available()) return false;
    try {
      await withinTimeout(
        this.sql.begin(async (transaction) => {
          await transaction`
            DELETE FROM ${transaction(TABLE_NAME)}
            WHERE tileset_version <> ${tilesetVersion}
          `;
          await transaction.unsafe(`
            WITH ranked AS (
              SELECT
                ctid,
                sum(byte_length) OVER (
                  ORDER BY created_at DESC, z DESC, x DESC, y DESC
                ) AS running_bytes
              FROM ${TABLE_NAME}
              WHERE tileset_version = $1
            )
            DELETE FROM ${TABLE_NAME} AS cache
            USING ranked
            WHERE cache.ctid = ranked.ctid
              AND ranked.running_bytes > $2
          `, [tilesetVersion, this.maxBytes]);
        }),
        this.queryTimeoutMs * 4,
        `Navigation cache shard ${this.slot} prune`
      );
      this.metrics.prunes += 1;
      return true;
    } catch (error) {
      this.recordError(error, 'prune');
      return false;
    }
  }

  async close() {
    await this.sql.end({ timeout: 2 }).catch(() => {});
  }

  snapshot() {
    return {
      slot: this.slot,
      initialized: this.initialized,
      available: this.available(),
      retryAfterMs: Math.max(0, this.disabledUntil - this.now()),
      maxBytes: this.maxBytes,
      lastErrorCode: this.lastErrorCode,
      ...this.metrics
    };
  }
}

export class NeonNavigationTileCache {
  constructor(databaseEntries, {
    maxZoom = DEFAULT_MAX_ZOOM,
    queryTimeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    maxBytesPerShard = DEFAULT_MAX_BYTES_PER_SHARD,
    pruneEveryWrites = DEFAULT_PRUNE_EVERY_WRITES,
    now = () => Date.now(),
    logger = console,
    shardFactory = (options) => new PostgresNavigationShard(options)
  } = {}) {
    this.maxZoom = boundedInteger(maxZoom, DEFAULT_MAX_ZOOM, 0, DEFAULT_MAX_ZOOM);
    this.queryTimeoutMs = boundedInteger(queryTimeoutMs, DEFAULT_QUERY_TIMEOUT_MS, 100, 30_000);
    this.retryDelayMs = boundedInteger(retryDelayMs, DEFAULT_RETRY_DELAY_MS, 1_000, 15 * 60_000);
    this.maxBytesPerShard = boundedInteger(
      maxBytesPerShard,
      DEFAULT_MAX_BYTES_PER_SHARD,
      1 * 1024 * 1024,
      256 * 1024 * 1024
    );
    this.pruneEveryWrites = boundedInteger(pruneEveryWrites, DEFAULT_PRUNE_EVERY_WRITES, 1, 10_000);
    this.now = now;
    this.logger = logger;
    this.metrics = {
      skippedAboveMaxZoom: 0,
      skippedNoShard: 0
    };
    this.shards = databaseEntries.map(({ slot, url }) => shardFactory({
      slot,
      url,
      queryTimeoutMs: this.queryTimeoutMs,
      retryDelayMs: this.retryDelayMs,
      maxBytes: this.maxBytesPerShard,
      pruneEveryWrites: this.pruneEveryWrites,
      now,
      logger
    }));
  }

  eligible(zoom) {
    return Number.isSafeInteger(zoom) && zoom >= 0 && zoom <= this.maxZoom;
  }

  shardFor(tilesetVersion, zoom, x, y) {
    if (!this.shards.length) {
      this.metrics.skippedNoShard += 1;
      return null;
    }
    const key = `${tilesetVersion}/${zoom}/${x}/${y}`;
    return this.shards[navigationTileShardIndex(key, this.shards.length)];
  }

  async initialize() {
    const results = [];
    for (const shard of this.shards) results.push(await shard.initialize());
    return results.filter(Boolean).length;
  }

  async get(tilesetVersion, zoom, x, y) {
    if (!this.eligible(zoom)) {
      this.metrics.skippedAboveMaxZoom += 1;
      return null;
    }
    const shard = this.shardFor(tilesetVersion, zoom, x, y);
    return shard ? shard.get(tilesetVersion, zoom, x, y) : null;
  }

  async set(tilesetVersion, zoom, x, y, value) {
    if (!this.eligible(zoom)) {
      this.metrics.skippedAboveMaxZoom += 1;
      return false;
    }
    const shard = this.shardFor(tilesetVersion, zoom, x, y);
    return shard ? shard.set(tilesetVersion, zoom, x, y, value) : false;
  }

  async close() {
    await Promise.all(this.shards.map((shard) => shard.close()));
  }

  snapshot() {
    return {
      enabled: this.shards.length > 0,
      configuredShards: this.shards.length,
      expectedShards: MAX_DATABASE_SHARDS,
      maxZoom: this.maxZoom,
      queryTimeoutMs: this.queryTimeoutMs,
      maxBytesPerShard: this.maxBytesPerShard,
      ...this.metrics,
      shards: this.shards.map((shard) => shard.snapshot())
    };
  }
}

export function createNeonNavigationTileCacheFromEnv(env = process.env, options = {}) {
  const databaseEntries = collectNavigationDatabaseUrls(env);
  if (!databaseEntries.length) return null;
  return new NeonNavigationTileCache(databaseEntries, {
    maxZoom: env.OCCUMED_NAV_CACHE_MAX_ZOOM,
    queryTimeoutMs: env.OCCUMED_NAV_CACHE_QUERY_TIMEOUT_MS,
    retryDelayMs: env.OCCUMED_NAV_CACHE_RETRY_DELAY_MS,
    maxBytesPerShard: env.OCCUMED_NAV_CACHE_MAX_BYTES_PER_SHARD,
    pruneEveryWrites: env.OCCUMED_NAV_CACHE_PRUNE_EVERY_WRITES,
    ...options
  });
}
