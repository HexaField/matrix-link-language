/**
 * Link ↔ Matrix event translation — pattern detection, rendering,
 * outbound/inbound conversion, and dual-language deduplication.
 *
 * No ad4m:host imports. Uses injected interfaces.
 *
 * Spec §2, §5, §6, §13.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import type { MatrixEvent } from "./api.js";
import type { MatrixSettings } from "./settings.js";

/** § Pattern Detection */

export interface DetectedPattern {
    type: "chat-message" | "reply" | "content" | "mention" | "reaction" | "unknown";
    /** Expression URI to resolve for content. */
    contentUri?: string;
    /** For replies: the parent message URI. */
    parentUri?: string;
    /** For chat: the channel/conversation URI. */
    channelUri?: string;
    /** For mentions: the mentioned agent DID or URI. */
    mentionedAgent?: string;
}

const REPLY_PREDICATES = new Set([
    "flux://has_reply",
    "sioc://reply_of",
]);

const REACTION_PREDICATES = new Set([
    "flux://has_reaction",
    "emoji://reaction",
]);

const CONTENT_PREDICATE = "sioc://content_of";

/**
 * Detect the Subject Class pattern of a link based on its predicate.
 */
export function detectPattern(
    link: LinkExpression,
    chatPredicates: string[],
): DetectedPattern {
    const predicate = link.data.predicate || "";
    const source = link.data.source || "";
    const target = link.data.target || "";

    // 1. Chat message
    if (predicate && chatPredicates.includes(predicate)) {
        return {
            type: "chat-message",
            contentUri: target,
            channelUri: source,
        };
    }

    // 2. Reply
    if (REPLY_PREDICATES.has(predicate)) {
        return {
            type: "reply",
            contentUri: target,
            parentUri: source,
        };
    }

    // 3. Mention
    if (predicate && predicate.toLowerCase().includes("mention")) {
        return {
            type: "mention",
            mentionedAgent: target,
        };
    }

    // 4. Reaction
    if (REACTION_PREDICATES.has(predicate)) {
        return {
            type: "reaction",
            contentUri: target,
        };
    }

    // 5. Content
    if (predicate === CONTENT_PREDICATE) {
        return {
            type: "content",
            contentUri: target,
        };
    }

    // 6. Unknown
    return { type: "unknown" };
}

/** § Rendering */

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

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

/** § Outbound — Link → Matrix Event */

/** Content shape for dev.ad4m.link.triple custom events. */
export interface LinkTripleContent {
    source: string;
    predicate: string;
    target: string;
    author: string;
    timestamp: string;
    proof: {
        signature: string;
        key: string;
    };
    link_hash?: string;
}

/** Content shape for m.room.message events with AD4M metadata. */
export interface Ad4mMessageContent {
    msgtype: "m.text";
    body: string;
    format?: string;
    formatted_body?: string;
    ad4m?: {
        source: string;
        predicate: string;
        target: string;
        author: string;
        proof: {
            signature: string;
            key: string;
        };
    };
    "m.relates_to"?: {
        rel_type: string;
        event_id: string;
        is_falling_back?: boolean;
        "m.in_reply_to"?: {
            event_id: string;
        };
    };
}

/** Content shape for m.reaction events. */
export interface ReactionContent {
    "m.relates_to": {
        rel_type: "m.annotation";
        event_id: string;
        key: string;
    };
}

/**
 * Convert a LinkExpression to a dev.ad4m.link.triple event content.
 */
export function linkToTripleContent(
    link: LinkExpression,
    linkHash?: string,
): LinkTripleContent {
    return {
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
        author: link.author,
        timestamp: link.timestamp,
        proof: {
            signature: link.proof?.signature || "",
            key: link.proof?.key || "",
        },
        ...(linkHash ? { link_hash: linkHash } : {}),
    };
}

/**
 * Convert a LinkExpression to an m.room.message event content.
 */
export function linkToMessageContent(
    link: LinkExpression,
    textBody: string,
    htmlBody?: string,
): Ad4mMessageContent {
    const content: Ad4mMessageContent = {
        msgtype: "m.text",
        body: textBody,
        ad4m: {
            source: link.data.source || "",
            predicate: link.data.predicate || "",
            target: link.data.target || "",
            author: link.author,
            proof: {
                signature: link.proof?.signature || "",
                key: link.proof?.key || "",
            },
        },
    };

    if (htmlBody) {
        content.format = "org.matrix.custom.html";
        content.formatted_body = htmlBody;
    }

    return content;
}

