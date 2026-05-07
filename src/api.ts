/**
 * Matrix Client-Server API — types, URL builders, parsers, session management,
 * HTTP methods, and membership utilities.
 *
 * No ad4m:host imports. Uses injected Transport via adapters.
 *
 * Spec §16 — Client-Server API Endpoints Reference.
 */

import { getTransport } from "./adapters.js";
import type { TransportResponse } from "./adapters.js";

/** § Types */

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

export interface RoomMember {
    userId: string;
    displayName?: string;
    avatarUrl?: string;
    membership: "join" | "invite" | "leave" | "ban" | "knock";
    /** Mapped DID if the member is an AD4M agent. */
    did?: string;
}

export interface PowerLevelConfig {
    /** Default power level for new members. */
    usersDefault: number;
    /** Power level overrides by user ID. */
    users: Record<string, number>;
    /** Power level required to send specific event types. */
    events: Record<string, number>;
    /** Default power level required to send events. */
    eventsDefault: number;
    /** Power level required to invite. */
    invite: number;
    /** Power level required to kick. */
    kick: number;
    /** Power level required to ban. */
    ban: number;
    /** Power level required to redact others' events. */
    redact: number;
}

/** § URL Builders (private helpers) */

function buildLoginUrl(homeserverUrl: string): string {
    return `${homeserverUrl}/_matrix/client/v3/login`;
}

