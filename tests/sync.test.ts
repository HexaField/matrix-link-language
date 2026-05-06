/**
 * Tests for sync token management and event deduplication.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter, RuntimeAdapter } from "../src/adapters.js";
import { initStorage, initRuntime } from "../src/adapters.js";
import * as store from "../src/store.js";
import {
    getSinceToken,
    setSinceToken,
    getPrevBatchToken,
    setPrevBatchToken,
    isEventProcessed,
    markEventProcessed,
    processSyncResponse,
    processBackfillEvents,
    extractMembersFromState,
} from "../src/sync.js";
import type { MatrixSyncResponse, MatrixEvent } from "../src/api.js";

// ---------------------------------------------------------------------------
// Mock Adapters
// ---------------------------------------------------------------------------

class MockStorage implements StorageAdapter {
    private data = new Map<string, string>();
    get(key: string): string | null { return this.data.get(key) ?? null; }
    put(key: string, value: string): void { this.data.set(key, value); }
    delete(key: string): void { this.data.delete(key); }
    listKeys(prefix?: string): string[] {
        return [...this.data.keys()].filter(k => !prefix || k.startsWith(prefix));
    }
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

class MockRuntime implements RuntimeAdapter {
    hash(data: string): string { return simpleHash(data); }
    emitSignal(_data: string): void {}
    emitPerspectiveDiff(_diff: unknown): void {}
}

function setup(): void {
    initStorage(new MockStorage());
    initRuntime(new MockRuntime());
    store.initStore(simpleHash);
}

// ---------------------------------------------------------------------------
// Since token management
// ---------------------------------------------------------------------------

describe("Since token management", () => {
    beforeEach(setup);

    it("returns null when no token stored", () => {
        assert.equal(getSinceToken(), null);
    });

    it("stores and retrieves since token", () => {
        setSinceToken("s123456_789");
        assert.equal(getSinceToken(), "s123456_789");
    });

    it("updates since token", () => {
        setSinceToken("s111");
        setSinceToken("s222");
        assert.equal(getSinceToken(), "s222");
    });
});

describe("Prev batch token management", () => {
    beforeEach(setup);

    it("returns null when no token stored", () => {
        assert.equal(getPrevBatchToken(), null);
    });

    it("stores and retrieves prev batch token", () => {
        setPrevBatchToken("p123");
        assert.equal(getPrevBatchToken(), "p123");
    });
});

// ---------------------------------------------------------------------------
// Event deduplication
// ---------------------------------------------------------------------------

describe("Event deduplication", () => {
    beforeEach(setup);

    it("returns false for unprocessed events", () => {
        assert.equal(isEventProcessed("$new-event:server"), false);
    });

    it("returns true for processed events", () => {
        markEventProcessed("$evt:server");
        assert.equal(isEventProcessed("$evt:server"), true);
    });

    it("handles multiple events", () => {
        markEventProcessed("$evt1:s");
        markEventProcessed("$evt2:s");
        assert.equal(isEventProcessed("$evt1:s"), true);
        assert.equal(isEventProcessed("$evt2:s"), true);
        assert.equal(isEventProcessed("$evt3:s"), false);
    });
});

// ---------------------------------------------------------------------------
// processSyncResponse
// ---------------------------------------------------------------------------

describe("processSyncResponse", () => {
    beforeEach(setup);

    const ROOM_ID = "!room:server";
    const NEIGHBOURHOOD = "neighbourhood://!room:server";

    it("processes timeline events into links", () => {
        const syncResp: MatrixSyncResponse = {
            next_batch: "s100",
            rooms: {
                join: {
                    [ROOM_ID]: {
                        timeline: {
                            events: [
                                {
                                    type: "dev.ad4m.link.triple",
                                    event_id: "$e1:s",
                                    sender: "@alice:s",
                                    origin_server_ts: 1746144000000,
                                    content: {
                                        source: "channel://main",
                                        predicate: "flux://has_message",
                                        target: "expr://msg1",
                                        author: "did:key:z6MkAlice",
                                        timestamp: "2026-05-02T00:00:00.000Z",
                                        proof: { signature: "sig", key: "key" },
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        };

        const diff = processSyncResponse(syncResp, ROOM_ID, NEIGHBOURHOOD);
        assert.equal(diff.additions.length, 1);
        assert.equal(diff.additions[0].data.source, "channel://main");
        assert.equal(diff.removals.length, 0);
    });

    it("updates since token", () => {
        const syncResp: MatrixSyncResponse = {
            next_batch: "s200",
            rooms: { join: { [ROOM_ID]: { timeline: { events: [] } } } },
        };

        processSyncResponse(syncResp, ROOM_ID, NEIGHBOURHOOD);
        assert.equal(getSinceToken(), "s200");
    });

    it("deduplicates events", () => {
        const event: MatrixEvent = {
            type: "dev.ad4m.link.triple",
            event_id: "$dup:s",
            sender: "@a:s",
            origin_server_ts: 1746144000000,
            content: {
                source: "a", predicate: "b", target: "c",
                author: "did:key:z6Mk", timestamp: "2026-05-02T00:00:00.000Z",
                proof: { signature: "", key: "" },
            },
        };

        const syncResp1: MatrixSyncResponse = {
            next_batch: "s1",
            rooms: { join: { [ROOM_ID]: { timeline: { events: [event] } } } },
        };
        const syncResp2: MatrixSyncResponse = {
            next_batch: "s2",
            rooms: { join: { [ROOM_ID]: { timeline: { events: [event] } } } },
        };

        const diff1 = processSyncResponse(syncResp1, ROOM_ID, NEIGHBOURHOOD);
        const diff2 = processSyncResponse(syncResp2, ROOM_ID, NEIGHBOURHOOD);

        assert.equal(diff1.additions.length, 1);
        assert.equal(diff2.additions.length, 0); // deduped
    });

    it("skips own events (echo suppression)", () => {
        const bridgeUserId = "@bridge:server";
        const syncResp: MatrixSyncResponse = {
            next_batch: "s1",
            rooms: {
                join: {
                    [ROOM_ID]: {
                        timeline: {
                            events: [
                                {
                                    type: "dev.ad4m.link.triple",
                                    event_id: "$own:s",
                                    sender: bridgeUserId,
                                    origin_server_ts: 1746144000000,
                                    content: {
                                        source: "a", predicate: "b", target: "c",
                                        author: "did:key:z6Mk", timestamp: "2026-05-02T00:00:00.000Z",
                                        proof: { signature: "", key: "" },
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        };

        const diff = processSyncResponse(syncResp, ROOM_ID, NEIGHBOURHOOD, bridgeUserId);
        assert.equal(diff.additions.length, 0);
    });

    it("processes redactions as removals", () => {
        const syncResp: MatrixSyncResponse = {
            next_batch: "s1",
            rooms: {
                join: {
                    [ROOM_ID]: {
                        timeline: {
                            events: [
                                {
                                    type: "m.room.redaction",
                                    event_id: "$redact:s",
                                    sender: "@admin:s",
                                    origin_server_ts: 1746144000000,
                                    content: {},
                                    redacts: "$target-evt:s",
                                },
                            ],
                        },
                    },
                },
            },
        };

        const diff = processSyncResponse(syncResp, ROOM_ID, NEIGHBOURHOOD);
        assert.equal(diff.removals.length, 1);
        assert.equal(diff.removals[0].data.target, "$target-evt:s");
    });

    it("returns empty diff for empty timeline", () => {
        const syncResp: MatrixSyncResponse = {
            next_batch: "s1",
            rooms: { join: { [ROOM_ID]: { timeline: { events: [] } } } },
        };
        const diff = processSyncResponse(syncResp, ROOM_ID, NEIGHBOURHOOD);
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });

    it("stores prev_batch token", () => {
        const syncResp: MatrixSyncResponse = {
            next_batch: "s2",
            rooms: {
                join: {
                    [ROOM_ID]: {
                        timeline: { events: [], prev_batch: "p1" },
                    },
                },
            },
        };
        processSyncResponse(syncResp, ROOM_ID, NEIGHBOURHOOD);
        assert.equal(getPrevBatchToken(), "p1");
    });
});

// ---------------------------------------------------------------------------
// processBackfillEvents
// ---------------------------------------------------------------------------

describe("processBackfillEvents", () => {
    beforeEach(setup);

    const NEIGHBOURHOOD = "neighbourhood://!room:server";

    it("processes backfill events into links", () => {
        const events: MatrixEvent[] = [
            {
                type: "dev.ad4m.link.triple",
                event_id: "$bf1:s",
                sender: "@alice:s",
                origin_server_ts: 1746000000000,
                content: {
                    source: "a", predicate: "b", target: "c",
                    author: "did:key:z6MkAlice", timestamp: "2026-05-01T00:00:00.000Z",
                    proof: { signature: "", key: "" },
                },
            },
            {
                type: "m.room.message",
                event_id: "$bf2:s",
                sender: "@bob:s",
                origin_server_ts: 1746001000000,
                content: { msgtype: "m.text", body: "Hello from backfill" },
            },
        ];

        const diff = processBackfillEvents(events, NEIGHBOURHOOD);
        assert.equal(diff.additions.length, 2);
    });

    it("deduplicates with previously processed events", () => {
        markEventProcessed("$already:s");
        const events: MatrixEvent[] = [
            {
                type: "m.room.message",
                event_id: "$already:s",
                sender: "@a:s",
                origin_server_ts: 1746000000000,
                content: { msgtype: "m.text", body: "old" },
            },
        ];
        const diff = processBackfillEvents(events, NEIGHBOURHOOD);
        assert.equal(diff.additions.length, 0);
    });
});

// ---------------------------------------------------------------------------
// extractMembersFromState
// ---------------------------------------------------------------------------

describe("extractMembersFromState", () => {
    beforeEach(setup);

    it("extracts joined members from state events", () => {
        const syncResp: MatrixSyncResponse = {
            next_batch: "s1",
            rooms: {
                join: {
                    "!room:s": {
                        state: {
                            events: [
                                {
                                    type: "m.room.member",
                                    state_key: "@alice:s",
                                    content: { membership: "join" },
                                    sender: "@alice:s",
                                },
                                {
                                    type: "m.room.member",
                                    state_key: "@bob:s",
                                    content: { membership: "join" },
                                    sender: "@bob:s",
                                },
                                {
                                    type: "m.room.member",
                                    state_key: "@left:s",
                                    content: { membership: "leave" },
                                    sender: "@left:s",
                                },
                            ],
                        },
                    },
                },
            },
        };

        const members = extractMembersFromState(syncResp, "!room:s");
        assert.equal(members.length, 2);
        assert.ok(members.includes("@alice:s"));
        assert.ok(members.includes("@bob:s"));
    });

    it("returns empty for no state", () => {
        const syncResp: MatrixSyncResponse = { next_batch: "s1" };
        assert.equal(extractMembersFromState(syncResp, "!room:s").length, 0);
    });
});
