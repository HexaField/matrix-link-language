/**
 * # Matrix Link Language for AD4M
 *
 * Bridge language that syncs Perspectives via the Matrix Client-Server API.
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * Now with full Flux ↔ Matrix interop:
 * - Flux Messages (flux://body links) are sent as m.room.message to Matrix
 * - Matrix m.room.message events are converted to Flux Message link sets
 *   (ad4m://has_child + flux://entry_type + flux://body)
 *
 * Spec: matrix-link-language.md
 */

import {
    defineLanguage,
    agentDid,
    agentCreateSignedExpression,
    hash,
    languageSettings,
    emitPerspectiveDiff,
} from "@coasys/ad4m-ldk";

import type { PerspectiveDiff, LinkExpression } from "./src/types.js";
import { parseSettings } from "./src/settings.js";
import type { MatrixSettings } from "./src/settings.js";
import { diffToEvents, eventsToLinks, linkContentKey } from "./src/translate.js";
import { shouldFederateLink, linkOriginKey } from "./src/translate.js";
import type { LinkOrigin } from "./src/translate.js";
import * as store from "./src/store.js";
import * as matrixApi from "./src/api.js";
import { generateTxnId } from "./src/api.js";
import type { MatrixEvent } from "./src/api.js";
import {
    processSyncResponse,
    processBackfillEvents,
    getSinceToken,
    setSinceToken,
    extractMembersFromState,
} from "./src/sync.js";
import { mxidToDid, didToMxid, parseMemberEvents } from "./src/api.js";

// Adapter imports (interfaces for singletons, Deno impls for init)
import { initTransport, initStorage, getStorage, initSigning, initRuntime } from "./src/adapters.js";
import { DenoTransport, DenoStorageAdapter, DenoSigningAdapter, DenoRuntime } from "./src/adapters-deno.js";

// ---------------------------------------------------------------------------
// Template Variables (per Spec §11)
// ---------------------------------------------------------------------------

//!@ad4m-template-variable
const MATRIX_HOMESERVER_URL = "<to-be-filled>";

//!@ad4m-template-variable
const MATRIX_ROOM_ID = "<to-be-filled>";

//!@ad4m-template-variable
const MATRIX_USER_ID = "<to-be-filled>";

//!@ad4m-template-variable
const MATRIX_ACCESS_TOKEN = "<to-be-filled>";

//!@ad4m-template-variable
const MATRIX_ROOM_ALIAS = "<to-be-filled>";

//!@ad4m-template-variable
const NEIGHBOURHOOD_META = "<to-be-filled>";

// ---------------------------------------------------------------------------
// Flux Constants (matching @coasys/flux-constants)
// ---------------------------------------------------------------------------

const FLUX = {
    ENTRY_TYPE: "flux://entry_type",
    HAS_COMMUNITY: "flux://has_community",
    HAS_CHANNEL: "flux://has_channel",
    HAS_MESSAGE: "flux://has_message",
    BODY: "flux://body",
    CHANNEL_NAME: "flux://has_channel_name",
    HAS_CHILD: "ad4m://has_child",
    TIMESTAMP: "ad4m://ontology/timestamp",
    AUTHOR: "ad4m://ontology/author",
    NAME: "rdf://name",
};

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let settings: MatrixSettings;
/** Whether the template variables have been filled with real values. */
let configured: boolean = false;
/** Whether we have authenticated and joined the room. */
let connected: boolean = false;
/** Guard to prevent concurrent ensureConnected() calls. */
let connectingPromise: Promise<void> | null = null;

/** Known channel IDs in this perspective (tracked for message routing). */
let knownChannelIds: Set<string> = new Set();

/** Registered telepresence signal callback. */
let telepresenceSignalCallback: ((payload: unknown) => void) | null = null;

function neighbourhoodUrl(): string {
    return `neighbourhood://${MATRIX_ROOM_ID}`;
}

/**
 * Returns true if a template variable still holds its placeholder value.
 */
function isPlaceholder(value: string): boolean {
    return !value || value === "<to-be-filled>";
}

/**
 * Lazy connection helper — authenticates and joins the room on first
 * real operation (commit / sync).  Runs at most once; subsequent calls
 * are no-ops.
 */
