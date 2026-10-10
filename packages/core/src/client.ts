import {
  UnifiError,
  errorFromStatus,
  parseRetryAfter,
  parseRetryAfterFromMessage,
} from "./errors.js";
import { SlidingWindowLimiter } from "./ratelimit.js";
import { appUrl, siteManagerUrl, type ConnectionMode, type RouteConfig, type UnifiApp } from "./routing.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface UnifiClientOptions extends RouteConfig {
  /** Console integration key (local) or Site Manager key (cloud). Sent as X-API-KEY only. */
  apiKey: string;
  /** Override fetch (Node: an undici fetch with a TLS-relaxed dispatcher for self-signed consoles). */
  fetch?: FetchLike;
  /** Per-request timeout. The cloud connector itself gives up after 25 s. */
  timeoutMs?: number;
  /** Requests per minute per console in cloud mode (Ubiquiti documents 100). */
  cloudRateLimitPerMinute?: number;
  /** Max wait we'll absorb for an upstream 429 before surfacing it (seconds). */
  maxRetryAfterSeconds?: number;
  /** Max bytes accepted for binary responses (connector caps at 10 MB). */
  maxBinaryBytes?: number;
  /** Shared limiter (e.g. per Worker isolate). Defaults to a per-client one. */
  limiter?: SlidingWindowLimiter;
  userAgent?: string;
}

export interface BinaryResult {
  bytes: Uint8Array;
  contentType: string;
}

type Query = Record<string, string | number | boolean | undefined>;

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Read-only HTTP client for UniFi Integration APIs. Only GET is implemented on
 * purpose: v1 of the connector ships no write paths at all.
 */
export class UnifiClient {
  readonly mode: ConnectionMode;
  private readonly opts: UnifiClientOptions;
  private readonly limiter: SlidingWindowLimiter;
  private consoleId?: string;

