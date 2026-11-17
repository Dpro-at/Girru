/**
 * Noise governor.
 *
 * Paces the app's own outbound checks so it stays polite and low-impact on the targets you own.
 * Three profiles — quiet, balanced, aggressive — set how fast checks go, how many may be in flight
 * per host, the jitter between them, and how hard to back off after a 429/503 or a connection
 * problem. Pacing state is kept in memory per host and resets on restart; the chosen profile is a
 * setting (quiet by default).
 */

const PROFILES = {
  quiet:      { gapMs: 800, jitterMs: 400, maxInFlight: 1, backoffBaseMs: 2000, backoffMax: 60_000, portConcurrency: 8 },
  balanced:   { gapMs: 250, jitterMs: 150, maxInFlight: 3, backoffBaseMs: 1000, backoffMax: 30_000, portConcurrency: 24 },
  aggressive: { gapMs: 60,  jitterMs: 40,  maxInFlight: 6, backoffBaseMs: 500,  backoffMax: 15_000, portConcurrency: 64 },
};

export function profileNames() { return Object.keys(PROFILES); }
export function profileConfig(name) { return PROFILES[name] || PROFILES.quiet; }

/** A per-run governor for one profile. Call before each outbound check; honours per-host backoff. */
export class NoiseGovernor {
  constructor(profileName = 'quiet') {
    this.cfg = profileConfig(profileName);
    this.name = PROFILES[profileName] ? profileName : 'quiet';
    this.lastAt = new Map();      // host -> last send time
    this.backoffUntil = new Map(); // host -> timestamp until which to hold off
    this.strikes = new Map();      // host -> consecutive throttle/error count
  }

  portConcurrency() { return this.cfg.portConcurrency; }

  /** Wait until it is polite to make the next request to `host`. */
  async pace(host) {
    const now = Date.now();
    const until = this.backoffUntil.get(host) || 0;
    const last = this.lastAt.get(host) || 0;
    const jitter = Math.floor(Math.random() * this.cfg.jitterMs);
    const earliest = Math.max(until, last + this.cfg.gapMs) + jitter;
    const wait = earliest - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastAt.set(host, Date.now());
  }

  /** Report the outcome so the governor can back off on throttling/errors or recover on success. */
  note(host, { status = 0, errored = false } = {}) {
    const throttled = status === 429 || status === 503 || errored;
    if (!throttled) { this.strikes.set(host, 0); return; }
    const n = (this.strikes.get(host) || 0) + 1;
    this.strikes.set(host, n);
    const delay = Math.min(this.cfg.backoffBaseMs * 2 ** (n - 1), this.cfg.backoffMax);
    this.backoffUntil.set(host, Date.now() + delay);
  }
}