async function ensureConnected(): Promise<void> {
    if (connected || !configured) return;
    if (connectingPromise) { await connectingPromise; return; }

    connectingPromise = (async () => {
        try {
            const hasTemplateToken = !isPlaceholder(MATRIX_ACCESS_TOKEN) && MATRIX_ACCESS_TOKEN;
            if (hasTemplateToken) {
                matrixApi.loginWithToken(
                    MATRIX_HOMESERVER_URL,
                    MATRIX_ACCESS_TOKEN,
                    MATRIX_USER_ID,
                );
            } else if (settings.auth.method === "access-token" && settings.auth.accessToken) {
                matrixApi.loginWithToken(
                    MATRIX_HOMESERVER_URL,
                    settings.auth.accessToken,
                    MATRIX_USER_ID,
                );
            } else if (settings.auth.method === "password" && settings.auth.password) {
                const loginResult = await matrixApi.login(
                    MATRIX_HOMESERVER_URL,
                    MATRIX_USER_ID,
                    settings.auth.password,
                );
                if (!loginResult) {
                    console.error("[matrix-link-language] login failed");
                    return;
                }
            } else {
                console.log("[matrix-link-language] no auth configured, setting bare session");
                matrixApi.loginWithToken(
                    MATRIX_HOMESERVER_URL,
                    "",
                    MATRIX_USER_ID || "",
                );
            }

            // Join the room
            const joinResult = await matrixApi.joinRoom(MATRIX_ROOM_ID);
            if (!joinResult) {
                console.error("[matrix-link-language] joinRoom failed (may need auth)");
            }
            connected = true;
            console.log("[matrix-link-language] connected to Matrix");
        } finally {
            connectingPromise = null;
        }
    })();

    await connectingPromise;
}

// ---------------------------------------------------------------------------
// Flux Message Detection & Extraction
// ---------------------------------------------------------------------------

/**
 * Extract the text body from a literal URI (literal://string:...).
 */
function extractLiteralString(uri: string): string | null {
    if (uri.startsWith("literal://string:")) {
        return decodeURIComponent(uri.slice("literal://string:".length));
    }
    // Handle JSON-encoded literals
    if (uri.startsWith("literal://json:")) {
        try {
            return JSON.parse(decodeURIComponent(uri.slice("literal://json:".length)));
        } catch { return null; }
    }
    return null;
}

/**
 * Encode a string as a literal URI.
 */
function toLiteralString(text: string): string {
    return `literal://string:${encodeURIComponent(text)}`;
}

/**
 * Detect if a batch of additions contains a Flux message creation.
 * Returns the body text and metadata if found.
 *
 * A Flux message consists of multiple links added together:
 * 1. channelId --ad4m://has_child--> messageId (reified with author+timestamp)
 * 2. messageId --flux://entry_type--> flux://has_message
 * 3. messageId --flux://body--> literal://string:{body}
 */
interface FluxMessageInfo {
    messageId: string;
    channelId: string;
    body: string;
    author: string;
    timestamp: string;
}

function detectFluxMessages(additions: LinkExpression[]): FluxMessageInfo[] {
    const messages: FluxMessageInfo[] = [];

    // Find all flux://body links — these indicate a message body
    const bodyLinks = additions.filter(l =>
        l.data.predicate === FLUX.BODY
    );

    for (const bodyLink of bodyLinks) {
        const messageId = bodyLink.data.source;
        const bodyText = extractLiteralString(bodyLink.data.target);
        if (!messageId || !bodyText) continue;

        // Find the type flag confirming this is a message
        const typeLink = additions.find(l =>
            l.data.source === messageId &&
            l.data.predicate === FLUX.ENTRY_TYPE &&
            l.data.target === FLUX.HAS_MESSAGE
        );
        if (!typeLink) continue;

        // Find the has_child link to get the channel and metadata
        const childLink = additions.find(l =>
            l.data.target === messageId &&
            l.data.predicate === FLUX.HAS_CHILD
        );

        const channelId = childLink?.data.source || "";
        const author = bodyLink.author || childLink?.author || myDid;
        const timestamp = bodyLink.timestamp || childLink?.timestamp || new Date().toISOString();

        messages.push({
            messageId,
            channelId,
            body: bodyText,
            author,
            timestamp,
        });
    }

    return messages;
}

// ---------------------------------------------------------------------------
// Signed Link Creation (Fix #5: all inbound links signed by bridge agent)
// ---------------------------------------------------------------------------

