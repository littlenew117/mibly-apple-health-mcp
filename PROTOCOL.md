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
- `type` is one of: `sleep`, `steps`, `heartRate`, `hrv`, `workout`, `weight`, `bodyFat`, `menstrualFlow`.
- `start`/`end` are ISO 8601 (the app sends UTC with `Z`). Only their string type is checked at ingestion.
- `sleep` may also carry `date` (wake-up date, `YYYY-MM-DD`, in the iPhone's calendar), `totalSleepMinutes`,
  `deepMinutes`, `coreMinutes`, `remMinutes`, `awakeMinutes` (each may be `null` = not recorded), `sleepStart`, `sleepEnd`.
  `value` is minutes (`unit: "min"`). These are stored and returned untouched. Legacy sleep samples without them remain valid.
- `bodyFat`: `value` is a percentage (`23.5` = 23.5%), `unit` is `%`.
- `menstrualFlow` exists only in Local mode.
- Invalid body: 400 `{"error":"malformed payload: expected { samples: HealthSample[] }"}`.
- Success: every sample is appended to history; `latest[type]` is set to the last sample of that type in the
  request; `lastPushAt` is set to the server time; response 200 `{"ok":true,"received":<n>}`.

## `GET /status`

200 `{"lastPushAt": <ISO|null>, "lastQueryAt": <ISO|null>, "lastQueryTool": <"health_now"|"health_detail:<type>"|null>}`.
`lastPushAt` is persisted; the other two are runtime-only.

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

## Presenting the data (also embedded in the MCP tool descriptions)

- Timestamps may be UTC (`Z`). Convert to the user's timezone when known; never show UTC as local; don't assume the agent host's timezone.
- Sleep `date` is authoritative; do not recompute it from UTC timestamps.
- Minutes may be fractional: keep raw values for calculation, round (not truncate) for display.
- `null` stage minutes mean unavailable, never 0.
- `bodyFat.value` is already a percentage.
