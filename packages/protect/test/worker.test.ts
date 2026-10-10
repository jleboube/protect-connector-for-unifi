import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startMockProtect, fixtures, type MockProtect } from "@unifi-mcp/mock-protect";
import { createHandler, type Env } from "../src/worker.js";

const KEY = "worker-secret-key-123";
const BASE = "https://unifi-mcp.test";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    IP_LIMITER: { limit: async () => ({ success: true }) },
    KEY_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  };
}

describe("Cloudflare Worker handler (Streamable HTTP, stateless)", () => {
  let mock: MockProtect;
  let handler: ReturnType<typeof createHandler>;
  const responses: string[] = [];

  beforeAll(async () => {
    mock = await startMockProtect({ apiKey: KEY });
    handler = createHandler({ cloudBaseUrl: mock.url });
  });
  afterAll(async () => {
    await mock.close();
  });

  async function mcpClient(headers: Record<string, string>, env = makeEnv()) {
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers },
      fetch: async (url, init) => {
        const res = await handler(new Request(url, init as RequestInit), env);
        const clone = res.clone();
        responses.push(await clone.text());
        return res;
      },
    });
    const client = new Client({ name: "worker-test", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }

  it("serves tools with a per-request key and never echoes it", async () => {
    const client = await mcpClient({ "X-UniFi-API-Key": KEY });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("unifi_list_consoles");
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
    const r = (await client.callTool({ name: "protect_list_cameras", arguments: {} })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect((r.content[0] as { text: string }).text).toMatch(/^4 cameras/);
    const snap = (await client.callTool({ name: "protect_get_snapshot", arguments: { camera: "Front Door" } })) as CallToolResult;
    expect(snap.content[0].type).toBe("image");
    await client.close();
    expect(responses.some((t) => t.includes(KEY))).toBe(false);
    // Upstream calls went through the cloud connector path only.
    expect(mock.requests.every((r) => r.url === "/v1/hosts?pageSize=100" || r.url.startsWith("/v1/connector/consoles/"))).toBe(true);
  });

  it("accepts Authorization: Bearer and an explicit console header", async () => {
    const client = await mcpClient({ Authorization: `Bearer ${KEY}`, "X-UniFi-Console-Id": fixtures.CONSOLE_ID_CABIN });
    const r = (await client.callTool({ name: "protect_get_info", arguments: {} })) as CallToolResult;
    expect((r.content[0] as { text: string }).text).toContain(fixtures.CONSOLE_ID_CABIN);
    await client.close();
  });

  it("ignores unsubstituted ${VAR} placeholders", async () => {
    const client = await mcpClient({ "X-UniFi-API-Key": KEY, "X-UniFi-Console-Id": "${UNIFI_CONSOLE_ID}" });
    const r = (await client.callTool({ name: "protect_list_lights", arguments: {} })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    await client.close();
  });

  it("lists tools without a key but explains how to configure it on call", async () => {
    const client = await mcpClient({});
    const { tools } = await client.listTools();
    expect(tools.length).toBe(12);
    const r = (await client.callTool({ name: "protect_list_cameras", arguments: {} })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/No UniFi API key was sent/);
    await client.close();
  });

  const rpc = (body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("rejects GET, browser origins, oversize and malformed bodies", async () => {
    expect((await handler(new Request(`${BASE}/mcp`), makeEnv())).status).toBe(405);
    expect((await handler(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Origin: "https://evil.example" }), makeEnv())).status).toBe(403);
    expect((await handler(rpc("x".repeat(200 * 1024)), makeEnv())).status).toBe(413);
    expect((await handler(rpc("{not json"), makeEnv())).status).toBe(400);
    expect((await handler(new Request(`${BASE}/nope`), makeEnv())).status).toBe(404);
    const health = await handler(new Request(`${BASE}/health`), makeEnv());
    expect(await health.text()).toBe("ok\n");
    const home = await handler(new Request(`${BASE}/`), makeEnv());
    expect(await home.text()).toMatch(/not affiliated with Ubiquiti/);
  });

  it("rate-limits by IP and by key", async () => {
    const deny = { limit: async () => ({ success: false }) };
    const byIp = await handler(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), makeEnv({ IP_LIMITER: deny }));
    expect(byIp.status).toBe(429);
    const byKey = await handler(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "X-UniFi-API-Key": KEY }), makeEnv({ KEY_LIMITER: deny }));
    expect(byKey.status).toBe(429);
    expect(await byKey.text()).not.toContain(KEY);
  });

  it("keys the per-key limiter by a hash, not the key", async () => {
    const seen: string[] = [];
    const spy = { limit: async ({ key }: { key: string }) => (seen.push(key), { success: true }) };
    await handler(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "X-UniFi-API-Key": KEY }), makeEnv({ KEY_LIMITER: spy }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^key:[0-9a-f]{64}$/);
    expect(seen[0]).not.toContain(KEY);
  });

  it("sets no-store on MCP responses", async () => {
    const res = await handler(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } } }), makeEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