function buildSyncUrl(
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

function buildSendEventUrl(
    homeserverUrl: string,
    roomId: string,
    eventType: string,
    txnId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`;
}

function buildRedactUrl(
    homeserverUrl: string,
    roomId: string,
    eventId: string,
    txnId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`;
}

function buildStateUrl(
    homeserverUrl: string,
    roomId: string,
    eventType: string,
    stateKey: string = "",
): string {
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/${encodeURIComponent(stateKey)}`;
}

function buildJoinUrl(
    homeserverUrl: string,
    roomIdOrAlias: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`;
}

function buildInviteUrl(
    homeserverUrl: string,
    roomId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`;
}

function buildMembersUrl(
    homeserverUrl: string,
    roomId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`;
}

function buildMessagesUrl(
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

function buildTypingUrl(
    homeserverUrl: string,
    roomId: string,
    userId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`;
}

export function buildPresenceUrl(
    homeserverUrl: string,
    userId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/presence/${encodeURIComponent(userId)}/status`;
}

export function buildSendToDeviceUrl(
    homeserverUrl: string,
    eventType: string,
    txnId: string,
): string {
    return `${homeserverUrl}/_matrix/client/v3/sendToDevice/${encodeURIComponent(eventType)}/${encodeURIComponent(txnId)}`;
}

function buildAuthHeaders(accessToken: string): Record<string, string> {
    return {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
    };
}

/** § Public Request/Response Builders */

/**
 * Build the login request URL and body.
 */
export function buildLoginRequest(
    homeserverUrl: string,
    userId: string,
    password: string,
    deviceId?: string,
): { url: string; body: MatrixLoginRequest } {
    const url = buildLoginUrl(homeserverUrl);
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

/** § Response Parsers */

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

/** § Extraction Helpers */

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

/** § Transaction ID */

let _txnCounter = 0;

/**
 * Generate a unique transaction ID for Matrix event sending.
 */
export function generateTxnId(): string {
    _txnCounter++;
    return `ad4m-${Date.now()}-${_txnCounter}`;
}

/** § Session State */

let _accessToken: string = "";
let _userId: string = "";
let _deviceId: string = "";
let _homeserverUrl: string = "";

export function setSession(
    homeserverUrl: string,
    accessToken: string,
    userId: string,
    deviceId: string,
): void {
    _homeserverUrl = homeserverUrl;
    _accessToken = accessToken;
    _userId = userId;
    _deviceId = deviceId;
}

export function getSession(): {
    homeserverUrl: string;
    accessToken: string;
    userId: string;
    deviceId: string;
} {
    return {
        homeserverUrl: _homeserverUrl,
        accessToken: _accessToken,
        userId: _userId,
        deviceId: _deviceId,
    };
}

export function clearSession(): void {
    _accessToken = "";
    _userId = "";
    _deviceId = "";
    _homeserverUrl = "";
}

function authHeaders(): Record<string, string> {
    return buildAuthHeaders(_accessToken);
}

/** § API Methods */

/**
 * Login to the Matrix homeserver.
 */
export async function login(
    homeserverUrl: string,
    user: string,
    password: string,
    deviceId?: string,
): Promise<MatrixLoginResponse | null> {
    const { url, body } = buildLoginRequest(homeserverUrl, user, password, deviceId);
    const response = await getTransport().fetch(
        url,
        "POST",
        { "Content-Type": "application/json" },
        JSON.stringify(body),
    );

    if (response.status < 200 || response.status >= 300) {
        console.log(`[matrix-api] login failed: ${response.status} ${response.body}`);
        return null;
    }

    const loginResp = parseLoginResponse(response.body);
    if (loginResp) {
        setSession(homeserverUrl, loginResp.access_token, loginResp.user_id, loginResp.device_id);
    }
    return loginResp;
}

/**
 * Login with a pre-existing access token.
 */
export function loginWithToken(
    homeserverUrl: string,
    accessToken: string,
    userId: string,
    deviceId: string = "AD4M_DEVICE",
): void {
    setSession(homeserverUrl, accessToken, userId, deviceId);
}

/**
 * Perform an incremental /sync call.
 */
export async function sync(
    sinceToken?: string,
    timeoutMs: number = 30000,
    filter?: string,
): Promise<MatrixSyncResponse | null> {
    const url = buildSyncUrl(_homeserverUrl, sinceToken, timeoutMs, filter);
    const response = await getTransport().fetch(url, "GET", authHeaders(), "");

    if (response.status < 200 || response.status >= 300) {
        console.log(`[matrix-api] sync failed: ${response.status}`);
        return null;
    }

    return parseSyncResponse(response.body);
}

/**
 * Send a room event (timeline event).
 */
export async function sendEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
    txnId?: string,
): Promise<string | null> {
    const tid = txnId || generateTxnId();
    const url = buildSendEventUrl(_homeserverUrl, roomId, eventType, tid);
    const response = await getTransport().fetch(
        url,
        "PUT",
        authHeaders(),
        JSON.stringify(content),
    );

    if (response.status < 200 || response.status >= 300) {
        console.log(`[matrix-api] sendEvent failed: ${response.status} ${response.body}`);
        return null;
    }

    try {
        const parsed = JSON.parse(response.body);
        return parsed.event_id || null;
    } catch {
        return null;
    }
}

/**
 * Redact a room event.
 */
export async function redactEvent(
    roomId: string,
    eventId: string,
    reason?: string,
): Promise<string | null> {
    const txnId = generateTxnId();
    const url = buildRedactUrl(_homeserverUrl, roomId, eventId, txnId);
    const body = reason ? JSON.stringify({ reason }) : "{}";
    const response = await getTransport().fetch(url, "PUT", authHeaders(), body);

    if (response.status < 200 || response.status >= 300) {
        console.log(`[matrix-api] redact failed: ${response.status} ${response.body}`);
        return null;
    }

    try {
        const parsed = JSON.parse(response.body);
        return parsed.event_id || null;
    } catch {
        return null;
    }
}

/**
 * Get room state for a specific event type.
 */
export async function getState(
    roomId: string,
    eventType: string,
    stateKey: string = "",
): Promise<Record<string, unknown> | null> {
    const url = buildStateUrl(_homeserverUrl, roomId, eventType, stateKey);
    const response = await getTransport().fetch(url, "GET", authHeaders(), "");

    if (response.status < 200 || response.status >= 300) {
        return null;
    }

    try {
        return JSON.parse(response.body);
    } catch {
        return null;
    }
}

/**
 * Set room state for a specific event type.
 */
export async function setState(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
    stateKey: string = "",
): Promise<string | null> {
    const url = buildStateUrl(_homeserverUrl, roomId, eventType, stateKey);
    const response = await getTransport().fetch(
        url,
        "PUT",
        authHeaders(),
        JSON.stringify(content),
    );

    if (response.status < 200 || response.status >= 300) {
        console.log(`[matrix-api] setState failed: ${response.status} ${response.body}`);
        return null;
    }

    try {
        const parsed = JSON.parse(response.body);
        return parsed.event_id || null;
    } catch {
        return null;
    }
}

/**
 * Join a room by ID or alias.
 */
export async function joinRoom(
    roomIdOrAlias: string,
): Promise<{ room_id: string } | null> {
    const url = buildJoinUrl(_homeserverUrl, roomIdOrAlias);
    const response = await getTransport().fetch(url, "POST", authHeaders(), "{}");

    if (response.status < 200 || response.status >= 300) {
        console.log(`[matrix-api] joinRoom failed: ${response.status} ${response.body}`);
        return null;
    }

    try {
        return JSON.parse(response.body);
    } catch {
        return null;
    }
}

/**
 * Invite a user to a room.
 */
export async function inviteUser(
    roomId: string,
    userId: string,
): Promise<boolean> {
    const url = buildInviteUrl(_homeserverUrl, roomId);
    const response = await getTransport().fetch(
        url,
        "POST",
        authHeaders(),
        JSON.stringify({ user_id: userId }),
    );
    return response.status >= 200 && response.status < 300;
}

/**
 * Get room members.
 */
export async function getMembers(
    roomId: string,
): Promise<MatrixEvent[]> {
    const url = buildMembersUrl(_homeserverUrl, roomId);
    const response = await getTransport().fetch(url, "GET", authHeaders(), "");

    if (response.status < 200 || response.status >= 300) {
        return [];
    }

    try {
        const parsed = JSON.parse(response.body);
        return Array.isArray(parsed.chunk) ? parsed.chunk : [];
    } catch {
        return [];
    }
}

/**
 * Get room messages (for backfill).
 */
export async function getMessages(
    roomId: string,
    from: string,
    dir: "b" | "f" = "b",
    limit: number = 100,
): Promise<MatrixMessagesResponse | null> {
    const url = buildMessagesUrl(_homeserverUrl, roomId, from, dir, limit);
    const response = await getTransport().fetch(url, "GET", authHeaders(), "");

    if (response.status < 200 || response.status >= 300) {
        return null;
    }

    return parseMessagesResponse(response.body);
}

/**
 * Set typing indicator.
 */
export async function setTyping(
    roomId: string,
    typing: boolean,
    timeoutMs: number = 30000,
): Promise<boolean> {
    const url = buildTypingUrl(_homeserverUrl, roomId, _userId);
    const body = typing
        ? JSON.stringify({ typing: true, timeout: timeoutMs })
        : JSON.stringify({ typing: false });
    const response = await getTransport().fetch(url, "PUT", authHeaders(), body);
    return response.status >= 200 && response.status < 300;
}

/**
 * Set presence status.
 */
export async function setPresence(
    presence: "online" | "offline" | "unavailable",
    statusMsg?: string,
): Promise<boolean> {
    const url = buildPresenceUrl(_homeserverUrl, _userId);
    const body: Record<string, unknown> = { presence };
    if (statusMsg) body.status_msg = statusMsg;
    const response = await getTransport().fetch(
        url,
        "PUT",
        authHeaders(),
        JSON.stringify(body),
    );
    return response.status >= 200 && response.status < 300;
}

/**
 * Get presence status for a specific user.
 */
export async function getPresence(
    userId: string,
): Promise<{ presence: string; last_active_ago?: number; status_msg?: string; currently_active?: boolean } | null> {
    const url = buildPresenceUrl(_homeserverUrl, userId);
    const response = await getTransport().fetch(url, "GET", authHeaders(), "");

    if (response.status < 200 || response.status >= 300) {
        return null;
    }

    try {
        return JSON.parse(response.body);
    } catch {
        return null;
    }
}

/**
 * Send to-device messages.
 */
export async function sendToDevice(
    eventType: string,
    messages: Record<string, Record<string, Record<string, unknown>>>,
    txnId?: string,
): Promise<boolean> {
    const tid = txnId || generateTxnId();
    const url = buildSendToDeviceUrl(_homeserverUrl, eventType, tid);
    const body = JSON.stringify({ messages });
    const response = await getTransport().fetch(url, "PUT", authHeaders(), body);
    return response.status >= 200 && response.status < 300;
}

/** § Membership */

/**
 * Default power levels for AD4M neighbourhoods.
 */
export function defaultPowerLevels(creatorUserId: string): PowerLevelConfig {
    return {
        usersDefault: 0,
        users: {
            [creatorUserId]: 100,
        },
        events: {
            "dev.ad4m.link.triple": 0,
            "m.room.message": 0,
            "m.reaction": 0,
            "dev.ad4m.neighbourhood.config": 50,
            "m.room.name": 50,
            "m.room.topic": 50,
            "m.room.power_levels": 100,
        },
        eventsDefault: 0,
        invite: 50,
        kick: 50,
        ban: 50,
        redact: 50,
    };
}

/**
 * Parse m.room.member state events into RoomMember objects.
 */
export function parseMemberEvents(events: MatrixEvent[]): RoomMember[] {
    const members: RoomMember[] = [];

    for (const event of events) {
        if (event.type !== "m.room.member") continue;
        if (!event.state_key) continue;

        const content = event.content as {
            membership?: string;
            displayname?: string;
            avatar_url?: string;
        };

        const membership = content.membership as RoomMember["membership"];
        if (!membership) continue;

        members.push({
            userId: event.state_key,
            displayName: content.displayname,
            avatarUrl: content.avatar_url,
            membership,
            did: mxidToDid(event.state_key),
        });
    }

    return members;
}

/**
 * Map a Matrix user ID to an AD4M DID.
 * AD4M bridge users: @_ad4m_<key>:server → did:key:<key>
 * Regular Matrix users: @user:server → did:matrix:server:user
 */
export function mxidToDid(mxid: string): string {
    const ad4mMatch = mxid.match(/^@_ad4m_(.+?):/);
    if (ad4mMatch) {
        return `did:key:${ad4mMatch[1]}`;
    }
    // Proper DID format: @user:server → did:matrix:server:user
    const match = mxid.match(/^@([^:]+):(.+)$/);
    if (match) {
        return `did:matrix:${match[2]}:${match[1]}`;
    }
    return `did:matrix:unknown:${mxid.replace('@', '')}`;
}

/**
 * Map an AD4M DID to a Matrix user ID.
 */
export function didToMxid(did: string, serverName: string): string {
    if (did.startsWith("matrix:")) {
        return did.slice(7);  // legacy format
    }
    if (did.startsWith("did:matrix:")) {
        // did:matrix:server:user → @user:server
        const parts = did.slice(11).split(':');
        if (parts.length >= 2) {
            const server = parts[0];
            const user = parts.slice(1).join(':');
            return `@${user}:${server}`;
        }
    }
    if (did.startsWith("did:key:")) {
        const suffix = did.slice(8);
        return `@_ad4m_${suffix}:${serverName}`;
    }
    return `@${did}:${serverName}`;
}

/**
 * Filter members by membership status.
 */
export function getJoinedMembers(members: RoomMember[]): RoomMember[] {
    return members.filter(m => m.membership === "join");
}

/**
 * Get DID list for joined members.
 */
export function getJoinedMemberDids(members: RoomMember[]): string[] {
    return getJoinedMembers(members).map(m => m.did || `matrix:${m.userId}`);
}

/**
 * Check if a user should be allowed to join based on membership mode.
 */
export function canJoin(
    userId: string,
    membershipMode: "open" | "invite-only",
    invitedUsers: Set<string>,
): boolean {
    if (membershipMode === "open") return true;
    return invitedUsers.has(userId);
}

/**
 * Build power level content override for room creation.
 */
export function buildPowerLevelOverride(
    creatorUserId: string,
    additionalAdmins: string[] = [],
): Record<string, unknown> {
    const config = defaultPowerLevels(creatorUserId);

    for (const admin of additionalAdmins) {
        config.users[admin] = 100;
    }

    return config as unknown as Record<string, unknown>;
}
