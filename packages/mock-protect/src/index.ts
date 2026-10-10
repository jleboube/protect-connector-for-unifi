import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as fx from "./fixtures.js";
import { MOCK_JPEG_BASE64 } from "./jpeg.js";

export * as fixtures from "./fixtures.js";
export { MOCK_JPEG_BASE64 };

export interface MockOptions {
  /** Accepted X-API-KEY value. */
  apiKey?: string;
  /** Which hosts /v1/hosts returns. */
  hosts?: "one" | "two" | "none" | "fleet";
  /** Console ids that answer 403 "insufficient permissions for this host" through the connector. */
  forbiddenConsoles?: string[];
  /** Respond 429 to the next N Protect requests. */
  fail429?: number;
  /** Retry-After seconds to send with 429s. */
  retryAfterSeconds?: number;
  /** Paths (after /integration) that should 404 as if missing on older firmware. */
  missingPaths?: string[];
  /** Pretend the cloud connector can't reach the console (502). */
  consoleOffline?: boolean;
  port?: number;
}

export interface RecordedRequest {
  method: string;
  url: string;
  apiKey?: string;
}

export interface MockProtect {
  url: string;
  port: number;
  requests: RecordedRequest[];
  options: MockOptions;
  close(): Promise<void>;
}

const PROTECT_PREFIX = "/proxy/protect/integration";
const CONNECTOR_RE = /^\/v1\/connector\/consoles\/([^/]+)(\/proxy\/.*)$/;

/** Start a mock UniFi console + Site Manager on 127.0.0.1 (plain HTTP). */
export async function startMockProtect(options: MockOptions = {}): Promise<MockProtect> {
  const opts: MockOptions = { apiKey: "test-key", hosts: "one", retryAfterSeconds: 1, ...options };
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => handle(req, res, opts, requests));
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    options: opts,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function handle(req: IncomingMessage, res: ServerResponse, opts: MockOptions, log: RecordedRequest[]): void {
  const url = new URL(req.url ?? "/", "http://mock");
  const apiKey = header(req, "x-api-key");
  log.push({ method: req.method ?? "GET", url: url.pathname + url.search, apiKey });

  if (apiKey !== opts.apiKey) {
    return send(res, 401, { error: "Failed to authenticate request using 'apiKey'", name: "UNAUTHENTICATED", type: "apiKey" });
  }
  if (req.method !== "GET") return send(res, 405, { error: "Mock is read-only", name: "METHOD_NOT_ALLOWED" });

  // Site Manager
  if (url.pathname === "/v1/hosts") {
    const data = opts.hosts === "none" ? [] : opts.hosts === "fleet" ? fx.fleetHosts() : fx.hosts(opts.hosts ?? "one");
    return send(res, 200, { data, httpStatusCode: 200, traceId: "mock" });
  }

  // Cloud connector → local path
  let path = url.pathname;
  const m = CONNECTOR_RE.exec(path);
  if (m) {
    const known = [fx.CONSOLE_ID_HOME, fx.CONSOLE_ID_CABIN, ...Object.values(fx.FLEET)];
    const cid = decodeURIComponent(m[1]);
    if (opts.forbiddenConsoles?.includes(cid)) {
      return send(res, 403, { code: "forbidden", httpStatusCode: 403, message: "insufficient permissions for this host", traceId: "mock" });
    }
    if (!known.includes(cid)) return send(res, 404, { code: "not_found", httpStatusCode: 404, message: "console not found" });
    if (opts.consoleOffline) return send(res, 502, { code: "bad_gateway", httpStatusCode: 502, message: "console is not connected" });
    path = m[2];
  }
  if (!path.startsWith(PROTECT_PREFIX + "/v1/")) return send(res, 404, { error: "Not found", name: "NOT_FOUND" });
  const p = path.slice(PROTECT_PREFIX.length);

  if ((opts.fail429 ?? 0) > 0) {
    opts.fail429!--;
    res.setHeader("Retry-After", String(opts.retryAfterSeconds ?? 1));
    return send(res, 429, { error: "Too many requests", name: "RATE_LIMIT" });
  }
  if (opts.missingPaths?.some((mp) => p.startsWith(mp))) return send(res, 404, { error: "Not found", name: "NOT_FOUND" });

  const route = p.split("/").filter(Boolean); // ["v1", "cameras", id, ...]
  const [, resource, id, sub] = route;
  const byId = <T extends { id: string }>(list: T[]): T | undefined => list.find((x) => x.id === id);

  switch (resource) {
    case "meta":
      if (id === "info") return send(res, 200, { applicationVersion: "7.2.105" });
      break;
    case "nvrs":
      return send(res, 200, fx.nvr);
    case "cameras": {
      if (!id) return send(res, 200, fx.cameras);
      const cam = byId(fx.cameras);
      if (!cam) return send(res, 404, { error: `Camera ${id} not found`, name: "NOT_FOUND" });
      if (!sub) return send(res, 200, cam);
      if (sub === "snapshot") {
        if (cam.state !== "CONNECTED") return send(res, 503, undefined);
        if (url.searchParams.get("highQuality") === "true" && !cam.featureFlags?.supportFullHdSnapshot) {
          return send(res, 400, { error: "Camera does not support full HD snapshot", name: "BAD_REQUEST" });
        }
        const jpeg = Buffer.from(MOCK_JPEG_BASE64, "base64");
        res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": String(jpeg.length) });
        return void res.end(jpeg);
      }
      if (sub === "rtsps-stream") return send(res, 200, fx.rtspsStreams[cam.id] ?? { high: null, medium: null, low: null, package: null });
      break;
    }
    case "lights":
      return id ? sendOne(res, byId(fx.lights)) : send(res, 200, fx.lights);
    case "chimes":
      return id ? sendOne(res, byId(fx.chimes)) : send(res, 200, fx.chimes);
    case "sensors":
      return id ? sendOne(res, byId(fx.sensors)) : send(res, 200, fx.sensors);
    case "viewers":
      return id ? sendOne(res, byId(fx.viewers)) : send(res, 200, fx.viewers);
  }
  return send(res, 404, { error: "Not found", name: "NOT_FOUND" });
}

function sendOne(res: ServerResponse, item: unknown): void {
  if (!item) return send(res, 404, { error: "Not found", name: "NOT_FOUND" });
  send(res, 200, item);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    return void res.end();
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