/**
 * Build a reply message content with Matrix threading (MSC3440).
 */
export function linkToReplyContent(
    link: LinkExpression,
    textBody: string,
    rootEventId: string,
    parentEventId: string,
    htmlBody?: string,
): Ad4mMessageContent {
    const content = linkToMessageContent(link, textBody, htmlBody);
    content["m.relates_to"] = {
        rel_type: "m.thread",
        event_id: rootEventId,
        is_falling_back: true,
        "m.in_reply_to": {
            event_id: parentEventId,
        },
    };
    return content;
}

/**
 * Build a reaction event content.
 */
export function linkToReactionContent(
    targetEventId: string,
    emoji: string,
): ReactionContent {
    return {
        "m.relates_to": {
            rel_type: "m.annotation",
            event_id: targetEventId,
            key: emoji,
        },
    };
}

/**
 * Determine the content key for a link (used for dedup and txn IDs).
 */
export function linkContentKey(link: LinkExpression): string {
    const data = link.data;
    return `${data.source || ""}:${data.predicate || ""}:${data.target || ""}:${link.author}:${link.timestamp}`;
}

/**
 * Convert an ISO-8601 timestamp or epoch-ms to ISO-8601 UTC.
 */
export function toISO(ts: string | number): string {
    const date = typeof ts === "number" ? new Date(ts) : new Date(ts);
    return date.toISOString();
}

export interface OutboundEvent {
    eventType: string;
    content: Record<string, unknown>;
}

export interface DiffToEventsOptions {
    settings: MatrixSettings;
    hashFn: (data: string) => string;
    neighbourhoodUrl: string;
    /** Optional map of expression URIs → resolved content */
    resolvedContent?: Map<string, string>;
    /** Optional map of parent URIs → Matrix event IDs (for reply threading) */
    parentEventIds?: Map<string, { rootEventId: string; parentEventId: string }>;
    /** Optional map of target URIs → Matrix event IDs (for reactions) */
    targetEventIds?: Map<string, string>;
    /** Federation filter: skip links that should not be sent */
    shouldFederate?: (linkHash: string) => boolean;
}

/**
 * Convert a PerspectiveDiff into Matrix event payloads.
 */
export function diffToEvents(
    diff: PerspectiveDiff,
    opts: DiffToEventsOptions,
): OutboundEvent[] {
    const events: OutboundEvent[] = [];
    const strategy = opts.settings.rendering.strategy;
    const chatPredicates = opts.settings.rendering.chatPredicates;

    for (const addition of diff.additions) {
        const lk = linkContentKey(addition);
        const linkHash = opts.hashFn(lk);

        // Check federation filter
        if (opts.shouldFederate && !opts.shouldFederate(linkHash)) {
            continue;
        }

        // Detect SDNA pattern for smart rendering
        const pattern = detectPattern(addition, chatPredicates);

        // Native event (dev.ad4m.link.triple)
        if (strategy === "native" || strategy === "dual") {
            events.push({
                eventType: "dev.ad4m.link.triple",
                content: linkToTripleContent(addition, linkHash) as unknown as Record<string, unknown>,
            });
        }

        // Matrix-visible event (m.room.message or m.reaction)
        if (strategy === "matrix" || strategy === "dual") {
            const matrixEvent = patternToMatrixEvent(addition, pattern, opts);
            if (matrixEvent) {
                events.push(matrixEvent);
            }
        }
    }

    return events;
}

/**
 * Convert a detected SDNA pattern into the appropriate Matrix event.
 */
