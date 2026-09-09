/**
 * Client-side helpers for provider inline references (`op://`, `vw://`, ...).
 *
 * Detection here is a lightweight prefix test used only to drive editor
 * feedback (the "checking / found / not found" badge and the placement hint).
 * The authoritative check is each provider's server-side `isReference()` in
 * `src/lib/server/secretproviders/*.ts`; keep the scheme map below in sync with
 * those.
 */

/** Inline-reference URI scheme per secret-provider type. Bulk-only backends
 *  (doppler, vault, infisical) have none. */
export const PROVIDER_REF_SCHEME: Record<string, string> = {
	'op-service-account': 'op://',
	'op-connect': 'op://',
	'azure-kv': 'azurekv://',
	proton: 'pass://',
	keepass: 'keepass://',
	vaultwarden: 'vw://'
};

/** All known provider ref schemes (for a provider-agnostic prefix test). */
export const ALL_PROVIDER_REF_SCHEMES: readonly string[] = [
	...new Set(Object.values(PROVIDER_REF_SCHEME))
];

/**
 * Strip ONE layer of matching surrounding quotes, for reference DETECTION only
 * (parity with the server's `stripSurroundingQuotes`). The stored value is left
 * untouched by callers.
 */
export function stripQuotes(value: string): string {
	return value.trim().replace(/^(["'])(.*)\1$/s, '$2');
}

/** The inline-reference scheme for a provider type, or undefined (bulk-only / none). */
export function refSchemeFor(providerType: string | null | undefined): string | undefined {
	return providerType ? PROVIDER_REF_SCHEME[providerType] : undefined;
}

/** True when `value` is an inline reference for `providerType`'s scheme. */
export function isProviderRef(
	value: string | null | undefined,
	providerType: string | null | undefined
): boolean {
	const scheme = refSchemeFor(providerType);
	return scheme !== undefined && stripQuotes(value ?? '').startsWith(scheme);
}

export type ProviderRefStatus = 'resolved' | 'unresolved' | 'checking';

/**
 * Per-variable status for the env editor's provider-ref badge:
 *   - `resolved`   the live probe found this key in the bound provider
 *   - `checking`   value is a ref but a probe is still in flight
 *   - `unresolved` probe settled and the key is absent (bad name, missing
 *                  permission, or the provider hasn't re-synced yet)
 *
 * Only variables whose value is a ref for `providerType` appear in the map.
 */
export function providerRefStatuses(
	variables: readonly { key: string; value: string }[],
	providerType: string | null | undefined,
	providerKeySet: ReadonlySet<string>,
	opts: { probing?: boolean } = {}
): Map<string, ProviderRefStatus> {
	const out = new Map<string, ProviderRefStatus>();
	const scheme = refSchemeFor(providerType);
	if (!scheme) return out;
	for (const v of variables) {
		const key = v.key.trim();
		if (!key || !stripQuotes(v.value ?? '').startsWith(scheme)) continue;
		out.set(
			key,
			providerKeySet.has(key) ? 'resolved' : opts.probing ? 'checking' : 'unresolved'
		);
	}
	return out;
}
