/**
 * # Matrix Link Language for AD4M
 *
 * Bridge language that syncs Perspectives via the Matrix Client-Server API.
 * Implements perspective-commit, perspective-sync, perspective-query,
 * and peers capabilities.
 *
 * Publishes links as Matrix room events (dev.ad4m.link.triple + m.room.message),
 * processes inbound events via /sync long-poll, handles room membership,
 * and manages bidirectional link federation.
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
            // Authenticate — try access-token first, then password, then
            // fall back to a bare session (still sets homeserver URL so
            // API calls don't break with relative URLs).
            const hasTemplateToken = !isPlaceholder(MATRIX_ACCESS_TOKEN) && MATRIX_ACCESS_TOKEN;
            if (hasTemplateToken) {
                // Token provided via template variable — use it directly
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
                // No auth configured — set the session anyway so the
                // homeserver URL is available for API calls.  The server
                // will reject authenticated endpoints but at least the
                // URL construction won't break.
                console.log("[matrix-link-language] no auth configured, setting bare session");
                matrixApi.loginWithToken(
                    MATRIX_HOMESERVER_URL,
                    "",  // no token
                    MATRIX_USER_ID || "",
                );
            }

            // Join the room
            const joinResult = await matrixApi.joinRoom(MATRIX_ROOM_ID);
            if (!joinResult) {
                console.error("[matrix-link-language] joinRoom failed (may need auth)");
                // Still mark connected if we have auth — the join may
                // have already happened or the room is public
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
// DID ↔ MXID Mapping (for telepresence)
// ---------------------------------------------------------------------------

const DID_TO_MXID_PREFIX = "did-mxid/";
const MXID_TO_DID_PREFIX = "mxid-did/";

/**
 * Store a DID ↔ MXID mapping in both directions.
 */
function storeDIDMapping(did: string, mxid: string): void {
    const storage = getStorage();
    storage.put(`${DID_TO_MXID_PREFIX}${did}`, mxid);
    storage.put(`${MXID_TO_DID_PREFIX}${mxid}`, did);
}

/**
 * Look up MXID by DID.
 */
function getMxidForDid(did: string): string | null {
    return getStorage().get(`${DID_TO_MXID_PREFIX}${did}`);
}

/**
 * Look up DID by MXID.
 */
function getDidForMxid(mxid: string): string | null {
    return getStorage().get(`${MXID_TO_DID_PREFIX}${mxid}`);
}

/**
 * Extract the homeserver name from a Matrix user ID.
 * e.g. "@user:matrix.org" → "matrix.org"
 */
function extractServerName(userId: string): string {
    const match = userId.match(/:(.+)$/);
    return match ? match[1] : "";
}

/**
 * Map an AD4M online status to a Matrix presence state.
 */
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

/**
 * Process to-device events from a sync response, invoking the
 * telepresence signal callback for matching event types.
 */
function processToDeviceEvents(events: MatrixEvent[]): void {
    if (!telepresenceSignalCallback) return;

    for (const event of events) {
        if (event.type === "dev.ad4m.signal" || event.type === "dev.ad4m.broadcast") {
            const payload = event.content;
            telepresenceSignalCallback(payload);
        }
    }
}

/**
 * Process timeline events from a sync response for broadcast signals.
 * Invokes the telepresence signal callback for dev.ad4m.broadcast room events.
 */
function processTimelineBroadcasts(events: MatrixEvent[], myUserId: string): void {
    if (!telepresenceSignalCallback) return;

    for (const event of events) {
        if (event.type === "dev.ad4m.broadcast") {
            // Skip our own broadcasts
            if (event.sender === myUserId) continue;
            telepresenceSignalCallback(event.content);
        }
    }
}

// ---------------------------------------------------------------------------
// Language definition
// ---------------------------------------------------------------------------

