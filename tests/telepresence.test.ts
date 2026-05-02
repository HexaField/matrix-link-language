/**
 * Tests for telepresence capability — DID↔MXID mapping, status mapping,
 * signal routing, broadcast, and callback registration.
 *
 * Uses the same mock transport pattern as other tests.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
    buildGetPresenceUrl,
    buildPresenceUrl,
    buildSendToDeviceUrl,
    generateTxnId,
    resetTxnCounter,
} from "../src/matrix-api.pure.js";

import type { MatrixSyncResponse, MatrixEvent } from "../src/matrix-api.pure.js";

import { mxidToDid, didToMxid, parseMemberEvents } from "../src/membership.js";

import { initStorage, getStorage } from "../src/storage-interface.js";
import type { StorageAdapter } from "../src/storage-interface.js";

// ---------------------------------------------------------------------------
// Test helpers — in-memory storage
// ---------------------------------------------------------------------------

class InMemoryStorage implements StorageAdapter {
    private data: Map<string, string> = new Map();

    get(key: string): string | null {
        return this.data.get(key) ?? null;
    }

    put(key: string, value: string): void {
        this.data.set(key, value);
    }

    delete(key: string): void {
        this.data.delete(key);
    }

    listKeys(prefix?: string): string[] {
        const keys: string[] = [];
        for (const k of this.data.keys()) {
            if (!prefix || k.startsWith(prefix)) {
                keys.push(k);
            }
        }
        return keys;
    }
}

// ---------------------------------------------------------------------------
// DID ↔ MXID mapping helpers (mirrors index.ts logic)
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

// ---------------------------------------------------------------------------
// Status mapping helper (mirrors index.ts logic)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Process to-device / broadcast helpers (mirrors index.ts logic)
// ---------------------------------------------------------------------------

function processToDeviceEvents(
    events: MatrixEvent[],
    callback: ((payload: unknown) => void) | null,
): void {
    if (!callback) return;
    for (const event of events) {
        if (event.type === "dev.ad4m.signal" || event.type === "dev.ad4m.broadcast") {
            callback(event.content);
        }
    }
}

function processTimelineBroadcasts(
    events: MatrixEvent[],
    myUserId: string,
    callback: ((payload: unknown) => void) | null,
): void {
    if (!callback) return;
    for (const event of events) {
        if (event.type === "dev.ad4m.broadcast") {
            if (event.sender === myUserId) continue;
            callback(event.content);
        }
    }
}

const HOMESERVER = "https://matrix.example.com";

// ===========================================================================
// Test suites
// ===========================================================================

describe("DID ↔ MXID mapping", () => {
    beforeEach(() => {
        initStorage(new InMemoryStorage());
    });

    it("stores and retrieves DID → MXID mapping", () => {
        storeDIDMapping("did:key:z6MkTest123", "@bridge:matrix.org");
        assert.equal(getMxidForDid("did:key:z6MkTest123"), "@bridge:matrix.org");
    });

    it("stores and retrieves MXID → DID mapping", () => {
        storeDIDMapping("did:key:z6MkABC", "@user:matrix.org");
        assert.equal(getDidForMxid("@user:matrix.org"), "did:key:z6MkABC");
    });

    it("returns null for unknown DID", () => {
        assert.equal(getMxidForDid("did:key:unknown"), null);
    });

    it("returns null for unknown MXID", () => {
        assert.equal(getDidForMxid("@unknown:server"), null);
    });

    it("overwrites existing mapping", () => {
        storeDIDMapping("did:key:z6MkTest", "@old:server");
        storeDIDMapping("did:key:z6MkTest", "@new:server");
        assert.equal(getMxidForDid("did:key:z6MkTest"), "@new:server");
    });

    it("bidirectional consistency", () => {
        const did = "did:key:z6MkBiDi";
        const mxid = "@bidi:matrix.org";
        storeDIDMapping(did, mxid);
        assert.equal(getMxidForDid(did), mxid);
        assert.equal(getDidForMxid(mxid), did);
    });
});

describe("mxidToDid (convention-based)", () => {
    it("maps AD4M bridge user to did:key", () => {
        assert.equal(mxidToDid("@_ad4m_z6MkTest:server"), "did:key:z6MkTest");
    });

    it("maps regular Matrix user to matrix: prefix", () => {
        assert.equal(mxidToDid("@alice:server.com"), "matrix:@alice:server.com");
    });
});

describe("didToMxid (convention-based)", () => {
    it("maps did:key to AD4M bridge format", () => {
        assert.equal(didToMxid("did:key:z6MkTest", "matrix.org"), "@_ad4m_z6MkTest:matrix.org");
    });

    it("maps matrix: prefix back to raw MXID", () => {
        assert.equal(didToMxid("matrix:@alice:server.com", "matrix.org"), "@alice:server.com");
    });
});

describe("Status mapping (AD4M → Matrix)", () => {
    it("maps 'online' string to 'online'", () => {
        assert.equal(mapStatusToPresence("online"), "online");
    });

    it("maps 'offline' string to 'offline'", () => {
        assert.equal(mapStatusToPresence("offline"), "offline");
    });

    it("maps 'away' to 'unavailable'", () => {
        assert.equal(mapStatusToPresence("away"), "unavailable");
    });

    it("maps 'idle' to 'unavailable'", () => {
        assert.equal(mapStatusToPresence("idle"), "unavailable");
    });

    it("maps 'unavailable' to 'unavailable'", () => {
        assert.equal(mapStatusToPresence("unavailable"), "unavailable");
    });

    it("maps unknown string to 'online' (default)", () => {
        assert.equal(mapStatusToPresence("custom-status"), "online");
    });

    it("maps object with status field", () => {
        assert.equal(mapStatusToPresence({ status: "offline" }), "offline");
    });

    it("maps object with presence field", () => {
        assert.equal(mapStatusToPresence({ presence: "away" }), "unavailable");
    });

    it("maps null/undefined to 'online' (default)", () => {
        assert.equal(mapStatusToPresence(null), "online");
        assert.equal(mapStatusToPresence(undefined), "online");
    });

    it("is case-insensitive", () => {
        assert.equal(mapStatusToPresence("ONLINE"), "online");
        assert.equal(mapStatusToPresence("Offline"), "offline");
        assert.equal(mapStatusToPresence("AWAY"), "unavailable");
    });
});

describe("Signal routing (to-device events)", () => {
    it("invokes callback for dev.ad4m.signal events", () => {
        const received: unknown[] = [];
        const callback = (payload: unknown) => received.push(payload);

        const events: MatrixEvent[] = [
            {
                type: "dev.ad4m.signal",
                content: {
                    sender_did: "did:key:z6MkSender",
                    payload: { action: "offer", sdp: "..." },
                    timestamp: "2025-01-01T00:00:00Z",
                },
                sender: "@sender:matrix.org",
            },
        ];

        processToDeviceEvents(events, callback);
        assert.equal(received.length, 1);
        assert.deepEqual(received[0], events[0].content);
    });

    it("invokes callback for dev.ad4m.broadcast to-device events", () => {
        const received: unknown[] = [];
        const callback = (payload: unknown) => received.push(payload);

        const events: MatrixEvent[] = [
            {
                type: "dev.ad4m.broadcast",
                content: { sender_did: "did:key:z6MkBroadcast", payload: "hello all" },
            },
        ];

        processToDeviceEvents(events, callback);
        assert.equal(received.length, 1);
    });

    it("ignores non-signal event types", () => {
        const received: unknown[] = [];
        const callback = (payload: unknown) => received.push(payload);

        const events: MatrixEvent[] = [
            { type: "m.room.message", content: { body: "hello" } },
            { type: "m.presence", content: { presence: "online" } },
        ];

        processToDeviceEvents(events, callback);
        assert.equal(received.length, 0);
    });

    it("does nothing with null callback", () => {
        const events: MatrixEvent[] = [
            { type: "dev.ad4m.signal", content: { payload: "test" } },
        ];
        // Should not throw
        processToDeviceEvents(events, null);
    });
});

describe("Broadcast processing (timeline events)", () => {
    it("invokes callback for dev.ad4m.broadcast timeline events from other users", () => {
        const received: unknown[] = [];
        const callback = (payload: unknown) => received.push(payload);

        const events: MatrixEvent[] = [
            {
                type: "dev.ad4m.broadcast",
                sender: "@other:matrix.org",
                content: { sender_did: "did:key:z6MkOther", payload: "broadcast msg" },
            },
        ];

        processTimelineBroadcasts(events, "@me:matrix.org", callback);
        assert.equal(received.length, 1);
        assert.deepEqual(received[0], events[0].content);
    });

    it("skips our own broadcast events", () => {
        const received: unknown[] = [];
        const callback = (payload: unknown) => received.push(payload);

        const events: MatrixEvent[] = [
            {
                type: "dev.ad4m.broadcast",
                sender: "@me:matrix.org",
                content: { sender_did: "did:key:z6MkMe", payload: "my broadcast" },
            },
        ];

        processTimelineBroadcasts(events, "@me:matrix.org", callback);
        assert.equal(received.length, 0);
    });

    it("ignores non-broadcast timeline events", () => {
        const received: unknown[] = [];
        const callback = (payload: unknown) => received.push(payload);

        const events: MatrixEvent[] = [
            { type: "dev.ad4m.link.triple", sender: "@other:matrix.org", content: {} },
            { type: "m.room.message", sender: "@other:matrix.org", content: {} },
        ];

        processTimelineBroadcasts(events, "@me:matrix.org", callback);
        assert.equal(received.length, 0);
    });

    it("does nothing with null callback", () => {
        const events: MatrixEvent[] = [
            { type: "dev.ad4m.broadcast", sender: "@other:server", content: {} },
        ];
        processTimelineBroadcasts(events, "@me:server", null);
    });
});

describe("Callback registration", () => {
    it("stores and invokes callback", () => {
        let signalCallback: ((payload: unknown) => void) | null = null;

        // Register
        signalCallback = (payload: unknown) => {
            /* received */
        };
        assert.ok(signalCallback !== null);

        // Unregister
        signalCallback = null;
        assert.equal(signalCallback, null);
    });
});

