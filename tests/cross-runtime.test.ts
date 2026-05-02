/**
 * Cross-runtime test harness.
 *
 * Exercises the full production modules using mock adapters that
 * simulate an alternative runtime. Proves that the core logic has
 * NO hidden dependency on ad4m:host.
 *
 * Test scenarios:
 * 1. Store links via mock storage, query them back, verify indexes
 * 2. Process sync responses with mock storage
 * 3. Translate links to Matrix events and back (round-trip)
 * 4. Full pipeline: link → event → back → verify
 * 5. Settings parsing
 * 6. Dual-language federation filter
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Adapter interfaces
import type { StorageAdapter } from "../src/storage-interface.js";
import { initStorage } from "../src/storage-interface.js";
import type { Transport, TransportResponse } from "../src/transport.js";
import { initTransport } from "../src/transport.js";
import type { SigningAdapter } from "../src/signing-interface.js";
import { initSigning } from "../src/signing-interface.js";
import type { RuntimeAdapter } from "../src/runtime-interface.js";
import { initRuntime } from "../src/runtime-interface.js";

// Production modules under test
import * as store from "../src/store.js";
import { diffToEvents, eventsToLinks, linkToTripleContent, linkContentKey } from "../src/translate.js";
import { processSyncResponse, getSinceToken } from "../src/sync.js";
import { shouldFederate, linkOriginKey } from "../src/dual-language.js";
import { parseSettings, DEFAULT_SETTINGS } from "../src/settings.js";
import { parseMemberEvents, mxidToDid } from "../src/membership.js";
import { detectPattern } from "../src/sdna.js";
import { renderLinkAsText, renderLinkAsHtml } from "../src/rendering.pure.js";

// Types
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";
import type { MatrixSyncResponse, MatrixEvent } from "../src/matrix-api.pure.js";

// ---------------------------------------------------------------------------
// Mock Adapters
// ---------------------------------------------------------------------------

class MockStorageAdapter implements StorageAdapter {
    private data = new Map<string, string>();

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
        return [...this.data.keys()].filter(k => !prefix || k.startsWith(prefix));
    }

    _dump(): Map<string, string> {
        return new Map(this.data);
    }

    _clear(): void {
        this.data.clear();
    }
}

class MockTransport implements Transport {
    public requests: { url: string; method: string; headers: Record<string, string>; body: string }[] = [];
    private responses = new Map<string, TransportResponse>();

    addResponse(url: string, response: TransportResponse): void {
        this.responses.set(url, response);
    }

    async fetch(url: string, method: string, headers: Record<string, string>, body: string): Promise<TransportResponse> {
        this.requests.push({ url, method, headers, body });
        return this.responses.get(url) || { status: 404, headers: {}, body: "Not found" };
    }
}

class MockSigningAdapter implements SigningAdapter {
    signStringHex(payload: string): string {
        return "mocksig" + payload.length.toString(16);
    }
    signingKeyId(): string {
        return "mock-key-id";
    }
}

class MockRuntime implements RuntimeAdapter {
    public signals: string[] = [];
    public diffs: unknown[] = [];

    hash(data: string): string {
        return simpleHash(data);
    }

    emitSignal(data: string): void {
        this.signals.push(data);
    }

    emitPerspectiveDiff(diff: unknown): void {
        this.diffs.push(diff);
    }
}

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOM_ID = "!testroom:matrix.example.com";
const NEIGHBOURHOOD_URL = `neighbourhood://${ROOM_ID}`;

function makeLink(overrides?: Partial<LinkExpression>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "channel://main",
            target: "expr://msg-001",
            predicate: "flux://has_message",
        },
        proof: {
            signature: "abc123",
            key: "key123",
        },
        ...overrides,
    };
}

function makeChatLink(index: number = 1): LinkExpression {
    return makeLink({
        data: {
            source: "channel://main",
            target: `expr://msg-${index.toString().padStart(3, "0")}`,
            predicate: "flux://has_message",
        },
    });
}

let mockStorage: MockStorageAdapter;
let mockTransport: MockTransport;
let mockRuntime: MockRuntime;

function initAllAdapters(): void {
    mockStorage = new MockStorageAdapter();
    mockTransport = new MockTransport();
    mockRuntime = new MockRuntime();

    initRuntime(mockRuntime);
    initStorage(mockStorage);
    initTransport(mockTransport);
    initSigning(new MockSigningAdapter());
    store.initStore(simpleHash);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Store operations via mock storage
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Store operations", () => {
    beforeEach(initAllAdapters);

    it("stores and retrieves a link", () => {
        const link = makeLink();
        const hash = store.putLink(link);
        assert.ok(hash);

        const retrieved = store.getLink(hash);
        assert.ok(retrieved);
        assert.equal(retrieved!.data.source, "channel://main");
        assert.equal(retrieved!.data.target, "expr://msg-001");
    });

    it("indexes by source, target, and predicate", () => {
        store.putLink(makeLink());

        assert.equal(store.queryLinks({ source: "channel://main" }).length, 1);
        assert.equal(store.queryLinks({ target: "expr://msg-001" }).length, 1);
        assert.equal(store.queryLinks({ predicate: "flux://has_message" }).length, 1);
    });

    it("returns empty for queries with no matches", () => {
        store.putLink(makeLink());
        assert.equal(store.queryLinks({ source: "nonexistent://uri" }).length, 0);
    });

    it("supports multi-field query filtering", () => {
        store.putLink(makeLink());
        store.putLink(makeLink({
            data: { source: "channel://main", target: "other://target", predicate: "other://pred" },
        }));

        const results = store.queryLinks({ source: "channel://main", predicate: "flux://has_message" });
        assert.equal(results.length, 1);
        assert.equal(results[0].data.target, "expr://msg-001");
    });

    it("removes links and cleans up indexes", () => {
        const link = makeLink();
        const hash = store.putLink(link);
        assert.ok(store.getLink(hash));

        store.removeLink(link);
        assert.equal(store.getLink(hash), null);
        assert.equal(store.queryLinks({ source: "channel://main" }).length, 0);
    });

    it("applies a PerspectiveDiff", () => {
        const link1 = makeLink();
        const link2 = makeLink({
            data: { source: "a", target: "b", predicate: "c" },
        });

        store.putLink(link1);

        const diff: PerspectiveDiff = {
            additions: [link2],
            removals: [link1],
        };
        store.applyDiff(diff);

        assert.equal(store.getLink(store.hashLink(link1)), null);
        assert.ok(store.getLink(store.hashLink(link2)));
    });

    it("allLinks returns all stored links", () => {
        store.putLink(makeLink());
        store.putLink(makeLink({
            data: { source: "x", target: "y", predicate: "z" },
            timestamp: "2026-05-02T01:00:00.000Z",
        }));
        assert.equal(store.allLinks().links.length, 2);
    });

    it("manages revision tracking", () => {
        assert.equal(store.getRevision(), null);
        store.setRevision("s42");
        assert.equal(store.getRevision(), "s42");
    });

    it("manages event-to-link mapping", () => {
        store.mapEventToLink("$evt1:s", "QmHash1");
        assert.equal(store.getLinkHashByEventId("$evt1:s"), "QmHash1");
        assert.equal(store.getLinkHashByEventId("$unknown:s"), null);
    });

    it("manages peers", () => {
        store.setPeer("did:key:z6MkA", { name: "Alice" });
        store.setPeer("did:key:z6MkB", { name: "Bob" });

        assert.equal(store.listPeers().length, 2);

        const meta = store.getPeerMetadata("did:key:z6MkA");
        assert.ok(meta);
        assert.equal(meta!.name, "Alice");

        store.removePeer("did:key:z6MkA");
        assert.equal(store.listPeers().length, 1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Sync processing via mock storage
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Sync processing", () => {
    beforeEach(initAllAdapters);

    it("processes sync response and stores links", () => {
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
                                {
                                    type: "m.room.message",
                                    event_id: "$e2:s",
                                    sender: "@bob:matrix.org",
                                    origin_server_ts: 1746144001000,
                                    content: {
                                        msgtype: "m.text",
                                        body: "Hello from Matrix!",
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        };

        const diff = processSyncResponse(syncResp, ROOM_ID, NEIGHBOURHOOD_URL);
        assert.equal(diff.additions.length, 2);

        // Verify links are in store
        assert.equal(store.allLinks().links.length, 2);

        // Verify since token
        assert.equal(getSinceToken(), "s100");
    });

    it("handles mixed events including redactions", () => {
        const syncResp: MatrixSyncResponse = {
            next_batch: "s200",
            rooms: {
                join: {
                    [ROOM_ID]: {
                        timeline: {
                            events: [
                                {
                                    type: "dev.ad4m.link.triple",
                                    event_id: "$e1:s",
                                    sender: "@a:s",
                                    origin_server_ts: 1746144000000,
                                    content: {
                                        source: "a", predicate: "b", target: "c",
                                        author: "did:key:z6Mk", timestamp: "2026-05-02T00:00:00.000Z",
                                        proof: { signature: "", key: "" },
                                    },
                                },
                                {
                                    type: "m.room.redaction",
                                    event_id: "$r1:s",
                                    sender: "@admin:s",
                                    origin_server_ts: 1746144002000,
                                    content: {},
                                    redacts: "$old-event:s",
                                },
                            ],
                        },
                    },
                },
            },
        };

        const diff = processSyncResponse(syncResp, ROOM_ID, NEIGHBOURHOOD_URL);
        assert.equal(diff.additions.length, 1);
        assert.equal(diff.removals.length, 1);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Translation round-trip
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Translation round-trip", () => {
    beforeEach(initAllAdapters);

    it("round-trips a link through dev.ad4m.link.triple", () => {
        const original = makeLink();

        // Outbound: link → triple content
        const tripleContent = linkToTripleContent(original);

        // Simulate event
        const event: MatrixEvent = {
            type: "dev.ad4m.link.triple",
            event_id: "$rt:s",
            sender: "@bridge:s",
            origin_server_ts: 1746144000000,
            content: tripleContent as unknown as Record<string, unknown>,
        };

        // Inbound: event → links
        const { additions } = eventsToLinks([event], NEIGHBOURHOOD_URL);
        assert.equal(additions.length, 1);

        const roundTripped = additions[0];
        assert.equal(roundTripped.data.source, original.data.source);
        assert.equal(roundTripped.data.predicate, original.data.predicate);
        assert.equal(roundTripped.data.target, original.data.target);
        assert.equal(roundTripped.author, original.author);
        assert.equal(roundTripped.proof.signature, original.proof.signature);
    });

    it("translates links to events using dual strategy", () => {
        const link = makeChatLink();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const events = diffToEvents(diff, {
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
            neighbourhoodUrl: NEIGHBOURHOOD_URL,
        });

        // Dual strategy produces both native + message events
        assert.equal(events.length, 2);
        assert.ok(events.some(e => e.eventType === "dev.ad4m.link.triple"));
        assert.ok(events.some(e => e.eventType === "m.room.message"));
    });

    it("translates links to events using native-only strategy", () => {
        const link = makeLink();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const settings = { ...DEFAULT_SETTINGS, rendering: { ...DEFAULT_SETTINGS.rendering, strategy: "native" as const } };
        const events = diffToEvents(diff, {
            settings,
            hashFn: simpleHash,
            neighbourhoodUrl: NEIGHBOURHOOD_URL,
        });

        assert.equal(events.length, 1);
        assert.equal(events[0].eventType, "dev.ad4m.link.triple");
    });

    it("translates links to events using matrix-only strategy", () => {
        const link = makeLink();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const settings = { ...DEFAULT_SETTINGS, rendering: { ...DEFAULT_SETTINGS.rendering, strategy: "matrix" as const } };
        const events = diffToEvents(diff, {
            settings,
            hashFn: simpleHash,
            neighbourhoodUrl: NEIGHBOURHOOD_URL,
        });

        assert.equal(events.length, 1);
        assert.equal(events[0].eventType, "m.room.message");
    });

    it("respects shouldFederate filter", () => {
        const link = makeLink();
        const diff: PerspectiveDiff = { additions: [link], removals: [] };

        const events = diffToEvents(diff, {
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
            neighbourhoodUrl: NEIGHBOURHOOD_URL,
            shouldFederate: () => false,
        });

        assert.equal(events.length, 0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Full pipeline: commit → events → sync → verify
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Full pipeline", () => {
    beforeEach(initAllAdapters);

    it("complete round-trip: link → event → sync → stored link", () => {
        // 1. Create links
        const link1 = makeLink();
        const link2 = makeChatLink(42);
        const diff: PerspectiveDiff = { additions: [link1, link2], removals: [] };

        // 2. Generate events (native strategy for lossless)
        const settings = { ...DEFAULT_SETTINGS, rendering: { ...DEFAULT_SETTINGS.rendering, strategy: "native" as const } };
        const events = diffToEvents(diff, {
            settings,
            hashFn: simpleHash,
            neighbourhoodUrl: NEIGHBOURHOOD_URL,
        });
        assert.equal(events.length, 2);

        // 3. Simulate receiving these events via /sync on another node
        const freshStorage = new MockStorageAdapter();
        initStorage(freshStorage);
        store.initStore(simpleHash);

        const matrixEvents: MatrixEvent[] = events.map((e, i) => ({
            type: e.eventType,
            event_id: `$synced-${i}:s`,
            sender: "@bridge:s",
            origin_server_ts: 1746144000000 + i * 1000,
            content: e.content,
        }));

        const syncResp: MatrixSyncResponse = {
            next_batch: "s999",
            rooms: {
                join: {
                    [ROOM_ID]: {
                        timeline: { events: matrixEvents },
                    },
                },
            },
        };

        const syncDiff = processSyncResponse(syncResp, ROOM_ID, NEIGHBOURHOOD_URL);
        assert.equal(syncDiff.additions.length, 2);

        // 4. Verify round-tripped links match originals
        const source0 = syncDiff.additions.find(l => l.data.source === "channel://main" && l.data.target === "expr://msg-001");
        const source1 = syncDiff.additions.find(l => l.data.target === "expr://msg-042");
        assert.ok(source0);
        assert.ok(source1);
        assert.equal(source0!.data.predicate, "flux://has_message");
        assert.equal(source1!.data.predicate, "flux://has_message");
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Dual-language origin tracking
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Dual-language", () => {
    beforeEach(initAllAdapters);

    it("federates native-origin links", () => {
        mockStorage.put(linkOriginKey("hash1"), "native");
        assert.equal(shouldFederate("hash1", k => mockStorage.get(k)), true);
    });

    it("blocks matrix-origin links from re-federation", () => {
        mockStorage.put(linkOriginKey("hash2"), "matrix");
        assert.equal(shouldFederate("hash2", k => mockStorage.get(k)), false);
    });

    it("federates links with no origin (new commits)", () => {
        assert.equal(shouldFederate("hash3", k => mockStorage.get(k)), true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Rendering pipeline
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: Rendering", () => {
    it("renders links as text", () => {
        const link = makeLink();
        const text = renderLinkAsText(link);
        assert.ok(text.includes("channel://main"));
        assert.ok(text.includes("flux://has_message"));
    });

    it("renders links as HTML", () => {
        const link = makeLink();
        const html = renderLinkAsHtml(link);
        assert.ok(html.includes("<code>"));
        assert.ok(html.includes("🔗"));
    });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. SDNA pattern detection integration
// ═══════════════════════════════════════════════════════════════════════════

describe("Cross-runtime: SDNA integration", () => {
    it("diffToEvents uses SDNA for reaction links (dual strategy)", () => {
        initAllAdapters();

        const reactionLink = makeLink({
            data: {
                source: "expr://msg",
                target: "👍",
                predicate: "flux://has_reaction",
            },
        });

        const diff: PerspectiveDiff = { additions: [reactionLink], removals: [] };
        const events = diffToEvents(diff, {
            settings: DEFAULT_SETTINGS,
            hashFn: simpleHash,
            neighbourhoodUrl: NEIGHBOURHOOD_URL,
        });

        // Should produce native + matrix event
        assert.ok(events.length >= 1);
        const nativeEvt = events.find(e => e.eventType === "dev.ad4m.link.triple");
        assert.ok(nativeEvt);
    });

    it("pattern detection works for all types", () => {
        const chat = detectPattern(makeLink({ data: { source: "a", target: "b", predicate: "flux://has_message" } }), ["flux://has_message"]);
        assert.equal(chat.type, "chat-message");

        const reply = detectPattern(makeLink({ data: { source: "a", target: "b", predicate: "flux://has_reply" } }), []);
        assert.equal(reply.type, "reply");

        const reaction = detectPattern(makeLink({ data: { source: "a", target: "b", predicate: "flux://has_reaction" } }), []);
        assert.equal(reaction.type, "reaction");

        const mention = detectPattern(makeLink({ data: { source: "a", target: "b", predicate: "flux://has_mention" } }), []);
        assert.equal(mention.type, "mention");
    });
});
