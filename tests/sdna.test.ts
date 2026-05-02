/**
 * Tests for SDNA/Subject Class pattern detection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectPattern } from "../src/sdna.js";
import type { DetectedPattern } from "../src/sdna.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_CHAT_PREDICATES = ["flux://has_message", "sioc://content_of"];

function makeLink(overrides?: Partial<LinkExpression["data"]>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "channel://main",
            target: "expr://msg-001",
            predicate: "flux://has_message",
            ...overrides,
        },
        proof: { signature: "sig", key: "key" },
    };
}

// ---------------------------------------------------------------------------
// detectPattern
// ---------------------------------------------------------------------------

describe("detectPattern", () => {
    describe("chat-message detection", () => {
        it("detects flux://has_message as chat-message", () => {
            const result = detectPattern(makeLink(), DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "chat-message");
            assert.equal(result.channelUri, "channel://main");
            assert.equal(result.contentUri, "expr://msg-001");
        });

        it("detects sioc://content_of as chat-message (when in chatPredicates)", () => {
            const link = makeLink({ predicate: "sioc://content_of" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "chat-message");
        });

        it("detects custom chat predicates", () => {
            const link = makeLink({ predicate: "custom://chat" });
            const result = detectPattern(link, ["custom://chat"]);
            assert.equal(result.type, "chat-message");
        });

        it("does not detect when predicate not in chatPredicates", () => {
            const link = makeLink({ predicate: "flux://has_message" });
            const result = detectPattern(link, []);
            assert.equal(result.type, "unknown");
        });
    });

    describe("reply detection", () => {
        it("detects flux://has_reply", () => {
            const link = makeLink({
                source: "expr://parent",
                target: "expr://reply",
                predicate: "flux://has_reply",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reply");
            assert.equal(result.parentUri, "expr://parent");
            assert.equal(result.contentUri, "expr://reply");
        });

        it("detects sioc://reply_of", () => {
            const link = makeLink({ predicate: "sioc://reply_of" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reply");
        });
    });

    describe("mention detection", () => {
        it("detects predicate containing 'mention'", () => {
            const link = makeLink({
                target: "did:key:z6MkAlice",
                predicate: "flux://has_mention",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "mention");
            assert.equal(result.mentionedAgent, "did:key:z6MkAlice");
        });

        it("detects case-insensitively", () => {
            const link = makeLink({ predicate: "custom://HasMention" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "mention");
        });

        it("detects partial 'mention' in predicate", () => {
            const link = makeLink({ predicate: "app://user_mentioned" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "mention");
        });
    });

    describe("reaction detection", () => {
        it("detects flux://has_reaction", () => {
            const link = makeLink({
                source: "expr://msg",
                target: "👍",
                predicate: "flux://has_reaction",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reaction");
            assert.equal(result.contentUri, "👍");
        });

        it("detects emoji://reaction", () => {
            const link = makeLink({ target: "❤️", predicate: "emoji://reaction" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reaction");
        });
    });

    describe("content detection", () => {
        it("detects sioc://content_of when NOT in chatPredicates", () => {
            const link = makeLink({ predicate: "sioc://content_of" });
            const result = detectPattern(link, ["flux://has_message"]);
            assert.equal(result.type, "content");
        });
    });

    describe("priority ordering", () => {
        it("chat predicate takes priority over content_of", () => {
            const link = makeLink({ predicate: "sioc://content_of" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "chat-message");
        });

        it("reply is detected when not a chat predicate", () => {
            const link = makeLink({ predicate: "flux://has_reply" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reply");
        });
    });

    describe("edge cases", () => {
        it("returns unknown for empty predicate", () => {
            const link = makeLink({ predicate: "" });
            assert.equal(detectPattern(link, DEFAULT_CHAT_PREDICATES).type, "unknown");
        });

        it("returns unknown for undefined predicate", () => {
            const link = makeLink({ predicate: undefined });
            assert.equal(detectPattern(link, DEFAULT_CHAT_PREDICATES).type, "unknown");
        });

        it("returns unknown for unrecognized predicate", () => {
            const link = makeLink({ predicate: "custom://unknown-action" });
            assert.equal(detectPattern(link, DEFAULT_CHAT_PREDICATES).type, "unknown");
        });

        it("handles empty chatPredicates array", () => {
            const link = makeLink({ predicate: "flux://has_message" });
            assert.equal(detectPattern(link, []).type, "unknown");
        });

        it("handles link with empty source and target", () => {
            const link = makeLink({ source: "", target: "" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "chat-message");
            assert.equal(result.channelUri, "");
            assert.equal(result.contentUri, "");
        });
    });
});