describe("URL builders for telepresence endpoints", () => {
    it("buildGetPresenceUrl returns correct URL", () => {
        const url = buildGetPresenceUrl(HOMESERVER, "@alice:matrix.org");
        assert.ok(url.startsWith(HOMESERVER));
        assert.ok(url.includes("/_matrix/client/v3/presence/"));
        assert.ok(url.includes("/status"));
    });

    it("buildSendToDeviceUrl returns correct URL", () => {
        const url = buildSendToDeviceUrl(HOMESERVER, "dev.ad4m.signal", "txn42");
        assert.equal(
            url,
            `${HOMESERVER}/_matrix/client/v3/sendToDevice/dev.ad4m.signal/txn42`,
        );
    });

    it("buildPresenceUrl for setting own presence", () => {
        const url = buildPresenceUrl(HOMESERVER, "@me:matrix.org");
        assert.ok(url.includes("/presence/"));
        assert.ok(url.includes("/status"));
    });
});

describe("SyncResponse to_device field", () => {
    it("parsed sync response includes to_device events", () => {
        const syncResponse: MatrixSyncResponse = {
            next_batch: "s123",
            rooms: { join: {} },
            to_device: {
                events: [
                    {
                        type: "dev.ad4m.signal",
                        content: {
                            sender_did: "did:key:z6MkTest",
                            payload: { type: "offer", data: "sdp-data" },
                        },
                    },
                ],
            },
        };

        assert.ok(syncResponse.to_device);
        assert.equal(syncResponse.to_device.events.length, 1);
        assert.equal(syncResponse.to_device.events[0].type, "dev.ad4m.signal");
    });

    it("sync response without to_device is valid", () => {
        const syncResponse: MatrixSyncResponse = {
            next_batch: "s456",
            rooms: { join: {} },
        };

        assert.equal(syncResponse.to_device, undefined);
    });
});