const language = defineLanguage({
    name: "@hexafield/matrix-link-language",
    version: "0.1.0",

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
        console.log(`[matrix-link-language] rendering: ${settings.rendering.strategy}`);

        // Network operations are deferred to ensureConnected(), called
        // lazily on first commit() or sync().
    },

    async teardown() {
        myDid = "";
        connected = false;
        configured = false;
        connectingPromise = null;
        telepresenceSignalCallback = null;
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
                emitPerspectiveDiff(diff);
                return "";
            }

            // 0b. Ensure we are connected before sending
            await ensureConnected();

            // 1. Store links locally
            store.applyDiff(diff);

            // 1b. Store DID ↔ MXID mapping for our commits
            if (myDid && MATRIX_USER_ID) {
                storeDIDMapping(myDid, MATRIX_USER_ID);
            }

            // 2. Skip outbound in subscribe-only mode
            if (settings.syncMode === "subscribe-only") {
                emitPerspectiveDiff(diff);
                return "";
            }

            // 3. Track origins for new native commits
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

            // 4. Build federation filter
            const federationFilter = (linkHash: string): boolean => {
                if (!settings.dualLanguage.enabled) return true;
                return shouldFederateLink(
                    linkHash,
                    undefined, // predicate checked in diffToEvents
                    (key) => getStorage().get(key),
                    settings.dualLanguage.excludePredicates,
                );
            };

            // 5. Translate to Matrix events
            const events = diffToEvents(diff, {
                settings,
                hashFn: hash,
                neighbourhoodUrl: neighbourhoodUrl(),
                shouldFederate: federationFilter,
            });

            // 6. Send events to the room
            for (const event of events) {
                const txnId = generateTxnId();
                await matrixApi.sendEvent(
                    MATRIX_ROOM_ID,
                    event.eventType,
                    event.content,
                    txnId,
                );
            }

            // 7. Handle removals (redactions)
            for (const removal of diff.removals) {
                const linkHash = store.hashLink(removal);
                // Look up the Matrix event ID for this link
                const eventId = store.getLinkHashByEventId(linkHash);
                if (eventId) {
                    await matrixApi.redactEvent(MATRIX_ROOM_ID, eventId, "Link removed");
                }
            }

            // 8. Emit the perspective diff for local subscribers
            emitPerspectiveDiff(diff);

            return "";
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

            const diff = processSyncResponse(
                syncResponse,
                MATRIX_ROOM_ID,
                neighbourhoodUrl(),
                MATRIX_USER_ID,
            );

            // Process to-device events for telepresence signals
            if (syncResponse.to_device?.events) {
                processToDeviceEvents(syncResponse.to_device.events);
            }

            // Process timeline events for broadcast signals
            const room = syncResponse.rooms?.join?.[MATRIX_ROOM_ID];
            if (room?.timeline?.events) {
                processTimelineBroadcasts(room.timeline.events, MATRIX_USER_ID);
            }

            // Build DID ↔ MXID mappings from incoming link events
            if (room?.timeline?.events) {
                for (const event of room.timeline.events) {
                    if (event.type === "dev.ad4m.link.triple" && event.sender) {
                        const content = event.content as Record<string, unknown>;
                        const author = content.author as string;
                        if (author && event.sender) {
                            storeDIDMapping(author, event.sender);
                        }
                    }
                }
            }

            // Track origins for inbound links
            for (const link of diff.additions) {
                const h = store.hashLink(link);
                const originKey = linkOriginKey(h);
                const existing = getStorage().get(originKey);
                if (existing === "native") {
                    getStorage().put(originKey, "dual");
                } else if (!existing) {
                    getStorage().put(originKey, "matrix");
                }
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
            // Remote peers are room members
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

            // Also store our own DID ↔ MXID mapping
            if (myDid && MATRIX_USER_ID) {
                storeDIDMapping(myDid, MATRIX_USER_ID);
            }
        },

        async getOnlineAgents(): Promise<unknown[]> {
            if (!configured) return [];
            await ensureConnected();

            // Get room members
            const memberEvents = await matrixApi.getMembers(MATRIX_ROOM_ID);
            const members = parseMemberEvents(memberEvents);
            const joinedMembers = members.filter(m => m.membership === "join");

            const onlineAgents: unknown[] = [];

            for (const member of joinedMembers) {
                // Skip ourselves
                if (member.userId === MATRIX_USER_ID) continue;

                // Check presence
                const presence = await matrixApi.getPresence(member.userId);
                if (!presence) continue;
                if (presence.presence !== "online") continue;

                // Resolve DID — check our stored mapping first,
                // then fall back to the convention-based mxidToDid
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

            // Resolve DID → MXID
            let targetMxid = getMxidForDid(remoteDid);
            if (!targetMxid) {
                // Fall back to convention-based mapping
                const serverName = extractServerName(MATRIX_USER_ID);
                targetMxid = didToMxid(remoteDid, serverName);
            }

            // Send via to-device message
            const content: Record<string, unknown> = {
                sender_did: myDid,
                payload,
                timestamp: new Date().toISOString(),
            };

            // Send to all devices of the target user ("*" = all devices)
            const messages: Record<string, Record<string, Record<string, unknown>>> = {
                [targetMxid]: {
                    "*": content,
                },
            };

            const success = await matrixApi.sendToDevice("dev.ad4m.signal", messages);
            return { success };
        },

        async sendBroadcast(payload: unknown): Promise<object> {
            if (!configured) return { error: "not configured" };
            await ensureConnected();

            // Send as a room event so all members receive it
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

/**
 * List of template parameters this language expects.  Pass this as
 * `languageMeta.possibleTemplateParams` when publishing.
 */
export const possibleTemplateParams: string[] = [
    "MATRIX_HOMESERVER_URL",
    "MATRIX_ROOM_ID",
    "MATRIX_USER_ID",
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

/**
 * Handle signals emitted by the executor.
 *
 * The executor forwards inbound events as signals to the language.
 */
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
    const { eventsToLinks: translate } = await import("./src/translate.js");
    const diff = translate([event as any], neighbourhoodUrl());

    const combinedDiff: PerspectiveDiff = {
        additions: diff.additions,
        removals: diff.removals,
    };

    if (combinedDiff.additions.length > 0 || combinedDiff.removals.length > 0) {
        store.applyDiff(combinedDiff);
        if (linkCallback) {
            linkCallback(combinedDiff);
        }
    }
}
