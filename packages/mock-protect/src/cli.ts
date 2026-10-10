#!/usr/bin/env node
import { startMockProtect } from "./index.js";

const port = Number(process.env.PORT ?? 8787);
const apiKey = process.env.MOCK_API_KEY ?? "test-key";
startMockProtect({ port, apiKey, hosts: (process.env.MOCK_HOSTS as "one" | "two") ?? "one" }).then((m) => {
  process.stderr.write(`Mock UniFi Protect on ${m.url} (X-API-KEY: ${apiKey === "test-key" ? "test-key" : "<custom>"})\n`);
  process.stderr.write(`Local mode:  UNIFI_HOST=${m.url} UNIFI_API_KEY=${apiKey === "test-key" ? "test-key" : "<key>"}\n`);
  process.stderr.write(`Cloud mode:  UNIFI_CLOUD_BASE_URL=${m.url} UNIFI_API_KEY=...\n`);
});
