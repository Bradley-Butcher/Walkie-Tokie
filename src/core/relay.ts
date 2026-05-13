import { randomUUID } from "node:crypto";
import type {
  AskReviewPeerInput,
  AskReviewPeerResult,
  Capability,
  DeliveredReviewRequest,
  Evidence,
  Origin,
  ReviewEndpoint,
  ReviewRequestStatus,
  WaitForReviewRequestInput,
  WaitForReviewRequestResult,
} from "./types.js";
import { RelayError } from "./types.js";

interface PendingRequest {
  requestId: string;
  target: string;
  question: string;
  mode: Capability;
  origin?: Origin;
  deadlineMs: number;
  status: ReviewRequestStatus;
  resolveAsk: (result: AskReviewPeerResult) => void;
  timeout: NodeJS.Timeout;
}

interface ActiveWaiter {
  endpoint: string;
  resolve: (result: WaitForReviewRequestResult) => void;
  timeout: NodeJS.Timeout;
}

interface ActiveAnswer {
  request: PendingRequest;
  deliveredAtMs: number;
}

export interface ReviewRelayOptions {
  now?: () => number;
  makeRequestId?: () => string;
}

export class ReviewRelay {
  private readonly endpoints = new Map<string, ReviewEndpoint>();
  private readonly sessionTargets = new Map<string, string>();
  private readonly queues = new Map<string, PendingRequest[]>();
  private readonly waiters = new Map<string, ActiveWaiter>();
  private readonly activeAnswers = new Map<string, ActiveAnswer>();
  private readonly now: () => number;
  private readonly makeRequestId: () => string;

  constructor(options: ReviewRelayOptions = {}) {
    this.now = options.now ?? Date.now;
    this.makeRequestId = options.makeRequestId ?? (() => `req_${randomUUID()}`);
  }

  startReviewMode(input: {
    target: string;
    repo?: string;
    pr?: number;
    session: string;
    capabilities: Capability[];
    maxPending?: number;
  }): ReviewEndpoint {
    const previousEndpointAtTarget = this.endpoints.get(input.target);
    if (previousEndpointAtTarget) {
      this.cancelEndpoint(input.target, "Review mode restarted before the request was answered.");
      this.sessionTargets.delete(previousEndpointAtTarget.session);
    }

    const previousTarget = this.sessionTargets.get(input.session);
    if (previousTarget && previousTarget !== input.target) {
      this.closeReviewMode(previousTarget);
    }

    const endpoint: ReviewEndpoint = {
      target: input.target,
      repo: input.repo,
      pr: input.pr,
      session: input.session,
      state: "review_idle",
      capabilities: input.capabilities,
      maxPending: input.maxPending ?? 5,
    };
    this.endpoints.set(endpoint.target, endpoint);
    this.sessionTargets.set(endpoint.session, endpoint.target);
    this.queues.set(endpoint.target, []);
    return endpoint;
  }

  closeReviewMode(target: string): void {
    const endpoint = this.requireEndpoint(target);
    endpoint.state = "closed";
    this.sessionTargets.delete(endpoint.session);
    this.cancelEndpoint(target, "Review mode closed before the request was answered.");
  }

  private cancelEndpoint(target: string, message: string): void {
    const waiter = this.waiters.get(target);
    if (waiter) {
      clearTimeout(waiter.timeout);
      waiter.resolve({ status: "timeout" });
      this.waiters.delete(target);
    }

    const queued = this.queues.get(target) ?? [];
    for (const request of queued) {
      this.finishRequest(request, {
        requestId: request.requestId,
        status: "cancelled",
        message,
      });
    }
    this.queues.set(target, []);

    const active = this.activeAnswers.get(target);
    if (active) {
      this.activeAnswers.delete(target);
      this.finishRequest(active.request, {
        requestId: active.request.requestId,
        status: "cancelled",
        message,
      });
    }
  }

