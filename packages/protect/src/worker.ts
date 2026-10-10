/**
 * Cloudflare Worker: remote MCP over Streamable HTTP (stateless, JSON responses).
 *
 * Security model
 *  - Keys are never stored. Each request carries the user's Site Manager key in
 *    the X-UniFi-API-Key header (or Authorization: Bearer). It is used for that
 *    request's upstream calls to api.ui.com and then dropped.
 *  - Nothing is logged: no console.* calls, and observability is off in wrangler.toml.
 *  - Cloud mode only, upstream fixed to https://api.ui.com: the Worker can't be
 *    pointed at arbitrary hosts (no SSRF).
 *  - Abuse protection: per-IP and per-key rate limits (Workers Rate Limiting
 *    bindings), request body cap, POST-only MCP endpoint, browser Origin check.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { SlidingWindowLimiter, UnifiClient, isUnifiError, sha256Hex } from "@unifi-mcp/core";
import { cleanValue } from "./config.js";
import { createProtectServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  IP_LIMITER?: RateLimit;
  KEY_LIMITER?: RateLimit;
  /** Comma-separated browser origins allowed to call /mcp (default: none). */
  ALLOWED_ORIGINS?: string;
}

export interface HandlerOptions {
  /** Tests only; production is always https://api.ui.com. */
  cloudBaseUrl?: string;
  maxBodyBytes?: number;
}

const MAX_BODY_BYTES = 128 * 1024;
// Per-isolate state. Shared limiter keeps each console under 100 req/min within
// this isolate; console auto-selection is cached by SHA-256 of the key (never the key itself).
const consoleLimiter = new SlidingWindowLimiter(100, 60_000);
const consoleCache = new Map<string, { id: string; at: number }>();
const CONSOLE_CACHE_TTL_MS = 10 * 60_000;

const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function createHandler(hopts: HandlerOptions = {}) {
  return async function handle(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return text(
        `${SERVER_NAME} ${SERVER_VERSION}\nRead-only MCP server for UniFi Protect (community project, not affiliated with Ubiquiti).\nMCP endpoint: POST ${url.origin}/mcp with header X-UniFi-API-Key: <Site Manager API key>.\nSource: https://github.com/jleboube/unifi-mcp\n`,
      );
    }
    if (url.pathname === "/health") return text("ok\n");
    if (url.pathname !== "/mcp") return text("Not found\n", 404);

    if (request.method !== "POST") {
      // Stateless server: no SSE GET stream and no sessions to DELETE.
      return json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST." }, id: null }, 405, { Allow: "POST" });
    }

    // Browsers send Origin; native MCP clients don't. Block cross-site browser use.
    const origin = request.headers.get("origin");
    if (origin) {
      const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!allowed.includes(origin)) return json(rpcError("Origin not allowed."), 403);
    }

    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (env.IP_LIMITER && !(await env.IP_LIMITER.limit({ key: `ip:${ip}` })).success) {
      return json(rpcError("Too many requests. Slow down and try again in a minute."), 429, { "Retry-After": "60" });
    }

    const declared = Number(request.headers.get("content-length") ?? "0");
    const maxBody = hopts.maxBodyBytes ?? MAX_BODY_BYTES;
    if (declared > maxBody) return json(rpcError("Request body too large."), 413);
    const raw = await request.text();
    if (raw.length > maxBody) return json(rpcError("Request body too large."), 413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
    }

    const apiKey = extractKey(request);
    let keyHash: string | undefined;
    if (apiKey) {
      keyHash = await sha256Hex(apiKey);
      if (env.KEY_LIMITER && !(await env.KEY_LIMITER.limit({ key: `key:${keyHash}` })).success) {
        return json(rpcError("Too many requests for this API key. Try again in a minute."), 429, { "Retry-After": "60" });
      }
    }

    // Console selector: an ID or a console name (validated loosely; it never reaches a URL unless it's a valid ID).
    let consoleSelector = cleanValue(request.headers.get("x-unifi-console-id"));
    if (consoleSelector && (consoleSelector.length > 200 || /[\u0000-\u001f]/.test(consoleSelector))) consoleSelector = undefined;

    const server = apiKey
      ? createProtectServer({
          client: new UnifiClient({
            apiKey,
            mode: "cloud",
            cloudBaseUrl: hopts.cloudBaseUrl,
            limiter: consoleLimiter,
            timeoutMs: 24_000,
            userAgent: `protect-connector-for-unifi/${SERVER_VERSION} (worker)`,
          }),
          defaultConsole: consoleSelector,
          consoleCache: {
            get: (selector) => {
              const hit = keyHash ? consoleCache.get(`${keyHash}|${selector.toLowerCase()}`) : undefined;
              return hit && Date.now() - hit.at < CONSOLE_CACHE_TTL_MS ? hit.id : undefined;
            },
            set: (selector, id) => {
              if (consoleCache.size > 5000) consoleCache.clear();
              if (keyHash) consoleCache.set(`${keyHash}|${selector.toLowerCase()}`, { id, at: Date.now() });
            },
          },
          jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
          transportLabel: "UniFi cloud connector via remote Worker",
        })
      : createKeylessServer();

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(request, { parsedBody: parsed });
      return withHeaders(res, SECURITY_HEADERS);
    } catch (e) {
      return json(rpcError(isUnifiError(e) ? e.toUserMessage() : "Internal error"), 500);
    } finally {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    }
  };
}

/**
 * Without a key we still answer initialize/tools/list (so clients can show the
 * tool list), but every tool call explains how to configure the key. We avoid
 * HTTP 401 on purpose: MCP clients treat 401 as "start OAuth", which we don't offer.
 */
function createKeylessServer() {
  return createProtectServer({
    client: new UnifiClient({ apiKey: "unset", mode: "cloud", cloudBaseUrl: "https://invalid.invalid" }),
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
    unconfiguredMessage:
      "No UniFi API key was sent. Set UNIFI_API_KEY in the plugin settings to a Site Manager API key from unifi.ui.com → Settings → API Keys (Remote Access must be on for the console).",
  });
}

function extractKey(request: Request): string | undefined {
  const direct = cleanValue(request.headers.get("x-unifi-api-key"));
  if (direct) return direct;
  const auth = request.headers.get("authorization");
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth) : null;
  return cleanValue(m?.[1]);
}

function rpcError(message: string) {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...extra } });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS } });
}

function withHeaders(res: Response, extra: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const handler = createHandler();
export default {
  fetch: (request: Request, env: Env) => handler(request, env),
};
