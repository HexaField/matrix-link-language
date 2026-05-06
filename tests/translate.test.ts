/**
 * Tests for Link ↔ Matrix event translation, SDNA pattern detection,
 * rendering, and dual-language deduplication.
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
    detectPattern,
    renderLinkAsText,
    renderLinkAsHtml,
    renderChatMessageText,
    renderChatMessageHtml,
    renderReplyText,
    renderReplyHtml,
    renderSemanticHtml,
    renderBatchHtml,
    renderReactionText,
    isDuplicate,
    linkContentHash,
    linkOriginKey,
    shouldFederate,
    isPredicateExcluded,
    shouldFederateLink,
} from "../src/translate.js";

import type { LinkTripleContent, Ad4mMessageContent, ReactionContent, DetectedPattern, LinkOrigin } from "../src/translate.js";
import type { LinkExpression } from "../src/types.js";
import type { MatrixEvent } from "../src/api.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NEIGHBOURHOOD = "neighbourhood://!abc123:matrix.example.com";
const DEFAULT_CHAT_PREDICATES = ["flux://has_message", "sioc://content_of"];

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

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

function makeLinkData(overrides?: Partial<LinkExpression["data"]>): LinkExpression {
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

// ===========================================================================
// SDNA Pattern Detection (from sdna.test.ts)
// ===========================================================================

describe("detectPattern", () => {
    describe("chat-message detection", () => {
        it("detects flux://has_message as chat-message", () => {
            const result = detectPattern(makeLinkData(), DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "chat-message");
            assert.equal(result.channelUri, "channel://main");
            assert.equal(result.contentUri, "expr://msg-001");
        });

        it("detects sioc://content_of as chat-message (when in chatPredicates)", () => {
            const link = makeLinkData({ predicate: "sioc://content_of" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "chat-message");
        });

        it("detects custom chat predicates", () => {
            const link = makeLinkData({ predicate: "custom://chat" });
            const result = detectPattern(link, ["custom://chat"]);
            assert.equal(result.type, "chat-message");
        });

        it("does not detect when predicate not in chatPredicates", () => {
            const link = makeLinkData({ predicate: "flux://has_message" });
            const result = detectPattern(link, []);
            assert.equal(result.type, "unknown");
        });
    });

    describe("reply detection", () => {
        it("detects flux://has_reply", () => {
            const link = makeLinkData({
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
            const link = makeLinkData({ predicate: "sioc://reply_of" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reply");
        });
    });

    describe("mention detection", () => {
        it("detects predicate containing 'mention'", () => {
            const link = makeLinkData({
                target: "did:key:z6MkAlice",
                predicate: "flux://has_mention",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "mention");
            assert.equal(result.mentionedAgent, "did:key:z6MkAlice");
        });

        it("detects case-insensitively", () => {
            const link = makeLinkData({ predicate: "custom://HasMention" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "mention");
        });

        it("detects partial 'mention' in predicate", () => {
            const link = makeLinkData({ predicate: "app://user_mentioned" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "mention");
        });
    });

    describe("reaction detection", () => {
        it("detects flux://has_reaction", () => {
            const link = makeLinkData({
                source: "expr://msg",
                target: "👍",
                predicate: "flux://has_reaction",
            });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reaction");
            assert.equal(result.contentUri, "👍");
        });

        it("detects emoji://reaction", () => {
            const link = makeLinkData({ target: "❤️", predicate: "emoji://reaction" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reaction");
        });
    });

    describe("content detection", () => {
        it("detects sioc://content_of when NOT in chatPredicates", () => {
            const link = makeLinkData({ predicate: "sioc://content_of" });
            const result = detectPattern(link, ["flux://has_message"]);
            assert.equal(result.type, "content");
        });
    });

    describe("priority ordering", () => {
        it("chat predicate takes priority over content_of", () => {
            const link = makeLinkData({ predicate: "sioc://content_of" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "chat-message");
        });

        it("reply is detected when not a chat predicate", () => {
            const link = makeLinkData({ predicate: "flux://has_reply" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "reply");
        });
    });

    describe("edge cases", () => {
        it("returns unknown for empty predicate", () => {
            const link = makeLinkData({ predicate: "" });
            assert.equal(detectPattern(link, DEFAULT_CHAT_PREDICATES).type, "unknown");
        });

        it("returns unknown for undefined predicate", () => {
            const link = makeLinkData({ predicate: undefined });
            assert.equal(detectPattern(link, DEFAULT_CHAT_PREDICATES).type, "unknown");
        });

        it("returns unknown for unrecognized predicate", () => {
            const link = makeLinkData({ predicate: "custom://unknown-action" });
            assert.equal(detectPattern(link, DEFAULT_CHAT_PREDICATES).type, "unknown");
        });

        it("handles empty chatPredicates array", () => {
            const link = makeLinkData({ predicate: "flux://has_message" });
            assert.equal(detectPattern(link, []).type, "unknown");
        });

        it("handles link with empty source and target", () => {
            const link = makeLinkData({ source: "", target: "" });
            const result = detectPattern(link, DEFAULT_CHAT_PREDICATES);
            assert.equal(result.type, "chat-message");
            assert.equal(result.channelUri, "");
            assert.equal(result.contentUri, "");
        });
    });
});

// ===========================================================================
// Rendering (from rendering.test.ts)
// ===========================================================================

describe("renderLinkAsText", () => {
    it("renders a full triple", () => {
        const link = makeLinkData();
        const text = renderLinkAsText(link);
        assert.equal(text, "channel://main —[flux://has_message]→ expr://msg-001");
    });

    it("renders target only when source and predicate are empty", () => {
        const link = makeLinkData({ source: "", predicate: "" });
        const text = renderLinkAsText(link);
        assert.equal(text, "expr://msg-001");
    });

    it("renders [empty link] when all fields empty", () => {
        const link = makeLinkData({ source: "", predicate: "", target: "" });
        assert.equal(renderLinkAsText(link), "[empty link]");
    });
});

describe("renderChatMessageText", () => {
    it("uses resolved content when available", () => {
        const link = makeLinkData();
        assert.equal(renderChatMessageText(link, "Hello!"), "Hello!");
    });

    it("falls back to target URI", () => {
        const link = makeLinkData();
        assert.equal(renderChatMessageText(link), "expr://msg-001");
    });

    it("returns [no content] when target is empty", () => {
        const link = makeLinkData({ target: "" });
        assert.equal(renderChatMessageText(link), "[no content]");
    });
});

describe("renderReplyText", () => {
    it("includes parent author in quote", () => {
        const link = makeLinkData();
        const text = renderReplyText(link, "I agree!", "Alice");
        assert.equal(text, "> Alice:\nI agree!");
    });

    it("omits quote without parent author", () => {
        const link = makeLinkData();
        assert.equal(renderReplyText(link, "Reply"), "Reply");
    });

    it("falls back to target URI without resolved content", () => {
        const link = makeLinkData();
        assert.equal(renderReplyText(link), "expr://msg-001");
    });
});

describe("renderReactionText", () => {
    it("returns the emoji", () => {
        assert.equal(renderReactionText("👍"), "👍");
    });

    it("defaults to 👍", () => {
        assert.equal(renderReactionText(""), "👍");
    });
});

describe("renderLinkAsHtml", () => {
    it("renders triple with code tags", () => {
        const link = makeLinkData();
        const html = renderLinkAsHtml(link);
        assert.ok(html.includes("🔗"));
        assert.ok(html.includes("<code>channel://main</code>"));
        assert.ok(html.includes("<code>flux://has_message</code>"));
        assert.ok(html.includes("<code>expr://msg-001</code>"));
    });

    it("escapes HTML entities", () => {
        const link = makeLinkData({ source: "<script>alert(1)</script>" });
        const html = renderLinkAsHtml(link);
        assert.ok(html.includes("&lt;script&gt;"));
        assert.ok(!html.includes("<script>"));
    });

    it("handles empty source and predicate", () => {
        const link = makeLinkData({ source: "", predicate: "" });
        const html = renderLinkAsHtml(link);
        assert.ok(html.includes("expr://msg-001"));
    });
});

describe("renderChatMessageHtml", () => {
    it("wraps resolved content in paragraph", () => {
        const link = makeLinkData();
        assert.equal(renderChatMessageHtml(link, "Hello!"), "<p>Hello!</p>");
    });

    it("escapes HTML in resolved content", () => {
        const link = makeLinkData();
        const html = renderChatMessageHtml(link, "<b>bold</b>");
        assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;"));
    });

    it("falls back to target URI", () => {
        const link = makeLinkData();
        assert.equal(renderChatMessageHtml(link), "<p>expr://msg-001</p>");
    });
});

describe("renderReplyHtml", () => {
    it("includes blockquote for parent author", () => {
        const link = makeLinkData();
        const html = renderReplyHtml(link, "I agree!", "Alice");
        assert.ok(html.includes("<blockquote>"));
        assert.ok(html.includes("Alice"));
        assert.ok(html.includes("I agree!"));
    });

    it("omits blockquote without parent author", () => {
        const link = makeLinkData();
        const html = renderReplyHtml(link, "Reply");
        assert.ok(!html.includes("<blockquote>"));
        assert.ok(html.includes("Reply"));
    });
});

describe("renderSemanticHtml", () => {
    it("renders with author and full triple", () => {
        const link = makeLinkData();
        const html = renderSemanticHtml(link);
        assert.ok(html.includes("<strong>did:key:z6MkTest</strong>"));
        assert.ok(html.includes("channel://main"));
        assert.ok(html.includes("flux://has_message"));
        assert.ok(html.includes("expr://msg-001"));
    });
});

describe("renderBatchHtml", () => {
    it("renders empty batch", () => {
        assert.equal(renderBatchHtml([]), "<p>No links</p>");
    });

    it("renders single link (delegates to renderLinkAsHtml)", () => {
        const link = makeLinkData();
        const html = renderBatchHtml([link]);
        assert.ok(html.includes("🔗"));
    });

    it("renders multiple links as list", () => {
        const links = [
            makeLinkData(),
            makeLinkData({ source: "a", target: "b", predicate: "c" }),
        ];
        const html = renderBatchHtml(links);
        assert.ok(html.includes("📦 2 links:"));
        assert.ok(html.includes("<ul>"));
        assert.ok(html.includes("<li>"));
    });
});

// ===========================================================================
// Dual-Language Dedup (from dual-language.test.ts)
// ===========================================================================

describe("isDuplicate", () => {
    it("returns false when no existing hashes", () => {
        const link = makeLinkData({ source: "literal://hello", target: "literal://world", predicate: "sioc://content_of" });
        const existing = new Set<string>();
        assert.equal(isDuplicate(link, existing, simpleHash), false);
    });

    it("returns true when content hash matches existing", () => {
        const link = makeLinkData({ source: "literal://hello", target: "literal://world", predicate: "sioc://content_of" });
        const contentHash = linkContentHash(link, simpleHash);
        const existing = new Set<string>([contentHash]);
        assert.equal(isDuplicate(link, existing, simpleHash), true);
    });

    it("returns false for different link content", () => {
        const link1 = makeLinkData({ source: "a", target: "b", predicate: "c" });
        const link2 = makeLinkData({ source: "x", target: "y", predicate: "z" });
        const hash1 = linkContentHash(link1, simpleHash);
        const existing = new Set<string>([hash1]);
        assert.equal(isDuplicate(link2, existing, simpleHash), false);
    });

    it("deduplicates based on triple only (ignores author/timestamp)", () => {
        const link1 = makeLinkData({ source: "literal://hello", target: "literal://world", predicate: "sioc://content_of" });
        const link2: LinkExpression = {
            ...makeLinkData({ source: "literal://hello", target: "literal://world", predicate: "sioc://content_of" }),
            author: "did:key:z6MkOther",
            timestamp: "2026-06-01T00:00:00.000Z",
        };
        const hash1 = linkContentHash(link1, simpleHash);
        const existing = new Set<string>([hash1]);
        assert.equal(isDuplicate(link2, existing, simpleHash), true);
    });
});

describe("linkContentHash", () => {
    it("produces deterministic hash", () => {
        const link = makeLinkData({ source: "literal://hello", target: "literal://world", predicate: "sioc://content_of" });
        assert.equal(linkContentHash(link, simpleHash), linkContentHash(link, simpleHash));
    });

    it("produces different hashes for different links", () => {
        const link1 = makeLinkData({ source: "a" });
        const link2 = makeLinkData({ source: "b" });
        assert.notEqual(linkContentHash(link1, simpleHash), linkContentHash(link2, simpleHash));
    });

    it("ignores author and timestamp in hash", () => {
        const link1 = makeLinkData({ source: "literal://hello", target: "literal://world", predicate: "sioc://content_of" });
        const link2: LinkExpression = {
            ...makeLinkData({ source: "literal://hello", target: "literal://world", predicate: "sioc://content_of" }),
            author: "did:key:z6MkDifferent",
            timestamp: "2099-01-01T00:00:00.000Z",
        };
        assert.equal(linkContentHash(link1, simpleHash), linkContentHash(link2, simpleHash));
    });
});

describe("linkOriginKey", () => {
    it("produces correct storage key format", () => {
        assert.equal(linkOriginKey("abc123"), "link-origin/abc123");
    });

    it("handles empty hash", () => {
        assert.equal(linkOriginKey(""), "link-origin/");
    });
});

describe("shouldFederate", () => {
    it("returns true when no origin is tracked (new local commit)", () => {
        assert.equal(shouldFederate("hash123", () => null), true);
    });

    it("returns true for native-origin links", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash123") return "native";
            return null;
        };
        assert.equal(shouldFederate("hash123", getOrigin), true);
    });

    it("returns true for dual-origin links", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash456") return "dual";
            return null;
        };
        assert.equal(shouldFederate("hash456", getOrigin), true);
    });

    it("returns false for matrix-origin links (prevents echo loop)", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash789") return "matrix";
            return null;
        };
        assert.equal(shouldFederate("hash789", getOrigin), false);
    });

    it("constructs correct storage key for lookup", () => {
        let queriedKey = "";
        const getOrigin = (key: string): string | null => {
            queriedKey = key;
            return null;
        };
        shouldFederate("myLinkHash", getOrigin);
        assert.equal(queriedKey, "link-origin/myLinkHash");
    });
});

describe("isPredicateExcluded", () => {
    it("returns false for empty exclude list", () => {
        assert.equal(isPredicateExcluded("flux://has_message", []), false);
    });

    it("returns true for excluded predicate", () => {
        assert.equal(isPredicateExcluded("flux://internal", ["flux://internal"]), true);
    });

    it("returns false for non-excluded predicate", () => {
        assert.equal(isPredicateExcluded("flux://public", ["flux://internal"]), false);
    });

    it("returns false for undefined predicate", () => {
        assert.equal(isPredicateExcluded(undefined, ["flux://internal"]), false);
    });
});

describe("shouldFederateLink", () => {
    it("returns false when predicate is excluded", () => {
        assert.equal(
            shouldFederateLink("hash", "flux://internal", () => null, ["flux://internal"]),
            false,
        );
    });

    it("returns false when origin is matrix", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash") return "matrix";
            return null;
        };
        assert.equal(
            shouldFederateLink("hash", "flux://public", getOrigin, []),
            false,
        );
    });

    it("returns true when all checks pass", () => {
        assert.equal(
            shouldFederateLink("hash", "flux://public", () => null, []),
            true,
        );
    });

    it("returns true for native origin with non-excluded predicate", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash") return "native";
            return null;
        };
        assert.equal(
            shouldFederateLink("hash", "flux://public", getOrigin, ["flux://internal"]),
            true,
        );
    });
});
