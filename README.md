# mibly-receiver

Reference **Local** receiver and MCP server for the [Mibly](https://mibly.app) iPhone app.

Mibly reads Apple Health on your iPhone and pushes it over your own network to a small
service that **you** run. This repository is that service, in about 250 lines of
TypeScript, so you can read exactly where your data goes.

It does three things:

1. `POST /ingest`: receives samples pushed by the iPhone.
2. Stores them **encrypted on the machine it runs on** (`~/.mibly/data.enc`).
3. Exposes them to an AI agent through MCP (`POST /mcp`, tools `health_now` and `health_detail`).

This is the same protocol the Mibly app's "Agent setup prompt" asks an agent to build.
This repo is a ready-made, reviewable implementation of it. See [PROTOCOL.md](PROTOCOL.md).
Mibly's optional Cloud mode is a separate product and is not part of this repository.

## Where does the data go?

| Question | Answer |
|---|---|
| Where is health data stored? | `~/.mibly/data.enc` only. AES-256-GCM, key = scrypt(pairing token, random salt). |
| Does the service make outbound network requests? | No. It only listens. It has no telemetry and no update check. |
| Who can read it over the network? | Anyone holding the pairing token. Every route requires `Authorization: Bearer <token>`. |
| How long is it kept? | 30 days of history (max 25,000 samples). Only the latest sample per type is kept longer. |
| Is traffic encrypted in transit? | **No.** The iPhone talks plain HTTP, intended for a trusted LAN or VPN. Do not expose the port to the public internet. |

Check it yourself. This should print nothing:

```sh
grep -rnE "fetch\(|https?\.request|axios|net\.connect|XMLHttpRequest" src
```

## Run

Requires Node.js 18+.

```sh
npm ci
npm run build
MIBLY_TOKEN=<token from the Mibly app> npm start
```

On first run the token is saved to `~/.mibly/config.json` (mode 0600), so later restarts
need no env var. Then enter `<this machine's LAN IP>:7345` in the app's Target Host field
(just `IP:port`, no `http://` and no path).

| Variable | Meaning | Default |
|---|---|---|
| `MIBLY_TOKEN` | Pairing token from the app | saved config |
| `MIBLY_HOST` | Bind address `host:port` | `0.0.0.0:7345` |

Connect an MCP client (HTTP) to `http://<ip>:7345/mcp` with header
`Authorization: Bearer <token>`. For agents that spawn MCP servers over stdio, run with
`--stdio` as well (logs go to stderr).

If you regenerate the token in the app, restart with the new `MIBLY_TOKEN`. The old
encrypted store cannot be decrypted by the new key, so the receiver starts empty.

## Layout

| File | Role |
|---|---|
| `src/index.ts` | HTTP server and routes |
| `src/auth.ts` | Bearer token check (constant time) |
| `src/config.ts` | `~/.mibly/config.json` |
| `src/ingest.ts` | Payload validation |
| `src/store.ts` | Encryption, retention, queries |
| `src/mcp.ts` | The two MCP tools |

## Test

```sh
npm test
```

Starts the real server against a temporary `$HOME` and checks auth, validation,
the MCP handshake and tools, retention, the on-disk format, restart and token rotation.

## License

MIT. See [SECURITY.md](SECURITY.md) for the threat model.