  constructor(opts: UnifiClientOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) {
      throw new UnifiError("config", "No UniFi API key configured.", {
        hint: "Set UNIFI_API_KEY (a Site Manager key for cloud mode, or a console integration key for local mode).",
      });
    }
    this.opts = { ...opts, apiKey: opts.apiKey.trim() };
    this.mode = opts.mode;
    this.consoleId = opts.consoleId;
    this.limiter = opts.limiter ?? new SlidingWindowLimiter(opts.cloudRateLimitPerMinute ?? 100, 60_000);
  }

  get selectedConsoleId(): string | undefined {
    return this.consoleId;
  }

  /** Cloud mode: choose which console subsequent app calls go to. */
  withConsole(consoleId: string | undefined): UnifiClient {
    if (consoleId === this.consoleId) return this;
    return new UnifiClient({ ...this.opts, consoleId, limiter: this.limiter });
  }

  /** GET an Integration API path and parse JSON. */
  async getJson<T = unknown>(app: UnifiApp, path: string, opts: { query?: Query; what?: string } = {}): Promise<T> {
    const url = appUrl(this.route(), app, path, opts.query);
    const res = await this.send(url, "application/json", opts.what, true);
    return (await this.readJson(res, opts.what)) as T;
  }

  /** GET a binary resource (e.g. a JPEG snapshot). */
  async getBinary(app: UnifiApp, path: string, opts: { query?: Query; what?: string; accept?: string } = {}): Promise<BinaryResult> {
    const url = appUrl(this.route(), app, path, opts.query);
    const res = await this.send(url, opts.accept ?? "image/jpeg", opts.what, true);
    const max = this.opts.maxBinaryBytes ?? 10 * 1024 * 1024;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > max) throw new UnifiError("too_large", `The image is larger than ${Math.round(max / 1048576)} MB.`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > max) throw new UnifiError("too_large", `The image is larger than ${Math.round(max / 1048576)} MB.`);
    return { bytes: buf, contentType: (res.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim() };
  }

  /** GET a Site Manager API path (cloud key required; works in either mode if the key is a Site Manager key). */
  async siteManagerGet<T = unknown>(path: string, opts: { query?: Query; what?: string } = {}): Promise<T> {
    const url = siteManagerUrl(this.opts.cloudBaseUrl, path, opts.query);
    const res = await this.send(url, "application/json", opts.what, false, "cloud");
    return (await this.readJson(res, opts.what)) as T;
  }

  private route(): RouteConfig {
    return { mode: this.mode, host: this.opts.host, consoleId: this.consoleId, cloudBaseUrl: this.opts.cloudBaseUrl };
  }

  private async send(url: string, accept: string, what: string | undefined, isAppCall: boolean, modeForErrors: ConnectionMode = this.mode): Promise<Response> {
    if (this.mode === "cloud" && isAppCall) {
      const waitMs = this.limiter.take(`console:${this.consoleId}`);
      if (waitMs > 0) {
        const secs = Math.ceil(waitMs / 1000);
        throw new UnifiError("rate_limited", "Paused to stay under UniFi's limit of 100 requests per minute per console.", {
          retryAfterSeconds: secs,
          hint: `Try again in about ${secs}s.`,
        });
      }
    }

    let attempt = 0;
    // One retry at most, and only for short upstream 429s.
    for (;;) {
      attempt++;
      const res = await this.fetchWithTimeout(url, accept, what, modeForErrors);
      if (res.ok) return res;

      const body = await safeErrorBody(res);
      const retryAfter = parseRetryAfter(res.headers.get("retry-after")) ?? parseRetryAfterFromMessage(body?.message);
      if (res.status === 429 && attempt === 1 && retryAfter !== undefined && retryAfter <= (this.opts.maxRetryAfterSeconds ?? 5)) {
        await sleep(retryAfter * 1000);
        continue;
      }
      throw errorFromStatus(res.status, { mode: modeForErrors, what, body, retryAfterSeconds: retryAfter });
    }
  }

  private async fetchWithTimeout(url: string, accept: string, what: string | undefined, mode: ConnectionMode): Promise<Response> {
    const f: FetchLike = this.opts.fetch ?? ((i, init) => fetch(i, init));
    const controller = new AbortController();
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { "X-API-KEY": this.opts.apiKey, Accept: accept };
    if (this.opts.userAgent) headers["User-Agent"] = this.opts.userAgent;
    try {
      return await f(url, { method: "GET", headers, signal: controller.signal, redirect: "manual" });
    } catch (e) {
      if (controller.signal.aborted) {
        throw new UnifiError("timeout", `UniFi didn't respond within ${Math.round(timeoutMs / 1000)}s${what ? ` (${what})` : ""}.`, {
          hint: mode === "cloud" ? "The console may be offline or Remote Access may be off." : "Check that the console is reachable from this machine.",
        });
      }
      const detail = describeNetworkError(e);
      throw new UnifiError("network", `Couldn't reach UniFi${what ? ` (${what})` : ""}: ${detail}.`, {
        hint:
          mode === "local"
            ? "Check UNIFI_HOST, that this machine is on the console's network, and UNIFI_VERIFY_TLS if the console uses a self-signed certificate."
            : undefined,
        cause: e,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readJson(res: Response, what?: string): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new UnifiError("upstream", `UniFi sent a response that isn't JSON${what ? ` (${what})` : ""}.`, {
        hint: "In local mode this usually means the host isn't a UniFi OS console or the path is wrong.",
      });
    }
  }
}

/** Accept both bare arrays (Protect) and { data: [...] } envelopes (Site Manager / Network). */
export function unwrapList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)) {
    return (payload as { data: T[] }).data;
  }
  return [];
}

async function safeErrorBody(res: Response): Promise<{ error?: string; message?: string; name?: string; code?: string } | undefined> {
  try {
    const text = await res.text();
    if (!text) return undefined;
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      const pick = (k: string) => (typeof o[k] === "string" ? (o[k] as string).slice(0, 300) : undefined);
      return { error: pick("error"), message: pick("message"), name: pick("name"), code: pick("code") };
    }
  } catch {
    /* non-JSON error body: ignore */
  }
  return undefined;
}

function describeNetworkError(e: unknown): string {
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (e as { code?: string })?.code;
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "host not found";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "connection timed out";
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return "TLS certificate not trusted";
  return code ?? "network error";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
