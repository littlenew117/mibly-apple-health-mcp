# Security notes

## Threat model

- **Protects against:** another process or user reading health data from disk (it is
  encrypted, and `~/.mibly` is 0700 with 0600 files); unauthenticated network callers
  (every route requires the pairing token, checked in constant time before any body is parsed).
- **Does not protect against:** anyone on the network path (traffic is plain HTTP, which is what the
  iPhone app speaks), or anyone who can read `~/.mibly/config.json`. That file holds the token
  in plaintext, and the data key is derived from it. Treat it like an SSH private key.
- Run it on a trusted LAN or a VPN. Do not forward the port to the public internet.

## Data flow

iPhone → `POST /ingest` → `~/.mibly/data.enc` → `health_now` / `health_detail` → your MCP client.
The service never contacts any other host. The token is never logged or returned by any endpoint.

## Reporting a vulnerability

Please open a private security advisory on this repository's GitHub Security tab.