/**
 * Create a properly signed link using the bridge agent's DID and key.
 * The executor requires valid `did:key:` signatures to accept links.
 */
function createSignedLink(source: string, predicate: string, target: string): LinkExpression {
    const data = { source, predicate, target };
    // agentCreateSignedExpression signs with the bridge agent's key
    // Returns { author, timestamp, data, proof: { signature, key } }
    const signed = agentCreateSignedExpression(data);
    if (!signed || !signed.author) {
        console.error("[matrix-link-language] createSignedLink: agentCreateSignedExpression returned invalid result:", JSON.stringify(signed));
        // Fallback: create a manually-structured link
        return {
            author: agentDid(),
            timestamp: new Date().toISOString(),
            data,
            proof: { signature: "", key: "" },
        } as unknown as LinkExpression;
    }
    return signed as unknown as LinkExpression;
}

/**
 * Convert a Matrix m.room.message into a set of Flux Message links.
 * All links are signed by the bridge agent (Fix #1 & #5).
 * Original Matrix sender preserved via attribution link.
 */
function matrixMessageToFluxLinks(
    event: MatrixEvent,
    channelId: string,
): LinkExpression[] {
    const content = event.content as Record<string, unknown>;
    if (!content || content.msgtype !== "m.text") return [];

    const body = content.body as string;
    if (!body) return [];

    // Skip messages that originated from AD4M (echo suppression)
    const ad4m = content.ad4m as Record<string, unknown> | undefined;
    if (ad4m) return [];

    // Preserve original Matrix sender as did:matrix: DID
    const originalAuthor = event.sender
        ? mxidToDid(event.sender)
        : "did:matrix:unknown:anonymous";

    // Generate a stable message ID from the Matrix event ID
    const messageId = `matrix-msg://${event.event_id || Date.now()}`;

    const links: LinkExpression[] = [];

    // 1. Channel → Message (has_child) — signed by bridge agent
    links.push(createSignedLink(channelId, FLUX.HAS_CHILD, messageId));

    // 2. Message type flag — signed by bridge agent
    links.push(createSignedLink(messageId, FLUX.ENTRY_TYPE, FLUX.HAS_MESSAGE));

    // 3. Message body — signed by bridge agent
    links.push(createSignedLink(messageId, FLUX.BODY, toLiteralString(body)));

    // 4. Attribution link — preserves the original Matrix author
    links.push(createSignedLink(messageId, "matrix://original_sender", originalAuthor));

    return links;
}

// ---------------------------------------------------------------------------
// DID ↔ MXID Mapping (for telepresence)
// ---------------------------------------------------------------------------

const DID_TO_MXID_PREFIX = "did-mxid/";
const MXID_TO_DID_PREFIX = "mxid-did/";

function storeDIDMapping(did: string, mxid: string): void {
    const storage = getStorage();
    storage.put(`${DID_TO_MXID_PREFIX}${did}`, mxid);
    storage.put(`${MXID_TO_DID_PREFIX}${mxid}`, did);
}

function getMxidForDid(did: string): string | null {
    return getStorage().get(`${DID_TO_MXID_PREFIX}${did}`);
}

function getDidForMxid(mxid: string): string | null {
    return getStorage().get(`${MXID_TO_DID_PREFIX}${mxid}`);
}

function extractServerName(userId: string): string {
    const match = userId.match(/:(.+)$/);
    return match ? match[1] : "";
}

function mapStatusToPresence(status: unknown): "online" | "offline" | "unavailable" {
    if (typeof status === "string") {
        switch (status.toLowerCase()) {
            case "online": return "online";
            case "offline": return "offline";
            case "unavailable":
            case "away":
            case "idle":
                return "unavailable";
            default:
                return "online";
        }
    }
    if (typeof status === "object" && status !== null) {
        const s = status as Record<string, unknown>;
        if (typeof s.status === "string") return mapStatusToPresence(s.status);
        if (typeof s.presence === "string") return mapStatusToPresence(s.presence);
    }
    return "online";
}

