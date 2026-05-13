import { relayBaseUrlFromHost } from "./relayAddress.js";

export interface RecipientAddress {
  host: string;
  sessionName: string;
  baseUrl: string;
}

export function parseRecipientAddress(recipient: string, port = 8787): RecipientAddress {
  const slash = recipient.indexOf("/");
  if (slash <= 0 || slash === recipient.length - 1 || recipient.indexOf("/", slash + 1) !== -1) {
    throw new Error("Recipient must look like host/session-name");
  }

  const host = recipient.slice(0, slash);
  const sessionName = recipient.slice(slash + 1);
  return {
    host,
    sessionName,
    baseUrl: relayBaseUrlFromHost(host, port),
  };
}
