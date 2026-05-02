/**
 * Runtime interface — interfaces and singleton only.
 *
 * No ad4m:host imports. Safe for cross-runtime testing.
 * Deno-specific implementations are in runtime-deno.ts.
 */

export interface RuntimeAdapter {
    hash(data: string): string;
    emitSignal(data: string): void;
    emitPerspectiveDiff(diff: unknown): void;
}

let _runtime: RuntimeAdapter | null = null;

export function initRuntime(adapter: RuntimeAdapter): void {
    _runtime = adapter;
}

export function getRuntime(): RuntimeAdapter {
    if (!_runtime) {
        throw new Error(
            "RuntimeAdapter not initialized. Call initRuntime() during language init().",
        );
    }
    return _runtime;
}