function processToDeviceEvents(events: MatrixEvent[]): void {
    if (!telepresenceSignalCallback) return;
    for (const event of events) {
        if (event.type === "dev.ad4m.signal" || event.type === "dev.ad4m.broadcast") {
            // Wrap in PerspectiveExpression format for the executor
            const wrapped = {
                author: (event as any).sender ? mxidToDid((event as any).sender) : agentDid(),
                timestamp: new Date((event as any).origin_server_ts || Date.now()).toISOString(),
                data: { links: [] },
                proof: { key: "", signature: "" },
                signal: event.content,
            };
            telepresenceSignalCallback(wrapped);
        }
    }
}

function processTimelineBroadcasts(events: MatrixEvent[], myUserId: string): void {
    if (!telepresenceSignalCallback) return;
    for (const event of events) {
        if (event.type === "dev.ad4m.broadcast") {
            if (event.sender === myUserId) continue;
            // The executor's registered callback expects PerspectiveExpression format:
            // { author, timestamp, data: { links: [...] }, proof: { key, signature } }
            // Wrap the raw signal content in the proper structure.
            const wrapped = {
                author: event.sender ? mxidToDid(event.sender) : "did:matrix:unknown:anonymous",
                timestamp: new Date(event.origin_server_ts || Date.now()).toISOString(),
                data: { links: [] },
                proof: { key: "", signature: "" },
                // Attach original content as custom field for downstream handling
                signal: event.content,
            };
            telepresenceSignalCallback(wrapped);
        }
    }
}

// ---------------------------------------------------------------------------
// Channel tracking
// ---------------------------------------------------------------------------

/**
 * Scan links for channel definitions and track their IDs.
 */
function trackChannels(links: LinkExpression[]): void {
    for (const link of links) {
        // Detect channel type flags
        if (link.data.predicate === FLUX.ENTRY_TYPE &&
            link.data.target === FLUX.HAS_CHANNEL) {
            knownChannelIds.add(link.data.source);
        }
        // Detect has_channel relations (community → channel)
        if (link.data.predicate === FLUX.HAS_CHANNEL) {
            knownChannelIds.add(link.data.target);
        }
    }
}

/**
 * Get the first known channel ID (for routing inbound messages).
 */
function getDefaultChannelId(): string {
    if (knownChannelIds.size > 0) {
        return knownChannelIds.values().next().value!;
    }
    // Fall back to a synthetic channel reference
    return `channel://${MATRIX_ROOM_ID}`;
}

// ---------------------------------------------------------------------------
// Language definition
// ---------------------------------------------------------------------------

