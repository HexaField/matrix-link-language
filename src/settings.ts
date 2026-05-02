/**
 * Settings for the Matrix Link Language.
 *
 * Parsed from the JSON string returned by `languageSettings()` at
 * runtime. Provides sensible defaults per Spec §12.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RenderingSettings {
    /** Which event types to create: "native" (dev.ad4m.link.triple only),
     *  "matrix" (m.room.message only), "dual" (both). */
    strategy: "native" | "matrix" | "dual";
    /** Predicates treated as chat messages for m.room.message rendering. */
    chatPredicates: string[];
    /** Whether to resolve expression URIs for message content. */
    resolveContent: boolean;
}

export type SyncMode = "bidirectional" | "publish-only" | "subscribe-only";

export type MembershipMode = "open" | "invite-only";

export interface SyncSettings {
    /** Long-poll timeout (ms). */
    timeoutMs: number;
    /** Max events per sync response. */
    limit: number;
    /** Enable backfill on first sync. */
    backfillEnabled: boolean;
    /** Max events to backfill. */
    backfillLimit: number;
}

export interface AuthSettings {
    /** Auth method. */
    method: "password" | "access-token" | "appservice";
    /** Password (for password auth). */
    password: string;
    /** Static access token (for token auth). */
    accessToken: string;
}

export interface EncryptionSettings {
    /** Enable E2E encryption. */
    enabled: boolean;
    /** Verify devices before sending. */
    verifyDevices: boolean;
}

export interface RateLimitSettings {
    /** Max events per second (client-side throttle). */
    maxEventsPerSecond: number;
}

export interface DualLanguageSettings {
    enabled: boolean;
    excludePredicates: string[];
}

export interface TelepresenceSettings {
    /** Enable typing indicators. */
    typing: boolean;
    /** Enable presence updates. */
    presence: boolean;
}

export interface MatrixSettings {
    syncMode: SyncMode;
    rendering: RenderingSettings;
    sync: SyncSettings;
    auth: AuthSettings;
    encryption: EncryptionSettings;
    rateLimit: RateLimitSettings;
    membership: MembershipMode;
    dualLanguage: DualLanguageSettings;
    telepresence: TelepresenceSettings;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: MatrixSettings = {
    syncMode: "bidirectional",
    rendering: {
        strategy: "dual",
        chatPredicates: ["flux://has_message", "sioc://content_of"],
        resolveContent: true,
    },
    sync: {
        timeoutMs: 30000,
        limit: 100,
        backfillEnabled: true,
        backfillLimit: 1000,
    },
    auth: {
        method: "password",
        password: "",
        accessToken: "",
    },
    encryption: {
        enabled: false,
        verifyDevices: false,
    },
    rateLimit: {
        maxEventsPerSecond: 10,
    },
    membership: "invite-only",
    dualLanguage: {
        enabled: false,
        excludePredicates: [],
    },
    telepresence: {
        typing: true,
        presence: true,
    },
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse settings from a raw JSON string, falling back to defaults
 * for any missing or invalid fields.
 */
export function parseSettings(raw: string | null | undefined): MatrixSettings {
    if (!raw) return { ...DEFAULT_SETTINGS };
    try {
        const p = JSON.parse(raw);
        return {
            syncMode:
                ["bidirectional", "publish-only", "subscribe-only"].includes(p?.syncMode)
                    ? p.syncMode
                    : DEFAULT_SETTINGS.syncMode,
            rendering: {
                strategy:
                    ["native", "matrix", "dual"].includes(p?.rendering?.strategy)
                        ? p.rendering.strategy
                        : DEFAULT_SETTINGS.rendering.strategy,
                chatPredicates:
                    Array.isArray(p?.rendering?.chatPredicates)
                        ? p.rendering.chatPredicates
                        : DEFAULT_SETTINGS.rendering.chatPredicates,
                resolveContent:
                    typeof p?.rendering?.resolveContent === "boolean"
                        ? p.rendering.resolveContent
                        : DEFAULT_SETTINGS.rendering.resolveContent,
            },
            sync: {
                timeoutMs:
                    typeof p?.sync?.timeoutMs === "number" && p.sync.timeoutMs > 0
                        ? p.sync.timeoutMs
                        : DEFAULT_SETTINGS.sync.timeoutMs,
                limit:
                    typeof p?.sync?.limit === "number" && p.sync.limit > 0
                        ? p.sync.limit
                        : DEFAULT_SETTINGS.sync.limit,
                backfillEnabled:
                    typeof p?.sync?.backfillEnabled === "boolean"
                        ? p.sync.backfillEnabled
                        : DEFAULT_SETTINGS.sync.backfillEnabled,
                backfillLimit:
                    typeof p?.sync?.backfillLimit === "number" && p.sync.backfillLimit > 0
                        ? p.sync.backfillLimit
                        : DEFAULT_SETTINGS.sync.backfillLimit,
            },
            auth: {
                method:
                    ["password", "access-token", "appservice"].includes(p?.auth?.method)
                        ? p.auth.method
                        : DEFAULT_SETTINGS.auth.method,
                password:
                    typeof p?.auth?.password === "string"
                        ? p.auth.password
                        : DEFAULT_SETTINGS.auth.password,
                accessToken:
                    typeof p?.auth?.accessToken === "string"
                        ? p.auth.accessToken
                        : DEFAULT_SETTINGS.auth.accessToken,
            },
            encryption: {
                enabled:
                    typeof p?.encryption?.enabled === "boolean"
                        ? p.encryption.enabled
                        : DEFAULT_SETTINGS.encryption.enabled,
                verifyDevices:
                    typeof p?.encryption?.verifyDevices === "boolean"
                        ? p.encryption.verifyDevices
                        : DEFAULT_SETTINGS.encryption.verifyDevices,
            },
            rateLimit: {
                maxEventsPerSecond:
                    typeof p?.rateLimit?.maxEventsPerSecond === "number" && p.rateLimit.maxEventsPerSecond > 0
                        ? p.rateLimit.maxEventsPerSecond
                        : DEFAULT_SETTINGS.rateLimit.maxEventsPerSecond,
            },
            membership:
                ["open", "invite-only"].includes(p?.membership)
                    ? p.membership
                    : DEFAULT_SETTINGS.membership,
            dualLanguage: {
                enabled:
                    typeof p?.dualLanguage?.enabled === "boolean"
                        ? p.dualLanguage.enabled
                        : DEFAULT_SETTINGS.dualLanguage.enabled,
                excludePredicates:
                    Array.isArray(p?.dualLanguage?.excludePredicates)
                        ? p.dualLanguage.excludePredicates
                        : DEFAULT_SETTINGS.dualLanguage.excludePredicates,
            },
            telepresence: {
                typing:
                    typeof p?.telepresence?.typing === "boolean"
                        ? p.telepresence.typing
                        : DEFAULT_SETTINGS.telepresence.typing,
                presence:
                    typeof p?.telepresence?.presence === "boolean"
                        ? p.telepresence.presence
                        : DEFAULT_SETTINGS.telepresence.presence,
            },
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}
