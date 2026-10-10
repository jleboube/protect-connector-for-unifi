import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startMockProtect, type MockProtect } from "@unifi-mcp/mock-protect";

const STDIO = fileURLToPath(new URL("../dist/stdio.js", import.meta.url));

describe("stdio server (built binary) against the mock", () => {
  let mock: MockProtect;
  beforeAll(async () => {
    mock = await startMockProtect({ apiKey: "stdio-key" });
  });
  afterAll(async () => {
    await mock.close();
  });

  it("starts, lists tools and answers in local mode", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO],
      env: { UNIFI_API_KEY: "stdio-key", UNIFI_HOST: mock.url, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);
    const r = (await client.callTool({ name: "protect_get_info", arguments: {} })) as CallToolResult;
    expect((r.content[0] as { text: string }).text).toContain("Protect version: 7.2.105");
    const snap = (await client.callTool({ name: "protect_get_snapshot", arguments: { camera: "Driveway" } })) as CallToolResult;
    expect(snap.content[0].type).toBe("image");
    await client.close();
  });

  it("runs in cloud mode against a mock api.ui.com", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [STDIO],
      env: { UNIFI_API_KEY: "stdio-key", UNIFI_CLOUD_BASE_URL: mock.url, PATH: process.env.PATH ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("unifi_list_consoles");
    const r = (await client.callTool({ name: "protect_list_cameras", arguments: {} })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    await client.close();
  });

  it("exits with a helpful message when the key is missing", async () => {
    const { spawnSync } = await import("node:child_process");
    const out = spawnSync(process.execPath, [STDIO], { env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 10000 });
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/UNIFI_API_KEY is not set/);
  });
});