const language = defineLanguage({
    name: "@hexafield/matrix-link-language",
    version: "0.2.0",

    isPublic: true,

    async init() {
        // Initialize adapters before anything else
        initRuntime(new DenoRuntime());
        initStorage(new DenoStorageAdapter());
        initTransport(new DenoTransport());
        initSigning(new DenoSigningAdapter());
        store.initStore();

        myDid = agentDid();
        settings = parseSettings(languageSettings());

        // Check whether template variables have been filled
        configured = !isPlaceholder(MATRIX_HOMESERVER_URL) && !isPlaceholder(MATRIX_ROOM_ID);

        if (!configured) {
            console.warn(
                "[matrix-link-language] init: template variables not yet filled — " +
                "language loaded in unconfigured mode (no network ops until configured)",
            );
        }

        console.log(`[matrix-link-language] init: did=${myDid}, homeserver=${MATRIX_HOMESERVER_URL}`);
        console.log(`[matrix-link-language] room: ${MATRIX_ROOM_ID}`);
        console.log(`[matrix-link-language] configured: ${configured}`);
        console.log(`[matrix-link-language] sync mode: ${settings.syncMode}`);

        // Scan existing links for channel IDs
        const allLinks = store.allLinks();
        trackChannels(allLinks.links);
    },

    async teardown() {
        myDid = "";
        connected = false;
        configured = false;
        connectingPromise = null;
        telepresenceSignalCallback = null;
        knownChannelIds.clear();
        matrixApi.clearSession();
        console.log("[matrix-link-language] teardown");
    },

    interactions() {
        return [];
    },

    // -----------------------------------------------------------------------
    // perspective-commit
    // -----------------------------------------------------------------------
    commit: {
        async commit(diff: PerspectiveDiff) {
            // 0. If not configured, store locally only and return
            if (!configured) {
                store.applyDiff(diff);
                trackChannels(diff.additions);
                emitPerspectiveDiff(diff);
                return getSinceToken() || hash(JSON.stringify(diff));
            }

            // 0b. Ensure we are connected before sending
            await ensureConnected();

            // 1. Store links locally
            store.applyDiff(diff);
            trackChannels(diff.additions);

            // 1b. Store DID ↔ MXID mapping for our commits
            if (myDid && MATRIX_USER_ID) {
                storeDIDMapping(myDid, MATRIX_USER_ID);
            }

            // 2. Skip outbound in subscribe-only mode
            if (settings.syncMode === "subscribe-only") {
                emitPerspectiveDiff(diff);
                return getSinceToken() || hash(JSON.stringify(diff));
            }

            // ------------------------------------------------------------------
            // FLUX MESSAGE DETECTION
            // Detect Flux message patterns and send as m.room.message
            // ------------------------------------------------------------------
            const fluxMessages = detectFluxMessages(diff.additions);
            const sentMessageIds = new Set<string>();

            for (const msg of fluxMessages) {
                // Send to Matrix as a readable m.room.message
                const txnId = generateTxnId();
                const messageContent: Record<string, unknown> = {
                    msgtype: "m.text",
                    body: msg.body,
                    // Tag with ad4m metadata so we can suppress echo on sync
                    ad4m: {
                        source: msg.channelId,
                        predicate: FLUX.HAS_CHILD,
                        target: msg.messageId,
                        author: msg.author,
                        message_id: msg.messageId,
                    },
                };
                await matrixApi.sendEvent(
                    MATRIX_ROOM_ID,
                    "m.room.message",
                    messageContent,
                    txnId,
                );
                sentMessageIds.add(msg.messageId);
                console.log(`[matrix-link-language] sent Flux message to Matrix: "${msg.body.substring(0, 50)}..."`);
            }

            // ------------------------------------------------------------------
            // STANDARD LINK FEDERATION (for non-message links)
            // ------------------------------------------------------------------

            // Track origins for new native commits
            for (const link of diff.additions) {
                const h = store.hashLink(link);
                const originKey = linkOriginKey(h);
                const existing = getStorage().get(originKey);
                if (existing === "matrix") {
                    getStorage().put(originKey, "dual");
                } else if (!existing) {
                    getStorage().put(originKey, "native");
                }
            }

            // Build federation filter
            const federationFilter = (linkHash: string): boolean => {
                if (!settings.dualLanguage.enabled) return true;
                return shouldFederateLink(
                    linkHash,
                    undefined,
                    (key) => getStorage().get(key),
                    settings.dualLanguage.excludePredicates,
                );
            };

            // Filter out links that are part of already-sent Flux messages
            const nonMessageAdditions = diff.additions.filter(link => {
                // If this link is part of a Flux message we already sent, skip
                if (sentMessageIds.has(link.data.source) || sentMessageIds.has(link.data.target)) {
                    return false;
                }
                return true;
            });

            // ------------------------------------------------------------------
            // OUTBOUND WHITELIST FILTER (Fix #2)
            // Only federate Flux messages (handled above) to Matrix.
            // All other links (SDNA, schema, structural) stay local.
            // ------------------------------------------------------------------
            const federableAdditions = nonMessageAdditions.filter(link => {
                const pred = link.data.predicate || "";
                const source = link.data.source || "";
                const target = link.data.target || "";

                // NEVER send SDNA/SHACL links
                if (pred.includes("ad4m://shacl") || pred.includes("ad4m://SubjectClass") || pred.includes("rdf://type")) {
                    return false;
                }
                // NEVER send ontology predicates
                if (pred.startsWith("ad4m://ontology/")) {
                    return false;
                }
                // NEVER send schema/shape links
                if (source.endsWith("Shape") || target.endsWith("Shape")) {
                    return false;
                }
                // NEVER send entry type markers
                if (pred === FLUX.ENTRY_TYPE) {
                    return false;
                }
                // NEVER send channel structure
                if (pred === FLUX.HAS_CHANNEL || pred === FLUX.CHANNEL_NAME || pred === FLUX.HAS_COMMUNITY || pred === FLUX.NAME) {
                    return false;
                }
                // NEVER send flux://body links that weren't part of a detected message
                // (they were already handled in the Flux message detection above)
                if (pred === FLUX.BODY) {
                    return false;
                }
                // NEVER send has_child links (structural hierarchy)
                if (pred === FLUX.HAS_CHILD) {
                    return false;
                }

                // Default: don't send to Matrix (whitelist approach)
                // Only Flux messages (already sent above) go to Matrix.
                return false;
            });

            // Translate remaining links to Matrix events (dev.ad4m.link.triple)
            const remainingDiff: PerspectiveDiff = {
                additions: federableAdditions,
                removals: diff.removals,
            };
            const events = diffToEvents(remainingDiff, {
                settings,
                hashFn: hash,
                neighbourhoodUrl: neighbourhoodUrl(),
                shouldFederate: federationFilter,
            });

            // Send events to the room
            for (const event of events) {
                const txnId = generateTxnId();
                await matrixApi.sendEvent(
                    MATRIX_ROOM_ID,
                    event.eventType,
                    event.content,
                    txnId,
                );
            }

            // Handle removals (redactions)
            for (const removal of diff.removals) {
                const linkHash = store.hashLink(removal);
                const eventId = store.getLinkHashByEventId(linkHash);
                if (eventId) {
                    await matrixApi.redactEvent(MATRIX_ROOM_ID, eventId, "Link removed");
                }
            }

            // Emit the perspective diff for local subscribers
            emitPerspectiveDiff(diff);

            // Fix #3: Return a meaningful revision string
            return getSinceToken() || hash(JSON.stringify(diff));
        },
    },

    // -----------------------------------------------------------------------
    // perspective-sync
    // -----------------------------------------------------------------------
    sync: {
        async sync() {
            if (!configured) {
                return { additions: [], removals: [] };
            }

            await ensureConnected();

            if (settings.syncMode === "publish-only") {
                return { additions: [], removals: [] };
            }

            const sinceToken = getSinceToken() || undefined;
            const syncResponse = await matrixApi.sync(
                sinceToken,
                settings.sync.timeoutMs,
            );

            if (!syncResponse) {
                return { additions: [], removals: [] };
            }

            // Update since token
            if (syncResponse.next_batch) {
                setSinceToken(syncResponse.next_batch);
            }

            // Extract room timeline
            const room = syncResponse.rooms?.join?.[MATRIX_ROOM_ID];
            const timelineEvents = room?.timeline?.events || [];

            // Process to-device events for telepresence signals
            if (syncResponse.to_device?.events) {
                processToDeviceEvents(syncResponse.to_device.events);
            }

            // Process timeline events for broadcast signals
            if (timelineEvents.length > 0) {
                processTimelineBroadcasts(timelineEvents, MATRIX_USER_ID);
            }

            // ------------------------------------------------------------------
            // FLUX-AWARE INBOUND PROCESSING
            // Convert Matrix messages to Flux Message link sets
            // ------------------------------------------------------------------

            const allAdditions: LinkExpression[] = [];
            const allRemovals: LinkExpression[] = [];

            const channelId = getDefaultChannelId();

            for (const event of timelineEvents) {
                const eventId = event.event_id;
                if (!eventId) continue;

                // Skip events sent by our bridge user (echo suppression)
                if (event.sender === MATRIX_USER_ID) continue;

                // Skip already-processed events
                const processedKey = `processed:${eventId}`;
                if (getStorage().get(processedKey)) continue;
                getStorage().put(processedKey, "1");

                if (event.type === "m.room.message") {
                    // Convert to Flux Message links
                    const fluxLinks = matrixMessageToFluxLinks(event, channelId);
                    if (fluxLinks.length > 0) {
                        allAdditions.push(...fluxLinks);
                        console.log(`[matrix-link-language] inbound Matrix message → Flux links (${fluxLinks.length} links)`);
                    }
                } else if (event.type === "dev.ad4m.link.triple") {
                    // Standard link triple — sign with bridge agent key
                    const content = event.content as Record<string, unknown>;
                    if (content && typeof content.source === "string") {
                        const signedLink = createSignedLink(
                            content.source as string,
                            (content.predicate as string) || "",
                            (content.target as string) || "",
                        );
                        allAdditions.push(signedLink);
                    }
                } else if (event.type === "m.room.redaction") {
                    const redactedEventId = event.redacts || (event.content?.redacts as string);
                    if (redactedEventId) {
                        allRemovals.push({
                            author: event.sender ? `matrix:${event.sender}` : "matrix:unknown",
                            timestamp: new Date(event.origin_server_ts || Date.now()).toISOString(),
                            data: {
                                source: neighbourhoodUrl(),
                                target: redactedEventId,
                                predicate: "matrix://redacted",
                            },
                            proof: { signature: "", key: "" },
                        });
                    }
                }

                // Build DID ↔ MXID mappings
                if (event.type === "dev.ad4m.link.triple" && event.sender) {
                    const content = event.content as Record<string, unknown>;
                    const author = content.author as string;
                    if (author) {
                        storeDIDMapping(author, event.sender);
                    }
                }
            }

            // Apply to store
            const diff: PerspectiveDiff = { additions: allAdditions, removals: allRemovals };
            if (allAdditions.length > 0 || allRemovals.length > 0) {
                store.applyDiff(diff);

                // Track origins for inbound links
                for (const link of allAdditions) {
                    const h = store.hashLink(link);
                    const originKey = linkOriginKey(h);
                    const existing = getStorage().get(originKey);
                    if (existing === "native") {
                        getStorage().put(originKey, "dual");
                    } else if (!existing) {
                        getStorage().put(originKey, "matrix");
                    }
                }

                // CRITICAL: emit the diff so the executor persists
                // inbound links in the perspective's SPARQL store.
                // Validate all links before passing to Rust
                for (const link of diff.additions) {
                    if (!link.author || !link.data) {
                        console.error("[matrix-link-language] INVALID LINK in additions:", JSON.stringify(link));
                    }
                }
                for (const link of diff.removals) {
                    if (!link.author || !link.data) {
                        console.error("[matrix-link-language] INVALID LINK in removals:", JSON.stringify(link));
                    }
                }
                console.log(`[matrix-link-language] emitting diff: ${diff.additions.length} additions, ${diff.removals.length} removals`);
                emitPerspectiveDiff(diff);
            }

            return diff;
        },

        async render() {
            return store.allLinks();
        },

        async currentRevision() {
            return getSinceToken() || "";
        },
    },

    // -----------------------------------------------------------------------
    // perspective-query
    // -----------------------------------------------------------------------
    query: {
        supportedKinds() {
            return ["link-pattern"];
        },

        async run(req: { kind: string; payload: unknown }) {
            if (req.kind !== "link-pattern") {
                return { kind: "error", payload: `Unsupported query kind: ${req.kind}` };
            }
            const pattern = req.payload as { source?: string; target?: string; predicate?: string };
            const links = store.queryLinks(pattern);
            return { kind: "links", payload: links };
        },
    },

    // -----------------------------------------------------------------------
    // peers
    // -----------------------------------------------------------------------
    peers: {
        setLocal(agents: string[]) {
            for (const did of agents) {
                store.setPeer(did, { local: true });
            }
        },

        async remote() {
            return store.listPeers("peers/");
        },
    },

    // -----------------------------------------------------------------------
    // telepresence
    // -----------------------------------------------------------------------
    telepresence: {
        async setOnlineStatus(status: unknown): Promise<void> {
            if (!configured) return;
            await ensureConnected();

            const matrixPresence = mapStatusToPresence(status);
            const statusMsg = typeof status === "object" && status !== null
                ? (status as Record<string, unknown>).statusMessage as string | undefined
                : undefined;

            await matrixApi.setPresence(matrixPresence, statusMsg);

            if (myDid && MATRIX_USER_ID) {
                storeDIDMapping(myDid, MATRIX_USER_ID);
            }
        },

        async getOnlineAgents(): Promise<unknown[]> {
            if (!configured) return [];
            await ensureConnected();

            const memberEvents = await matrixApi.getMembers(MATRIX_ROOM_ID);
            const members = parseMemberEvents(memberEvents);
            const joinedMembers = members.filter(m => m.membership === "join");

            const onlineAgents: unknown[] = [];

            for (const member of joinedMembers) {
                if (member.userId === MATRIX_USER_ID) continue;

                const presence = await matrixApi.getPresence(member.userId);
                if (!presence) continue;
                if (presence.presence !== "online") continue;

                const did = getDidForMxid(member.userId) || mxidToDid(member.userId);

                onlineAgents.push({
                    did,
                    status: {
                        presence: presence.presence,
                        lastActiveAgo: presence.last_active_ago,
                        statusMessage: presence.status_msg,
                        currentlyActive: presence.currently_active,
                    },
                });
            }

            return onlineAgents;
        },

        async sendSignal(remoteDid: string, payload: unknown): Promise<object> {
            if (!configured) return { error: "not configured" };
            await ensureConnected();

            let targetMxid = getMxidForDid(remoteDid);
            if (!targetMxid) {
                const serverName = extractServerName(MATRIX_USER_ID);
                targetMxid = didToMxid(remoteDid, serverName);
            }

            const content: Record<string, unknown> = {
                sender_did: myDid,
                payload,
                timestamp: new Date().toISOString(),
            };

            const messages: Record<string, Record<string, Record<string, unknown>>> = {
                [targetMxid]: { "*": content },
            };

            const success = await matrixApi.sendToDevice("dev.ad4m.signal", messages);
            return { success };
        },

        async sendBroadcast(payload: unknown): Promise<object> {
            if (!configured) return { error: "not configured" };
            await ensureConnected();

            const content: Record<string, unknown> = {
                sender_did: myDid,
                payload,
                timestamp: new Date().toISOString(),
            };

            const txnId = generateTxnId();
            const eventId = await matrixApi.sendEvent(
                MATRIX_ROOM_ID,
                "dev.ad4m.broadcast",
                content,
                txnId,
            );

            return { success: !!eventId, eventId };
        },

        async registerSignalCallback(callback: any): Promise<void> {
            telepresenceSignalCallback = callback;
        },
    },
});

