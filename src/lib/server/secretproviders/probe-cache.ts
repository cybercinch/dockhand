/**
 * Short-lived cache for live provider probes.
 *
 * The stack editor probes the bound provider to classify a compose ${VAR} as
 * present ("IN VAULT") or missing. Without protection a busy editor page (debounced
 * keystrokes + the list auto-refresh) fires overlapping probes, and each one would
 * hit the provider: wasted 1Password/Vault API calls, and for the CLI providers a
 * burst of keepassxc-cli/bws spawns (each re-deriving the key). Two guards:
 *   - a ~30s result cache (KEY NAMES only, never values), and
 *   - single-flight: probes for the same (providerId, selector) that arrive while a
 *     call is already in flight share that one Promise instead of spawning their own.
 */

import type { SecretProvider, SecretProviderConfig } from './shared';

const TTL_MS = 30_000;

interface Entry {
	keys: string[];
	at: number;
}

// Keyed by `${providerId}:${selector}`. A stale entry is deleted when read, so the
// map self-trims to selectors probed within the TTL window rather than growing
// forever across a live editing session (every keystroke is a distinct selector).
const cache = new Map<string, Entry>();

// In-flight probes, keyed the same way, so concurrent callers coalesce onto one
// provider call. Cleared when the call settles (success or failure).
const inflight = new Map<string, Promise<string[]>>();

/**
 * Returns the KEY NAMES available under a provider's bulk selector, cached for
 * ~30s per (providerId, selector). Values are discarded immediately - only the
 * names are stored and returned. Concurrent callers for the same key coalesce onto
 * a single provider call. Propagates the provider's errors to the caller.
 */
export async function probeBulkKeysCached(
	providerId: number,
	provider: SecretProvider,
	config: SecretProviderConfig,
	selector: string
): Promise<string[]> {
	const cacheKey = `${providerId}:${selector}`;
	const now = Date.now();
	const hit = cache.get(cacheKey);
	if (hit) {
		if (now - hit.at < TTL_MS) return hit.keys;
		cache.delete(cacheKey); // stale: drop it so the map doesn't grow unbounded
	}

	// Coalesce onto an existing in-flight call for the same key.
	const pending = inflight.get(cacheKey);
	if (pending) return pending;

	const call = (async () => {
		// Prefer the provider's names-only path; fall back to a full bulk pull
		// (which for some backends fetches every value just to learn the names).
		const keys = provider.listBulkKeys
			? await provider.listBulkKeys(config, selector)
			: Object.keys(await provider.resolveBulk(config, selector));
		cache.set(cacheKey, { keys, at: Date.now() });
		return keys;
	})().finally(() => {
		inflight.delete(cacheKey);
	});

	inflight.set(cacheKey, call);
	return call;
}
