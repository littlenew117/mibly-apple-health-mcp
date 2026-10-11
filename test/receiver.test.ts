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
    assert.deepEqual(await res.json(), { lastPushAt: null, lastQueryAt: null, lastQueryTool: null });
  });

  it("400 on malformed payloads", async () => {
    const expected = { error: "malformed payload: expected { samples: HealthSample[] }" };
    for (const body of [
      "not json",
      {},
      { samples: "x" },
      { samples: [{ type: "steps", start: "a", end: "b", value: "1", unit: "count" }] },
      { samples: [{ type: "nope", start: "a", end: "b", value: 1, unit: "count" }] },
      { samples: [{ type: "steps", start: "a", end: "b", value: 1 }] },
    ]) {
      const res = await post("/ingest", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), expected);
    }
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
  it("drops history older than 30 days and clamps detail queries, but keeps `latest`", async () => {
    const old = { type: "hrv", start: iso(-40 * 86400e3), end: iso(-40 * 86400e3), value: 50, unit: "ms" };
    assert.equal((await post("/ingest", { samples: [old] })).status, 200);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(BASE + "/mcp"), { requestInit: { headers: AUTH } }));
    const r: any = await client.callTool({ name: "health_detail", arguments: { type: "hrv", start: iso(-60 * 86400e3), end: iso(0) } });
    assert.deepEqual(JSON.parse(r.content[0].text), []);
    const n: any = await client.callTool({ name: "health_now", arguments: {} });
    assert.deepEqual(JSON.parse(n.content[0].text).hrv, old);
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
