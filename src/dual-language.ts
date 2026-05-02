/**
 * Dual-language deduplication — pure module.
 *
 * When the Matrix Link Language operates alongside a primary link language
 * (e.g. Holochain), we need to:
 * - Deduplicate links that arrive via both Matrix and native sync
 * - Track which links originated from Matrix vs native
 * - Filter outbound federation for links that arrived via Matrix
 *   (to avoid echo/re-federation loops)
 *
 * Spec §13.
 *
 * Pure functions — no ad4m:host imports. Safe for unit testing.
 */

import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LinkOrigin = "matrix" | "native" | "dual";

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

function canonicalLinkData(link: LinkExpression): string {
    return JSON.stringify({
        source: link.data.source || "",
        predicate: link.data.predicate || "",
        target: link.data.target || "",
    });
}

/**
 * Check if a link already exists in the store (dedup before applying).
 */
export function isDuplicate(
    link: LinkExpression,
    existingHashes: Set<string>,
    hashFn: (data: string) => string,
): boolean {
    const contentHash = hashFn(canonicalLinkData(link));
    return existingHashes.has(contentHash);
}

/**
 * Compute the content hash of a link for dedup tracking.
 */
export function linkContentHash(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    return hashFn(canonicalLinkData(link));
}

// ---------------------------------------------------------------------------
// Origin tracking
// ---------------------------------------------------------------------------

/**
 * Build the storage key for tracking a link's origin.
 */
export function linkOriginKey(linkHash: string): string {
    return `link-origin/${linkHash}`;
}

// ---------------------------------------------------------------------------
// Federation filtering
// ---------------------------------------------------------------------------

/**
 * Determine if an outbound link should be federated to Matrix.
 *
 * Links that originated from Matrix should NOT be re-sent to avoid
 * echo loops. Only "native" or "dual" origin links (or links with
 * no tracked origin, i.e. new local commits) should be federated.
 */
export function shouldFederate(
    linkHash: string,
    getOrigin: (key: string) => string | null,
): boolean {
    const origin = getOrigin(linkOriginKey(linkHash));
    if (origin === null) return true;
    return origin !== "matrix";
}

/**
 * Determine if an outbound link should be excluded based on predicate filter.
 */
export function isPredicateExcluded(
    predicate: string | undefined,
    excludePredicates: string[],
): boolean {
    if (!predicate || excludePredicates.length === 0) return false;
    return excludePredicates.includes(predicate);
}

/**
 * Combined federation check: origin + predicate exclusion.
 */
export function shouldFederateLink(
    linkHash: string,
    predicate: string | undefined,
    getOrigin: (key: string) => string | null,
    excludePredicates: string[],
): boolean {
    if (isPredicateExcluded(predicate, excludePredicates)) return false;
    return shouldFederate(linkHash, getOrigin);
}
