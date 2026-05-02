/**
 * Pure Link ↔ Matrix event translation logic.
 *
 * Handles bidirectional mapping between AD4M LinkExpressions and
 * Matrix events:
 *
 * - dev.ad4m.link.triple (custom event) — lossless native link triple
 * - m.room.message — chat-style links for Element/client interop
 * - m.reaction — reaction links
 * - m.room.redaction — link removals
 *
 * Pure functions — no ad4m:host imports. Safe for unit testing.
 *
 * Spec §2, §5.
 */

import type { LinkExpression, ExpressionProof } from "./types.js";
import type { MatrixEvent } from "./matrix-api.pure.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Link → Matrix Event Content (Outbound)
// ---------------------------------------------------------------------------

/**
 * Convert a LinkExpression to a dev.ad4m.link.triple event content.
 * This is the lossless native representation.
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
 * Used for chat-style links that should be visible in Matrix clients.
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

// ---------------------------------------------------------------------------
// Matrix Event → Link (Inbound)
// ---------------------------------------------------------------------------

/**
 * Convert a dev.ad4m.link.triple event to a LinkExpression.
 * Lossless round-trip.
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
 *
 * If the message carries ad4m metadata, reconstruct the native link.
 * Otherwise, create a synthetic link.
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
 * Routes to the appropriate handler based on event type.
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
