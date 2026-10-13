// End-to-end protocol tests: start the real server against a throwaway $HOME
// and talk to it the way the iPhone and an MCP client would.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createDecipheriv, scryptSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const TOKEN = "test-token-0123456789";
const PORT = 17000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const AUTH = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

let home: string;
let proc: ChildProcess;

function start(token: string) {
  return new Promise<ChildProcess>((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
      env: { ...process.env, HOME: home, MIBLY_TOKEN: token, MIBLY_HOST: `127.0.0.1:${PORT}` },
      stdio: ["ignore", "ignore", "pipe"],
    });
    p.once("error", reject);
    p.stderr!.on("data", (d) => String(d).includes("listening") && resolve(p));
  });
}
const stop = (p: ChildProcess) => new Promise((r) => (p.once("exit", r), p.kill()));
const post = (path: string, body: unknown, headers: Record<string, string> = AUTH) =>
  fetch(BASE + path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

const now = Date.now();
const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
const sleep = {
  type: "sleep", start: iso(-8 * 3600e3), end: iso(-1 * 3600e3), value: 420.5, unit: "min",
  date: "2026-09-27", totalSleepMinutes: 420.5, deepMinutes: null, coreMinutes: 300.25, remMinutes: null,
  awakeMinutes: 12, sleepStart: iso(-8 * 3600e3), sleepEnd: iso(-1 * 3600e3),
};
const bodyFat = { type: "bodyFat", start: iso(-3600e3), end: iso(-3600e3), value: 23.5, unit: "%" };
const steps = { type: "steps", start: iso(-3600e3), end: iso(0), value: 4321, unit: "count", source: "iPhone" };

before(async () => {
  home = mkdtempSync(join(tmpdir(), "mibly-receiver-"));
  proc = await start(TOKEN);
});
after(async () => {
  await stop(proc);
  rmSync(home, { recursive: true, force: true });
});

describe("startup output", () => {
  it("prints a Target Host line the user can copy, never the token", async () => {
    const out = await new Promise<string>((resolve) => {
      const p = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
        env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "mibly-receiver-")), MIBLY_TOKEN: TOKEN, MIBLY_HOST: `127.0.0.1:${PORT + 1}` },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let buf = "";
      p.stderr!.on("data", (d) => {
        buf += d;
        if (buf.includes("Target Host")) (p.kill(), resolve(buf));
      });
    });
    assert.match(out, /Target Host to enter in Mibly/);
    assert.match(out, new RegExp(`127\\.0\\.0\\.1:${PORT + 1}`));
    assert.ok(!out.includes(TOKEN));
  });
});

describe("auth", () => {
  for (const [name, headers] of [
    ["missing token", {}],
    ["wrong token", { authorization: "Bearer nope" }],
  ] as const) {
    it(`401 on /status, /ingest and /mcp with ${name}`, async () => {
      for (const res of [
        await fetch(BASE + "/status", { headers }),
        await post("/ingest", { samples: [] }, headers),
        await post("/mcp", {}, headers),
      ]) {
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { error: "invalid or missing pairing token" });
      }
    });
  }
});

describe("/status and /ingest", () => {
  it("starts empty", async () => {
    const res = await fetch(BASE + "/status", { headers: AUTH });
    assert.equal(res.status, 200);
    const status = await res.json();
    assert.match(status.version, /^\d+\.\d+\.\d+$/);
    for (const c of ["bodyFat", "restingHeartRate", "walkingHeartRateAverage", "heartRateSummary", "sampleIdUpsert", "latestByEnd", "backfill"]) {
      assert.ok(status.capabilities.includes(c), c);
    }
    const { version: _v, capabilities: _c, ...rest } = status;
    assert.deepEqual(rest, { lastPushAt: null, lastQueryAt: null, lastQueryTool: null });
  });

  it("400 on malformed payloads", async () => {
    const expected = { error: "malformed payload: expected { samples: HealthSample[] }" };
    for (const body of [
      "not json",
      {},
      { samples: "x" },
      { samples: [{ type: "steps", start: "a", end: "b", value: "1", unit: "count" }] },
      { samples: [{ type: "steps", start: "a", end: "b", value: 1 }] },
      { samples: [{ type: "steps", start: "a", end: "b", value: 1, unit: "count", sampleId: 7 }] },
      { samples: [{ type: "heartRate", start: "a", end: "b", value: 70, unit: "bpm", heartRateSummary: { min: 80, avg: 70, max: 90, count: 3, context: "active" } }] },
      { samples: [{ type: "heartRate", start: "a", end: "b", value: 70, unit: "bpm", heartRateSummary: { min: 60, avg: 70, max: 90, count: 3, context: "running" } }] },
    ]) {
      const res = await post("/ingest", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), expected);
    }
  });

  it("skips unknown types instead of failing the whole batch, and reports them", async () => {
    const unknown = { type: "futureMetric", start: iso(-1000), end: iso(-1000), value: 1, unit: "x" };
    const res = await post("/ingest", { samples: [unknown, unknown, { type: "weight", start: iso(-5 * 86400e3), end: iso(-5 * 86400e3), value: 70, unit: "kg" }] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, received: 1, rejectedTypes: ["futureMetric"] });
  });

  it("accepts samples (incl. Sleep summary with null stages and bodyFat) and updates lastPushAt", async () => {
    const res = await post("/ingest", { samples: [sleep, bodyFat, steps], deviceName: "iPhone" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, received: 3 });
    const status = await (await fetch(BASE + "/status", { headers: AUTH })).json();
    assert.match(status.lastPushAt, /^\d{4}-\d\d-\d\dT.*Z$/);
  });
});

