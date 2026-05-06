/**
 * Local link store — wraps the storage adapter KV API to maintain
 * a link store with indexes.
 *
 * Key scheme:
 *   links/{link-hash}                → serialized LinkExpression
 *   links-by-source/{source}/{hash}  → link-hash
 *   links-by-target/{target}/{hash}  → link-hash
 *   links-by-pred/{predicate}/{hash} → link-hash
 *   revision                         → last known sync token
 *   matrix-events/{event-id-hash}    → serialized Matrix event JSON
 *   peers/{did}                      → peer metadata JSON
 *   event-to-link/{event-id}         → link-hash (for redaction lookup)
 */

import { getStorage } from "./adapters.js";
import { getRuntime } from "./adapters.js";
import type { LinkExpression, PerspectiveDiff, Perspective } from "./types.js";

let _hashFn: ((data: string) => string) | null = null;

export function initStore(hashFn?: (data: string) => string): void {
    _hashFn = hashFn ?? null;
}

function getHashFn(): (data: string) => string {
    if (_hashFn) return _hashFn;
    return getRuntime().hash;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function linkKey(linkHash: string): string {
    return `links/${linkHash}`;
}

function sourceIndexKey(source: string, linkHash: string): string {
    return `links-by-source/${source}/${linkHash}`;
}

function targetIndexKey(target: string, linkHash: string): string {
    return `links-by-target/${target}/${linkHash}`;
}

function predIndexKey(predicate: string, linkHash: string): string {
    return `links-by-pred/${predicate}/${linkHash}`;
}

function peerKey(did: string): string {
    return `peers/${did}`;
}

function eventToLinkKey(eventId: string): string {
    return `event-to-link/${eventId}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function hashLink(link: LinkExpression): string {
    const content = JSON.stringify({
        source: link.data.source,
        predicate: link.data.predicate,
        target: link.data.target,
        author: link.author,
        timestamp: link.timestamp,
    });
    return getHashFn()(content);
}

export function putLink(link: LinkExpression): string {
    const h = hashLink(link);
    const storage = getStorage();
    storage.put(linkKey(h), JSON.stringify(link));

    const source = link.data.source || "";
    const target = link.data.target || "";
    const predicate = link.data.predicate || "";

    if (source) storage.put(sourceIndexKey(source, h), h);
    if (target) storage.put(targetIndexKey(target, h), h);
    if (predicate) storage.put(predIndexKey(predicate, h), h);

    return h;
}

export function removeLink(link: LinkExpression): void {
    const h = hashLink(link);
    const storage = getStorage();
    storage.delete(linkKey(h));

    const source = link.data.source || "";
    const target = link.data.target || "";
    const predicate = link.data.predicate || "";

    if (source) storage.delete(sourceIndexKey(source, h));
    if (target) storage.delete(targetIndexKey(target, h));
    if (predicate) storage.delete(predIndexKey(predicate, h));
}

export function getLink(linkHash: string): LinkExpression | null {
    const raw = getStorage().get(linkKey(linkHash));
    if (!raw) return null;
    return JSON.parse(raw) as LinkExpression;
}

export function applyDiff(diff: PerspectiveDiff): void {
    for (const addition of diff.additions) {
        putLink(addition);
    }
    for (const removal of diff.removals) {
        removeLink(removal);
    }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface LinkQuery {
    source?: string;
    target?: string;
    predicate?: string;
}

export function queryLinks(query: LinkQuery): LinkExpression[] {
    const { source, target, predicate } = query;
    const storage = getStorage();

    let candidateHashes: string[];

    if (source) {
        const keys = storage.listKeys(`links-by-source/${source}/`);
        candidateHashes = keys.map((k: string) => storage.get(k) || "").filter(Boolean);
    } else if (target) {
        const keys = storage.listKeys(`links-by-target/${target}/`);
        candidateHashes = keys.map((k: string) => storage.get(k) || "").filter(Boolean);
    } else if (predicate) {
        const keys = storage.listKeys(`links-by-pred/${predicate}/`);
        candidateHashes = keys.map((k: string) => storage.get(k) || "").filter(Boolean);
    } else {
        const keys = storage.listKeys("links/");
        candidateHashes = keys.map((k: string) => k.replace("links/", ""));
    }

    const results: LinkExpression[] = [];
    const seen = new Set<string>();

    for (const h of candidateHashes) {
        if (seen.has(h)) continue;
        seen.add(h);

        const link = getLink(h);
        if (!link) continue;

        if (source && link.data.source !== source) continue;
        if (target && link.data.target !== target) continue;
        if (predicate && link.data.predicate !== predicate) continue;

        results.push(link);
    }

    return results;
}

export function allLinks(): Perspective {
    const keys = getStorage().listKeys("links/");
    const links: LinkExpression[] = [];

    for (const key of keys) {
        const raw = getStorage().get(key);
        if (raw) {
            links.push(JSON.parse(raw) as LinkExpression);
        }
    }

    return { links };
}

// ---------------------------------------------------------------------------
// Revision tracking (sync token)
// ---------------------------------------------------------------------------

const REVISION_KEY = "revision";

export function getRevision(): string | null {
    return getStorage().get(REVISION_KEY);
}

export function setRevision(rev: string): void {
    getStorage().put(REVISION_KEY, rev);
}

// ---------------------------------------------------------------------------
// Event ↔ Link mapping (for redaction lookup)
// ---------------------------------------------------------------------------

export function mapEventToLink(eventId: string, linkHash: string): void {
    getStorage().put(eventToLinkKey(eventId), linkHash);
}

export function getLinkHashByEventId(eventId: string): string | null {
    return getStorage().get(eventToLinkKey(eventId));
}

// ---------------------------------------------------------------------------
// Matrix events cache
// ---------------------------------------------------------------------------

export function putMatrixEvent(eventId: string, json: string): void {
    const key = `matrix-events/${getHashFn()(eventId)}`;
    getStorage().put(key, json);
}

export function getMatrixEvent(eventId: string): string | null {
    const key = `matrix-events/${getHashFn()(eventId)}`;
    return getStorage().get(key);
}

// ---------------------------------------------------------------------------
// Peer management
// ---------------------------------------------------------------------------

export function setPeer(did: string, metadata: Record<string, unknown> = {}): void {
    getStorage().put(peerKey(did), JSON.stringify(metadata));
}

export function removePeer(did: string): void {
    getStorage().delete(peerKey(did));
}

export function listPeers(prefix: string = "peers/"): string[] {
    const keys = getStorage().listKeys(prefix);
    return keys.map((k: string) => k.replace(prefix, ""));
}

export function getPeerMetadata(did: string): Record<string, unknown> | null {
    const raw = getStorage().get(peerKey(did));
    if (!raw) return null;
    return JSON.parse(raw);
}
