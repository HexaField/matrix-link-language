/**
 * Tests for dual-language deduplication logic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    isDuplicate,
    linkContentHash,
    linkOriginKey,
    shouldFederate,
    isPredicateExcluded,
    shouldFederateLink,
} from "../src/dual-language.js";

import type { LinkOrigin } from "../src/dual-language.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function simpleHash(data: string): string {
    let h = 0;
    for (let i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    }
    return `Qm${Math.abs(h).toString(16)}`;
}

function makeLink(overrides?: Partial<LinkExpression["data"]>): LinkExpression {
    return {
        author: "did:key:z6MkTest",
        timestamp: "2026-05-02T00:00:00.000Z",
        data: {
            source: "literal://hello",
            target: "literal://world",
            predicate: "sioc://content_of",
            ...overrides,
        },
        proof: { signature: "sig", key: "key" },
    };
}

// ---------------------------------------------------------------------------
// isDuplicate
// ---------------------------------------------------------------------------

describe("isDuplicate", () => {
    it("returns false when no existing hashes", () => {
        const link = makeLink();
        const existing = new Set<string>();
        assert.equal(isDuplicate(link, existing, simpleHash), false);
    });

    it("returns true when content hash matches existing", () => {
        const link = makeLink();
        const contentHash = linkContentHash(link, simpleHash);
        const existing = new Set<string>([contentHash]);
        assert.equal(isDuplicate(link, existing, simpleHash), true);
    });

    it("returns false for different link content", () => {
        const link1 = makeLink({ source: "a", target: "b", predicate: "c" });
        const link2 = makeLink({ source: "x", target: "y", predicate: "z" });
        const hash1 = linkContentHash(link1, simpleHash);
        const existing = new Set<string>([hash1]);
        assert.equal(isDuplicate(link2, existing, simpleHash), false);
    });

    it("deduplicates based on triple only (ignores author/timestamp)", () => {
        const link1 = makeLink();
        const link2: LinkExpression = {
            ...makeLink(),
            author: "did:key:z6MkOther",
            timestamp: "2026-06-01T00:00:00.000Z",
        };
        const hash1 = linkContentHash(link1, simpleHash);
        const existing = new Set<string>([hash1]);
        assert.equal(isDuplicate(link2, existing, simpleHash), true);
    });
});

// ---------------------------------------------------------------------------
// linkContentHash
// ---------------------------------------------------------------------------

describe("linkContentHash", () => {
    it("produces deterministic hash", () => {
        const link = makeLink();
        assert.equal(linkContentHash(link, simpleHash), linkContentHash(link, simpleHash));
    });

    it("produces different hashes for different links", () => {
        const link1 = makeLink({ source: "a" });
        const link2 = makeLink({ source: "b" });
        assert.notEqual(linkContentHash(link1, simpleHash), linkContentHash(link2, simpleHash));
    });

    it("ignores author and timestamp in hash", () => {
        const link1 = makeLink();
        const link2: LinkExpression = {
            ...makeLink(),
            author: "did:key:z6MkDifferent",
            timestamp: "2099-01-01T00:00:00.000Z",
        };
        assert.equal(linkContentHash(link1, simpleHash), linkContentHash(link2, simpleHash));
    });
});

// ---------------------------------------------------------------------------
// linkOriginKey
// ---------------------------------------------------------------------------

describe("linkOriginKey", () => {
    it("produces correct storage key format", () => {
        assert.equal(linkOriginKey("abc123"), "link-origin/abc123");
    });

    it("handles empty hash", () => {
        assert.equal(linkOriginKey(""), "link-origin/");
    });
});

// ---------------------------------------------------------------------------
// shouldFederate
// ---------------------------------------------------------------------------

describe("shouldFederate", () => {
    it("returns true when no origin is tracked (new local commit)", () => {
        assert.equal(shouldFederate("hash123", () => null), true);
    });

    it("returns true for native-origin links", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash123") return "native";
            return null;
        };
        assert.equal(shouldFederate("hash123", getOrigin), true);
    });

    it("returns true for dual-origin links", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash456") return "dual";
            return null;
        };
        assert.equal(shouldFederate("hash456", getOrigin), true);
    });

    it("returns false for matrix-origin links (prevents echo loop)", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash789") return "matrix";
            return null;
        };
        assert.equal(shouldFederate("hash789", getOrigin), false);
    });

    it("constructs correct storage key for lookup", () => {
        let queriedKey = "";
        const getOrigin = (key: string): string | null => {
            queriedKey = key;
            return null;
        };
        shouldFederate("myLinkHash", getOrigin);
        assert.equal(queriedKey, "link-origin/myLinkHash");
    });
});

// ---------------------------------------------------------------------------
// isPredicateExcluded
// ---------------------------------------------------------------------------

describe("isPredicateExcluded", () => {
    it("returns false for empty exclude list", () => {
        assert.equal(isPredicateExcluded("flux://has_message", []), false);
    });

    it("returns true for excluded predicate", () => {
        assert.equal(isPredicateExcluded("flux://internal", ["flux://internal"]), true);
    });

    it("returns false for non-excluded predicate", () => {
        assert.equal(isPredicateExcluded("flux://public", ["flux://internal"]), false);
    });

    it("returns false for undefined predicate", () => {
        assert.equal(isPredicateExcluded(undefined, ["flux://internal"]), false);
    });
});

// ---------------------------------------------------------------------------
// shouldFederateLink (combined)
// ---------------------------------------------------------------------------

describe("shouldFederateLink", () => {
    it("returns false when predicate is excluded", () => {
        assert.equal(
            shouldFederateLink("hash", "flux://internal", () => null, ["flux://internal"]),
            false,
        );
    });

    it("returns false when origin is matrix", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash") return "matrix";
            return null;
        };
        assert.equal(
            shouldFederateLink("hash", "flux://public", getOrigin, []),
            false,
        );
    });

    it("returns true when all checks pass", () => {
        assert.equal(
            shouldFederateLink("hash", "flux://public", () => null, []),
            true,
        );
    });

    it("returns true for native origin with non-excluded predicate", () => {
        const getOrigin = (key: string): string | null => {
            if (key === "link-origin/hash") return "native";
            return null;
        };
        assert.equal(
            shouldFederateLink("hash", "flux://public", getOrigin, ["flux://internal"]),
            true,
        );
    });
});
