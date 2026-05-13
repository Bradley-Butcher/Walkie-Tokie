export function relayBaseUrlFromHost(host: string, port = 8787): string {
  if (host.startsWith("http://") || host.startsWith("https://")) {
    return trimTrailingSlash(host);
  }

  if (host.includes(":")) {
    return `http://${host}`;
  }

  return `http://${host}:${port}`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}