// ---------------------------------------------------------------------------
// Flat exports
// ---------------------------------------------------------------------------

export const {
    name,
    version,
    isPublic,
    init,
    teardown,
    interactions,
    perspectiveCommit,
    perspectiveSyncSync,
    perspectiveSyncRender,
    perspectiveSyncCurrentRevision,
    perspectiveQuerySupportedKinds,
    perspectiveQueryRun,
    peersSetLocal,
    peersRemote,
    telepresenceSetOnlineStatus,
    telepresenceGetOnlineAgents,
    telepresenceSendSignal,
    telepresenceSendBroadcast,
    telepresenceRegisterSignalCallback,
} = language;

export default language;

// ---------------------------------------------------------------------------
// Template params metadata (for language.publish / LanguageMeta)
// ---------------------------------------------------------------------------

export const possibleTemplateParams: string[] = [
    "MATRIX_HOMESERVER_URL",
    "MATRIX_ROOM_ID",
    "MATRIX_USER_ID",
    "MATRIX_ACCESS_TOKEN",
    "MATRIX_ROOM_ALIAS",
    "NEIGHBOURHOOD_META",
];

// ---------------------------------------------------------------------------
// Callback registration
// ---------------------------------------------------------------------------

let linkCallback: ((diff: PerspectiveDiff) => void) | null = null;
let syncStateChangeCallback: ((state: string) => void) | null = null;

