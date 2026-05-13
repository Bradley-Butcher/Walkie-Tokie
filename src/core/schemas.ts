import * as z from "zod/v4";
import type { Capability } from "./types.js";

export const capabilitySchema = z.enum(["explain", "inspect", "verify", "propose", "write"]);

export const targetSchema = z
  .string()
  .min(3)
  .max(300)
  .regex(/^(?:[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+#\d+|session\/[a-zA-Z0-9_.-]+)$/, {
    message: "target must look like namespace/owner/repo#123 or session/name",
  });

export const repoSchema = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, {
    message: "repo must look like owner/repo",
  });

export const sessionSchema = z.string().min(1).max(200);
export const hostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9_.-]+(?::\d+)?$/, {
    message: "host must be a Tailscale hostname, IPv4 address, or host:port",
  });
export const recipientSchema = z
  .string()
  .min(3)
  .max(500)
  .regex(/^[a-zA-Z0-9_.-]+(?::\d+)?\/[^/]+$/, {
    message: "recipient must look like host/session-name",
  });
export const callerNameSchema = z.string().min(1).max(200);
export const questionSchema = z.string().min(1).max(20_000);
export const answerSchema = z.string().min(1).max(100_000);
export const requestIdSchema = z.string().min(1).max(200);
export const timeoutSecondsSchema = (fallback: number, max: number) => {
  return z.number().int().positive().max(max).default(fallback);
};

export const originSchema = z
  .object({
    agent: callerNameSchema.optional(),
    machine: callerNameSchema.optional(),
  })
  .strict();

export const startReviewModeSchema = z
  .object({
    target: targetSchema,
    repo: repoSchema.optional(),
    pr: z.number().int().positive().optional(),
    session: sessionSchema,
    capabilities: z.array(capabilitySchema).min(1).max(5),
    maxPending: z.number().int().positive().max(100).optional(),
  })
  .strict();

export const waitForMessageMcpSchema = z.object({
  session_name: sessionSchema,
  repo: repoSchema.optional(),
  pr: z.number().int().positive().optional(),
  capabilities: z.array(capabilitySchema).min(1).max(5).default(["inspect"]),
  target: targetSchema.optional(),
  timeoutSeconds: timeoutSecondsSchema(43_200, 86_400),
  maxPending: z.number().int().positive().max(100).optional(),
});

export const prepareReviewModeMcpSchema = waitForMessageMcpSchema.omit({
  timeoutSeconds: true,
});

export const closeReviewModeSchema = z
  .object({
    target: targetSchema,
  })
  .strict();

export const waitForReviewRequestSchema = z
  .object({
    endpoint: targetSchema,
    timeoutSeconds: timeoutSecondsSchema(43_200, 86_400),
  })
  .strict();

export const askReviewPeerHttpSchema = z
  .object({
    target: targetSchema,
    question: questionSchema,
    mode: capabilitySchema,
    timeoutSeconds: timeoutSecondsSchema(900, 3_600),
    caller: originSchema.optional(),
    clientRequestId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const sendSessionMessageHttpSchema = z
  .object({
    message: questionSchema,
    mode: capabilitySchema.default("inspect"),
    timeoutSeconds: timeoutSecondsSchema(900, 3_600),
    caller: originSchema.optional(),
    clientRequestId: z.string().min(1).max(200).optional(),
  })
  .strict();

export const replyToReviewRequestSchema = z
  .object({
    answer: answerSchema,
    evidence: z.array(evidenceSchema()).max(100).optional(),
  })
  .strict();

export function evidenceSchema() {
  return z
    .object({
      kind: z.enum(["file", "command", "url", "note"]),
      path: z.string().min(1).max(1_000).optional(),
      line: z.number().int().positive().optional(),
      command: z.string().min(1).max(2_000).optional(),
      url: z.url().optional(),
      note: z.string().min(1).max(2_000).optional(),
    })
    .strict();
}

export function parseCapability(value: unknown): Capability {
  return capabilitySchema.parse(value);
}
