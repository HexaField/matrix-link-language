/**
 * Pure Matrix Client-Server API request/response builders.
 *
 * Constructs request URLs, headers, and bodies for the Matrix CS API v3.
 * Zero runtime dependencies — safe for unit testing.
 *
 * Spec §16 — Client-Server API Endpoints Reference.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MatrixLoginRequest {
    type: "m.login.password";
    identifier: { type: "m.id.user"; user: string };
    password: string;
    device_id?: string;
    initial_device_display_name?: string;
}

export interface MatrixLoginResponse {
    access_token: string;
    user_id: string;
    device_id: string;
    home_server?: string;
}

export interface MatrixSyncResponse {
    next_batch: string;
    rooms?: {
        join?: Record<string, MatrixJoinedRoom>;
        invite?: Record<string, unknown>;
        leave?: Record<string, unknown>;
    };
    /** To-device messages delivered during this sync batch. */
    to_device?: {
        events: MatrixEvent[];
    };
}

export interface MatrixJoinedRoom {
    timeline?: {
        events: MatrixEvent[];
        prev_batch?: string;
        limited?: boolean;
    };
    state?: {
        events: MatrixEvent[];
    };
    ephemeral?: {
        events: MatrixEvent[];
    };
}

export interface MatrixEvent {
    type: string;
    event_id?: string;
    room_id?: string;
    sender?: string;
    origin_server_ts?: number;
    content: Record<string, unknown>;
    state_key?: string;
    unsigned?: Record<string, unknown>;
    redacts?: string;
}

export interface MatrixFilter {
    room?: {
        timeline?: {
            types?: string[];
            limit?: number;
        };
        state?: {
            types?: string[];
        };
        ephemeral?: {
            types?: string[];
        };
    };
}

export interface MatrixMessagesResponse {
    start: string;
    end?: string;
    chunk: MatrixEvent[];
    state?: MatrixEvent[];
}

export interface MatrixMemberEvent {
    type: "m.room.member";
    state_key: string;
    content: {
        membership: "join" | "invite" | "leave" | "ban" | "knock";
        displayname?: string;
        avatar_url?: string;
    };
    sender: string;
}

// ---------------------------------------------------------------------------
// Request Builders
// ---------------------------------------------------------------------------

/**
 * Build the login request URL and body.
 */
export function buildLoginRequest(
    homeserverUrl: string,
    userId: string,
    password: string,
    deviceId?: string,
): { url: string; body: MatrixLoginRequest } {
    const url = `${homeserverUrl}/_matrix/client/v3/login`;
    const body: MatrixLoginRequest = {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: userId },
        password,
        ...(deviceId ? { device_id: deviceId } : {}),
        initial_device_display_name: "AD4M Matrix Bridge",
    };
    return { url, body };
}

/**
 * Build the sync request URL with query parameters.
 */
export function buildSyncUrl(
    homeserverUrl: string,
    sinceToken?: string,
    timeoutMs: number = 30000,
    filter?: string,
): string {
    const params = new URLSearchParams();
    if (sinceToken) params.set("since", sinceToken);
    params.set("timeout", String(timeoutMs));
    if (filter) params.set("filter", filter);
    return `${homeserverUrl}/_matrix/client/v3/sync?${params.toString()}`;
}

/**
 * Build the send event URL with transaction ID.
 */
export function buildSendEventUrl(
    homeserverUrl: string,
    roomId: string,
    eventType: string,
    txnId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`;
}

/**
 * Build the redaction URL.
 */
export function buildRedactUrl(
    homeserverUrl: string,
    roomId: string,
    eventId: string,
    txnId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`;
}

/**
 * Build the room state URL.
 */
export function buildStateUrl(
    homeserverUrl: string,
    roomId: string,
    eventType: string,
    stateKey: string = "",
): string {
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/${encodeURIComponent(stateKey)}`;
}

/**
 * Build the join room URL.
 */
export function buildJoinUrl(
    homeserverUrl: string,
    roomIdOrAlias: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`;
}

/**
 * Build the invite URL.
 */
export function buildInviteUrl(
    homeserverUrl: string,
    roomId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`;
}

/**
 * Build the room members URL.
 */
export function buildMembersUrl(
    homeserverUrl: string,
    roomId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`;
}

/**
 * Build the room messages URL (for backfill).
 */
