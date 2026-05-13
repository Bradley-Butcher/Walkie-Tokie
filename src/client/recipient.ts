import { relayBaseUrlFromHost } from "./relayAddress.js";

export interface RecipientAddress {
  host: string;
  sessionName: string;
  baseUrl: string;
}

export interface WalkieTokieTrigger {
  recipient: RecipientAddress;
  question: string;
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

export function parseWalkieTokieTrigger(input: string, port = 8787): WalkieTokieTrigger {
  const match = input.match(/^walkie-tokie\/([a-zA-Z0-9_.-]+(?::\d+)?)\/([^/\s]+)\s+([\s\S]+)$/);
  if (!match) {
    throw new Error("Trigger must look like walkie-tokie/host/session-name question");
  }

  const [, host, sessionName, question] = match;
  if (!host || !sessionName || !question?.trim()) {
    throw new Error("Trigger must include host, session name, and question");
  }

  return {
    recipient: {
      host,
      sessionName,
      baseUrl: relayBaseUrlFromHost(host, port),
    },
    question: question.trim(),
  };
}
