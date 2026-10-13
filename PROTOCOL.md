# Mibly Local protocol

What the Mibly iPhone app sends and expects, and what this receiver implements.
Any implementation (including one an agent writes for you) must follow this exactly.

## Network

- TCP `7345` by default, listening on `0.0.0.0` (not only loopback; the iPhone must reach it).
- The app is given only `IP:port` as its Target Host and builds `http://<host>/ingest` and `http://<host>/status` itself.

## Authentication

`POST /ingest`, `GET /status` and `POST /mcp` all require `Authorization: Bearer <pairing token>`.
Otherwise: HTTP 401 `{"error":"invalid or missing pairing token"}`.

## `POST /ingest`

JSON body, up to 2 MB:

```json
{
  "samples": [
    { "type": "steps", "start": "2026-09-27T00:00:00Z", "end": "2026-09-27T08:30:00Z",
      "value": 4321, "unit": "count", "source": "optional" }
  ],
  "deviceName": "optional, accepted but not stored"
}
```

- Required per sample: `type`, `start`, `end` (strings), `value` (number), `unit` (string). Optional: `source`.
- `type` is one of: `sleep`, `steps`, `heartRate`, `restingHeartRate`, `walkingHeartRateAverage`, `hrv`, `workout`, `weight`, `bodyFat`, `menstrualFlow`.
  A sample with any other `type` is skipped (not stored) and does not fail the batch; the response lists it in `rejectedTypes`.
- Optional `sampleId` (string): the phone's stable identity for the sample. See "Dedupe" below.
- `start`/`end` are ISO 8601 (the app sends UTC with `Z`). Only their string type is checked at ingestion.
- `sleep` may also carry `date` (wake-up date, `YYYY-MM-DD`, in the iPhone's calendar), `totalSleepMinutes`,
  `deepMinutes`, `coreMinutes`, `remMinutes`, `awakeMinutes` (each may be `null` = not recorded), `sleepStart`, `sleepEnd`.
  `value` is minutes (`unit: "min"`). These are stored and returned untouched. Legacy sleep samples without them remain valid.
- `bodyFat`: `value` is a percentage (`23.5` = 23.5%), `unit` is `%`.
- `heartRate` is an hourly summary: `value` is the hour's average bpm and `heartRateSummary` is
  `{"min":number,"avg":number,"max":number,"count":number,"context":"sedentary"|"active"|"unknown"}` (`min <= avg <= max`).
  One hour can arrive once per `context`. The in-progress hour is re-sent with updated values. A malformed `heartRateSummary` is a 400.
  Older phones send single readings without `heartRateSummary`; they are stored as-is.
- `restingHeartRate` and `walkingHeartRateAverage`: one sample per day, `value` in bpm, `unit` `bpm`.
- `menstrualFlow` exists only in Local mode.
- Invalid body: 400 `{"error":"malformed payload: expected { samples: HealthSample[] }"}`.
- Success: each sample is stored once (see "Dedupe"); `latest[type]` is updated (see "Latest"); `lastPushAt` is set to
  the server time; response 200 `{"ok":true,"received":<n>}` (`n` counts accepted samples), plus `"rejectedTypes":[...]` if any type was unknown.

### Dedupe

A sample's key is its `sampleId` when it has one, otherwise `type` + `start` + `end` (timestamps compared as instants).
A sample whose key is already stored **replaces** the stored one; it never adds a second entry. Within one request the later one wins.
History is returned ordered by `start`, then `end`.

### Latest

`latest[type]` is the sample with the greatest `end`; on equal `end`, the greatest `start`; on a full tie the later arrival.
Arrival order does not matter, so a backfill of older samples never overwrites a newer latest value.

## `GET /status`

200 `{"version": "1.2.0", "capabilities": [...], "lastPushAt": <ISO|null>, "lastQueryAt": <ISO|null>, "lastQueryTool": <"health_now"|"health_detail:<type>"|null>}`.
`lastPushAt` is persisted; the other two are runtime-only.

`version` and `capabilities` let the app tell receivers apart; a receiver that omits them is treated as an older one.
Current capabilities: `bodyFat`, `restingHeartRate`, `walkingHeartRateAverage`, `heartRateSummary`, `sampleIdUpsert` (the Dedupe rule above),
`latestByEnd` (the Latest rule above), `backfill` (safe to receive about seven days of history after pairing).
Only advertise a capability you implement.

## `POST /mcp`

MCP Streamable HTTP, stateless (no session id; fresh transport and server per request).
Server name `mibly`, version `0.1.0`. Exactly two tools; results are one text content item
containing pretty-printed JSON (not `structuredContent`).

- `health_now` (no arguments): the latest sample per type, flattened, plus `lastPushAt`. Types never received are absent.
  With no data: `{"lastPushAt": null}`.
- `health_detail` (`type`, `start`, `end`, all required strings): a JSON array of stored samples of that
  `type` whose `start` is within `[max(start, now - 365 days), end]`.

Both record `lastQueryAt` / `lastQueryTool`. They read only what was pushed; they never contact the phone or HealthKit.

## Storage

- `~/.mibly/config.json` (0600): `{"token","salt","host"}`; `salt` is 16 random bytes, base64.
- `~/.mibly/data.enc` (0600): `IV (12 bytes) | GCM tag (16 bytes) | ciphertext`; key = `scrypt(token, salt, 32)`,
  AES-256-GCM, fresh random IV per write. Plaintext is `{"latest":{},"history":[],"lastPushAt":null}`.
- If the token changes: new salt, empty store. If `data.enc` is missing or undecryptable: empty store.
- Retention after each ingest: drop history whose `end` is older than 365 days, keep at most the last 25,000 entries.
  `latest` is not pruned.
- Upgrading from a receiver that predates `heartRateSummary`: on start-up, delete stored `heartRate` records that have no `heartRateSummary`
  (and fall back `latest.heartRate` to the newest remaining summary). Keep all other data, the token and the salt.

## Presenting the data (also embedded in the MCP tool descriptions)

- Timestamps may be UTC (`Z`). Convert to the user's timezone when known; never show UTC as local; don't assume the agent host's timezone.
- Sleep `date` is authoritative; do not recompute it from UTC timestamps.
- Minutes may be fractional: keep raw values for calculation, round (not truncate) for display.
- `null` stage minutes mean unavailable, never 0.
- `bodyFat.value` is already a percentage.
- `heartRate` samples are hourly summaries (`heartRateSummary`: min/avg/max/count and `context` sedentary/active/unknown); the newest hour may be in progress.
- `restingHeartRate` and `walkingHeartRateAverage` are separate daily values; never derive resting heart rate from `heartRate` minimums.
