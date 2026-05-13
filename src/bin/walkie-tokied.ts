#!/usr/bin/env node
import {
  createRelayHttpServer,
  isLocalBindHost,
  isTailscaleIpv4,
  isWildcardBindHost,
  listenRelayHttpServer,
} from "../server/http.js";

const host = process.env.WALKIE_TOKIE_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.WALKIE_TOKIE_PORT ?? "8787", 10);
const logger = process.env.WALKIE_TOKIE_LOG !== "0";
const token = process.env.WALKIE_TOKIE_TOKEN;

if (
  !token &&
  !isLocalBindHost(host) &&
  !isTailscaleIpv4(host) &&
  !isWildcardBindHost(host) &&
  process.env.WALKIE_TOKIE_ALLOW_UNAUTHENTICATED !== "1"
) {
  process.stderr.write(
    "Refusing to listen on a non-local, non-Tailscale address without WALKIE_TOKIE_TOKEN. " +
      "Use the default wildcard bind, set WALKIE_TOKIE_TOKEN, or set " +
      "WALKIE_TOKIE_ALLOW_UNAUTHENTICATED=1.\n",
  );
  process.exit(1);
}

const { app } = createRelayHttpServer({ logger, token });

try {
  const url = await listenRelayHttpServer(app, { host, port });
  console.log(`walkie-tokied listening on ${url}`);
} catch (error) {
  process.stderr.write(`Could not start walkie-tokied: ${formatStartupError(error)}\n`);
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app.close().finally(() => process.exit(0));
  });
}

function formatStartupError(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      return `port ${port} is already in use`;
    }
    if (code === "EADDRNOTAVAIL") {
      return `${host} is not an address on this machine`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
