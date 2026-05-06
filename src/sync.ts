/**
 * Matrix /sync long-poll coordination + since token management.
 *
 * Orchestrates the incremental sync loop:
 * 1. Call /sync with stored since token
 * 2. Process timeline events → links
 * 3. Process redactions → removals
 * 4. Update since token
 * 5. Return PerspectiveDiff
 *
 * No ad4m:host imports. Uses injected interfaces.
 *
 * Spec §6.
 */

import type { PerspectiveDiff, LinkExpression } from "./types.js";
import type { MatrixSyncResponse, MatrixEvent } from "./api.js";
import { extractRoomTimeline, extractRoomState, extractPrevBatch } from "./api.js";
import { eventsToLinks } from "./translate.js";
import * as store from "./store.js";
import { getStorage } from "./adapters.js";

// ---------------------------------------------------------------------------
// Since token management
// ---------------------------------------------------------------------------

const SYNC_TOKEN_KEY = "matrix:sync:token";
const PREV_BATCH_KEY = "matrix:prev:batch";

export function getSinceToken(): string | null {
    return getStorage().get(SYNC_TOKEN_KEY);
}

export function setSinceToken(token: string): void {
    getStorage().put(SYNC_TOKEN_KEY, token);
}

export function getPrevBatchToken(): string | null {
    return getStorage().get(PREV_BATCH_KEY);
}

export function setPrevBatchToken(token: string): void {
    getStorage().put(PREV_BATCH_KEY, token);
}

// ---------------------------------------------------------------------------
// Event deduplication
// ---------------------------------------------------------------------------

const PROCESSED_EVENTS_PREFIX = "processed:";

/**
 * Check if an event has already been processed (dedup).
 */
export function isEventProcessed(eventId: string): boolean {
    return getStorage().get(`${PROCESSED_EVENTS_PREFIX}${eventId}`) !== null;
}

/**
 * Mark an event as processed.
 */
export function markEventProcessed(eventId: string): void {
    getStorage().put(`${PROCESSED_EVENTS_PREFIX}${eventId}`, "1");
}

// ---------------------------------------------------------------------------
// Sync processing
// ---------------------------------------------------------------------------

/**
 * Process a sync response for a specific room.
 *
 * Extracts timeline events, deduplicates, translates to links,
 * and returns the resulting PerspectiveDiff.
 */
export function processSyncResponse(
    syncResponse: MatrixSyncResponse,
    roomId: string,
    neighbourhoodUrl: string,
    bridgeUserId?: string,
): PerspectiveDiff {
    // Extract timeline events
    const timelineEvents = extractRoomTimeline(syncResponse, roomId);

    // Always update since token — Matrix /sync advances the batch cursor
    // regardless of whether any events are present.
    if (syncResponse.next_batch) {
        setSinceToken(syncResponse.next_batch);
    }

    // Store prev_batch for potential backfill
    const prevBatch = extractPrevBatch(syncResponse, roomId);
    if (prevBatch) {
        setPrevBatchToken(prevBatch);
    }

    // Filter out already-processed events and our own events
    const newEvents: MatrixEvent[] = [];
    for (const event of timelineEvents) {
        const eventId = event.event_id;
        if (!eventId) continue;

        // Skip events we've already processed
        if (isEventProcessed(eventId)) continue;

        // Skip events sent by our bridge user (echo suppression)
        if (bridgeUserId && event.sender === bridgeUserId) continue;

        newEvents.push(event);
        markEventProcessed(eventId);
    }

    if (newEvents.length === 0) {
        return { additions: [], removals: [] };
    }

    // Translate events to links
    const diff = eventsToLinks(newEvents, neighbourhoodUrl);

    // Store links and event mappings
    for (let i = 0; i < newEvents.length; i++) {
        const event = newEvents[i];
        if (event.type === "m.room.redaction") continue;

        // Find the corresponding link in additions
        // (Events and additions are processed in order)
        const link = diff.additions.find(l => {
            if (event.type === "dev.ad4m.link.triple") {
                const content = event.content as Record<string, unknown>;
                return l.data.source === content.source &&
                       l.data.target === content.target &&
                       l.data.predicate === content.predicate;
            }
            return false;
        });

        if (link && event.event_id) {
            const linkHash = store.hashLink(link);
            store.mapEventToLink(event.event_id, linkHash);
        }
    }

    // Apply diff to store
    store.applyDiff(diff);

    return diff;
}

/**
 * Process backfill events (from /messages endpoint).
 */
export function processBackfillEvents(
    events: MatrixEvent[],
    neighbourhoodUrl: string,
    bridgeUserId?: string,
): PerspectiveDiff {
    const newEvents: MatrixEvent[] = [];
    for (const event of events) {
        const eventId = event.event_id;
        if (!eventId) continue;
        if (isEventProcessed(eventId)) continue;
        if (bridgeUserId && event.sender === bridgeUserId) continue;

        newEvents.push(event);
        markEventProcessed(eventId);
    }

    if (newEvents.length === 0) {
        return { additions: [], removals: [] };
    }

    const diff = eventsToLinks(newEvents, neighbourhoodUrl);
    store.applyDiff(diff);
    return diff;
}

/**
 * Extract room member DIDs/MXIDs from state events.
 */
export function extractMembersFromState(
    syncResponse: MatrixSyncResponse,
    roomId: string,
): string[] {
    const stateEvents = extractRoomState(syncResponse, roomId);
    const members: string[] = [];

    for (const event of stateEvents) {
        if (event.type === "m.room.member" && event.state_key) {
            const content = event.content as { membership?: string };
            if (content.membership === "join") {
                members.push(event.state_key);
            }
        }
    }

    return members;
}
