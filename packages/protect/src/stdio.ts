#!/usr/bin/env node
/**
 * stdio entry point: run locally (LAN or cloud mode) and attach from any MCP client.
 * Logs go to stderr only and never include the API key.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { UnifiClient, isUnifiError, type FetchLike } from "@unifi-mcp/core";
import { Agent, fetch as undiciFetch } from "undici";
import { configFromEnv } from "./config.js";
import { createProtectServer, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const cfg = configFromEnv(process.env);
  let customFetch: FetchLike | undefined;
  if (cfg.mode === "local" && !cfg.verifyTls) {
    // UniFi consoles ship self-signed certificates. Only relax verification for
    // the configured console in local mode; cloud calls always verify TLS.
    const agent = new Agent({ connect: { rejectUnauthorized: false } });
    customFetch = (url, init) => undiciFetch(url, { ...(init as object), dispatcher: agent } as never) as unknown as Promise<Response>;
    process.stderr.write("protect-connector-for-unifi: TLS verification is off for the local console (self-signed certificate). Set UNIFI_VERIFY_TLS=true if it has a trusted certificate.\n");
  }
  const client = new UnifiClient({
    apiKey: cfg.apiKey,
    mode: cfg.mode,
    host: cfg.host,
    cloudBaseUrl: cfg.cloudBaseUrl,
    fetch: customFetch,
    userAgent: `protect-connector-for-unifi/${SERVER_VERSION}`,
  });
  const consoleCache = new Map<string, string>();
  const server = createProtectServer({
    client,
    defaultConsole: cfg.consoleId,
    consoleCache: { get: (sel) => consoleCache.get(sel.toLowerCase()), set: (sel, id) => void consoleCache.set(sel.toLowerCase(), id) },
    transportLabel: cfg.mode === "local" ? `local network (${cfg.host})` : "UniFi cloud connector (api.ui.com)",
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(`protect-connector-for-unifi ${SERVER_VERSION} ready (${cfg.mode} mode, read-only)\n`);
}

main().catch((e) => {
  process.stderr.write(`protect-connector-for-unifi: ${isUnifiError(e) ? e.toUserMessage() : "failed to start"}\n`);
  process.exit(1);
});
