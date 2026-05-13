import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import * as z from "zod/v4";
import { ReviewRelay } from "../core/relay.js";
import { isAllowedUnauthenticatedPeerAddress } from "../core/tailscale.js";
import {
  askReviewPeerHttpSchema,
  closeReviewModeSchema,
  replyToReviewRequestSchema,
  requestIdSchema,
  sendSessionMessageHttpSchema,
  sessionSchema,
  startReviewModeSchema,
  waitForReviewRequestSchema,
} from "../core/schemas.js";
import { RelayError } from "../core/types.js";
export { isTailscaleIpv4 } from "../core/tailscale.js";

const jsonBodyLimitBytes = 128 * 1024;

export interface RelayHttpServerOptions {
  relay?: ReviewRelay;
  logger?: boolean;
  token?: string;
}

export function createRelayHttpServer(options: RelayHttpServerOptions = {}) {
  const relay = options.relay ?? new ReviewRelay();
  const app = Fastify({
    bodyLimit: jsonBodyLimitBytes,
    connectionTimeout: 0,
    keepAliveTimeout: 65_000,
    logger: options.logger ?? false,
    requestTimeout: 0,
  });

  app.setErrorHandler(writeError);

  const token = options.token;
  if (token) {
    app.addHook("onRequest", async (request) => {
      if (request.url === "/healthz") {
        return;
      }
      const authorization = request.headers.authorization;
      if (!isBearerToken(authorization, token)) {
        throw new RelayError("not_allowed", "Missing or invalid Walkie Tokie token", 401);
      }
    });
  } else {
    app.addHook("onRequest", async (request) => {
      if (!isAllowedUnauthenticatedPeerAddress(request.ip)) {
        throw new RelayError(
          "not_allowed",
          "Walkie Tokie accepts unauthenticated requests only from localhost or Tailscale peers",
          403,
        );
      }
    });
  }

  app.get("/healthz", async () => {
    return { ok: true };
  });

  app.get("/v1/review-endpoints", async () => {
    return { endpoints: relay.listEndpoints() };
  });

  app.post("/v1/review-mode/start", async (request) => {
    const body = startReviewModeSchema.parse(request.body);
    return {
      endpoint: relay.startReviewMode(body),
    };
  });

  app.post("/v1/review-mode/close", async (request) => {
    const body = closeReviewModeSchema.parse(request.body);
    relay.closeReviewMode(body.target);
    return { target: body.target, status: "closed" };
  });

  app.post("/v1/author/wait", async (request) => {
    const body = waitForReviewRequestSchema.parse(request.body);
    return await relay.waitForReviewRequest(body);
  });

  app.post("/v1/sessions/:session/wait", async (request) => {
    const params = z
      .object({
        session: sessionSchema,
      })
      .strict()
      .parse(request.params);
    const body = z
      .object({
        timeoutSeconds: z.number().int().positive().max(86_400).default(43_200),
      })
      .strict()
      .parse(request.body);

    return await relay.waitForReviewSession({
      session: decodeURIComponent(params.session),
      timeoutSeconds: body.timeoutSeconds,
    });
  });

  app.post("/v1/review-requests:wait", async (request) => {
    const body = askReviewPeerHttpSchema.parse(request.body);
    return await relay.askReviewPeer(body);
  });

  app.post("/v1/sessions/:session/messages/wait", async (request) => {
    const params = z
      .object({
        session: sessionSchema,
      })
      .strict()
      .parse(request.params);
    const body = sendSessionMessageHttpSchema.parse(request.body);

    return await relay.askReviewSession({
      session: decodeURIComponent(params.session),
      question: body.message,
      mode: body.mode,
      timeoutSeconds: body.timeoutSeconds,
      caller: body.caller,
      clientRequestId: body.clientRequestId,
    });
  });

  app.post("/v1/review-requests/:requestId/reply", async (request) => {
    const params = z
      .object({
        requestId: requestIdSchema,
      })
      .strict()
      .parse(request.params);
    const body = replyToReviewRequestSchema.parse(request.body);

    relay.replyToReviewRequest({
      requestId: params.requestId,
      answer: body.answer,
      evidence: body.evidence,
    });
    return {
      requestId: params.requestId,
      status: "sent",
    };
  });

  return { app, relay };
}

export function isLocalBindHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function isWildcardBindHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::";
}

export async function listenRelayHttpServer(
  app: FastifyInstance,
  options: { host: string; port: number },
): Promise<string> {
  await app.listen(options);
  return serverUrl(app.server.address());
}

function isBearerToken(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith("Bearer ")) {
    return false;
  }
  const actual = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function serverUrl(address: AddressInfo | string | null): string {
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

function writeError(
  error: FastifyError | RelayError | z.ZodError,
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  if (error instanceof RelayError) {
    void reply.status(error.status).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }

  if (error instanceof z.ZodError) {
    void reply.status(400).send({
      error: {
        code: "invalid_request",
        message: "Invalid request body",
        issues: z.treeifyError(error),
      },
    });
    return;
  }

  const status = typeof error.statusCode === "number" ? error.statusCode : 500;
  void reply.status(status).send({
    error: {
      code: status === 404 ? "not_found" : "internal_error",
      message: status >= 500 ? "Internal server error" : error.message,
    },
  });
}
