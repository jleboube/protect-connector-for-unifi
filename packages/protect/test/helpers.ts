import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UnifiClient } from "@unifi-mcp/core";
import { createProtectServer } from "../src/server.js";

export async function connect(client: UnifiClient, cache?: { v?: string }, defaultConsole?: string) {
  const server = createProtectServer({
    client,
    defaultConsole,
    consoleCache: cache ? { get: () => cache.v, set: (_sel, id) => void (cache.v = id) } : undefined,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return {
    mcp,
    call: async (name: string, args: Record<string, unknown> = {}) => (await mcp.callTool({ name, arguments: args })) as CallToolResult,
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

export function textOf(r: CallToolResult): string {
  return r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
}
