/**
 * Tests for Matrix Client-Server API request/response builders and membership.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    buildLoginRequest,
    buildDefaultFilter,
    parseLoginResponse,
    parseSyncResponse,
    parseMessagesResponse,
    extractRoomTimeline,
    extractRoomState,
    extractPrevBatch,
    generateTxnId,
    parseMemberEvents,
    mxidToDid,
    didToMxid,
    getJoinedMembers,
    getJoinedMemberDids,
    canJoin,
    defaultPowerLevels,
    buildPowerLevelOverride,
} from "../src/api.js";

import type { MatrixSyncResponse, MatrixEvent, RoomMember } from "../src/api.js";

const HOMESERVER = "https://matrix.example.com";

// ---------------------------------------------------------------------------
// Request Builders
// ---------------------------------------------------------------------------

describe("buildLoginRequest", () => {
    it("builds correct URL and body", () => {
        const { url, body } = buildLoginRequest(HOMESERVER, "bridge", "secret");
        assert.equal(url, `${HOMESERVER}/_matrix/client/v3/login`);
        assert.equal(body.type, "m.login.password");
        assert.equal(body.identifier.type, "m.id.user");
        assert.equal(body.identifier.user, "bridge");
        assert.equal(body.password, "secret");
        assert.equal(body.initial_device_display_name, "AD4M Matrix Bridge");
    });

    it("includes device_id when provided", () => {
        const { body } = buildLoginRequest(HOMESERVER, "user", "pass", "MYDEVICE");
        assert.equal(body.device_id, "MYDEVICE");
    });

    it("omits device_id when not provided", () => {
        const { body } = buildLoginRequest(HOMESERVER, "user", "pass");
        assert.equal(body.device_id, undefined);
    });
});

describe("buildDefaultFilter", () => {
    it("includes expected event types", () => {
        const filter = buildDefaultFilter();
        assert.ok(filter.room?.timeline?.types?.includes("dev.ad4m.link.triple"));
        assert.ok(filter.room?.timeline?.types?.includes("m.room.message"));
        assert.ok(filter.room?.timeline?.types?.includes("m.reaction"));
        assert.ok(filter.room?.timeline?.types?.includes("m.room.redaction"));
        assert.ok(filter.room?.state?.types?.includes("m.room.member"));
        assert.ok(filter.room?.ephemeral?.types?.includes("m.typing"));
    });
});

// ---------------------------------------------------------------------------
// Response Parsers
// ---------------------------------------------------------------------------

describe("parseLoginResponse", () => {
    it("parses valid login response", () => {
        const raw = JSON.stringify({
            access_token: "token123",
            user_id: "@bridge:server",
            device_id: "DEV1",
            home_server: "server",
        });
        const result = parseLoginResponse(raw);
        assert.ok(result);
        assert.equal(result!.access_token, "token123");
        assert.equal(result!.user_id, "@bridge:server");
        assert.equal(result!.device_id, "DEV1");
    });

    it("returns null for missing access_token", () => {
        assert.equal(parseLoginResponse(JSON.stringify({ user_id: "@a:s" })), null);
    });

    it("returns null for invalid JSON", () => {
        assert.equal(parseLoginResponse("not json"), null);
    });
});

describe("parseSyncResponse", () => {
    it("parses valid sync response", () => {
        const raw = JSON.stringify({
            next_batch: "s123",
            rooms: {
                join: {
                    "!room:s": {
                        timeline: { events: [{ type: "m.room.message", content: { body: "hi" } }] },
                    },
                },
            },
        });
        const result = parseSyncResponse(raw);
        assert.ok(result);
        assert.equal(result!.next_batch, "s123");
    });

    it("returns null for missing next_batch", () => {
        assert.equal(parseSyncResponse(JSON.stringify({ rooms: {} })), null);
    });

    it("returns null for invalid JSON", () => {
        assert.equal(parseSyncResponse("{bad}"), null);
    });
});

describe("parseMessagesResponse", () => {
    it("parses valid messages response", () => {
        const raw = JSON.stringify({
            start: "s1",
            end: "s2",
            chunk: [{ type: "m.room.message", content: {} }],
        });
        const result = parseMessagesResponse(raw);
        assert.ok(result);
        assert.equal(result!.start, "s1");
        assert.equal(result!.end, "s2");
        assert.equal(result!.chunk.length, 1);
    });

    it("returns null for missing chunk array", () => {
        assert.equal(parseMessagesResponse(JSON.stringify({ start: "s1" })), null);
    });
});

// ---------------------------------------------------------------------------
// Extraction helpers
// ---------------------------------------------------------------------------

describe("extractRoomTimeline", () => {
    it("extracts timeline events for a room", () => {
        const events: MatrixEvent[] = [
            { type: "m.room.message", content: { body: "hello" } },
        ];
        const syncResp: MatrixSyncResponse = {
            next_batch: "s1",
            rooms: {
                join: {
                    "!room:s": { timeline: { events } },
                },
            },
        };
        assert.equal(extractRoomTimeline(syncResp, "!room:s").length, 1);
    });

    it("returns empty array for missing room", () => {
        const syncResp: MatrixSyncResponse = { next_batch: "s1" };
        assert.equal(extractRoomTimeline(syncResp, "!missing:s").length, 0);
    });
});

describe("extractRoomState", () => {
    it("extracts state events for a room", () => {
        const syncResp: MatrixSyncResponse = {
            next_batch: "s1",
            rooms: {
                join: {
                    "!room:s": {
                        state: {
                            events: [{ type: "m.room.name", content: { name: "Test" } }],
                        },
                    },
                },
            },
        };
        assert.equal(extractRoomState(syncResp, "!room:s").length, 1);
    });
});

describe("extractPrevBatch", () => {
    it("extracts prev_batch token", () => {
        const syncResp: MatrixSyncResponse = {
            next_batch: "s2",
            rooms: {
                join: {
                    "!room:s": {
                        timeline: { events: [], prev_batch: "s1" },
                    },
                },
            },
        };
        assert.equal(extractPrevBatch(syncResp, "!room:s"), "s1");
    });

    it("returns null when no prev_batch", () => {
        const syncResp: MatrixSyncResponse = {
            next_batch: "s2",
            rooms: { join: { "!room:s": { timeline: { events: [] } } } },
        };
        assert.equal(extractPrevBatch(syncResp, "!room:s"), null);
    });
});

// ---------------------------------------------------------------------------
// Transaction IDs
// ---------------------------------------------------------------------------

describe("generateTxnId", () => {
    it("produces unique IDs", () => {
        const id1 = generateTxnId();
        const id2 = generateTxnId();
        assert.notEqual(id1, id2);
    });

    it("has ad4m prefix", () => {
        const id = generateTxnId();
        assert.ok(id.startsWith("ad4m-"));
    });
});

// ---------------------------------------------------------------------------
// parseMemberEvents
// ---------------------------------------------------------------------------

describe("parseMemberEvents", () => {
    it("parses join member events", () => {
        const events: MatrixEvent[] = [
            {
                type: "m.room.member",
                state_key: "@alice:matrix.org",
                content: {
                    membership: "join",
                    displayname: "Alice",
                    avatar_url: "mxc://matrix.org/avatar",
                },
                sender: "@alice:matrix.org",
            },
            {
                type: "m.room.member",
                state_key: "@bob:matrix.org",
                content: {
                    membership: "join",
                    displayname: "Bob",
                },
                sender: "@bob:matrix.org",
            },
        ];

        const members = parseMemberEvents(events);
        assert.equal(members.length, 2);
        assert.equal(members[0].userId, "@alice:matrix.org");
        assert.equal(members[0].displayName, "Alice");
        assert.equal(members[0].membership, "join");
        assert.equal(members[1].userId, "@bob:matrix.org");
    });

    it("parses mixed membership states", () => {
        const events: MatrixEvent[] = [
            {
                type: "m.room.member",
                state_key: "@alice:s",
                content: { membership: "join" },
                sender: "@alice:s",
            },
            {
                type: "m.room.member",
                state_key: "@left:s",
                content: { membership: "leave" },
                sender: "@left:s",
            },
            {
                type: "m.room.member",
                state_key: "@banned:s",
                content: { membership: "ban" },
                sender: "@admin:s",
            },
        ];

        const members = parseMemberEvents(events);
        assert.equal(members.length, 3);
        assert.equal(members[0].membership, "join");
        assert.equal(members[1].membership, "leave");
        assert.equal(members[2].membership, "ban");
    });

    it("skips non-member events", () => {
        const events: MatrixEvent[] = [
            { type: "m.room.name", content: { name: "Test" } },
            {
                type: "m.room.member",
                state_key: "@alice:s",
                content: { membership: "join" },
                sender: "@alice:s",
            },
        ];
        assert.equal(parseMemberEvents(events).length, 1);
    });

    it("skips events without state_key", () => {
        const events: MatrixEvent[] = [
            {
                type: "m.room.member",
                content: { membership: "join" },
                sender: "@alice:s",
            },
        ];
        assert.equal(parseMemberEvents(events).length, 0);
    });

    it("handles empty event list", () => {
        assert.equal(parseMemberEvents([]).length, 0);
    });
});

// ---------------------------------------------------------------------------
// mxidToDid
// ---------------------------------------------------------------------------

describe("mxidToDid", () => {
    it("maps AD4M bridge user to DID", () => {
        assert.equal(mxidToDid("@_ad4m_z6MkAlice:server"), "did:key:z6MkAlice");
    });

    it("maps regular Matrix user to matrix: prefix", () => {
        assert.equal(mxidToDid("@alice:matrix.org"), "matrix:@alice:matrix.org");
    });

    it("handles complex AD4M DID suffix", () => {
        assert.equal(
            mxidToDid("@_ad4m_z6MkhaLF9hXWZ:server.com"),
            "did:key:z6MkhaLF9hXWZ",
        );
    });
});

// ---------------------------------------------------------------------------
// didToMxid
// ---------------------------------------------------------------------------

describe("didToMxid", () => {
    it("maps DID to AD4M bridge user", () => {
        assert.equal(didToMxid("did:key:z6MkAlice", "server"), "@_ad4m_z6MkAlice:server");
    });

    it("maps matrix: prefixed ID back", () => {
        assert.equal(didToMxid("matrix:@alice:matrix.org", "server"), "@alice:matrix.org");
    });

    it("handles unknown DID format", () => {
        const mxid = didToMxid("some:other:did", "server.com");
        assert.ok(mxid.startsWith("@_ad4m_"));
        assert.ok(mxid.endsWith(":server.com"));
    });
});

// ---------------------------------------------------------------------------
// getJoinedMembers / getJoinedMemberDids
// ---------------------------------------------------------------------------

describe("getJoinedMembers", () => {
    const members: RoomMember[] = [
        { userId: "@a:s", membership: "join" },
        { userId: "@b:s", membership: "leave" },
        { userId: "@c:s", membership: "join" },
        { userId: "@d:s", membership: "invite" },
    ];

    it("filters to joined members only", () => {
        const joined = getJoinedMembers(members);
        assert.equal(joined.length, 2);
        assert.equal(joined[0].userId, "@a:s");
        assert.equal(joined[1].userId, "@c:s");
    });
});

describe("getJoinedMemberDids", () => {
    it("returns DIDs for joined members", () => {
        const members: RoomMember[] = [
            { userId: "@_ad4m_z6MkAlice:s", membership: "join", did: "did:key:z6MkAlice" },
            { userId: "@bob:s", membership: "join", did: "matrix:@bob:s" },
            { userId: "@left:s", membership: "leave", did: "matrix:@left:s" },
        ];
        const dids = getJoinedMemberDids(members);
        assert.equal(dids.length, 2);
        assert.ok(dids.includes("did:key:z6MkAlice"));
        assert.ok(dids.includes("matrix:@bob:s"));
    });
});

// ---------------------------------------------------------------------------
// canJoin
// ---------------------------------------------------------------------------

describe("canJoin", () => {
    it("allows anyone in open mode", () => {
        assert.equal(canJoin("@random:s", "open", new Set()), true);
    });

    it("allows invited users in invite-only mode", () => {
        const invited = new Set(["@alice:s"]);
        assert.equal(canJoin("@alice:s", "invite-only", invited), true);
    });

    it("rejects uninvited users in invite-only mode", () => {
        const invited = new Set(["@alice:s"]);
        assert.equal(canJoin("@random:s", "invite-only", invited), false);
    });
});

// ---------------------------------------------------------------------------
// defaultPowerLevels
// ---------------------------------------------------------------------------

describe("defaultPowerLevels", () => {
    it("gives creator PL 100", () => {
        const config = defaultPowerLevels("@admin:s");
        assert.equal(config.users["@admin:s"], 100);
    });

    it("allows anyone to send link triples", () => {
        const config = defaultPowerLevels("@admin:s");
        assert.equal(config.events["dev.ad4m.link.triple"], 0);
    });

    it("requires PL 50 for neighbourhood config", () => {
        const config = defaultPowerLevels("@admin:s");
        assert.equal(config.events["dev.ad4m.neighbourhood.config"], 50);
    });

    it("sets default user PL to 0", () => {
        const config = defaultPowerLevels("@admin:s");
        assert.equal(config.usersDefault, 0);
    });
});

// ---------------------------------------------------------------------------
// buildPowerLevelOverride
// ---------------------------------------------------------------------------

describe("buildPowerLevelOverride", () => {
    it("includes creator as PL 100", () => {
        const override = buildPowerLevelOverride("@admin:s") as any;
        assert.equal(override.users["@admin:s"], 100);
    });

    it("adds additional admins", () => {
        const override = buildPowerLevelOverride("@admin:s", ["@mod:s"]) as any;
        assert.equal(override.users["@admin:s"], 100);
        assert.equal(override.users["@mod:s"], 100);
    });
});
