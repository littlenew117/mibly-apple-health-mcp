import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "./config.js";
import type { HealthSample, HealthSampleType, StoreSnapshot } from "./types.js";

export const RETENTION_DAYS = 365;
const MAX_HISTORY = 25_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// File layout: 12-byte IV | 16-byte GCM tag | ciphertext. Key = scrypt(token, salt).
function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(key: Buffer, blob: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
  decipher.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
}

const empty = (): StoreSnapshot => ({ latest: {}, history: [], lastPushAt: null });

// Unparseable timestamps sort first and never win `latest`.
const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? -Infinity : t;
};

/**
 * Identity of a sample: its `sampleId` when the phone sent one, otherwise type+start+end.
 * Timestamps are compared as instants, so `Z` and `+00:00` spellings are the same key.
 */
export function dedupeKey(s: HealthSample): string {
  if (s.sampleId) return `id:${s.sampleId}`;
  const instant = (iso: string) => (Number.isNaN(Date.parse(iso)) ? iso : String(Date.parse(iso)));
  return `${s.type}|${instant(s.start)}|${instant(s.end)}`;
}

/** True when `a` should be the `latest` over `b`: greater end, then greater start; on a full tie the newer arrival wins. */
function isNewerOrSame(a: HealthSample, b: HealthSample): boolean {
  return time(a.end) > time(b.end) || (time(a.end) === time(b.end) && time(a.start) >= time(b.start));
}

/** Reported by GET /status so the Mibly app knows which protocol features this receiver has. */
export const RECEIVER_VERSION = "1.2.0";
export const CAPABILITIES = [
  "bodyFat",
  "restingHeartRate",
  "walkingHeartRateAverage",
  "heartRateSummary",
  "sampleIdUpsert", // same sampleId (or type+start+end) replaces instead of duplicating
  "latestByEnd",
  "backfill", // safe to receive ~7 days of history after pairing
] as const;

/**
 * Upgrade from before heartRateSummary: heartRate used to be single readings, now it is an
 * hourly summary, and the two must not be mixed. Remove the old ones; keep everything else.
 */
function dropLegacyHeartRate(snap: StoreSnapshot): StoreSnapshot {
  const legacy = (s: HealthSample) => s.type === "heartRate" && s.heartRateSummary === undefined;
  snap.history = snap.history.filter((s) => !legacy(s));
  if (snap.latest.heartRate && legacy(snap.latest.heartRate)) {
    delete snap.latest.heartRate;
    for (const s of snap.history) {
      const cur = snap.latest.heartRate;
      if (s.type === "heartRate" && (!cur || isNewerOrSame(s, cur))) snap.latest.heartRate = s;
    }
  }
  return snap;
}

export class HealthStore {
  private key: Buffer;
  private snapshot: StoreSnapshot;
  // Runtime-only; shown in /status and reset on restart.
  private lastQuery: { at: string; tool: string } | null = null;

  constructor(token: string, salt: string, freshStore: boolean) {
    this.key = scryptSync(token, salt, 32);
    this.snapshot = freshStore ? empty() : this.load();
  }

  private load(): StoreSnapshot {
    if (!existsSync(dataPath())) return empty();
    try {
      return dropLegacyHeartRate(JSON.parse(decrypt(this.key, readFileSync(dataPath()))));
    } catch {
      return empty(); // undecryptable or corrupt: start empty rather than crash
    }
  }

  ingest(samples: HealthSample[]): void {
    // One stored entry per dedupe key. A repeat replaces the earlier entry in place
    // (the phone re-sends an in-progress hour or today's steps with updated values).
    const index = new Map<string, number>();
    this.snapshot.history.forEach((s, i) => index.set(dedupeKey(s), i));
    for (const sample of samples) {
      const key = dedupeKey(sample);
      const at = index.get(key);
      if (at === undefined) {
        index.set(key, this.snapshot.history.push(sample) - 1);
      } else {
        this.snapshot.history[at] = sample;
      }
      // `latest` is the sample with the greatest end, then the greatest start, no
      // matter what order samples arrive in (a backfill must not overwrite it).
      const current = this.snapshot.latest[sample.type];
      if (!current || isNewerOrSame(sample, current)) this.snapshot.latest[sample.type] = sample;
    }
    const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
    this.snapshot.history = this.snapshot.history
      .filter((s) => new Date(s.end).getTime() >= cutoff)
      .sort((a, b) => time(a.start) - time(b.start) || time(a.end) - time(b.end))
      .slice(-MAX_HISTORY);
    this.snapshot.lastPushAt = new Date().toISOString();
    writeFileSync(dataPath(), encrypt(this.key, JSON.stringify(this.snapshot)), { mode: 0o600 });
  }

  now() {
    return { ...this.snapshot.latest, lastPushAt: this.snapshot.lastPushAt };
  }

  detail(type: HealthSampleType, start: string, end: string): HealthSample[] {
    const from = Math.max(new Date(start).getTime(), Date.now() - RETENTION_DAYS * DAY_MS);
    const to = new Date(end).getTime();
    return this.snapshot.history.filter((s) => {
      const t = new Date(s.start).getTime();
      return s.type === type && t >= from && t <= to;
    });
  }

  recordQuery(tool: string): void {
    this.lastQuery = { at: new Date().toISOString(), tool };
  }

  status() {
    return {
      version: RECEIVER_VERSION,
      capabilities: CAPABILITIES,
      lastPushAt: this.snapshot.lastPushAt,
      lastQueryAt: this.lastQuery?.at ?? null,
      lastQueryTool: this.lastQuery?.tool ?? null,
    };
  }
}