export function buildMessagesUrl(
    homeserverUrl: string,
    roomId: string,
    from: string,
    dir: "b" | "f" = "b",
    limit: number = 100,
    filter?: string,
): string {
    const params = new URLSearchParams();
    params.set("from", from);
    params.set("dir", dir);
    params.set("limit", String(limit));
    if (filter) params.set("filter", filter);
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`;
}

/**
 * Build the typing indicator URL.
 */
export function buildTypingUrl(
    homeserverUrl: string,
    roomId: string,
    userId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`;
}

/**
 * Build the presence URL (for setting own presence).
 */
export function buildPresenceUrl(
    homeserverUrl: string,
    userId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/presence/${encodeURIComponent(userId)}/status`;
}

/**
 * Build the presence URL for *getting* another user's presence.
 * (Same endpoint, but used with GET instead of PUT.)
 */
export function buildGetPresenceUrl(
    homeserverUrl: string,
    userId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/presence/${encodeURIComponent(userId)}/status`;
}

/**
 * Build the send-to-device URL.
 *
 * PUT /_matrix/client/v3/sendToDevice/{eventType}/{txnId}
 */
export function buildSendToDeviceUrl(
    homeserverUrl: string,
    eventType: string,
    txnId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`;
}

/**
 * Build authorization headers for authenticated requests.
 */
export function buildAuthHeaders(accessToken: string): Record<string, string> {
    return {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
    };
}

/**
 * Build a default sync filter for the Matrix Link Language.
 */
export function buildDefaultFilter(): MatrixFilter {
    return {
        room: {
            timeline: {
                types: [
                    "dev.ad4m.link.triple",
                    "m.room.message",
                    "m.reaction",
                    "m.room.redaction",
                ],
                limit: 100,
            },
            state: {
                types: [
                    "dev.ad4m.neighbourhood.config",
                    "m.room.member",
                    "m.room.name",
                    "m.room.power_levels",
                ],
            },
            ephemeral: {
                types: ["m.typing"],
            },
        },
    };
}

// ---------------------------------------------------------------------------
// Response Parsers
// ---------------------------------------------------------------------------

/**
 * Parse a login response JSON string.
 */
export function parseLoginResponse(raw: string): MatrixLoginResponse | null {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed.access_token || !parsed.user_id) return null;
        return {
            access_token: parsed.access_token,
            user_id: parsed.user_id,
            device_id: parsed.device_id || "",
            home_server: parsed.home_server,
        };
    } catch {
        return null;
    }
}

/**
 * Parse a sync response JSON string.
 */
export function parseSyncResponse(raw: string): MatrixSyncResponse | null {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed.next_batch) return null;
        return parsed as MatrixSyncResponse;
    } catch {
        return null;
    }
}

/**
 * Parse a messages response JSON string (for backfill).
 */
export function parseMessagesResponse(raw: string): MatrixMessagesResponse | null {
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.chunk)) return null;
        return {
            start: parsed.start || "",
            end: parsed.end,
            chunk: parsed.chunk,
            state: parsed.state,
        };
    } catch {
        return null;
    }
}

/**
 * Extract timeline events for a specific room from a sync response.
 */
export function extractRoomTimeline(
    syncResponse: MatrixSyncResponse,
    roomId: string,
): MatrixEvent[] {
    const room = syncResponse.rooms?.join?.[roomId];
    if (!room?.timeline?.events) return [];
    return room.timeline.events;
}

/**
 * Extract state events for a specific room from a sync response.
 */
export function extractRoomState(
    syncResponse: MatrixSyncResponse,
    roomId: string,
): MatrixEvent[] {
    const room = syncResponse.rooms?.join?.[roomId];
    if (!room?.state?.events) return [];
    return room.state.events;
}

/**
 * Extract the prev_batch token for backfill from a sync response.
 */
export function extractPrevBatch(
    syncResponse: MatrixSyncResponse,
    roomId: string,
): string | null {
    const room = syncResponse.rooms?.join?.[roomId];
    return room?.timeline?.prev_batch ?? null;
}

/**
 * Generate a unique transaction ID for Matrix event sending.
 */
let _txnCounter = 0;
export function generateTxnId(): string {
    _txnCounter++;
    return `ad4m-${Date.now()}-${_txnCounter}`;
}

/**
 * Reset the transaction counter (for testing).
 */
export function resetTxnCounter(): void {
    _txnCounter = 0;
}
