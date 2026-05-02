/**
 * Link ↔ Matrix event translation layer — orchestration module.
 *
 * Wraps the pure translation functions and adds SDNA pattern detection,
 * rendering strategy selection, and batch diff processing.
 *
 * No ad4m:host imports. Uses injected interfaces.
 *
 * Spec §2, §5, §6.
 */

import type { LinkExpression, PerspectiveDiff } from "./types.js";
import type { MatrixEvent } from "./matrix-api.pure.js";
import type { MatrixSettings } from "./settings.js";
import { detectPattern } from "./sdna.js";
import type { DetectedPattern } from "./sdna.js";
import {
    linkToTripleContent,
    linkToMessageContent,
    linkToReplyContent,
    linkToReactionContent,
    linkContentKey,
    inboundEventToLink,
    tripleEventToLink,
    messageEventToLink,
    reactionEventToLink,
    redactionToRemoval,
} from "./translate.pure.js";
import type { LinkTripleContent, Ad4mMessageContent, ReactionContent } from "./translate.pure.js";
import { renderLinkAsText, renderLinkAsHtml } from "./rendering.pure.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Outbound: Diff → Matrix Events
// ---------------------------------------------------------------------------

/**
 * Convert a PerspectiveDiff into Matrix event payloads.
 *
 * Respects rendering strategy:
 * - "native": only dev.ad4m.link.triple events
 * - "matrix": only m.room.message events (with SDNA rendering)
 * - "dual": both event types for each link
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

    // Removals are handled separately (redaction events are API calls, not event types)
    // The sync/commit layer handles redaction via the Matrix API

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
            // Fall through to simple message if no parent mapping
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
            // Can't create reaction without target event ID — emit as message
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

// ---------------------------------------------------------------------------
// Inbound: Matrix Events → Links
// ---------------------------------------------------------------------------

/**
 * Process an array of inbound Matrix events into LinkExpressions.
 * Separates additions from removals (redactions).
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

// Re-export pure functions
export {
    linkToTripleContent,
    linkToMessageContent,
    linkToReplyContent,
    linkToReactionContent,
    linkContentKey,
    inboundEventToLink,
    tripleEventToLink,
    messageEventToLink,
    reactionEventToLink,
    redactionToRemoval,
    toISO,
} from "./translate.pure.js";
