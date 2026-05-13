export type Capability = "explain" | "inspect" | "verify" | "propose" | "write";

export type ReviewState =
  | "authoring"
  | "review_idle"
  | "waiting"
  | "answering"
  | "paused"
  | "closed";

export type ReviewRequestStatus =
  | "queued"
  | "delivered_to_author"
  | "answered"
  | "rejected"
  | "timeout"
  | "cancelled";

export type RelayErrorCode =
  | "not_found"
  | "not_allowed"
  | "not_in_review_mode"
  | "paused"
  | "busy"
  | "unsupported_mode"
  | "timeout"
  | "waiter_disconnected"
  | "invalid_request";

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  readonly status: number;

  constructor(code: RelayErrorCode, message: string, status = 400) {
    super(message);
    this.name = "RelayError";
    this.code = code;
    this.status = status;
  }
}

export interface ReviewEndpoint {
  target: string;
  repo: string;
  pr: number;
  session: string;
  state: ReviewState;
  capabilities: Capability[];
  allowedCallers: string[];
  maxPending: number;
}

export interface Origin {
  user: string;
  agent?: string;
  machine?: string;
}

export interface AskReviewPeerInput {
  target: string;
  question: string;
  mode: Capability;
  timeoutSeconds: number;
  caller: Origin;
  clientRequestId?: string;
}

export interface AskReviewPeerResult {
  requestId?: string;
  status: "answered" | "rejected" | "timeout" | "cancelled";
  answer?: string;
  reason?: RelayErrorCode;
  message?: string;
}

export interface WaitForReviewRequestInput {
  endpoint: string;
  timeoutSeconds: number;
}

export interface WaitForReviewRequestResult {
  status: "request" | "timeout";
  request?: DeliveredReviewRequest;
}

export interface DeliveredReviewRequest {
  requestId: string;
  target: string;
  question: string;
  mode: Capability;
  origin: Origin;
  deadline: string;
}

export interface ReplyToReviewRequestInput {
  requestId: string;
  answer: string;
  evidence?: Evidence[];
}

export interface Evidence {
  kind: "file" | "command" | "url" | "note";
  path?: string;
  line?: number;
  command?: string;
  url?: string;
  note?: string;
}
