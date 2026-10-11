import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dataPath } from "./config.js";
import type { HealthSample, HealthSampleType, StoreSnapshot } from "./types.js";

export const RETENTION_DAYS = 30;
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
      return JSON.parse(decrypt(this.key, readFileSync(dataPath())));
    } catch {
      return empty(); // undecryptable or corrupt: start empty rather than crash
    }
  }

  ingest(samples: HealthSample[]): void {
    for (const sample of samples) {
      this.snapshot.latest[sample.type] = sample;
      this.snapshot.history.push(sample);
    }
    const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
    this.snapshot.history = this.snapshot.history
      .filter((s) => new Date(s.end).getTime() >= cutoff)
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
      lastPushAt: this.snapshot.lastPushAt,
      lastQueryAt: this.lastQuery?.at ?? null,
      lastQueryTool: this.lastQuery?.tool ?? null,
    };
  }
}
