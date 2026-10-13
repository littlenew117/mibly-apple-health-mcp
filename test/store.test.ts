// Store-level test for the history cap. Runs in its own process, so pointing HOME at a temp dir is safe.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

const home = mkdtempSync(join(tmpdir(), "mibly-store-"));
process.env.HOME = home;
mkdirSync(join(home, ".mibly"));
const { HealthStore } = await import("../src/store.js");

after(() => rmSync(home, { recursive: true, force: true }));

describe("history cap", () => {
  it("keeps at most 100,000 samples, dropping the oldest, and survives a reload", () => {
    const now = Date.now();
    const samples = Array.from({ length: 100_010 }, (_, i) => {
      const end = now - (100_010 - i) * 60_000; // one per minute, all within 365 days
      return { type: "steps" as const, start: new Date(end - 60_000).toISOString(), end: new Date(end).toISOString(), value: i, unit: "count", sampleId: `s${i}` };
    });
    const store = new HealthStore("tok", "c2FsdHNhbHRzYWx0c2FsdA==", true);
    store.ingest(samples);

    const all = (s: InstanceType<typeof HealthStore>) => s.detail("steps", new Date(now - 400 * 864e5).toISOString(), new Date(now + 864e5).toISOString());
    const kept = all(store);
    assert.equal(kept.length, 100_000);
    assert.equal(kept[0].sampleId, "s10", "the 10 oldest were dropped");
    assert.equal(kept.at(-1)!.sampleId, "s100009");

    const reloaded = new HealthStore("tok", "c2FsdHNhbHRzYWx0c2FsdA==", false);
    assert.equal(all(reloaded).length, 100_000);
    assert.equal((reloaded.now().steps as any).sampleId, "s100009");
  });
});