  listEndpoints(): ReviewEndpoint[] {
    return [...this.endpoints.values()].map((endpoint) => ({ ...endpoint }));
  }

  endpointForSession(session: string): ReviewEndpoint {
    const target = this.sessionTargets.get(session);
    if (!target) {
      throw new RelayError("not_found", `No review session named ${session}`, 404);
    }
    return this.requireEndpoint(target);
  }

  async waitForReviewSession(input: {
    session: string;
    timeoutSeconds: number;
  }): Promise<WaitForReviewRequestResult> {
    const endpoint = this.endpointForSession(input.session);
    return await this.waitForReviewRequest({
      endpoint: endpoint.target,
      timeoutSeconds: input.timeoutSeconds,
    });
  }

  async askReviewSession(input: Omit<AskReviewPeerInput, "target"> & {
    session: string;
  }): Promise<AskReviewPeerResult> {
    const endpoint = this.endpointForSession(input.session);
    return await this.askReviewPeer({
      target: endpoint.target,
      question: input.question,
      mode: input.mode,
      timeoutSeconds: input.timeoutSeconds,
      caller: input.caller,
      clientRequestId: input.clientRequestId,
    });
  }

  async waitForReviewRequest(input: WaitForReviewRequestInput): Promise<WaitForReviewRequestResult> {
    const endpoint = this.requireEndpoint(input.endpoint);
    if (endpoint.state === "paused") {
      throw new RelayError("paused", "Review mode is paused", 409);
    }
    if (endpoint.state === "closed" || endpoint.state === "authoring") {
      throw new RelayError("not_in_review_mode", "Review mode is not active", 409);
    }
    this.supersedeWaiter(endpoint.target);
    if (this.activeAnswers.has(endpoint.target)) {
      throw new RelayError("busy", "The author agent is already answering a request", 409);
    }

    const next = this.dequeueValidRequest(endpoint.target);
    if (next) {
      return { status: "request", request: this.deliverToAuthor(endpoint, next) };
    }

    endpoint.state = "waiting";
    return await new Promise<WaitForReviewRequestResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters.delete(endpoint.target);
        if (endpoint.state === "waiting") {
          endpoint.state = "review_idle";
        }
        resolve({ status: "timeout" });
      }, input.timeoutSeconds * 1000);

      this.waiters.set(endpoint.target, {
        endpoint: endpoint.target,
        resolve,
        timeout,
      });
    });
  }

  async askReviewPeer(input: AskReviewPeerInput): Promise<AskReviewPeerResult> {
    const endpoint = this.requireEndpoint(input.target);
    const rejection = this.validateAsk(endpoint, input);
    if (rejection) {
      return rejection;
    }

    const request: PendingRequest = {
      requestId: this.makeRequestId(),
      target: input.target,
      question: input.question,
      mode: input.mode,
      origin: input.caller,
      deadlineMs: this.now() + input.timeoutSeconds * 1000,
      status: "queued",
      resolveAsk: () => undefined,
      timeout: setTimeout(() => undefined, 0),
    };
    clearTimeout(request.timeout);

    return await new Promise<AskReviewPeerResult>((resolve) => {
      request.resolveAsk = resolve;
      request.timeout = setTimeout(() => {
        this.expireRequest(request);
      }, input.timeoutSeconds * 1000);

      const waiter = this.waiters.get(endpoint.target);
      if (waiter && !this.activeAnswers.has(endpoint.target)) {
        this.waiters.delete(endpoint.target);
        clearTimeout(waiter.timeout);
        waiter.resolve({ status: "request", request: this.deliverToAuthor(endpoint, request) });
        return;
      }

      const queue = this.queues.get(endpoint.target) ?? [];
      if (queue.length >= endpoint.maxPending) {
        this.finishRequest(request, {
          requestId: request.requestId,
          status: "rejected",
          reason: "busy",
          message: "The author agent has too many pending review questions.",
        });
        return;
      }

      queue.push(request);
      this.queues.set(endpoint.target, queue);
    });
  }

  replyToReviewRequest(input: {
    requestId: string;
    answer: string;
    evidence?: Evidence[];
  }): void {
    const active = [...this.activeAnswers.entries()].find(([, value]) => {
      return value.request.requestId === input.requestId;
    });

    if (!active) {
      throw new RelayError("not_found", "No active request matches requestId", 404);
    }

    const [target, answer] = active;
    this.activeAnswers.delete(target);

    const endpoint = this.requireEndpoint(target);
    if (endpoint.state === "answering") {
      endpoint.state = "review_idle";
    }

    this.finishRequest(answer.request, {
      requestId: answer.request.requestId,
      status: "answered",
      answer: input.answer,
    });
  }

  private validateAsk(
    endpoint: ReviewEndpoint,
    input: AskReviewPeerInput,
  ): AskReviewPeerResult | undefined {
    if (endpoint.state === "closed" || endpoint.state === "authoring") {
      return {
        status: "rejected",
        reason: "not_in_review_mode",
        message: "The author agent is not accepting review questions.",
      };
    }
    if (endpoint.state === "paused") {
      return {
        status: "rejected",
        reason: "paused",
        message: "The author paused review mode.",
      };
    }
    if (!endpoint.capabilities.includes(input.mode)) {
      return {
        status: "rejected",
        reason: "unsupported_mode",
        message: "Requested mode is not enabled for this endpoint.",
      };
    }
    return undefined;
  }

  private dequeueValidRequest(target: string): PendingRequest | undefined {
    const queue = this.queues.get(target) ?? [];
    while (queue.length > 0) {
      const request = queue.shift();
      if (!request) {
        break;
      }
      if (request.deadlineMs <= this.now()) {
        this.finishRequest(request, {
          requestId: request.requestId,
          status: "timeout",
          message: "Request expired before the author agent received it.",
        });
        continue;
      }
      return request;
    }
    return undefined;
  }

  private supersedeWaiter(target: string): void {
    const waiter = this.waiters.get(target);
    if (!waiter) {
      return;
    }

    clearTimeout(waiter.timeout);
    this.waiters.delete(target);
    waiter.resolve({
      status: "superseded",
      message: "A newer wait call replaced this one.",
    });
  }

  private deliverToAuthor(endpoint: ReviewEndpoint, request: PendingRequest): DeliveredReviewRequest {
    request.status = "delivered_to_author";
    endpoint.state = "answering";
    this.activeAnswers.set(endpoint.target, {
      request,
      deliveredAtMs: this.now(),
    });

    return {
      requestId: request.requestId,
      target: request.target,
      question: request.question,
      mode: request.mode,
      origin: request.origin,
      deadline: new Date(request.deadlineMs).toISOString(),
    };
  }

  private expireRequest(request: PendingRequest): void {
    const queue = this.queues.get(request.target);
    if (queue) {
      const index = queue.findIndex((queued) => queued.requestId === request.requestId);
      if (index !== -1) {
        queue.splice(index, 1);
      }
    }

    const active = this.activeAnswers.get(request.target);
    if (active?.request.requestId === request.requestId) {
      this.activeAnswers.delete(request.target);
      const endpoint = this.endpoints.get(request.target);
      if (endpoint?.state === "answering") {
        endpoint.state = "review_idle";
      }
    }

    this.finishRequest(request, {
      requestId: request.requestId,
      status: "timeout",
      message: "No answer arrived before the reviewer timeout.",
    });
  }

  private finishRequest(request: PendingRequest, result: AskReviewPeerResult): void {
    clearTimeout(request.timeout);
    request.resolveAsk(result);
  }

  private requireEndpoint(target: string): ReviewEndpoint {
    const endpoint = this.endpoints.get(target);
    if (!endpoint) {
      throw new RelayError("not_found", `No review endpoint for ${target}`, 404);
    }
    return endpoint;
  }
}
