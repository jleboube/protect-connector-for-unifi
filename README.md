# Protect Connector for UniFi (community)

Community [Model Context Protocol](https://modelcontextprotocol.io) connectors for Ubiquiti UniFi, built on Ubiquiti's **official Integration APIs** (API-key auth, no username/password scraping).

| Package | What it is | Status |
|---|---|---|
| [`packages/core`](packages/core) | Shared client: API-key auth, local vs cloud-connector routing, error mapping, rate limiting, Site Manager console discovery | v0.1 |
| [`packages/protect`](packages/protect) | **Protect Connector for UniFi (community)**: read-only MCP server for UniFi Protect (stdio + Cloudflare Worker) | v0.1 |
| [`packages/mock-protect`](packages/mock-protect) | Mock Protect Integration API + Site Manager `/v1/hosts` for tests and local dev | v0.1 |
| `packages/network` | UniFi Network connector on the same core | planned |
| [`plugins/protect-connector-for-unifi`](plugins/protect-connector-for-unifi) | Marketplace plugin (manifest, `mcp.json`, logo, listing copy) | v0.1, not submitted |

> **Disclaimer.** This is an independent community project. It is **not affiliated with, endorsed by, or sponsored by Ubiquiti Inc.** "UniFi" and "UniFi Protect" are trademarks of Ubiquiti Inc. and are used only to describe compatibility.

## Protect Connector for UniFi: tools (all read-only)

| Tool | Description |
|---|---|
| `unifi_list_consoles` | Cloud mode only. Consoles visible to the Site Manager key, with console IDs, state, apps, Protect version |
| `protect_get_info` | Protect version + NVR name/model + alarm arm state; confirms the connection |
| `protect_list_cameras` | Cameras with online state, model, enabled smart detections; filter by name/state |
| `protect_get_camera` | One camera by id or name |
| `protect_get_snapshot` | Live JPEG as MCP `image` content; `channel` main/package, `high_quality` |
| `protect_get_nvr` | NVR details |
| `protect_list_lights`, `protect_list_chimes`, `protect_list_sensors`, `protect_list_viewers` | Device status |
| `protect_get_device` | One light/chime/sensor/viewer by id |
| `protect_get_stream_urls` | **Sensitive.** Existing RTSPS URLs, masked unless `reveal=true`; never creates streams |

Outputs are short text summaries, not raw JSON. v0.1 contains **no write code at all**: the core client only implements `GET`.

Every endpoint used is in Ubiquiti's published Protect API specs for **7.2.105** and **7.3.70** (their path sets are identical). Older Protect versions that lack an endpoint get a friendly "not found / not on this version" message instead of a crash.

## Two ways to run it

### 1. Remote (default for the plugin): Cloudflare Worker + UniFi cloud connector

`https://unifi-mcp.ai-sherpa.rocks/mcp` speaks Streamable HTTP (stateless, JSON responses). It reaches your console through Ubiquiti's Site Manager connector, `https://api.ui.com/v1/connector/consoles/{consoleId}/proxy/protect/integration/v1/...`, so no LAN access or port forwarding is needed.

- Send your **Site Manager API key** (unifi.ui.com → Settings → API Keys) as `X-UniFi-API-Key: <key>` (or `Authorization: Bearer <key>`). Optional `X-UniFi-Console-Id`.
- The console needs firmware ≥ 5.0.3 and **Remote Access** enabled. Ubiquiti allows 100 requests/min per console through the connector.

**Security model.** No keys are stored: each request's key is used for that request's calls to `api.ui.com` and discarded. Nothing is logged (no `console.*` calls; Workers observability is off). The upstream is fixed to `api.ui.com`, so the Worker can't be used to reach other hosts. Abuse controls: per-IP (120/min) and per-key-hash (100/min) Workers rate limits, a per-console limiter, a 128 KB body cap, POST-only `/mcp`, and rejection of browser `Origin`s. Without a key, `tools/list` works, but every call explains how to configure the key. It never returns 401, because MCP clients treat 401 as "start OAuth".

### 2. Local (stdio): LAN or cloud

```bash
pnpm install && pnpm build
UNIFI_HOST=192.168.1.1 UNIFI_API_KEY=<console key> node packages/protect/dist/stdio.js
```

MCP client config:

```json
{
  "mcpServers": {
    "protect-connector-for-unifi": {
      "command": "node",
      "args": ["/path/to/protect-connector-for-unifi/packages/protect/dist/stdio.js"],
      "env": { "UNIFI_HOST": "192.168.1.1", "UNIFI_API_KEY": "<key>" }
    }
  }
}
```

| Variable | Meaning |
|---|---|
| `UNIFI_API_KEY` | **Required.** Local: console key from the console's *Settings → Control Plane → Integrations*. Cloud: Site Manager key. |
| `UNIFI_HOST` | Console IP/hostname. Setting it selects local mode. |
| `UNIFI_CONSOLE_ID` | Cloud mode console, by ID or name (otherwise auto-detected when exactly one online console runs Protect 5.3+). Duplicate names resolve to the online console running Protect. |
| `UNIFI_MODE` | Force `local` or `cloud`. |
| `UNIFI_VERIFY_TLS` | Local mode. Default `false`, because consoles ship self-signed certs. Cloud mode always verifies. |

## Development

```bash
pnpm install
pnpm test            # builds, then runs unit + MCP integration tests (vitest)
pnpm mock            # mock Protect on http://127.0.0.1:8787 (key: test-key)
cd packages/protect && wrangler dev      # Worker locally
```

The tests cover:
- the core client: routing, error mapping, 429/Retry-After, the limiter, timeouts and console discovery
- every MCP tool through an in-memory MCP client
- the built stdio binary, spawned as a real MCP subprocess
- the Worker handler through the SDK's Streamable HTTP client, including the abuse controls and checks that the key never appears in responses

## Deployment

The hosted connector used by the plugin runs as a Cloudflare Worker at `https://unifi-mcp.ai-sherpa.rocks/mcp`.

To run your own copy:

1. Set `CLOUDFLARE_ACCOUNT_ID` (or uncomment `account_id` in `packages/protect/wrangler.toml`) and use a token with *Workers Scripts: Edit*.
2. Optionally uncomment `routes` in `wrangler.toml` and set a custom domain on a zone you own (also needs *Workers Routes / Zone: Edit*). Otherwise the Worker is served on your `workers.dev` subdomain.
3. Run `pnpm install && cd packages/protect && npx wrangler deploy`.
4. Point the plugin's `mcp.json` `url` at your Worker's `/mcp` endpoint.

`wrangler.toml` keeps request logging and observability off and defines the two rate-limit bindings.

## Credits

Design ideas (a read-only default, cloud-connector support, safety annotations) were inspired by [owine/unifi-protect-mcp](https://github.com/owine/unifi-protect-mcp) (MIT). No code was copied. API shapes come from Ubiquiti's public docs at [developer.ui.com](https://developer.ui.com/protect).

## License

[MIT](LICENSE)

## Real-hardware notes (tested Oct 2026, Protect 7.2.105 via the cloud connector)

- Every read endpoint used here exists on 7.2.105; no 404s were seen and field shapes matched the published spec.
- Typical latency through the hosted Worker: 0.3–0.7 s per list/get call, ~1 s for `unifi_list_consoles`, 1–2 s for the first call or name lookups, ~6 s for a 4K snapshot.
- Site Manager's `userData.controllers` lists apps a console *supports*; the connector only trusts `reportedState.controllers[].isInstalled`.
- A console you can see but not administer answers HTTP 403 "insufficient permissions for this host"; the connector explains this rather than calling the key invalid.
- Some cameras return 4K snapshots (~0.8 MB JPEG) even with `high_quality=false`.
