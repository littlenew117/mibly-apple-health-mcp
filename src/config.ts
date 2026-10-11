import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_HOST = "0.0.0.0:7345";

// Resolved lazily so tests can point HOME somewhere temporary.
export const configDir = () => join(homedir(), ".mibly");
export const configPath = () => join(configDir(), "config.json");
export const dataPath = () => join(configDir(), "data.enc");

interface PersistedConfig {
  token: string;
  salt: string; // base64; with the token it derives the key that encrypts data.enc
  host: string; // bind address, e.g. 0.0.0.0:7345
}

export interface ActiveConfig extends PersistedConfig {
  /** True when there was no previous config or the token changed: old data.enc is unreadable, start empty. */
  freshStore: boolean;
}

function readPersisted(): PersistedConfig | null {
  if (!existsSync(configPath())) return null;
  try {
    return JSON.parse(readFileSync(configPath(), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Token comes from MIBLY_TOKEN (first run) or the saved config. The token is
 * stored in plaintext in config.json (mode 0600), the same trust model as an
 * SSH key, so restarts don't need the env var again.
 */
export function resolveConfig(): ActiveConfig {
  const persisted = readPersisted();
  const token = process.env.MIBLY_TOKEN?.trim() || persisted?.token;
  if (!token) throw new Error("No pairing token. Set MIBLY_TOKEN (from the Mibly app) on first run.");

  const host = process.env.MIBLY_HOST?.trim() || persisted?.host || DEFAULT_HOST;
  const freshStore = !persisted || persisted.token !== token;
  const salt = freshStore ? randomBytes(16).toString("base64") : persisted.salt;

  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify({ token, salt, host }, null, 2), { mode: 0o600 });
  return { token, salt, host, freshStore };
}
