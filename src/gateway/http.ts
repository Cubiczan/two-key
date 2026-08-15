/**
 * The socket-facing adapter: JSON in, JSON out, CORS, and the translation of a
 * thrown `GatewayError` into the body shape both SDK clients read.
 *
 * Everything decision-shaped lives in `router.ts`. This file only knows how to
 * move bytes, so a bug here cannot change what the gateway permits.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { handle, type RouterDeps } from "./router";
import { GatewayError, type ErrorBody } from "./types";

export interface HttpOptions extends RouterDeps {
  /**
   * Exact origin permitted to call this gateway. The browser is the only
   * caller, and it sends the passkey-signed envelopes, so this is not
   * decorative — `*` is refused rather than accepted as a convenience.
   */
  allowedOrigin: string;
  /** Cap on request body size. A signed envelope is small; anything large is not ours. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export function corsHeaders(allowedOrigin: string): Record<string, string> {
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) {
      throw new GatewayError(413, "body_too_large", `request body exceeds ${limit} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Maps anything thrown to a status and the SDK-readable error body. */
export function toErrorResponse(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof GatewayError) {
    return { status: error.status, body: error.toBody() };
  }
  // Deliberately opaque: an unexpected failure here may carry relayer or
  // sponsor detail, and this response crosses into a browser.
  return {
    status: 500,
    body: { error: "internal_error", message: "the gateway failed to handle this request" },
  };
}

export function createGateway(options: HttpOptions): Server {
  const { allowedOrigin, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, ...deps } = options;

  if (allowedOrigin === "*") {
    throw new Error("allowedOrigin must name an exact origin — '*' is not permitted");
  }

  const cors = corsHeaders(allowedOrigin);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const send = (status: number, body: unknown): void => {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...cors,
        });
        res.end(payload);
      };

      try {
        if (req.method === "OPTIONS") {
          res.writeHead(204, cors);
          res.end();
          return;
        }

        const path = new URL(req.url ?? "/", "http://gateway.invalid").pathname;

        let body: unknown;
        if (req.method !== "GET") {
          const raw = await readBody(req, maxBodyBytes);
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw);
            } catch {
              throw new GatewayError(400, "invalid_json", "request body is not valid JSON");
            }
          }
        }

        const result = await handle(deps, { method: req.method ?? "GET", path, body });
        send(result.status, result.body);
      } catch (error) {
        const { status, body } = toErrorResponse(error);
        send(status, body);
      }
    })();
  });
}
