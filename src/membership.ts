/**
 * Room join/invite/power levels management.
 *
 * Handles Matrix room membership operations:
 * - Joining rooms
 * - Inviting users
 * - Managing power levels
 * - Listing members with DID mapping
 *
 * No ad4m:host imports. Uses injected interfaces via matrix-api.
 *
 * Spec §10, §19–§21.
 */

import type { MatrixEvent } from "./matrix-api.pure.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Default power levels for AD4M neighbourhoods
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Member event parsing
// ---------------------------------------------------------------------------

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
 *
 * Convention:
 * - AD4M bridge users: @_ad4m_{did-suffix}:server → did:key:{did-suffix}
 * - Other Matrix users: → matrix:{mxid}
 */
export function mxidToDid(mxid: string): string {
    const ad4mMatch = mxid.match(/^@_ad4m_(.+?):/);
    if (ad4mMatch) {
        return `did:key:${ad4mMatch[1]}`;
    }
    return `matrix:${mxid}`;
}

/**
 * Map an AD4M DID to a Matrix user ID.
 *
 * Convention:
 * - did:key:z6Mk... → @_ad4m_z6Mk...:server
 * - matrix:@user:server → @user:server
 */
export function didToMxid(did: string, serverName: string): string {
    if (did.startsWith("matrix:")) {
        return did.slice(7);
    }
    if (did.startsWith("did:key:")) {
        const suffix = did.slice(8);
        return `@_ad4m_${suffix}:${serverName}`;
    }
    return `@_ad4m_${encodeURIComponent(did)}:${serverName}`;
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
