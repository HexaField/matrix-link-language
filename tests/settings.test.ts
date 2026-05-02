/**
 * Tests for MatrixSettings parser.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseSettings, DEFAULT_SETTINGS } from "../src/settings.js";
import type { MatrixSettings } from "../src/settings.js";

// ---------------------------------------------------------------------------
// parseSettings
// ---------------------------------------------------------------------------

describe("parseSettings", () => {
    it("returns defaults for null input", () => {
        const s = parseSettings(null);
        assert.deepEqual(s.syncMode, DEFAULT_SETTINGS.syncMode);
        assert.deepEqual(s.rendering.strategy, DEFAULT_SETTINGS.rendering.strategy);
        assert.deepEqual(s.sync.timeoutMs, DEFAULT_SETTINGS.sync.timeoutMs);
        assert.deepEqual(s.auth.method, DEFAULT_SETTINGS.auth.method);
    });

    it("returns defaults for undefined input", () => {
        const s = parseSettings(undefined);
        assert.equal(s.syncMode, "bidirectional");
    });

    it("returns defaults for empty string", () => {
        const s = parseSettings("");
        assert.equal(s.syncMode, "bidirectional");
    });

    it("returns defaults for invalid JSON", () => {
        const s = parseSettings("{invalid json");
        assert.equal(s.syncMode, "bidirectional");
    });

    it("parses valid syncMode", () => {
        const s = parseSettings(JSON.stringify({ syncMode: "publish-only" }));
        assert.equal(s.syncMode, "publish-only");
    });

    it("rejects invalid syncMode", () => {
        const s = parseSettings(JSON.stringify({ syncMode: "invalid" }));
        assert.equal(s.syncMode, "bidirectional");
    });

    it("parses rendering strategy", () => {
        const s = parseSettings(JSON.stringify({
            rendering: { strategy: "native" },
        }));
        assert.equal(s.rendering.strategy, "native");
    });

    it("rejects invalid rendering strategy", () => {
        const s = parseSettings(JSON.stringify({
            rendering: { strategy: "invalid" },
        }));
        assert.equal(s.rendering.strategy, "dual");
    });

    it("parses chatPredicates array", () => {
        const preds = ["custom://pred1", "custom://pred2"];
        const s = parseSettings(JSON.stringify({
            rendering: { chatPredicates: preds },
        }));
        assert.deepEqual(s.rendering.chatPredicates, preds);
    });

    it("rejects non-array chatPredicates", () => {
        const s = parseSettings(JSON.stringify({
            rendering: { chatPredicates: "not-array" },
        }));
        assert.deepEqual(s.rendering.chatPredicates, DEFAULT_SETTINGS.rendering.chatPredicates);
    });

    it("parses boolean resolveContent", () => {
        const s = parseSettings(JSON.stringify({
            rendering: { resolveContent: false },
        }));
        assert.equal(s.rendering.resolveContent, false);
    });

    it("parses sync timeoutMs", () => {
        const s = parseSettings(JSON.stringify({ sync: { timeoutMs: 5000 } }));
        assert.equal(s.sync.timeoutMs, 5000);
    });

    it("rejects zero timeoutMs", () => {
        const s = parseSettings(JSON.stringify({ sync: { timeoutMs: 0 } }));
        assert.equal(s.sync.timeoutMs, DEFAULT_SETTINGS.sync.timeoutMs);
    });

    it("rejects negative timeoutMs", () => {
        const s = parseSettings(JSON.stringify({ sync: { timeoutMs: -1 } }));
        assert.equal(s.sync.timeoutMs, DEFAULT_SETTINGS.sync.timeoutMs);
    });

    it("parses sync limit", () => {
        const s = parseSettings(JSON.stringify({ sync: { limit: 50 } }));
        assert.equal(s.sync.limit, 50);
    });

    it("parses backfill settings", () => {
        const s = parseSettings(JSON.stringify({
            sync: { backfillEnabled: false, backfillLimit: 500 },
        }));
        assert.equal(s.sync.backfillEnabled, false);
        assert.equal(s.sync.backfillLimit, 500);
    });

    it("parses auth method", () => {
        const s = parseSettings(JSON.stringify({
            auth: { method: "access-token", accessToken: "tok123" },
        }));
        assert.equal(s.auth.method, "access-token");
        assert.equal(s.auth.accessToken, "tok123");
    });

    it("rejects invalid auth method", () => {
        const s = parseSettings(JSON.stringify({ auth: { method: "invalid" } }));
        assert.equal(s.auth.method, "password");
    });

    it("parses encryption settings", () => {
        const s = parseSettings(JSON.stringify({
            encryption: { enabled: true, verifyDevices: true },
        }));
        assert.equal(s.encryption.enabled, true);
        assert.equal(s.encryption.verifyDevices, true);
    });

    it("parses rate limit", () => {
        const s = parseSettings(JSON.stringify({
            rateLimit: { maxEventsPerSecond: 5 },
        }));
        assert.equal(s.rateLimit.maxEventsPerSecond, 5);
    });

    it("rejects zero rate limit", () => {
        const s = parseSettings(JSON.stringify({
            rateLimit: { maxEventsPerSecond: 0 },
        }));
        assert.equal(s.rateLimit.maxEventsPerSecond, DEFAULT_SETTINGS.rateLimit.maxEventsPerSecond);
    });

    it("parses membership mode", () => {
        const s = parseSettings(JSON.stringify({ membership: "open" }));
        assert.equal(s.membership, "open");
    });

    it("rejects invalid membership", () => {
        const s = parseSettings(JSON.stringify({ membership: "invalid" }));
        assert.equal(s.membership, "invite-only");
    });

    it("parses dualLanguage settings", () => {
        const s = parseSettings(JSON.stringify({
            dualLanguage: {
                enabled: true,
                excludePredicates: ["flux://internal"],
            },
        }));
        assert.equal(s.dualLanguage.enabled, true);
        assert.deepEqual(s.dualLanguage.excludePredicates, ["flux://internal"]);
    });

    it("parses telepresence settings", () => {
        const s = parseSettings(JSON.stringify({
            telepresence: { typing: false, presence: false },
        }));
        assert.equal(s.telepresence.typing, false);
        assert.equal(s.telepresence.presence, false);
    });

    it("handles partial settings (fills in defaults)", () => {
        const s = parseSettings(JSON.stringify({
            syncMode: "subscribe-only",
        }));
        assert.equal(s.syncMode, "subscribe-only");
        // Everything else should be defaults
        assert.equal(s.rendering.strategy, "dual");
        assert.equal(s.sync.timeoutMs, 30000);
        assert.equal(s.auth.method, "password");
        assert.equal(s.membership, "invite-only");
    });

    it("handles deeply nested partial settings", () => {
        const s = parseSettings(JSON.stringify({
            rendering: { strategy: "matrix" },
            // sync, auth, etc. not provided
        }));
        assert.equal(s.rendering.strategy, "matrix");
        assert.deepEqual(s.rendering.chatPredicates, DEFAULT_SETTINGS.rendering.chatPredicates);
        assert.equal(s.rendering.resolveContent, true);
    });
});

// ---------------------------------------------------------------------------
// DEFAULT_SETTINGS
// ---------------------------------------------------------------------------

describe("DEFAULT_SETTINGS", () => {
    it("has all required fields", () => {
        assert.ok(DEFAULT_SETTINGS.syncMode);
        assert.ok(DEFAULT_SETTINGS.rendering);
        assert.ok(DEFAULT_SETTINGS.sync);
        assert.ok(DEFAULT_SETTINGS.auth);
        assert.ok(DEFAULT_SETTINGS.encryption);
        assert.ok(DEFAULT_SETTINGS.rateLimit);
        assert.ok(DEFAULT_SETTINGS.membership);
        assert.ok(DEFAULT_SETTINGS.dualLanguage);
        assert.ok(DEFAULT_SETTINGS.telepresence);
    });

    it("has sensible defaults", () => {
        assert.equal(DEFAULT_SETTINGS.syncMode, "bidirectional");
        assert.equal(DEFAULT_SETTINGS.rendering.strategy, "dual");
        assert.equal(DEFAULT_SETTINGS.sync.timeoutMs, 30000);
        assert.equal(DEFAULT_SETTINGS.sync.limit, 100);
        assert.equal(DEFAULT_SETTINGS.encryption.enabled, false);
        assert.equal(DEFAULT_SETTINGS.rateLimit.maxEventsPerSecond, 10);
        assert.equal(DEFAULT_SETTINGS.membership, "invite-only");
        assert.equal(DEFAULT_SETTINGS.dualLanguage.enabled, false);
    });
});