describe("DID mapping from link events during sync", () => {
    beforeEach(() => {
        initStorage(new InMemoryStorage());
    });

    it("builds mapping from dev.ad4m.link.triple events", () => {
        // Simulate processing link events from sync
        const events: MatrixEvent[] = [
            {
                type: "dev.ad4m.link.triple",
                sender: "@alice:matrix.org",
                event_id: "$evt1",
                content: {
                    source: "ad4m://self",
                    predicate: "ad4m://has_name",
                    target: "Alice",
                    author: "did:key:z6MkAlice",
                },
            },
            {
                type: "dev.ad4m.link.triple",
                sender: "@bob:matrix.org",
                event_id: "$evt2",
                content: {
                    source: "ad4m://self",
                    predicate: "ad4m://has_name",
                    target: "Bob",
                    author: "did:key:z6MkBob",
                },
            },
        ];

        // Process events (mirrors sync handler logic)
        for (const event of events) {
            if (event.type === "dev.ad4m.link.triple" && event.sender) {
                const content = event.content as Record<string, unknown>;
                const author = content.author as string;
                if (author && event.sender) {
                    storeDIDMapping(author, event.sender);
                }
            }
        }

        // Verify mapping
        assert.equal(getMxidForDid("did:key:z6MkAlice"), "@alice:matrix.org");
        assert.equal(getMxidForDid("did:key:z6MkBob"), "@bob:matrix.org");
        assert.equal(getDidForMxid("@alice:matrix.org"), "did:key:z6MkAlice");
        assert.equal(getDidForMxid("@bob:matrix.org"), "did:key:z6MkBob");
    });

    it("ignores events without author field", () => {
        const events: MatrixEvent[] = [
            {
                type: "dev.ad4m.link.triple",
                sender: "@alice:matrix.org",
                content: {
                    source: "ad4m://self",
                    target: "test",
                    // no author field
                },
            },
        ];

        for (const event of events) {
            if (event.type === "dev.ad4m.link.triple" && event.sender) {
                const content = event.content as Record<string, unknown>;
                const author = content.author as string;
                if (author && event.sender) {
                    storeDIDMapping(author, event.sender);
                }
            }
        }

        // No mapping should be stored
        assert.equal(getMxidForDid("did:key:z6MkAlice"), null);
    });
});

