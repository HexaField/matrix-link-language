/**
 * Tests for Matrix Client-Server API request/response builders.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    buildLoginRequest,
    buildSyncUrl,
    buildSendEventUrl,
    buildRedactUrl,
    buildStateUrl,
    buildJoinUrl,
    buildInviteUrl,
    buildMembersUrl,
    buildMessagesUrl,
    buildTypingUrl,
    buildPresenceUrl,
    buildAuthHeaders,
    buildDefaultFilter,
    parseLoginResponse,
    parseSyncResponse,
    parseMessagesResponse,
    extractRoomTimeline,
    extractRoomState,
    extractPrevBatch,
    generateTxnId,
    resetTxnCounter,
} from "../src/matrix-api.pure.js";

import type { MatrixSyncResponse, MatrixEvent } from "../src/matrix-api.pure.js";

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

describe("buildSyncUrl", () => {
    it("builds URL without since token", () => {
        const url = buildSyncUrl(HOMESERVER);
        assert.ok(url.startsWith(`${HOMESERVER}/_matrix/client/v3/sync?`));
        assert.ok(url.includes("timeout=30000"));
        assert.ok(!url.includes("since="));
    });

    it("includes since token when provided", () => {
        const url = buildSyncUrl(HOMESERVER, "s12345");
        assert.ok(url.includes("since=s12345"));
    });

    it("uses custom timeout", () => {
        const url = buildSyncUrl(HOMESERVER, undefined, 5000);
        assert.ok(url.includes("timeout=5000"));
    });

    it("includes filter when provided", () => {
        const url = buildSyncUrl(HOMESERVER, undefined, 30000, "myfilter");
        assert.ok(url.includes("filter=myfilter"));
    });
});

describe("buildSendEventUrl", () => {
    it("builds correct URL", () => {
        const url = buildSendEventUrl(HOMESERVER, "!room:server", "dev.ad4m.link.triple", "txn1");
        assert.ok(url.includes("/_matrix/client/v3/rooms/"));
        assert.ok(url.includes("/send/"));
        assert.ok(url.includes("dev.ad4m.link.triple"));
        assert.ok(url.includes("txn1"));
    });

    it("encodes special characters in room ID", () => {
        const url = buildSendEventUrl(HOMESERVER, "!abc:server.com", "m.room.message", "txn");
        assert.ok(url.includes(encodeURIComponent("!abc:server.com")));
    });
});

describe("buildRedactUrl", () => {
    it("builds correct redaction URL", () => {
        const url = buildRedactUrl(HOMESERVER, "!room:s", "$evt:s", "txn1");
        assert.ok(url.includes("/redact/"));
        assert.ok(url.includes("txn1"));
    });
});

describe("buildStateUrl", () => {
    it("builds URL with event type and state key", () => {
        const url = buildStateUrl(HOMESERVER, "!room:s", "m.room.name", "");
        assert.ok(url.includes("/state/"));
        assert.ok(url.includes("m.room.name"));
    });
});

describe("buildJoinUrl", () => {
    it("builds join URL", () => {
        const url = buildJoinUrl(HOMESERVER, "#room:server");
        assert.ok(url.includes("/_matrix/client/v3/join/"));
    });
});

describe("buildInviteUrl", () => {
    it("builds invite URL", () => {
        const url = buildInviteUrl(HOMESERVER, "!room:s");
        assert.ok(url.includes("/invite"));
    });
});

describe("buildMembersUrl", () => {
    it("builds members URL", () => {
        const url = buildMembersUrl(HOMESERVER, "!room:s");
        assert.ok(url.includes("/members"));
    });
});

describe("buildMessagesUrl", () => {
    it("builds messages URL with pagination params", () => {
        const url = buildMessagesUrl(HOMESERVER, "!room:s", "s123", "b", 50);
        assert.ok(url.includes("/messages?"));
        assert.ok(url.includes("from=s123"));
        assert.ok(url.includes("dir=b"));
        assert.ok(url.includes("limit=50"));
    });

    it("uses default direction and limit", () => {
        const url = buildMessagesUrl(HOMESERVER, "!room:s", "s123");
        assert.ok(url.includes("dir=b"));
        assert.ok(url.includes("limit=100"));
    });
});

describe("buildTypingUrl", () => {
    it("builds typing URL", () => {
        const url = buildTypingUrl(HOMESERVER, "!room:s", "@user:s");
        assert.ok(url.includes("/typing/"));
    });
});

describe("buildPresenceUrl", () => {
    it("builds presence URL", () => {
        const url = buildPresenceUrl(HOMESERVER, "@user:s");
        assert.ok(url.includes("/presence/"));
        assert.ok(url.includes("/status"));
    });
});

describe("buildAuthHeaders", () => {
    it("produces Bearer auth header", () => {
        const headers = buildAuthHeaders("mytoken123");
        assert.equal(headers["Authorization"], "Bearer mytoken123");
        assert.equal(headers["Content-Type"], "application/json");
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
        resetTxnCounter();
        const id1 = generateTxnId();
        const id2 = generateTxnId();
        assert.notEqual(id1, id2);
    });

    it("has ad4m prefix", () => {
        const id = generateTxnId();
        assert.ok(id.startsWith("ad4m-"));
    });
});
