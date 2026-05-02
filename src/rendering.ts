/**
 * m.room.message rendering — orchestration module.
 *
 * Uses SDNA pattern detection and rendering settings to produce
 * the appropriate m.room.message content for each link.
 *
 * No ad4m:host imports.
 *
 * Spec §5.3, §5.4.
 */

import type { LinkExpression } from "./types.js";
import type { MatrixSettings } from "./settings.js";
import { detectPattern } from "./sdna.js";
import {
    renderLinkAsText,
    renderLinkAsHtml,
    renderChatMessageText,
    renderChatMessageHtml,
    renderReplyText,
    renderReplyHtml,
    renderSemanticHtml,
    renderReactionText,
} from "./rendering.pure.js";

export interface RenderedMessage {
    body: string;
    formattedBody?: string;
    format?: string;
}

/**
 * Render a LinkExpression into text/HTML bodies based on settings and
 * SDNA pattern detection.
 */
export function renderLink(
    link: LinkExpression,
    settings: MatrixSettings,
    resolvedContent?: string,
    parentAuthor?: string,
): RenderedMessage {
    const pattern = detectPattern(link, settings.rendering.chatPredicates);

    switch (pattern.type) {
        case "chat-message":
            return {
                body: renderChatMessageText(link, resolvedContent),
                formattedBody: renderChatMessageHtml(link, resolvedContent),
                format: "org.matrix.custom.html",
            };

        case "reply":
            return {
                body: renderReplyText(link, resolvedContent, parentAuthor),
                formattedBody: renderReplyHtml(link, resolvedContent, parentAuthor),
                format: "org.matrix.custom.html",
            };

        case "reaction":
            return {
                body: renderReactionText(link.data.target || ""),
            };

        case "mention":
        case "content":
            return {
                body: renderChatMessageText(link, resolvedContent),
                formattedBody: renderChatMessageHtml(link, resolvedContent),
                format: "org.matrix.custom.html",
            };

        case "unknown":
        default:
            return {
                body: renderLinkAsText(link),
                formattedBody: renderSemanticHtml(link),
                format: "org.matrix.custom.html",
            };
    }
}

// Re-export pure rendering functions
export {
    renderLinkAsText,
    renderLinkAsHtml,
    renderChatMessageText,
    renderChatMessageHtml,
    renderReplyText,
    renderReplyHtml,
    renderSemanticHtml,
    renderBatchHtml,
    renderReactionText,
} from "./rendering.pure.js";
