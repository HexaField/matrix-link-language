/**
 * Matrix Client-Server API client.
 *
 * Makes HTTP calls to the Matrix homeserver using the injected Transport.
 * All calls go through getTransport().fetch() — no direct ad4m:host imports.
 *
 * Spec §16 — Client-Server API Endpoints Reference.
 */

import { getTransport } from "./transport.js";
import type { TransportResponse } from "./transport.js";
import {
    buildLoginRequest,
    buildSyncUrl,
    buildSendEventUrl,
    buildRedactUrl,
    buildJoinUrl,
    buildInviteUrl,
    buildMembersUrl,
    buildMessagesUrl,
    buildTypingUrl,
    buildPresenceUrl,
    buildAuthHeaders,
    buildStateUrl,
    parseLoginResponse,
    parseSyncResponse,
    parseMessagesResponse,
    generateTxnId,
} from "./matrix-api.pure.js";
import type {
    MatrixLoginResponse,
    MatrixSyncResponse,
    MatrixEvent,
    MatrixMessagesResponse,
} from "./matrix-api.pure.js";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// API Methods
// ---------------------------------------------------------------------------

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
