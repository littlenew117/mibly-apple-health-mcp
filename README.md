[English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

# Apple Health MCP — Mibly Receiver

An open-source **Apple Health MCP server**: bring your Apple Health (HealthKit) data — sleep, steps, heart rate, HRV, workouts, weight, body fat, and more — into Claude Desktop/Code, Codex, or any other AI agent you build or run yourself (anything that speaks MCP).

**Local mode: your data never touches Mibly's servers.** No account, no cloud, no telemetry. It is stored encrypted on a machine you control, and this repository is the code that does it.

## Quickest way to get started

1. **Download Mibly** on your iPhone → [App Store](https://apps.apple.com/us/app/mibly-health-data-for-ai/id6812404098)
2. **Copy the setup prompt** from [mibly.app](https://mibly.app/) <!-- TODO: replace with the exact prompt page URL --> and paste it into your agent.

Your agent sets up the receiver and MCP service for you. No cloning, no building, no config files.

## Why an iPhone app?

Apple Health data can only be read through HealthKit, inside a native iOS app. There is no web API. Mibly handles the HealthKit side — permissions, background sync, and data formatting — so you don't need an Apple Developer account or Xcode.

## What this repository is

A reference implementation of the receiver your agent installs. It's here so you can:

- **Review** exactly what runs on your machine and where your data goes
- **Customize** it if you want to

You don't need this code to use Mibly. The setup prompt above is the recommended path.

## Where does the data go?

| Question | Answer |
|---|---|
| Where is health data stored? | `~/.mibly/data.enc` only. AES-256-GCM, key = scrypt(pairing token, random salt). |
| Does the service make outbound network requests? | No. It only listens. No telemetry, no update check. |
| Who can read it over the network? | Anyone holding the pairing token. Every route requires `Authorization: Bearer <token>`. |
| How long is it kept? | 30 days of history (max 25,000 samples). Only the latest sample per type is kept longer. |
| Is traffic encrypted in transit? | **No.** Local mode is designed for your home or office LAN: the iPhone and this receiver sit on the same Wi-Fi and talk plain HTTP. Don't expose the port to the public internet. |

Check it yourself. This should print nothing:

```sh
grep -rnE "fetch\(|https?\.request|axios|net\.connect|XMLHttpRequest" src
```

The wire protocol (endpoints, payloads, storage format) is in [PROTOCOL.md](PROTOCOL.md); the threat model is in [SECURITY.md](SECURITY.md).

## Run it yourself

Requires Node.js 18+.

```sh
npm ci
npm run build
MIBLY_TOKEN=<token from the Mibly app> npm start
```

On first run the token is saved to `~/.mibly/config.json` (mode 0600), so later restarts need no env var. On startup the receiver prints the address(es) to use, e.g. `Target Host to enter in Mibly: 192.168.1.24:7345 (en0)`. Enter that in the app's Target Host field (just `IP:port`, no `http://`, no path); pick the address on your Wi-Fi/LAN if several are listed.

| Variable | Meaning | Default |
|---|---|---|
| `MIBLY_TOKEN` | Pairing token from the app | saved config |
| `MIBLY_HOST` | Bind address `host:port` | `0.0.0.0:7345` |

Connect an MCP client over HTTP to `http://<ip>:7345/mcp` with the header `Authorization: Bearer <token>`. For agents that spawn MCP servers over stdio, add `--stdio` (logs go to stderr).

If you regenerate the token in the app, restart with the new `MIBLY_TOKEN`. The old encrypted store can't be decrypted with the new key, so the receiver starts empty.

Code map: `src/index.ts` (routes) · `src/auth.ts` (token check) · `src/config.ts` (`~/.mibly/config.json`) · `src/ingest.ts` (validation) · `src/store.ts` (encryption, retention, queries) · `src/mcp.ts` (the two tools). Run the tests with `npm test`.

## Local vs Cloud

| | Local (Free) | Cloud (Pro) |
|---|---|---|
| Data path | iPhone → an agent environment you control | iPhone → Mibly Cloud → your agents |
| Remote access across devices | — | ✓ |
| Multiple agents on the same data | — | ✓ |
| Menstrual cycle data | Available (off by default) | Never uploaded |

This repository covers Local only. You choose which data types are shared and can turn each one off at any time.

## Notes

- Mibly does not diagnose or make medical decisions. It only gives your agent access to the data you choose to share.
- Issues in this repo are for the receiver code. For app support, see [mibly.app](https://mibly.app/).
- Privacy policy: https://mibly.app/privacy/

## License

MIT <!-- TODO: confirm license -->