export function linkSyncAddCallback(callback: (diff: PerspectiveDiff) => void): number {
    linkCallback = callback;
    return 1;
}

export function linkSyncRemoveCallback(callback: (diff: PerspectiveDiff) => void): number {
    if (linkCallback === callback) linkCallback = null;
    return 1;
}

export function linkSyncAddSyncStateChangeCallback(callback: (state: string) => void): number {
    syncStateChangeCallback = callback;
    return 1;
}

// ---------------------------------------------------------------------------
// Signal-based event handler
// ---------------------------------------------------------------------------

export async function handleSignal(signalData: string): Promise<void> {
    let signal: unknown;
    try {
        signal = JSON.parse(signalData);
    } catch {
        return;
    }

    if (typeof signal !== "object" || signal === null) return;

    const event = signal as { type?: string; [key: string]: unknown };
    if (!event.type) return;

    // Process as a Matrix event
    const channelId = getDefaultChannelId();
    let diff: PerspectiveDiff = { additions: [], removals: [] };

    if (event.type === "m.room.message") {
        const fluxLinks = matrixMessageToFluxLinks(event as unknown as MatrixEvent, channelId);
        diff = { additions: fluxLinks, removals: [] };
    } else {
        // Standard event processing
        const { eventsToLinks: translate } = await import("./src/translate.js");
        diff = translate([event as any], neighbourhoodUrl());
    }

    if (diff.additions.length > 0 || diff.removals.length > 0) {
        store.applyDiff(diff);
        if (linkCallback) {
            linkCallback(diff);
        }
    }
}
