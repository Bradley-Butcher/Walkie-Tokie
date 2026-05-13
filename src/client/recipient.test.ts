import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRecipientAddress, parseWalkieTokieTrigger } from "./recipient.js";

describe("recipient addresses", () => {
  it("parses host and session from a shareable identifier", () => {
    assert.deepEqual(parseRecipientAddress("alice-laptop/review-pr-123"), {
      host: "alice-laptop",
      sessionName: "review-pr-123",
      baseUrl: "http://alice-laptop:8787",
    });
  });

  it("keeps explicit host ports", () => {
    assert.deepEqual(parseRecipientAddress("127.0.0.1:9999/review-pr-123"), {
      host: "127.0.0.1:9999",
      sessionName: "review-pr-123",
      baseUrl: "http://127.0.0.1:9999",
    });
  });

  it("rejects malformed identifiers", () => {
    assert.throws(() => parseRecipientAddress("alice-laptop"));
    assert.throws(() => parseRecipientAddress("/review-pr-123"));
    assert.throws(() => parseRecipientAddress("alice-laptop/one/two"));
  });

  it("parses copy-paste trigger strings", () => {
    assert.deepEqual(
      parseWalkieTokieTrigger("walkie-tokie/alice-laptop/review-pr-123 Why is this safe?"),
      {
        recipient: {
          host: "alice-laptop",
          sessionName: "review-pr-123",
          baseUrl: "http://alice-laptop:8787",
        },
        question: "Why is this safe?",
      },
    );
  });

  it("parses trigger strings with explicit host ports", () => {
    assert.deepEqual(
      parseWalkieTokieTrigger("walkie-tokie/127.0.0.1:9999/review-pr-123 Can I ask locally?"),
      {
        recipient: {
          host: "127.0.0.1:9999",
          sessionName: "review-pr-123",
          baseUrl: "http://127.0.0.1:9999",
        },
        question: "Can I ask locally?",
      },
    );
  });

  it("rejects malformed trigger strings", () => {
    assert.throws(() => parseWalkieTokieTrigger("walkie-tokie/alice-laptop/review-pr-123"));
    assert.throws(() => parseWalkieTokieTrigger("alice-laptop/review-pr-123 Why?"));
    assert.throws(() => parseWalkieTokieTrigger("walkie-tokie/alice-laptop/one/two Why?"));
  });
});
