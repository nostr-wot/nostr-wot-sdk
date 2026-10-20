import type {
  RelayStatsOptions,
  RelayMetrics,
  RelayStatsData,
  RelayStatsPersistence,
} from './types';

const DEFAULTS = {
  maxBackoffMs: 30_000,
  persistIntervalMs: 30_000,
};

/**
 * Per-relay performance tracking with optional persistence.
 *
 * Tracks success/failure counts, latency, and exponential backoff.
 * Works purely in-memory; call `init(persistence)` to enable
 * loading/saving stats via a custom adapter (e.g. IndexedDB).
 */
export class RelayStats {
  private _opts: Required<RelayStatsOptions>;
  private _metrics = new Map<string, RelayMetrics>();
  private _persistence: RelayStatsPersistence | null = null;
  private _persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options?: RelayStatsOptions) {
    this._opts = { ...DEFAULTS, ...options };
  }

  /** Initialize stats, optionally loading from a persistence adapter. */
  async init(persistence?: RelayStatsPersistence): Promise<void> {
    this._persistence = persistence ?? null;

    if (this._persistence) {
      const stats = await this._persistence.load();
      for (const s of stats) {
        this._metrics.set(s.url, {
          url: s.url,
          successCount: s.successCount,
          failureCount: s.failureCount,
          totalLatencyMs: s.avgLatencyMs * s.successCount,
          avgLatencyMs: s.avgLatencyMs,
          lastConnected: s.lastConnected,
          consecutiveFailures: s.consecutiveFailures,
          backoffUntil: 0,
        });
      }
    }

    // Auto-persist periodically
    if (this._persistence && this._opts.persistIntervalMs > 0) {
      this._persistTimer = setInterval(() => this.persist(), this._opts.persistIntervalMs);
    }
  }

  /** Record a successful relay interaction. */
  recordSuccess(url: string, latencyMs: number): void {
    const m = this._ensure(url);
    m.successCount++;
    m.totalLatencyMs += latencyMs;
    m.avgLatencyMs = m.totalLatencyMs / m.successCount;
    m.lastConnected = Date.now();
    m.consecutiveFailures = 0;
    m.backoffUntil = 0;
  }

  /** Record a failed relay interaction. */
  recordFailure(url: string, _error?: string): void {
    const m = this._ensure(url);
    m.failureCount++;
    m.consecutiveFailures++;
    m.backoffUntil = Date.now() + this.getBackoffMs(url);
  }

  /** Returns relay URLs sorted by priority (lowest latency + highest success rate). */
  getPrioritizedUrls(urls: string[]): string[] {
    return [...urls].sort((a, b) => {
      const ma = this._metrics.get(a);
      const mb = this._metrics.get(b);

      // Unknown relays go to the end
      if (!ma && !mb) return 0;
      if (!ma) return 1;
      if (!mb) return -1;

      // Backed-off relays go last
      const now = Date.now();
      const aBackedOff = ma.backoffUntil > now;
      const bBackedOff = mb.backoffUntil > now;
      if (aBackedOff && !bBackedOff) return 1;
      if (!aBackedOff && bBackedOff) return -1;

      // Score: lower is better (60% success rate, 40% latency)
      const aTotal = ma.successCount + ma.failureCount;
      const bTotal = mb.successCount + mb.failureCount;
      const aSuccessRate = aTotal > 0 ? ma.successCount / aTotal : 0.5;
      const bSuccessRate = bTotal > 0 ? mb.successCount / bTotal : 0.5;

      const aLatencyScore = Math.min(ma.avgLatencyMs, 5000) / 5000;
      const bLatencyScore = Math.min(mb.avgLatencyMs, 5000) / 5000;

      const aScore = (1 - aSuccessRate) * 0.6 + aLatencyScore * 0.4;
      const bScore = (1 - bSuccessRate) * 0.6 + bLatencyScore * 0.4;

      return aScore - bScore;
    });
  }

  /** Returns backoff delay in ms based on consecutive failures (exponential). */
  getBackoffMs(url: string): number {
    const m = this._metrics.get(url);
    if (!m) return 1000;
    return Math.min(1000 * Math.pow(2, m.consecutiveFailures - 1), this._opts.maxBackoffMs);
  }

  /** Check if a relay is currently in backoff. */
  isBackedOff(url: string): boolean {
    const m = this._metrics.get(url);
    if (!m) return false;
    return m.backoffUntil > Date.now();
  }

  /** Get metrics for a single relay. */
  getMetrics(url: string): RelayMetrics | undefined {
    return this._metrics.get(url);
  }

  /** Get metrics for all tracked relays. */
  getAllMetrics(): RelayMetrics[] {
    return [...this._metrics.values()];
  }

  /** Persist current stats via the adapter (no-op if no persistence configured). */
  async persist(): Promise<void> {
    if (!this._persistence) return;

    const stats: RelayStatsData[] = [];
    for (const m of this._metrics.values()) {
      stats.push({
        url: m.url,
        successCount: m.successCount,
        failureCount: m.failureCount,
        avgLatencyMs: m.avgLatencyMs,
        lastConnected: m.lastConnected,
        consecutiveFailures: m.consecutiveFailures,
      });
    }
    if (stats.length > 0) {
      await this._persistence.save(stats);
    }
  }

  /** Stop auto-persist timer and clean up. */
  destroy(): void {
    if (this._persistTimer) {
      clearInterval(this._persistTimer);
      this._persistTimer = null;
    }
  }

  // ── Internals ──

  private _ensure(url: string): RelayMetrics {
    let m = this._metrics.get(url);
    if (!m) {
      m = {
        url,
        successCount: 0,
        failureCount: 0,
        totalLatencyMs: 0,
        avgLatencyMs: 0,
        lastConnected: 0,
        consecutiveFailures: 0,
        backoffUntil: 0,
      };
      this._metrics.set(url, m);
    }
    return m;
  }
}
