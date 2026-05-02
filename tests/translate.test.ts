/**
 * Tests for Link ↔ Matrix event translation.
 *
 * Tests the pure translation functions without requiring ad4m:host runtime.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    linkToTripleContent,
    linkToMessageContent,
    linkToReplyContent,
    linkToReactionContent,
    linkContentKey,
    tripleEventToLink,
    messageEventToLink,
    reactionEventToLink,
    redactionToRemoval,
    inboundEventToLink,
    toISO,
} from "../src/translate.pure.js";

import type { LinkTripleContent, Ad4mMessageContent, ReactionContent } from "../src/translate.pure.js";
import type { LinkExpression } from "../src/types.js";
import type { MatrixEvent } from "../src/matrix-api.pure.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NEIGHBOURHOOD = "neighbourhood://!abc123:matrix.example.com";

function makeLink(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "channel://main",
            target: "expr://Qm456def",
            predicate: "flux://has_message",
        },
        proof: {
            signature: "abc123",
            key: "key123",
        },
        ...overrides,
    };
}

function makeChatLink(): LinkExpression {
    return makeLink({
        data: {
            source: "channel://main",
            target: "expr://msg-001",
            predicate: "flux://has_message",
        },
    });
}

function makeTripleEvent(overrides?: Partial<MatrixEvent>): MatrixEvent {
    return {
        type: "dev.ad4m.link.triple",
        event_id: "$evt1:matrix.example.com",
        sender: "@ad4m-bridge:matrix.example.com",
        origin_server_ts: 1746144000000,
        content: {
            source: "channel://main",
            predicate: "flux://has_message",
            target: "expr://Qm456def",
            author: "did:key:z6MkAgent",
            timestamp: "2026-05-02T12:00:00.000Z",
            proof: { signature: "sig123", key: "key456" },
        },
        ...overrides,
    };
}

function makeMessageEvent(overrides?: Partial<MatrixEvent>): MatrixEvent {
    return {
        type: "m.room.message",
        event_id: "$msg1:matrix.example.com",
        sender: "@alice:matrix.org",
        origin_server_ts: 1746144000000,
        content: {
            msgtype: "m.text",
            body: "Hello from Matrix!",
        },
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// linkToTripleContent
// ---------------------------------------------------------------------------

describe("linkToTripleContent", () => {
    it("produces lossless triple content from a LinkExpression", () => {
        const link = makeLink();
        const content = linkToTripleContent(link);

        assert.equal(content.source, "channel://main");
        assert.equal(content.predicate, "flux://has_message");
        assert.equal(content.target, "expr://Qm456def");
        assert.equal(content.author, "did:key:z6MkTest");
        assert.equal(content.timestamp, "2026-05-02T00:00:00.000Z");
        assert.equal(content.proof.signature, "abc123");
        assert.equal(content.proof.key, "key123");
    });

    it("includes link_hash when provided", () => {
        const link = makeLink();
        const content = linkToTripleContent(link, "QmHash123");
        assert.equal(content.link_hash, "QmHash123");
    });

    it("omits link_hash when not provided", () => {
        const link = makeLink();
        const content = linkToTripleContent(link);
        assert.equal(content.link_hash, undefined);
    });

    it("handles empty fields", () => {
        const link = makeLink({
            data: { source: "", target: "", predicate: "" },
            proof: { signature: "", key: "" },
        });
        const content = linkToTripleContent(link);
        assert.equal(content.source, "");
        assert.equal(content.target, "");
        assert.equal(content.predicate, "");
    });
});

// ---------------------------------------------------------------------------
// linkToMessageContent
// ---------------------------------------------------------------------------

describe("linkToMessageContent", () => {
    it("produces m.text message with ad4m metadata", () => {
        const link = makeLink();
        const content = linkToMessageContent(link, "Hello!");

        assert.equal(content.msgtype, "m.text");
        assert.equal(content.body, "Hello!");
        assert.ok(content.ad4m);
        assert.equal(content.ad4m!.source, "channel://main");
        assert.equal(content.ad4m!.predicate, "flux://has_message");
        assert.equal(content.ad4m!.target, "expr://Qm456def");
        assert.equal(content.ad4m!.author, "did:key:z6MkTest");
    });

    it("includes formatted_body when htmlBody is provided", () => {
        const link = makeLink();
        const content = linkToMessageContent(link, "Hello!", "<p>Hello!</p>");

        assert.equal(content.format, "org.matrix.custom.html");
        assert.equal(content.formatted_body, "<p>Hello!</p>");
    });

    it("omits format when no htmlBody", () => {
        const link = makeLink();
        const content = linkToMessageContent(link, "Hello!");

        assert.equal(content.format, undefined);
        assert.equal(content.formatted_body, undefined);
    });
});

// ---------------------------------------------------------------------------
// linkToReplyContent
// ---------------------------------------------------------------------------

describe("linkToReplyContent", () => {
    it("produces message with m.relates_to for threading", () => {
        const link = makeLink();
        const content = linkToReplyContent(link, "I agree!", "$root:server", "$parent:server");

        assert.equal(content.body, "I agree!");
        assert.ok(content["m.relates_to"]);
        assert.equal(content["m.relates_to"]!.rel_type, "m.thread");
        assert.equal(content["m.relates_to"]!.event_id, "$root:server");
        assert.equal(content["m.relates_to"]!.is_falling_back, true);
        assert.equal(content["m.relates_to"]!["m.in_reply_to"]!.event_id, "$parent:server");
    });

    it("includes ad4m metadata", () => {
        const link = makeLink();
        const content = linkToReplyContent(link, "Reply", "$root:s", "$parent:s");
        assert.ok(content.ad4m);
        assert.equal(content.ad4m!.author, "did:key:z6MkTest");
    });
});

// ---------------------------------------------------------------------------
// linkToReactionContent
// ---------------------------------------------------------------------------

describe("linkToReactionContent", () => {
    it("produces m.annotation reaction content", () => {
        const content = linkToReactionContent("$target:server", "👍");

        assert.equal(content["m.relates_to"].rel_type, "m.annotation");
        assert.equal(content["m.relates_to"].event_id, "$target:server");
        assert.equal(content["m.relates_to"].key, "👍");
    });

    it("handles emoji strings", () => {
        const content = linkToReactionContent("$evt:s", "❤️");
        assert.equal(content["m.relates_to"].key, "❤️");
    });
});

// ---------------------------------------------------------------------------
// tripleEventToLink
// ---------------------------------------------------------------------------

describe("tripleEventToLink", () => {
    it("reconstructs a LinkExpression from a triple event", () => {
        const event = makeTripleEvent();
        const link = tripleEventToLink(event);

        assert.ok(link);
        assert.equal(link!.data.source, "channel://main");
        assert.equal(link!.data.predicate, "flux://has_message");
        assert.equal(link!.data.target, "expr://Qm456def");
        assert.equal(link!.author, "did:key:z6MkAgent");
        assert.equal(link!.timestamp, "2026-05-02T12:00:00.000Z");
        assert.equal(link!.proof.signature, "sig123");
        assert.equal(link!.proof.key, "key456");
    });

    it("falls back to sender for author when content.author missing", () => {
        const event = makeTripleEvent({
            content: {
                source: "a",
                target: "b",
                predicate: "c",
                proof: { signature: "", key: "" },
            },
        });
        const link = tripleEventToLink(event);
        assert.ok(link);
        assert.equal(link!.author, "matrix:@ad4m-bridge:matrix.example.com");
    });

    it("returns null for invalid content", () => {
        const event: MatrixEvent = {
            type: "dev.ad4m.link.triple",
            content: { invalid: true },
        };
        assert.equal(tripleEventToLink(event), null);
    });
});

// ---------------------------------------------------------------------------
// messageEventToLink
// ---------------------------------------------------------------------------

describe("messageEventToLink", () => {
    it("reconstructs native link from ad4m metadata", () => {
        const event = makeMessageEvent({
            content: {
                msgtype: "m.text",
                body: "Hello!",
                ad4m: {
                    source: "channel://main",
                    predicate: "flux://has_message",
                    target: "expr://msg-001",
                    author: "did:key:z6MkAlice",
                    proof: { signature: "sig", key: "key" },
                },
            },
        });

        const link = messageEventToLink(event, NEIGHBOURHOOD);
        assert.ok(link);
        assert.equal(link!.data.source, "channel://main");
        assert.equal(link!.data.predicate, "flux://has_message");
        assert.equal(link!.data.target, "expr://msg-001");
        assert.equal(link!.author, "did:key:z6MkAlice");
    });

    it("creates synthetic link for plain Matrix message", () => {
        const event = makeMessageEvent();
        const link = messageEventToLink(event, NEIGHBOURHOOD);

        assert.ok(link);
        assert.equal(link!.data.source, NEIGHBOURHOOD);
        assert.equal(link!.data.predicate, "matrix://message");
        assert.equal(link!.data.target, "$msg1:matrix.example.com");
        assert.equal(link!.author, "matrix:@alice:matrix.org");
    });

    it("returns null for non-text messages", () => {
        const event = makeMessageEvent({
            content: { msgtype: "m.image", body: "photo.png" },
        });
        assert.equal(messageEventToLink(event, NEIGHBOURHOOD), null);
    });
});

// ---------------------------------------------------------------------------
// reactionEventToLink
// ---------------------------------------------------------------------------

describe("reactionEventToLink", () => {
    it("creates a reaction link", () => {
        const event: MatrixEvent = {
            type: "m.reaction",
            event_id: "$reaction1:server",
            sender: "@bob:matrix.org",
            origin_server_ts: 1746144000000,
            content: {
                "m.relates_to": {
                    rel_type: "m.annotation",
                    event_id: "$target:server",
                    key: "👍",
                },
            },
        };

        const link = reactionEventToLink(event);
        assert.ok(link);
        assert.equal(link!.data.source, "$target:server");
        assert.equal(link!.data.target, "👍");
        assert.equal(link!.data.predicate, "flux://has_reaction");
        assert.equal(link!.author, "matrix:@bob:matrix.org");
    });

    it("returns null for non-annotation reactions", () => {
        const event: MatrixEvent = {
            type: "m.reaction",
            content: {
                "m.relates_to": {
                    rel_type: "m.replace",
                    event_id: "$evt:s",
                    key: "x",
                },
            },
        };
        assert.equal(reactionEventToLink(event), null);
    });
});

// ---------------------------------------------------------------------------
// redactionToRemoval
// ---------------------------------------------------------------------------

describe("redactionToRemoval", () => {
    it("creates a removal link from redaction event", () => {
        const event: MatrixEvent = {
            type: "m.room.redaction",
            event_id: "$redact1:server",
            sender: "@admin:matrix.org",
            origin_server_ts: 1746144000000,
            content: {},
            redacts: "$target-event:server",
        };

        const link = redactionToRemoval(event, NEIGHBOURHOOD);
        assert.ok(link);
        assert.equal(link!.data.source, NEIGHBOURHOOD);
        assert.equal(link!.data.target, "$target-event:server");
        assert.equal(link!.data.predicate, "matrix://redacted");
    });

    it("returns null when no redacted event ID", () => {
        const event: MatrixEvent = {
            type: "m.room.redaction",
            content: {},
        };
        assert.equal(redactionToRemoval(event, NEIGHBOURHOOD), null);
    });
});

// ---------------------------------------------------------------------------
// inboundEventToLink (dispatcher)
// ---------------------------------------------------------------------------

describe("inboundEventToLink", () => {
    it("routes dev.ad4m.link.triple to tripleEventToLink", () => {
        const event = makeTripleEvent();
        const link = inboundEventToLink(event, NEIGHBOURHOOD);
        assert.ok(link);
        assert.equal(link!.data.source, "channel://main");
    });

    it("routes m.room.message to messageEventToLink", () => {
        const event = makeMessageEvent();
        const link = inboundEventToLink(event, NEIGHBOURHOOD);
        assert.ok(link);
        assert.equal(link!.data.predicate, "matrix://message");
    });

    it("routes m.reaction to reactionEventToLink", () => {
        const event: MatrixEvent = {
            type: "m.reaction",
            sender: "@user:server",
            origin_server_ts: 1746144000000,
            content: {
                "m.relates_to": {
                    rel_type: "m.annotation",
                    event_id: "$target:s",
                    key: "🔥",
                },
            },
        };
        const link = inboundEventToLink(event, NEIGHBOURHOOD);
        assert.ok(link);
        assert.equal(link!.data.predicate, "flux://has_reaction");
    });

    it("routes m.room.redaction to redactionToRemoval", () => {
        const event: MatrixEvent = {
            type: "m.room.redaction",
            sender: "@admin:server",
            origin_server_ts: 1746144000000,
            content: {},
            redacts: "$evt:s",
        };
        const link = inboundEventToLink(event, NEIGHBOURHOOD);
        assert.ok(link);
        assert.equal(link!.data.predicate, "matrix://redacted");
    });

    it("returns null for unsupported event types", () => {
        const event: MatrixEvent = {
            type: "m.room.topic",
            content: { topic: "test" },
        };
        assert.equal(inboundEventToLink(event, NEIGHBOURHOOD), null);
    });
});

// ---------------------------------------------------------------------------
// Round-trip tests
// ---------------------------------------------------------------------------

describe("Round-trip: link → triple event → link", () => {
    it("preserves all link fields losslessly", () => {
        const original = makeLink();
        const tripleContent = linkToTripleContent(original);

        // Simulate event from homeserver
        const event: MatrixEvent = {
            type: "dev.ad4m.link.triple",
            event_id: "$roundtrip:server",
            sender: "@bridge:server",
            origin_server_ts: 1746144000000,
            content: tripleContent as unknown as Record<string, unknown>,
        };

        const roundTripped = tripleEventToLink(event);
        assert.ok(roundTripped);
        assert.equal(roundTripped!.data.source, original.data.source);
        assert.equal(roundTripped!.data.predicate, original.data.predicate);
        assert.equal(roundTripped!.data.target, original.data.target);
        assert.equal(roundTripped!.author, original.author);
        assert.equal(roundTripped!.timestamp, original.timestamp);
        assert.equal(roundTripped!.proof.signature, original.proof.signature);
        assert.equal(roundTripped!.proof.key, original.proof.key);
    });

    it("round-trips a chat message via m.room.message with ad4m metadata", () => {
        const original = makeChatLink();
        const msgContent = linkToMessageContent(original, "Hello world!");

        const event: MatrixEvent = {
            type: "m.room.message",
            event_id: "$chat-rt:server",
            sender: "@bridge:server",
            origin_server_ts: 1746144000000,
            content: msgContent as unknown as Record<string, unknown>,
        };

        const roundTripped = messageEventToLink(event, NEIGHBOURHOOD);
        assert.ok(roundTripped);
        assert.equal(roundTripped!.data.source, original.data.source);
        assert.equal(roundTripped!.data.predicate, original.data.predicate);
        assert.equal(roundTripped!.data.target, original.data.target);
    });
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe("toISO", () => {
    it("converts ISO string passthrough", () => {
        assert.equal(toISO("2026-05-02T00:00:00.000Z"), "2026-05-02T00:00:00.000Z");
    });

    it("converts epoch ms to ISO", () => {
        const result = toISO(1746144000000);
        assert.ok(result.includes("2025-05-0"));
    });
});

describe("linkContentKey", () => {
    it("produces a deterministic key", () => {
        const link = makeLink();
        assert.equal(linkContentKey(link), linkContentKey(link));
    });

    it("differs for different links", () => {
        const link1 = makeLink();
        const link2 = makeLink({
            data: { source: "a", target: "b", predicate: "c" },
        });
        assert.notEqual(linkContentKey(link1), linkContentKey(link2));
    });
});
