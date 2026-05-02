/**
 * Tests for the local link store module.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter } from "../src/storage-interface.js";
import { initStorage } from "../src/storage-interface.js";
import type { RuntimeAdapter } from "../src/runtime-interface.js";
import { initRuntime } from "../src/runtime-interface.js";
import * as store from "../src/store.js";
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock adapters
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
// Fixtures
// ---------------------------------------------------------------------------

function makeLink(overrides?: Partial<LinkExpression["data"]>): LinkExpression {
    return {
        author: "did:key:z6MkStore",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "channel://main",
            target: "expr://msg-001",
            predicate: "flux://has_message",
            ...overrides,
        },
        proof: { signature: "sig", key: "key" },
    };
}

// ---------------------------------------------------------------------------
// putLink / getLink
// ---------------------------------------------------------------------------

describe("store: putLink / getLink", () => {
    beforeEach(setup);

    it("stores a link and retrieves it by hash", () => {
        const link = makeLink();
        const hash = store.putLink(link);
        assert.ok(hash);
        const retrieved = store.getLink(hash);
        assert.ok(retrieved);
        assert.deepEqual(retrieved!.data, link.data);
    });

    it("returns null for unknown hash", () => {
        assert.equal(store.getLink("nonexistent"), null);
    });

    it("is idempotent (same link stored twice → same hash)", () => {
        const link = makeLink();
        const h1 = store.putLink(link);
        const h2 = store.putLink(link);
        assert.equal(h1, h2);
    });
});

// ---------------------------------------------------------------------------
// removeLink
// ---------------------------------------------------------------------------

describe("store: removeLink", () => {
    beforeEach(setup);

    it("removes a previously stored link", () => {
        const link = makeLink();
        const hash = store.putLink(link);
        store.removeLink(link);
        assert.equal(store.getLink(hash), null);
    });

    it("is a no-op for links that don't exist", () => {
        const link = makeLink({ target: "nonexistent://x" });
        // Should not throw
        store.removeLink(link);
    });
});

// ---------------------------------------------------------------------------
// queryLinks
// ---------------------------------------------------------------------------

describe("store: queryLinks", () => {
    beforeEach(setup);

    it("queries by source", () => {
        store.putLink(makeLink({ source: "a", target: "x", predicate: "p" }));
        store.putLink(makeLink({ source: "a", target: "y", predicate: "q" }));
        store.putLink(makeLink({ source: "b", target: "z", predicate: "r" }));

        assert.equal(store.queryLinks({ source: "a" }).length, 2);
        assert.equal(store.queryLinks({ source: "b" }).length, 1);
        assert.equal(store.queryLinks({ source: "c" }).length, 0);
    });

    it("queries by target", () => {
        store.putLink(makeLink({ source: "s", target: "T1", predicate: "p" }));
        store.putLink(makeLink({ source: "s", target: "T2", predicate: "p" }));

        assert.equal(store.queryLinks({ target: "T1" }).length, 1);
        assert.equal(store.queryLinks({ target: "T2" }).length, 1);
    });

    it("queries by predicate", () => {
        store.putLink(makeLink({ predicate: "pred://A" }));
        store.putLink(makeLink({ predicate: "pred://B" }));

        assert.equal(store.queryLinks({ predicate: "pred://A" }).length, 1);
    });

    it("intersection: source + predicate", () => {
        store.putLink(makeLink({ source: "s", target: "a", predicate: "p1" }));
        store.putLink(makeLink({ source: "s", target: "b", predicate: "p2" }));

        const results = store.queryLinks({ source: "s", predicate: "p1" });
        assert.equal(results.length, 1);
        assert.equal(results[0].data.target, "a");
    });

    it("intersection: source + target + predicate (exact match)", () => {
        store.putLink(makeLink({ source: "s", target: "t", predicate: "p" }));
        store.putLink(makeLink({ source: "s", target: "t", predicate: "q" }));

        const results = store.queryLinks({ source: "s", target: "t", predicate: "p" });
        assert.equal(results.length, 1);
    });

    it("returns empty when no params match", () => {
        store.putLink(makeLink());
        assert.equal(store.queryLinks({ source: "nonexistent" }).length, 0);
    });

    it("returns all links when no filter params given", () => {
        store.putLink(makeLink({ source: "a", target: "b", predicate: "c" }));
        store.putLink(makeLink({ source: "x", target: "y", predicate: "z" }));
        const all = store.queryLinks({});
        assert.equal(all.length, 2);
    });
});

// ---------------------------------------------------------------------------
// allLinks
// ---------------------------------------------------------------------------

describe("store: allLinks", () => {
    beforeEach(setup);

    it("returns empty when no links stored", () => {
        assert.equal(store.allLinks().links.length, 0);
    });

    it("returns all stored links", () => {
        store.putLink(makeLink({ source: "a", target: "b", predicate: "c" }));
        store.putLink(makeLink({ source: "d", target: "e", predicate: "f" }));
        store.putLink(makeLink({ source: "g", target: "h", predicate: "i" }));
        assert.equal(store.allLinks().links.length, 3);
    });
});

// ---------------------------------------------------------------------------
// hashLink
// ---------------------------------------------------------------------------

describe("store: hashLink", () => {
    beforeEach(setup);

    it("produces deterministic hashes", () => {
        const link = makeLink();
        assert.equal(store.hashLink(link), store.hashLink(link));
    });

    it("produces different hashes for different links", () => {
        const l1 = makeLink({ source: "a" });
        const l2 = makeLink({ source: "b" });
        assert.notEqual(store.hashLink(l1), store.hashLink(l2));
    });
});

// ---------------------------------------------------------------------------
// applyDiff
// ---------------------------------------------------------------------------

describe("store: applyDiff", () => {
    beforeEach(setup);

    it("applies additions", () => {
        const link = makeLink();
        store.applyDiff({ additions: [link], removals: [] });
        assert.equal(store.allLinks().links.length, 1);
    });

    it("applies removals", () => {
        const link = makeLink();
        store.putLink(link);
        store.applyDiff({ additions: [], removals: [link] });
        assert.equal(store.allLinks().links.length, 0);
    });

    it("applies additions and removals atomically", () => {
        const old = makeLink({ source: "old" });
        const fresh = makeLink({ source: "new" });
        store.putLink(old);

        store.applyDiff({ additions: [fresh], removals: [old] });
        assert.equal(store.allLinks().links.length, 1);
        assert.equal(store.allLinks().links[0].data.source, "new");
    });
});

// ---------------------------------------------------------------------------
// revision tracking
// ---------------------------------------------------------------------------

describe("store: revision tracking", () => {
    beforeEach(setup);

    it("returns null initially", () => {
        assert.equal(store.getRevision(), null);
    });

    it("stores and retrieves revision", () => {
        store.setRevision("rev-42");
        assert.equal(store.getRevision(), "rev-42");
    });

    it("overwrites previous revision", () => {
        store.setRevision("rev-1");
        store.setRevision("rev-2");
        assert.equal(store.getRevision(), "rev-2");
    });
});

// ---------------------------------------------------------------------------
// event-to-link mapping
// ---------------------------------------------------------------------------

describe("store: event-to-link mapping", () => {
    beforeEach(setup);

    it("stores and retrieves event→link mapping", () => {
        store.mapEventToLink("$evt:server", "QmLinkHash");
        assert.equal(store.getLinkHashByEventId("$evt:server"), "QmLinkHash");
    });

    it("returns null for unknown event", () => {
        assert.equal(store.getLinkHashByEventId("$unknown:s"), null);
    });
});

// ---------------------------------------------------------------------------
// peers
// ---------------------------------------------------------------------------

describe("store: peers", () => {
    beforeEach(setup);

    it("add and list peers", () => {
        store.setPeer("did:key:z6MkA", { name: "Alice" });
        store.setPeer("did:key:z6MkB", { name: "Bob" });
        const peers = store.listPeers();
        assert.equal(peers.length, 2);
    });

    it("get peer metadata", () => {
        store.setPeer("did:key:z6MkA", { name: "Alice", age: 30 });
        const meta = store.getPeerMetadata("did:key:z6MkA");
        assert.ok(meta);
        assert.equal(meta!.name, "Alice");
    });

    it("returns null for unknown peer", () => {
        assert.equal(store.getPeerMetadata("did:key:z6MkUnknown"), null);
    });

    it("remove peer", () => {
        store.setPeer("did:key:z6MkA", { name: "Alice" });
        store.removePeer("did:key:z6MkA");
        assert.equal(store.listPeers().length, 0);
    });

    it("remove non-existent peer is a no-op", () => {
        store.removePeer("did:key:z6MkGhost");
        assert.equal(store.listPeers().length, 0);
    });
});
