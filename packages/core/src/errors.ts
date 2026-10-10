/**
 * Error model shared by every UniFi connector. Messages are written for the
 * end user (they surface in chat) and never include the API key or headers.
 */
export type UnifiErrorKind =
  | "config" // missing/invalid configuration (no key, bad console id, ...)
  | "auth" // 401/403 from the console or Site Manager
  | "not_found" // 404: unknown id, or endpoint missing on this firmware
  | "rate_limited" // 429 upstream, or our own limiter
  | "offline" // 503 from Protect (camera offline) or console unreachable
  | "timeout"
  | "network" // DNS/TLS/connection failure
  | "too_large"
  | "upstream"; // anything else

export class UnifiError extends Error {
  readonly kind: UnifiErrorKind;
  readonly status?: number;
  readonly retryAfterSeconds?: number;
  readonly hint?: string;

  constructor(
    kind: UnifiErrorKind,
    message: string,
    opts: { status?: number; retryAfterSeconds?: number; hint?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "UnifiError";
    this.kind = kind;
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.hint = opts.hint;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }

  /** One short, user-facing paragraph. */
  toUserMessage(): string {
    return this.hint ? `${this.message} ${this.hint}` : this.message;
  }
}

export function isUnifiError(e: unknown): e is UnifiError {
  return e instanceof UnifiError;
}

/** Parse an RFC 9110 Retry-After header (seconds or HTTP date). */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.max(0, Math.ceil(Number(trimmed)));
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - now) / 1000));
  return undefined;
}

/** Extract "retry after 5.37s" style hints from Site Manager 429 bodies. */
export function parseRetryAfterFromMessage(message: string | undefined): number | undefined {
  if (!message) return undefined;
  const m = /retry after ([\d.]+)s/i.exec(message);
  return m ? Math.ceil(Number(m[1])) : undefined;
}

export interface ErrorContext {
  mode: "local" | "cloud";
  /** What we were trying to fetch, in words: "camera 66d0..." */
  what?: string;
  /** Upstream error body (Protect genericError or Site Manager error). */
  body?: { error?: string; message?: string; name?: string; code?: string } | undefined;
  retryAfterSeconds?: number;
}

/** Map an HTTP status from Protect / Site Manager / the connector to a UnifiError. */
export function errorFromStatus(status: number, ctx: ErrorContext): UnifiError {
  const upstreamMsg = ctx.body?.error ?? ctx.body?.message;
  const what = ctx.what ? ` (${ctx.what})` : "";
  switch (status) {
    case 400:
      return new UnifiError("upstream", `UniFi rejected the request${what}: ${upstreamMsg ?? "bad request"}.`, { status });
    case 403:
      if (ctx.mode === "cloud" && upstreamMsg && /insufficient permissions/i.test(upstreamMsg)) {
        return new UnifiError("auth", `This API key isn't allowed to reach that console${what}: ${upstreamMsg}.`, {
          status,
          hint: "The key works, but its account lacks access to this console. Use a key from the console's owner (or an organization key), or pick another console with unifi_list_consoles.",
        });
      }
    // falls through
    case 401:
      return new UnifiError(
        "auth",
        `UniFi refused the API key${what} (HTTP ${status}).`,
        {
          status,
          hint:
            ctx.mode === "cloud"
              ? "Cloud mode needs a Site Manager API key from unifi.ui.com → Settings → API Keys, created by an owner/admin of this console."
              : "Local mode needs a console API key from the console's Settings → Control Plane → Integrations page.",
        },
      );
    case 404:
      return new UnifiError(
        "not_found",
        `Not found${what}.`,
        {
          status,
          hint:
            ctx.mode === "cloud"
              ? "Check the ID. If every call 404s, the console ID may be wrong or Protect may not be installed on that console (run unifi_list_consoles). An endpoint newer than your Protect version also returns 404."
              : "Check the ID. If every call 404s, the host may not be running Protect, or this endpoint is newer than your Protect version.",
        },
      );
    case 413:
      return new UnifiError("too_large", `The response was too large${what}.`, { status });
    case 429:
      return new UnifiError("rate_limited", `UniFi rate limit reached${what}.`, {
        status,
        retryAfterSeconds: ctx.retryAfterSeconds,
        hint: ctx.retryAfterSeconds !== undefined ? `Try again in about ${ctx.retryAfterSeconds}s.` : "Try again in a minute.",
      });
    case 502:
    case 503:
    case 504:
      return new UnifiError(
        "offline",
        ctx.mode === "cloud"
          ? `The console didn't answer through the UniFi cloud connector${what} (HTTP ${status}).`
          : `The console or device is unavailable${what} (HTTP ${status}).`,
        {
          status,
          hint:
            ctx.mode === "cloud"
              ? "Make sure the console is online and Remote Access is enabled for it in UniFi OS settings."
              : undefined,
        },
      );
    default:
      return new UnifiError("upstream", `UniFi returned HTTP ${status}${what}${upstreamMsg ? `: ${upstreamMsg}` : ""}.`, {
        status,
      });
  }
}
