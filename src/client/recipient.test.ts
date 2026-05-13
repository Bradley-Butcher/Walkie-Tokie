import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRecipientAddress, parseWalkieTokieTrigger } from "./recipient.js";

describe("recipient addresses", () => {
  it("parses host and session from a shareable identifier", () => {
    assert.deepEqual(parseRecipientAddress("brad-laptop/big-lad-john"), {
      host: "brad-laptop",
      sessionName: "big-lad-john",
      baseUrl: "http://brad-laptop:8787",
    });
  });

  it("keeps explicit host ports", () => {
    assert.deepEqual(parseRecipientAddress("127.0.0.1:9999/big-lad-john"), {
      host: "127.0.0.1:9999",
      sessionName: "big-lad-john",
      baseUrl: "http://127.0.0.1:9999",
    });
  });

  it("rejects malformed identifiers", () => {
    assert.throws(() => parseRecipientAddress("brad-laptop"));
    assert.throws(() => parseRecipientAddress("/big-lad-john"));
    assert.throws(() => parseRecipientAddress("brad-laptop/one/two"));
  });

  it("parses copy-paste trigger strings", () => {
    assert.deepEqual(
      parseWalkieTokieTrigger("walkie-tokie/brad-laptop/big-lad-john Why is this safe?"),
      {
        recipient: {
          host: "brad-laptop",
          sessionName: "big-lad-john",
          baseUrl: "http://brad-laptop:8787",
        },
        question: "Why is this safe?",
      },
    );
  });

  it("parses trigger strings with explicit host ports", () => {
    assert.deepEqual(
      parseWalkieTokieTrigger("walkie-tokie/127.0.0.1:9999/big-lad-john Can I ask locally?"),
      {
        recipient: {
          host: "127.0.0.1:9999",
          sessionName: "big-lad-john",
          baseUrl: "http://127.0.0.1:9999",
        },
        question: "Can I ask locally?",
      },
    );
  });

  it("rejects malformed trigger strings", () => {
    assert.throws(() => parseWalkieTokieTrigger("walkie-tokie/brad-laptop/big-lad-john"));
    assert.throws(() => parseWalkieTokieTrigger("brad-laptop/big-lad-john Why?"));
    assert.throws(() => parseWalkieTokieTrigger("walkie-tokie/brad-laptop/one/two Why?"));
  });
});