describe("MCP over Streamable HTTP", () => {
  async function connect() {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: AUTH } }));
    return client;
  }
  const payload = (r: any) => {
    assert.equal(r.content.length, 1);
    assert.equal(r.content[0].type, "text");
    assert.equal(r.structuredContent, undefined);
    return JSON.parse(r.content[0].text);
  };

  it("identifies as mibly 0.1.0 and lists exactly two tools", async () => {
    const client = await connect();
    assert.deepEqual(client.getServerVersion()?.name, "mibly");
    assert.deepEqual(client.getServerVersion()?.version, "0.1.0");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["health_detail", "health_now"]);
    const detail = tools.find((t) => t.name === "health_detail")!;
    assert.deepEqual((detail.inputSchema as any).required.sort(), ["end", "start", "type"]);
    assert.ok((detail.inputSchema as any).properties.type.enum.includes("bodyFat"));
    await client.close();
  });

  it("health_now is flat and preserves Sleep summary fields and nulls", async () => {
    const client = await connect();
    const out = payload(await client.callTool({ name: "health_now", arguments: {} }));
    assert.deepEqual(out.sleep, sleep);
    assert.equal(out.sleep.deepMinutes, null);
    assert.deepEqual(out.bodyFat, bodyFat);
    assert.deepEqual(out.steps, steps);
    assert.equal(out.latest, undefined);
    assert.ok(out.lastPushAt);
    assert.equal((await (await fetch(BASE + "/status", { headers: AUTH })).json()).lastQueryTool, "health_now");
    await client.close();
  });

  it("health_detail filters by type and range, and records lastQueryTool", async () => {
    const client = await connect();
    const args = { type: "steps", start: iso(-86400e3), end: iso(86400e3) };
    assert.deepEqual(payload(await client.callTool({ name: "health_detail", arguments: args })), [steps]);
    assert.deepEqual(payload(await client.callTool({ name: "health_detail", arguments: { ...args, type: "hrv" } })), []);
    const status = await (await fetch(BASE + "/status", { headers: AUTH })).json();
    assert.equal(status.lastQueryTool, "health_detail:hrv");
    assert.ok(status.lastQueryAt);
    await client.close();
  });
});

describe("retention", () => {
  it("keeps 365 days of history, drops older, clamps detail queries, but keeps `latest`", async () => {
    const recent = { type: "hrv", start: iso(-40 * 86400e3), end: iso(-40 * 86400e3), value: 50, unit: "ms" };
    const old = { type: "hrv", start: iso(-400 * 86400e3), end: iso(-400 * 86400e3), value: 40, unit: "ms" };
    // `old` is last in the request, but `latest` is chosen by end time, so `recent` stays latest.
    assert.equal((await post("/ingest", { samples: [recent, old] })).status, 200);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: AUTH } }));
    const r: any = await client.callTool({ name: "health_detail", arguments: { type: "hrv", start: iso(-500 * 86400e3), end: iso(0) } });
    assert.deepEqual(JSON.parse(r.content[0].text), [recent], "40 days old is kept, 400 days old is gone");
    const n: any = await client.callTool({ name: "health_now", arguments: {} });
    assert.deepEqual(JSON.parse(n.content[0].text).hrv, recent);
    await client.close();
  });
});

