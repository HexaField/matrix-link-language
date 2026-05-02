/**
 * Pure message body generation for m.room.message rendering.
 *
 * Generates text and HTML representations of LinkExpressions for
 * display in Matrix clients (Element, etc.).
 *
 * Zero runtime dependencies — safe for unit testing.
 *
 * Spec §5.3, §5.4.
 */

import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Plain text rendering
// ---------------------------------------------------------------------------

/**
 * Render a LinkExpression as plain text for m.room.message body.
 */
export function renderLinkAsText(link: LinkExpression): string {
    const source = link.data.source || "";
    const predicate = link.data.predicate || "";
    const target = link.data.target || "";

    if (!source && !predicate) {
        return target || "[empty link]";
    }

    return `${source} —[${predicate}]→ ${target}`;
}

/**
 * Render a chat message as plain text.
 * Uses resolved content if available, otherwise uses the target URI.
 */
export function renderChatMessageText(
    link: LinkExpression,
    resolvedContent?: string,
): string {
    if (resolvedContent) return resolvedContent;
    return link.data.target || "[no content]";
}

/**
 * Render a reply message as plain text.
 */
export function renderReplyText(
    link: LinkExpression,
    resolvedContent?: string,
    parentAuthor?: string,
): string {
    const content = resolvedContent || link.data.target || "[no content]";
    if (parentAuthor) {
        return `> ${parentAuthor}:\n${content}`;
    }
    return content;
}

/**
 * Render a reaction as plain text.
 */
export function renderReactionText(emoji: string): string {
    return emoji || "👍";
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

/**
 * Render a LinkExpression as HTML for m.room.message formatted_body.
 */
export function renderLinkAsHtml(link: LinkExpression): string {
    const source = escapeHtml(link.data.source || "");
    const predicate = escapeHtml(link.data.predicate || "");
    const target = escapeHtml(link.data.target || "");

    if (!source && !predicate) {
        return `<p>${target || "[empty link]"}</p>`;
    }

    return `<p>🔗 <code>${source}</code> —[<code>${predicate}</code>]→ <code>${target}</code></p>`;
}

/**
 * Render a chat message as HTML.
 */
export function renderChatMessageHtml(
    link: LinkExpression,
    resolvedContent?: string,
): string {
    if (resolvedContent) return `<p>${escapeHtml(resolvedContent)}</p>`;
    return `<p>${escapeHtml(link.data.target || "[no content]")}</p>`;
}

/**
 * Render a reply as HTML.
 */
export function renderReplyHtml(
    link: LinkExpression,
    resolvedContent?: string,
    parentAuthor?: string,
): string {
    const content = resolvedContent || link.data.target || "[no content]";
    if (parentAuthor) {
        return `<blockquote><p>${escapeHtml(parentAuthor)}:</p></blockquote><p>${escapeHtml(content)}</p>`;
    }
    return `<p>${escapeHtml(content)}</p>`;
}

/**
 * Render a semantic link as HTML with full triple display.
 */
export function renderSemanticHtml(link: LinkExpression): string {
    const source = escapeHtml(link.data.source || "");
    const predicate = escapeHtml(link.data.predicate || "");
    const target = escapeHtml(link.data.target || "");
    const author = escapeHtml(link.author);

    return `<p><strong>${author}</strong> linked ` +
        `<code>${source}</code> ` +
        `—[<code>${predicate}</code>]→ ` +
        `<code>${target}</code></p>`;
}

/**
 * Render a batch of links as an HTML summary.
 */
export function renderBatchHtml(links: LinkExpression[]): string {
    if (links.length === 0) return "<p>No links</p>";
    if (links.length === 1) return renderLinkAsHtml(links[0]);

    const items = links.map(link => {
        const source = escapeHtml(link.data.source || "");
        const pred = escapeHtml(link.data.predicate || "");
        const target = escapeHtml(link.data.target || "");
        return `<li><code>${source}</code> —[<code>${pred}</code>]→ <code>${target}</code></li>`;
    });

    return `<p>📦 ${links.length} links:</p><ul>${items.join("")}</ul>`;
}