function patternToMatrixEvent(
    link: LinkExpression,
    pattern: DetectedPattern,
    opts: DiffToEventsOptions,
): OutboundEvent | null {
    const target = link.data.target || "";
    const resolved = opts.resolvedContent?.get(target);

    switch (pattern.type) {
        case "chat-message": {
            const textBody = resolved || renderLinkAsText(link);
            const htmlBody = resolved ? undefined : renderLinkAsHtml(link);
            return {
                eventType: "m.room.message",
                content: linkToMessageContent(link, textBody, htmlBody) as unknown as Record<string, unknown>,
            };
        }

        case "reply": {
            const textBody = resolved || renderLinkAsText(link);
            const parentSource = link.data.source || "";
            const threadInfo = opts.parentEventIds?.get(parentSource);
            if (threadInfo) {
                return {
                    eventType: "m.room.message",
                    content: linkToReplyContent(
                        link,
                        textBody,
                        threadInfo.rootEventId,
                        threadInfo.parentEventId,
                    ) as unknown as Record<string, unknown>,
                };
            }
            return {
                eventType: "m.room.message",
                content: linkToMessageContent(link, textBody) as unknown as Record<string, unknown>,
            };
        }

        case "reaction": {
            const sourceUri = link.data.source || "";
            const targetEventId = opts.targetEventIds?.get(sourceUri);
            if (targetEventId) {
                return {
                    eventType: "m.reaction",
                    content: linkToReactionContent(targetEventId, target) as unknown as Record<string, unknown>,
                };
            }
            return {
                eventType: "m.room.message",
                content: linkToMessageContent(
                    link,
                    `Reacted with ${target}`,
                ) as unknown as Record<string, unknown>,
            };
        }

        case "mention":
        case "content":
        case "unknown":
        default: {
            const textBody = resolved || renderLinkAsText(link);
            const htmlBody = resolved ? undefined : renderLinkAsHtml(link);
            return {
                eventType: "m.room.message",
                content: linkToMessageContent(link, textBody, htmlBody) as unknown as Record<string, unknown>,
            };
        }
    }
}

/** § Inbound — Matrix Event → Link */

/**
 * Convert a dev.ad4m.link.triple event to a LinkExpression.
 */
export function tripleEventToLink(event: MatrixEvent): LinkExpression | null {
    const content = event.content as unknown as LinkTripleContent;
    if (!content || typeof content.source !== "string") return null;

    return {
        author: content.author || `matrix:${event.sender || "unknown"}`,
        timestamp: content.timestamp || (event.origin_server_ts
            ? new Date(event.origin_server_ts).toISOString()
            : new Date().toISOString()),
        data: {
            source: content.source,
            target: content.target || "",
            predicate: content.predicate || "",
        },
        proof: {
            signature: content.proof?.signature || "",
            key: content.proof?.key || "",
        },
    };
}

/**
 * Convert an m.room.message event to a LinkExpression.
 */
export function messageEventToLink(
    event: MatrixEvent,
    neighbourhoodUrl: string,
): LinkExpression | null {
    const content = event.content as Record<string, unknown>;
    if (!content || content.msgtype !== "m.text") return null;

    const timestamp = event.origin_server_ts
        ? new Date(event.origin_server_ts).toISOString()
        : new Date().toISOString();

    // Check for ad4m metadata
    const ad4m = content.ad4m as Ad4mMessageContent["ad4m"] | undefined;
    if (ad4m && typeof ad4m.source === "string") {
        return {
            author: ad4m.author || `matrix:${event.sender || "unknown"}`,
            timestamp,
            data: {
                source: ad4m.source,
                target: ad4m.target || "",
                predicate: ad4m.predicate || "",
            },
            proof: {
                signature: ad4m.proof?.signature || "",
                key: ad4m.proof?.key || "",
            },
        };
    }

    // Synthetic link for non-AD4M messages
    const author = event.sender ? `matrix:${event.sender}` : "matrix:unknown";
    return {
        author,
        timestamp,
        data: {
            source: neighbourhoodUrl,
            target: event.event_id || `matrix-event:${event.origin_server_ts}`,
            predicate: "matrix://message",
        },
        proof: { signature: "", key: "" },
    };
}

/**
 * Convert an m.reaction event to a LinkExpression.
 */