describe("dedupe, latest and heart rate types", () => {
  async function detail(type: string, start = iso(-30 * 86400e3), end = iso(86400e3)) {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: AUTH } }));
    const r: any = await client.callTool({ name: "health_detail", arguments: { type, start, end } });
    const now: any = await client.callTool({ name: "health_now", arguments: {} });
    await client.close();
    return { rows: JSON.parse(r.content[0].text), latest: JSON.parse(now.content[0].text) };
  }
  const hour = (h: number) => iso(-h * 3600e3);
  const hr = (h: number, context: string, avg: number, extra: object = {}) => ({
    type: "heartRate", start: hour(h + 1), end: hour(h), value: avg, unit: "bpm",
    heartRateSummary: { min: avg - 5, avg, max: avg + 5, count: 10, context }, ...extra,
  });

  it("stores hourly heart rate summaries and the daily types, returning them untouched", async () => {
    const a = hr(3, "sedentary", 60, { sampleId: "hk:heartRate:hourly-v1:a:sedentary" });
    const b = hr(3, "active", 110, { sampleId: "hk:heartRate:hourly-v1:a:active" });
    const resting = { type: "restingHeartRate", start: iso(-86400e3), end: iso(-1), value: 58, unit: "bpm", sampleId: "hk:restingHeartRate:day:x" };
    const walking = { type: "walkingHeartRateAverage", start: iso(-86400e3), end: iso(-1), value: 96, unit: "bpm", sampleId: "hk:walkingHeartRateAverage:day:x" };
    assert.equal((await post("/ingest", { samples: [a, b, resting, walking] })).status, 200);
    assert.deepEqual((await detail("heartRate")).rows, [a, b]);
    assert.deepEqual((await detail("restingHeartRate")).rows, [resting]);
    const { latest } = await detail("walkingHeartRateAverage");
    assert.deepEqual(latest.restingHeartRate, resting);
    assert.deepEqual(latest.walkingHeartRateAverage, walking);
  });

  it("a repeated sampleId replaces the stored sample (in-progress hour updated), never duplicates", async () => {
    const id = "hk:heartRate:hourly-v1:a:sedentary";
    const updated = hr(3, "sedentary", 64, { sampleId: id });
    await post("/ingest", { samples: [updated] });
    await post("/ingest", { samples: [updated] });
    const { rows } = await detail("heartRate");
    assert.equal(rows.length, 2);
    assert.equal(rows.find((r: any) => r.sampleId === id).value, 64);
  });

  it("without a sampleId, type+start+end is the key; a different end is a different sample", async () => {
    const w = { type: "weight", start: iso(-5 * 86400e3), end: iso(-5 * 86400e3), value: 71.5, unit: "kg" };
    await post("/ingest", { samples: [w, { ...w }] });
    let rows = (await detail("weight")).rows;
    assert.equal(rows.length, 1, "same key within and across requests is stored once");
    assert.equal(rows[0].value, 71.5, "the repeat overwrites");
    await post("/ingest", { samples: [{ ...w, end: iso(-5 * 86400e3 + 1000) }] });
    rows = (await detail("weight")).rows;
    assert.equal(rows.length, 2);
  });

  it("the same instant written with +00:00 instead of Z is the same key", async () => {
    const start = iso(-6 * 86400e3);
    const z = { type: "bodyFat", start, end: start, value: 20, unit: "%" };
    await post("/ingest", { samples: [z] });
    await post("/ingest", { samples: [{ ...z, start: start.replace("Z", "+00:00"), end: start.replace("Z", "+00:00"), value: 21 }] });
    const rows = (await detail("bodyFat", iso(-7 * 86400e3), iso(-5 * 86400e3))).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].value, 21);
  });

  it("latest is the greatest end, then the greatest start, regardless of arrival order", async () => {
    const mk = (startH: number, endH: number, value: number) => ({ type: "workout", start: hour(startH), end: hour(endH), value, unit: "min" });
    const newest = mk(2, 1, 30);
    await post("/ingest", { samples: [newest] });
    await post("/ingest", { samples: [mk(25, 24, 10), mk(10, 9, 20)] }); // backfill arrives later
    assert.deepEqual((await detail("workout")).latest.workout, newest);
    const longer = mk(3, 1, 45); // same end, earlier start: does not replace
    await post("/ingest", { samples: [longer] });
    assert.deepEqual((await detail("workout")).latest.workout, newest);
    const shorter = mk(1.5, 1, 15); // same end, later start: replaces
    await post("/ingest", { samples: [shorter] });
    assert.deepEqual((await detail("workout")).latest.workout, shorter);
  });

  it("an updated latest sample (same key, new value) becomes latest", async () => {
    const s = { type: "steps", start: iso(-3600e3), end: iso(0), value: 9999, unit: "count", source: "iPhone" };
    await post("/ingest", { samples: [s] });
    assert.equal((await detail("steps")).latest.steps.value, 9999);
    assert.equal((await detail("steps")).rows.filter((r: any) => r.start === s.start && r.end === s.end).length, 1);
  });
});