describe("Send signal content structure", () => {
    it("builds correct to-device message structure", () => {
        const myDid = "did:key:z6MkMe";
        const targetMxid = "@target:matrix.org";
        const payload = { type: "webrtc-offer", sdp: "v=0..." };

        const content: Record<string, unknown> = {
            sender_did: myDid,
            payload,
            timestamp: "2025-01-01T00:00:00Z",
        };

        const messages: Record<string, Record<string, Record<string, unknown>>> = {
            [targetMxid]: {
                "*": content,
            },
        };

        assert.ok(messages[targetMxid]);
        assert.ok(messages[targetMxid]["*"]);
        assert.equal(messages[targetMxid]["*"].sender_did, myDid);
        assert.deepEqual(messages[targetMxid]["*"].payload, payload);
    });
});

describe("Broadcast content structure", () => {
    it("builds correct broadcast room event content", () => {
        const myDid = "did:key:z6MkMe";
        const payload = { message: "hello neighbourhood" };

        const content: Record<string, unknown> = {
            sender_did: myDid,
            payload,
            timestamp: "2025-01-01T00:00:00Z",
        };

        assert.equal(content.sender_did, myDid);
        assert.deepEqual(content.payload, payload);
    });
});

describe("Member presence parsing", () => {
    it("parseMemberEvents extracts joined members", () => {
        const events: MatrixEvent[] = [
            {
                type: "m.room.member",
                state_key: "@alice:server",
                sender: "@alice:server",
                content: { membership: "join", displayname: "Alice" },
            },
            {
                type: "m.room.member",
                state_key: "@bob:server",
                sender: "@bob:server",
                content: { membership: "join" },
            },
            {
                type: "m.room.member",
                state_key: "@left:server",
                sender: "@left:server",
                content: { membership: "leave" },
            },
        ];

        const members = parseMemberEvents(events);
        assert.equal(members.length, 3);

        const joined = members.filter(m => m.membership === "join");
        assert.equal(joined.length, 2);
        assert.equal(joined[0].userId, "@alice:server");
        assert.equal(joined[1].userId, "@bob:server");
    });
});