export function reactionEventToLink(
    event: MatrixEvent,
): LinkExpression | null {
    const content = event.content as Record<string, unknown>;
    const relatesTo = content?.["m.relates_to"] as ReactionContent["m.relates_to"] | undefined;
    if (!relatesTo || relatesTo.rel_type !== "m.annotation") return null;

    const timestamp = event.origin_server_ts
        ? new Date(event.origin_server_ts).toISOString()
        : new Date().toISOString();

    const author = event.sender ? `matrix:${event.sender}` : "matrix:unknown";
    return {
        author,
        timestamp,
        data: {
            source: relatesTo.event_id,
            target: relatesTo.key,
            predicate: "flux://has_reaction",
        },
        proof: { signature: "", key: "" },
    };
}

/**
 * Convert an m.room.redaction event to a removal LinkExpression.
 */
export function redactionToRemoval(
    event: MatrixEvent,
    neighbourhoodUrl: string,
): LinkExpression | null {
    const redactedEventId = event.redacts || (event.content?.redacts as string);
    if (!redactedEventId) return null;

    const timestamp = event.origin_server_ts
        ? new Date(event.origin_server_ts).toISOString()
        : new Date().toISOString();

    const author = event.sender ? `matrix:${event.sender}` : "matrix:unknown";
    return {
        author,
        timestamp,
        data: {
            source: neighbourhoodUrl,
            target: redactedEventId,
            predicate: "matrix://redacted",
        },
        proof: { signature: "", key: "" },
    };
}

/**
 * Generic inbound event → LinkExpression dispatcher.
 */
export function inboundEventToLink(
    event: MatrixEvent,
    neighbourhoodUrl: string,
): LinkExpression | null {
    switch (event.type) {
        case "dev.ad4m.link.triple":
            return tripleEventToLink(event);
        case "m.room.message":
            return messageEventToLink(event, neighbourhoodUrl);
        case "m.reaction":
            return reactionEventToLink(event);
        case "m.room.redaction":
            return redactionToRemoval(event, neighbourhoodUrl);
        default:
            return null;
    }
}

/**
 * Process an array of inbound Matrix events into LinkExpressions.
 */
export function eventsToLinks(
    events: MatrixEvent[],
    neighbourhoodUrl: string,
): { additions: LinkExpression[]; removals: LinkExpression[] } {
    const additions: LinkExpression[] = [];
    const removals: LinkExpression[] = [];

    for (const event of events) {
        if (event.type === "m.room.redaction") {
            const removal = redactionToRemoval(event, neighbourhoodUrl);
            if (removal) removals.push(removal);
            continue;
        }

        const link = inboundEventToLink(event, neighbourhoodUrl);
        if (link) {
            additions.push(link);
        }
    }

    return { additions, removals };
}

/** § Dual-Language Dedup */

export type LinkOrigin = "matrix" | "native" | "dual";

function canonicalLinkData(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
    });
}

/**
 * Check if a link already exists in the store (dedup before applying).
 */
export function isDuplicate(
    link: LinkExpression,
    existingHashes: Set<string>,
    hashFn: (data: string) => string,
): boolean {
    const contentHash = hashFn(canonicalLinkData(link));
    return existingHashes.has(contentHash);
}

/**
 * Compute the content hash of a link for dedup tracking.
 */
export function linkContentHash(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    return hashFn(canonicalLinkData(link));
}

/**
 * Build the storage key for tracking a link's origin.
 */
export function linkOriginKey(linkHash: string): string {
    return `link-origin/${linkHash}`;
}

/**
 * Determine if an outbound link should be federated to Matrix.
 */
export function shouldFederate(
    linkHash: string,
    getOrigin: (key: string) => string | null,
): boolean {
    const origin = getOrigin(linkOriginKey(linkHash));
    if (origin === null) return true;
    return origin !== "matrix";
}

/**
 * Determine if an outbound link should be excluded based on predicate filter.
 */
export function isPredicateExcluded(
    predicate: string | undefined,
    excludePredicates: string[],
): boolean {
    if (!predicate || excludePredicates.length === 0) return false;
    return excludePredicates.includes(predicate);
}

/**
 * Combined federation check: origin + predicate exclusion.
 */
export function shouldFederateLink(
    linkHash: string,
    predicate: string | undefined,
    getOrigin: (key: string) => string | null,
    excludePredicates: string[],
): boolean {
    if (isPredicateExcluded(predicate, excludePredicates)) return false;
    return shouldFederate(linkHash, getOrigin);
}
