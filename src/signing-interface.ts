/**
 * Signing adapter interface — interfaces and singleton only.
 *
 * No ad4m:host imports. Safe for cross-runtime testing.
 * Deno-specific implementations are in signing-deno.ts.
 */

export interface SigningAdapter {
    signStringHex(payload: string): string;
    signingKeyId(): string;
}

let _signing: SigningAdapter | null = null;

export function initSigning(adapter: SigningAdapter): void {
    _signing = adapter;
}

export function getSigning(): SigningAdapter {
    if (!_signing) {
        throw new Error(
            "SigningAdapter not initialized. Call initSigning() during language init().",
        );
    }
    return _signing;
}