describe("upgrade", () => {
  it("drops legacy heartRate (no heartRateSummary) on load, keeps other data and the token", async () => {
    // `legacy` ends last, so it is the stored latest heartRate before the restart.
    const legacy = { type: "heartRate", start: iso(3600e3), end: iso(7200e3), value: 72, unit: "bpm" };
    const hourly = {
      type: "heartRate", start: iso(-7200e3), end: iso(-3600e3), value: 70, unit: "bpm",
      sampleId: "upgrade-test:hourly",
      heartRateSummary: { min: 60, avg: 70, max: 80, count: 12, context: "sedentary" },
    };
    const weight = { type: "weight", start: iso(-5400e3), end: iso(-5400e3), value: 61.2, unit: "kg", sampleId: "upgrade-test:weight" };
    assert.equal((await post("/ingest", { samples: [hourly, legacy, weight] })).status, 200);
    await stop(proc);
    proc = await start(TOKEN);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: AUTH } }));
    const range = { start: iso(-86400e3), end: iso(86400e3) };
    const hr: any = await client.callTool({ name: "health_detail", arguments: { type: "heartRate", ...range } });
    const records = JSON.parse(hr.content[0].text);
    assert.ok(records.some((r: any) => r.sampleId === "upgrade-test:hourly"), "hourly summary kept");
    assert.ok(records.every((r: any) => r.heartRateSummary), "legacy reading removed");
    const wt: any = await client.callTool({ name: "health_detail", arguments: { type: "weight", ...range } });
    assert.ok(JSON.parse(wt.content[0].text).some((r: any) => r.sampleId === "upgrade-test:weight"), "other types untouched");
    const now: any = await client.callTool({ name: "health_now", arguments: {} });
    assert.ok(JSON.parse(now.content[0].text).heartRate.heartRateSummary, "latest falls back to a summary, not the legacy reading");
    await client.close();
  });
});

describe("persistence", () => {
  it("writes 0600 files in the documented format (IV12 | tag16 | ciphertext, scrypt+AES-256-GCM)", () => {
    const dir = join(home, ".mibly");
    assert.equal(statSync(join(dir, "config.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "data.enc")).mode & 0o777, 0o600);
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    assert.equal(cfg.token, TOKEN);
    assert.equal(Buffer.from(cfg.salt, "base64").length, 16);
    const blob = readFileSync(join(dir, "data.enc"));
    const d = createDecipheriv("aes-256-gcm", scryptSync(TOKEN, cfg.salt, 32), blob.subarray(0, 12));
    d.setAuthTag(blob.subarray(12, 28));
    const plain = JSON.parse(Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString());
    assert.deepEqual(Object.keys(plain).sort(), ["history", "lastPushAt", "latest"]);
    assert.ok(!blob.includes(Buffer.from("4321")), "plaintext must not appear on disk");
  });

  it("keeps data across restarts with the same token, and starts empty when the token changes", async () => {
    await stop(proc);
    proc = await start(TOKEN);
    let status = await (await fetch(BASE + "/status", { headers: AUTH })).json();
    assert.ok(status.lastPushAt, "data survives restart");
    assert.equal(status.lastQueryTool, null, "query status is runtime-only");

    await stop(proc);
    const NEW = "rotated-token-9876543210";
    proc = await start(NEW);
    status = await (await fetch(BASE + "/status", { headers: { authorization: `Bearer ${NEW}` } })).json();
    assert.equal(status.lastPushAt, null);
    assert.equal((await fetch(BASE + "/status", { headers: AUTH })).status, 401, "old token no longer works");
  });
});
