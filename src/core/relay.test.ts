import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReviewRelay } from "./relay.js";
import { RelayError } from "./types.js";

const target = "team/example/repo#1234";

function relay() {
  let next = 1;
  const reviewRelay = new ReviewRelay({
    makeRequestId: () => `req_${next++}`,
  });
  reviewRelay.startReviewMode({
    target,
    repo: "example/repo",
    pr: 1234,
    session: "review-pr-123",
    capabilities: ["explain", "inspect"],
    maxPending: 2,
  });
  return reviewRelay;
}

describe("ReviewRelay", () => {
  it("matches a waiting author with a blocking reviewer ask", async () => {
    const reviewRelay = relay();

    const wait = reviewRelay.waitForReviewRequest({
      endpoint: target,
      timeoutSeconds: 30,
    });

    const ask = reviewRelay.askReviewPeer({
      target,
      question: "Why is validation below the transport boundary?",
      mode: "inspect",
      timeoutSeconds: 30,
    });

    const waitResult = await wait;
    assert.equal(waitResult.status, "request");
    assert.equal(waitResult.request?.requestId, "req_1");

    reviewRelay.replyToReviewRequest({
      requestId: "req_1",
      answer: "Because validation belongs below the transport boundary.",
    });

    assert.deepEqual(await ask, {
      requestId: "req_1",
      status: "answered",
      answer: "Because validation belongs below the transport boundary.",
    });
  });

  it("matches a named session wait with a host-routed message", async () => {
    const reviewRelay = relay();

    const wait = reviewRelay.waitForReviewSession({
      session: "review-pr-123",
      timeoutSeconds: 30,
    });

    const ask = reviewRelay.askReviewSession({
      session: "review-pr-123",
      question: "Can I address this by session name?",
      mode: "inspect",
      timeoutSeconds: 30,
    });

    const waitResult = await wait;
    assert.equal(waitResult.status, "request");
    assert.equal(waitResult.request?.target, target);
    assert.equal(waitResult.request?.question, "Can I address this by session name?");

    reviewRelay.replyToReviewRequest({
      requestId: waitResult.request?.requestId ?? "",
      answer: "Yes, the session name resolves to the active review endpoint.",
    });

    assert.equal((await ask).answer, "Yes, the session name resolves to the active review endpoint.");
  });

  it("queues asks while the author is answering and keeps reviewer calls blocked", async () => {
    const reviewRelay = relay();

    const firstAsk = reviewRelay.askReviewPeer({
      target,
      question: "First?",
      mode: "inspect",
      timeoutSeconds: 30,
    });
    const secondAsk = reviewRelay.askReviewPeer({
      target,
      question: "Second?",
      mode: "inspect",
      timeoutSeconds: 30,
    });

    const firstWait = await reviewRelay.waitForReviewRequest({
      endpoint: target,
      timeoutSeconds: 30,
    });
    assert.equal(firstWait.request?.requestId, "req_1");
    assert.equal(firstWait.request?.question, "First?");

    await assert.rejects(
      () =>
        reviewRelay.waitForReviewRequest({
          endpoint: target,
          timeoutSeconds: 30,
        }),
      (error: unknown) => error instanceof RelayError && error.code === "busy",
    );

    reviewRelay.replyToReviewRequest({ requestId: "req_1", answer: "First answer" });
    assert.equal((await firstAsk).answer, "First answer");

    const secondWait = await reviewRelay.waitForReviewRequest({
      endpoint: target,
      timeoutSeconds: 30,
    });
    assert.equal(secondWait.request?.requestId, "req_2");
    assert.equal(secondWait.request?.question, "Second?");

    reviewRelay.replyToReviewRequest({ requestId: "req_2", answer: "Second answer" });
    assert.equal((await secondAsk).answer, "Second answer");
  });

  it("rejects when the queue is full", async () => {
    const reviewRelay = relay();

    const firstAsk = reviewRelay.askReviewPeer({
      target,
      question: "First?",
      mode: "inspect",
      timeoutSeconds: 30,
    });
    const secondAsk = reviewRelay.askReviewPeer({
      target,
      question: "Second?",
      mode: "inspect",
      timeoutSeconds: 30,
    });
    const thirdAsk = reviewRelay.askReviewPeer({
      target,
      question: "Third?",
      mode: "inspect",
      timeoutSeconds: 30,
    });

    const thirdResult = await thirdAsk;
    assert.equal(thirdResult.status, "rejected");
    assert.equal(thirdResult.reason, "busy");

    const firstWait = await reviewRelay.waitForReviewRequest({
      endpoint: target,
      timeoutSeconds: 30,
    });
    reviewRelay.replyToReviewRequest({ requestId: firstWait.request?.requestId ?? "", answer: "A1" });
    assert.equal((await firstAsk).status, "answered");

    const secondWait = await reviewRelay.waitForReviewRequest({
      endpoint: target,
      timeoutSeconds: 30,
    });
    reviewRelay.replyToReviewRequest({ requestId: secondWait.request?.requestId ?? "", answer: "A2" });
    assert.equal((await secondAsk).status, "answered");
  });

  it("cancels an active reviewer ask when review mode closes", async () => {
    const reviewRelay = relay();

    const ask = reviewRelay.askReviewPeer({
      target,
      question: "Will this be cancelled?",
      mode: "inspect",
      timeoutSeconds: 30,
    });

    const delivered = await reviewRelay.waitForReviewRequest({
      endpoint: target,
      timeoutSeconds: 30,
    });
    assert.equal(delivered.request?.requestId, "req_1");

    reviewRelay.closeReviewMode(target);

    assert.deepEqual(await ask, {
      requestId: "req_1",
      status: "cancelled",
      message: "Review mode closed before the request was answered.",
    });
    assert.throws(
      () => reviewRelay.replyToReviewRequest({ requestId: "req_1", answer: "Too late" }),
      (error: unknown) => error instanceof RelayError && error.code === "not_found",
    );
  });

  it("restarting review mode cancels stale waits and requests for the same endpoint", async () => {
    const reviewRelay = relay();

    const staleWait = reviewRelay.waitForReviewRequest({
      endpoint: target,
      timeoutSeconds: 30,
    });

    reviewRelay.startReviewMode({
      target,
      repo: "example/repo",
      pr: 1234,
      session: "review-pr-123-v2",
      capabilities: ["inspect"],
    });

    assert.deepEqual(await staleWait, { status: "timeout" });

    const freshWait = reviewRelay.waitForReviewRequest({
      endpoint: target,
      timeoutSeconds: 30,
    });
    const freshAsk = reviewRelay.askReviewPeer({
      target,
      question: "Fresh request?",
      mode: "inspect",
      timeoutSeconds: 30,
    });

    const delivered = await freshWait;
    assert.equal(delivered.request?.requestId, "req_1");
    reviewRelay.replyToReviewRequest({ requestId: "req_1", answer: "Fresh answer" });
    assert.equal((await freshAsk).answer, "Fresh answer");
  });
});
