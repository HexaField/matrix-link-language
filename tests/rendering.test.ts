/**
 * Tests for pure message body generation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    renderLinkAsText,
    renderLinkAsHtml,
    renderChatMessageText,
    renderChatMessageHtml,
    renderReplyText,
    renderReplyHtml,
    renderSemanticHtml,
    renderBatchHtml,
    renderReactionText,
} from "../src/rendering.pure.js";

import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
// renderLinkAsText
// ---------------------------------------------------------------------------

describe("renderLinkAsText", () => {
    it("renders a full triple", () => {
        const link = makeLink();
        const text = renderLinkAsText(link);
        assert.equal(text, "channel://main —[flux://has_message]→ expr://msg-001");
    });

    it("renders target only when source and predicate are empty", () => {
        const link = makeLink({ source: "", predicate: "" });
        const text = renderLinkAsText(link);
        assert.equal(text, "expr://msg-001");
    });

    it("renders [empty link] when all fields empty", () => {
        const link = makeLink({ source: "", predicate: "", target: "" });
        assert.equal(renderLinkAsText(link), "[empty link]");
    });
});

// ---------------------------------------------------------------------------
// renderChatMessageText
// ---------------------------------------------------------------------------

describe("renderChatMessageText", () => {
    it("uses resolved content when available", () => {
        const link = makeLink();
        assert.equal(renderChatMessageText(link, "Hello!"), "Hello!");
    });

    it("falls back to target URI", () => {
        const link = makeLink();
        assert.equal(renderChatMessageText(link), "expr://msg-001");
    });

    it("returns [no content] when target is empty", () => {
        const link = makeLink({ target: "" });
        assert.equal(renderChatMessageText(link), "[no content]");
    });
});

// ---------------------------------------------------------------------------
// renderReplyText
// ---------------------------------------------------------------------------

describe("renderReplyText", () => {
    it("includes parent author in quote", () => {
        const link = makeLink();
        const text = renderReplyText(link, "I agree!", "Alice");
        assert.equal(text, "> Alice:\nI agree!");
    });

    it("omits quote without parent author", () => {
        const link = makeLink();
        assert.equal(renderReplyText(link, "Reply"), "Reply");
    });

    it("falls back to target URI without resolved content", () => {
        const link = makeLink();
        assert.equal(renderReplyText(link), "expr://msg-001");
    });
});

// ---------------------------------------------------------------------------
// renderReactionText
// ---------------------------------------------------------------------------

describe("renderReactionText", () => {
    it("returns the emoji", () => {
        assert.equal(renderReactionText("👍"), "👍");
    });

    it("defaults to 👍", () => {
        assert.equal(renderReactionText(""), "👍");
    });
});

// ---------------------------------------------------------------------------
// renderLinkAsHtml
// ---------------------------------------------------------------------------

describe("renderLinkAsHtml", () => {
    it("renders triple with code tags", () => {
        const link = makeLink();
        const html = renderLinkAsHtml(link);
        assert.ok(html.includes("🔗"));
        assert.ok(html.includes("<code>channel://main</code>"));
        assert.ok(html.includes("<code>flux://has_message</code>"));
        assert.ok(html.includes("<code>expr://msg-001</code>"));
    });

    it("escapes HTML entities", () => {
        const link = makeLink({ source: "<script>alert(1)</script>" });
        const html = renderLinkAsHtml(link);
        assert.ok(html.includes("&lt;script&gt;"));
        assert.ok(!html.includes("<script>"));
    });

    it("handles empty source and predicate", () => {
        const link = makeLink({ source: "", predicate: "" });
        const html = renderLinkAsHtml(link);
        assert.ok(html.includes("expr://msg-001"));
    });
});

// ---------------------------------------------------------------------------
// renderChatMessageHtml
// ---------------------------------------------------------------------------

describe("renderChatMessageHtml", () => {
    it("wraps resolved content in paragraph", () => {
        const link = makeLink();
        assert.equal(renderChatMessageHtml(link, "Hello!"), "<p>Hello!</p>");
    });

    it("escapes HTML in resolved content", () => {
        const link = makeLink();
        const html = renderChatMessageHtml(link, "<b>bold</b>");
        assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;"));
    });

    it("falls back to target URI", () => {
        const link = makeLink();
        assert.equal(renderChatMessageHtml(link), "<p>expr://msg-001</p>");
    });
});

// ---------------------------------------------------------------------------
// renderReplyHtml
// ---------------------------------------------------------------------------

describe("renderReplyHtml", () => {
    it("includes blockquote for parent author", () => {
        const link = makeLink();
        const html = renderReplyHtml(link, "I agree!", "Alice");
        assert.ok(html.includes("<blockquote>"));
        assert.ok(html.includes("Alice"));
        assert.ok(html.includes("I agree!"));
    });

    it("omits blockquote without parent author", () => {
        const link = makeLink();
        const html = renderReplyHtml(link, "Reply");
        assert.ok(!html.includes("<blockquote>"));
        assert.ok(html.includes("Reply"));
    });
});

// ---------------------------------------------------------------------------
// renderSemanticHtml
// ---------------------------------------------------------------------------

describe("renderSemanticHtml", () => {
    it("renders with author and full triple", () => {
        const link = makeLink();
        const html = renderSemanticHtml(link);
        assert.ok(html.includes("<strong>did:key:z6MkTest</strong>"));
        assert.ok(html.includes("channel://main"));
        assert.ok(html.includes("flux://has_message"));
        assert.ok(html.includes("expr://msg-001"));
    });
});

// ---------------------------------------------------------------------------
// renderBatchHtml
// ---------------------------------------------------------------------------

describe("renderBatchHtml", () => {
    it("renders empty batch", () => {
        assert.equal(renderBatchHtml([]), "<p>No links</p>");
    });

    it("renders single link (delegates to renderLinkAsHtml)", () => {
        const link = makeLink();
        const html = renderBatchHtml([link]);
        assert.ok(html.includes("🔗"));
    });

    it("renders multiple links as list", () => {
        const links = [
            makeLink(),
            makeLink({ source: "a", target: "b", predicate: "c" }),
        ];
        const html = renderBatchHtml(links);
        assert.ok(html.includes("📦 2 links:"));
        assert.ok(html.includes("<ul>"));
        assert.ok(html.includes("<li>"));
    });
});
