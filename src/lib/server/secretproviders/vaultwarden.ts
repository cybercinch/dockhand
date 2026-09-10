/**
 * Vaultwarden provider.
 *
 * Resolves stack secrets from a self-hosted Vaultwarden via the companion
 * **Vaultwarden-API** service (https://github.com/cybercinch/Vaultwarden-API) -
 * plain authenticated HTTPS, no `bws` binary and no Bitwarden Secrets Manager
 * protocol. Vaultwarden-API does all the Bitwarden crypto server-side and
 * returns plaintext over TLS on a trusted network.
 *
 * Two resolution modes:
 *   - Inline references: `vw://SECRET_NAME`, one item at a time via
 *     `GET /secret/:name`.
 *   - Bulk pull: `GET /secrets` (names only) then a value fetch per item. The
 *     `DOCKHAND_SECRET_SELECTOR` value overrides the configured collection
 *     filter; `*` or `all` means "no extra filter".
 *
 * Pure HTTP (undici). The API key stays in the (encrypted) config and is sent as
 * the `Authorization` header; it is never logged.
 */

import { request } from 'undici';
import type { SecretProvider, TestConnectionResult, VaultwardenConfig } from './shared';
import { assertSafeProviderHost, isJsonResponse, stripSurroundingQuotes } from './shared';

const VW_REF_PREFIX = 'vw://';
// vw://<name>. Names mirror Vaultwarden-API's own validator: a letter/digit at
// each end, and letters, digits, space, _ - . / between. 1-255 chars.
const VW_REF_RE = /^vw:\/\/[A-Za-z0-9](?:[A-Za-z0-9 _\-./]{0,253}[A-Za-z0-9])?$/;

const DEFAULT_TIMEOUT_MS = 10_000;
const VALUE_FETCH_CONCURRENCY = 5;
/** Selector values that mean "do not add a collection filter". */
const WILDCARD_SELECTORS = new Set(['*', 'all']);

/** Milliseconds for the per-request timeout (config is seconds, as a string). */
function timeoutMs(config: VaultwardenConfig): number {
	const n = Number.parseFloat(String(config.timeoutSeconds ?? '').trim());
	return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : DEFAULT_TIMEOUT_MS;
}

/** Base URL with any trailing slash removed. */
function baseUrl(config: VaultwardenConfig): string {
	return config.apiBaseUrl.trim().replace(/\/+$/, '');
}

/** The `?organization_name=&collection_name=&folder_name=` query for the configured filters. */
function filterQuery(config: VaultwardenConfig, collectionOverride?: string): string {
	const p = new URLSearchParams();
	const org = config.organizationName?.trim();
	const folder = config.folderName?.trim();
	const collection = (collectionOverride ?? config.collectionName ?? '').trim();
	if (org) p.set('organization_name', org);
	if (collection) p.set('collection_name', collection);
	if (folder) p.set('folder_name', folder);
	const s = p.toString();
	return s ? `?${s}` : '';
}

/** The secret name from a `vw://<name>` reference (quotes already stripped by the caller). */
function refName(ref: string): string {
	return ref.slice(VW_REF_PREFIX.length);
}

/**
 * The `Authorization` header value. Vaultwarden-API requires the `Bearer `
 * scheme; tolerate an operator who pasted the key with the prefix already on it.
 */
function authHeader(config: VaultwardenConfig): string {
	const key = config.apiKey.trim();
	return /^bearer\s/i.test(key) ? key : `Bearer ${key}`;
}

interface VwResponse {
	statusCode: number;
	body: string;
}

/** One authenticated GET against the Vaultwarden-API service. Never logs the key or the body. */
async function vwGet(config: VaultwardenConfig, path: string): Promise<VwResponse> {
	const { statusCode, body } = await request(`${baseUrl(config)}${path}`, {
		method: 'GET',
		headers: { authorization: authHeader(config) },
		signal: AbortSignal.timeout(timeoutMs(config))
	});
	const text = await body.text().catch(() => '');
	return { statusCode, body: text };
}

// A lookup can miss simply because Vaultwarden-API has not re-synced since the
// item was added (default SYNC_INTERVAL is 5m). On a miss we POST /refresh -
// which re-syncs synchronously - and retry once. Rate-limited per API base URL
// so a probe firing on every keystroke (or a genuine typo) cannot spam it.
const REFRESH_COOLDOWN_MS = 60_000;
const lastRefreshAt = new Map<string, number>();

/** Clear the per-base-URL `POST /refresh` cooldown (provider config change / tests). */
export function resetVaultwardenRefreshCooldown(): void {
	lastRefreshAt.clear();
}

/** Force a Vaultwarden-API re-sync (`POST /refresh`), at most once per cooldown
 *  per API base URL. Best-effort: returns true only when a refresh actually ran
 *  and succeeded, so the caller knows a retry is worthwhile. Never throws. */
async function refreshVault(config: VaultwardenConfig, logPrefix: string): Promise<boolean> {
	const base = baseUrl(config);
	const now = Date.now();
	if (now - (lastRefreshAt.get(base) ?? 0) < REFRESH_COOLDOWN_MS) return false;
	lastRefreshAt.set(base, now); // claim the slot before the request

	try {
		const { statusCode, body } = await request(`${base}/refresh`, {
			method: 'POST',
			headers: { authorization: authHeader(config) },
			signal: AbortSignal.timeout(timeoutMs(config))
		});
		await body.text().catch(() => '');
		if (statusCode >= 200 && statusCode < 300) {
			console.log(`${logPrefix} a lookup missed - forced a Vaultwarden-API re-sync`);
			return true;
		}
		console.warn(`${logPrefix} re-sync request returned HTTP ${statusCode}`);
	} catch (e) {
		console.warn(`${logPrefix} re-sync request failed: ${e instanceof Error ? e.message : e}`);
	}
	return false;
}

/** Maps a non-2xx status to an actionable, non-reflecting message. */
function statusMessage(status: number, context: string): string {
	switch (status) {
		case 401:
			return `${context}: authentication failed - check the API key`;
		case 403:
			return `${context}: the API key's scope denies this request`;
		case 404:
			return `${context}: not found`;
		case 429:
			return `${context}: rate limited by Vaultwarden-API`;
		default:
			return `${context}: Vaultwarden-API returned HTTP ${status}`;
	}
}

/** Turns a thrown transport error into a short message (TLS / timeout / unreachable). */
function transportMessage(e: unknown, context: string): string {
	const msg = e instanceof Error ? e.message : String(e);
	if (e instanceof Error && e.name === 'TimeoutError') return `${context}: request timed out`;
	if (/certificate|self-signed|altname|CERT_|TLS|SSL/i.test(msg)) {
		return `${context}: TLS certificate verification failed - the Vaultwarden-API service must present a trusted certificate`;
	}
	if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|fetch failed/i.test(msg)) {
		return `${context}: Vaultwarden-API is unreachable`;
	}
	return `${context}: ${msg}`;
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i]);
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

interface SecretListEntry {
	name: string;
}

/** `GET /secrets` -> the item names visible to this key/filter. Throws on any non-2xx. */
async function listSecretNames(config: VaultwardenConfig, collectionOverride?: string): Promise<string[]> {
	const res = await vwGet(config, `/secrets${filterQuery(config, collectionOverride)}`);
	if (res.statusCode < 200 || res.statusCode >= 300 || !isJsonResponse(res.body)) {
		throw new Error(statusMessage(res.statusCode, 'Vaultwarden list'));
	}
	const parsed = JSON.parse(res.body) as { secrets?: SecretListEntry[] };
	const names = new Set<string>();
	for (const entry of parsed.secrets ?? []) {
		if (entry && typeof entry.name === 'string' && entry.name) names.add(entry.name);
	}
	return [...names];
}

/** `GET /secret/:name` -> the value, or null on 404. Throws on 401/403/5xx. */
async function fetchSecretValue(config: VaultwardenConfig, name: string): Promise<string | null> {
	const res = await vwGet(config, `/secret/${encodeURIComponent(name)}${filterQuery(config)}`);
	if (res.statusCode === 404) return null;
	if (res.statusCode < 200 || res.statusCode >= 300 || !isJsonResponse(res.body)) {
		throw new Error(statusMessage(res.statusCode, `Vaultwarden secret "${name}"`));
	}
	const parsed = JSON.parse(res.body) as { value?: unknown };
	return typeof parsed.value === 'string' ? parsed.value : null;
}

/**
 * Vaultwarden item name -> environment variable key (bulk pull).
 * Rule (spec B4): upper-case, `[^A-Z0-9_]` -> `_`, collapse repeats, strip
 * leading `_` and leading digits.
 */
export function vaultwardenNameToEnvKey(name: string): string {
	return name
		.toUpperCase()
		.replace(/[^A-Z0-9_]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+/, '')
		.replace(/^[0-9]+/, '')
		.replace(/^_+/, '');
}

export const vaultwardenProvider: SecretProvider<VaultwardenConfig> = {
	type: 'vaultwarden',
	label: 'Vaultwarden',
	supportsReferences: true,
	supportsBulk: true,

	isReference(value: unknown): value is string {
		return typeof value === 'string' && VW_REF_RE.test(stripSurroundingQuotes(value));
	},

	async testConnection(config: VaultwardenConfig): Promise<TestConnectionResult> {
		if (!config.apiBaseUrl?.trim()) return { ok: false, error: 'API base URL is required' };
		if (!config.apiKey?.trim()) return { ok: false, error: 'API key is required' };
		try {
			assertSafeProviderHost(config.apiBaseUrl, 'Vaultwarden');

			const health = await vwGet(config, '/health');
			if (health.statusCode < 200 || health.statusCode >= 300 || !isJsonResponse(health.body)) {
				return { ok: false, error: statusMessage(health.statusCode, 'Vaultwarden health check') };
			}
			const healthBody = JSON.parse(health.body) as { status?: unknown };
			if (healthBody.status !== 'ok') {
				return { ok: false, error: 'Vaultwarden health check: unexpected response - is this the Vaultwarden-API service?' };
			}

			const list = await vwGet(config, `/secrets${filterQuery(config)}`);
			if (list.statusCode < 200 || list.statusCode >= 300 || !isJsonResponse(list.body)) {
				return { ok: false, error: statusMessage(list.statusCode, 'Vaultwarden list') };
			}
			const count = (JSON.parse(list.body) as { count?: number }).count ?? 0;
			console.log(`[Vaultwarden] testConnection ok - ${count} secret(s) visible to this key`);
			return { ok: true };
		} catch (e: unknown) {
			return { ok: false, error: transportMessage(e, 'Vaultwarden') };
		}
	},

	async resolveSecretReferences(
		config: VaultwardenConfig,
		refs: string[],
		logPrefix = '[Vaultwarden]'
	): Promise<Map<string, string>> {
		const result = new Map<string, string>();
		if (refs.length === 0) return result;
		assertSafeProviderHost(config.apiBaseUrl, 'Vaultwarden');

		const names = [...new Set(refs.map(refName))];
		const values = new Map<string, string>();

		const fetchInto = async (name: string, onMiss: () => void) => {
			// A transport / auth error propagates and fails the deploy; a plain
			// miss (404) is handled by the caller.
			const value = await fetchSecretValue(config, name).catch((e: unknown) => {
				throw new Error(`${logPrefix} ${e instanceof Error ? e.message : e}`);
			});
			if (value !== null) values.set(name, value);
			else onMiss();
		};

		const missing: string[] = [];
		await mapConcurrent(names, VALUE_FETCH_CONCURRENCY, (name) =>
			fetchInto(name, () => missing.push(name))
		);

		// A miss may just mean the API has not re-synced since the item was added.
		// Force one re-sync (rate-limited) and retry the misses before giving up.
		if (missing.length > 0 && (await refreshVault(config, logPrefix))) {
			const stillMissing: string[] = [];
			await mapConcurrent(missing, VALUE_FETCH_CONCURRENCY, (name) =>
				fetchInto(name, () => stillMissing.push(name))
			);
			missing.length = 0;
			missing.push(...stillMissing);
		}
		for (const name of missing) {
			console.warn(`${logPrefix} Skipping vw://${name}: secret not found`);
		}

		for (const ref of refs) {
			const v = values.get(refName(ref));
			if (v !== undefined) result.set(ref, v);
		}
		return result;
	},

	async resolveBulk(config: VaultwardenConfig, selector: string): Promise<Record<string, string>> {
		assertSafeProviderHost(config.apiBaseUrl, 'Vaultwarden');

		const trimmed = (selector ?? '').trim();
		const collectionOverride = trimmed && !WILDCARD_SELECTORS.has(trimmed.toLowerCase()) ? trimmed : undefined;

		let names = await listSecretNames(config, collectionOverride);
		// An empty result often just means the API has not re-synced since the
		// collection / items were created. Force one re-sync and re-list.
		if (names.length === 0 && (await refreshVault(config, '[Vaultwarden]'))) {
			names = await listSecretNames(config, collectionOverride);
		}

		// Map names -> env keys first so a collision fails before any value is fetched.
		const keyToSource = new Map<string, string>();
		const plan: Array<{ name: string; key: string }> = [];
		for (const name of names) {
			const key = vaultwardenNameToEnvKey(name);
			if (!key) {
				console.warn(`[Vaultwarden] Skipping "${name}": no valid env var key after mapping`);
				continue;
			}
			const existing = keyToSource.get(key);
			if (existing !== undefined && existing !== name) {
				throw new Error(
					`Vaultwarden bulk pull: items "${existing}" and "${name}" both map to env var ${key} - rename one`
				);
			}
			keyToSource.set(key, name);
			plan.push({ name, key });
		}

		const out: Record<string, string> = {};
		await mapConcurrent(plan, VALUE_FETCH_CONCURRENCY, async ({ name, key }) => {
			const value = await fetchSecretValue(config, name);
			if (value !== null) out[key] = value;
			else console.warn(`[Vaultwarden] Skipping "${name}": listed but no value returned`);
		});
		console.log(`[Vaultwarden] bulk pull injected ${Object.keys(out).length} secret(s)`);
		return out;
	},

	// --- cheap probe paths (editor feedback only) --------------------------------
	// One `GET /secrets` call, names only, no value fetch and NO forced re-sync -
	// so a probe firing on every keystroke costs a single request regardless of
	// how many refs, and cannot trip the API rate limit. A recently-added secret
	// still turns green on the next background sync or on a deploy (which does
	// force a re-sync).

	async probeReferences(config: VaultwardenConfig, refs: string[]): Promise<string[]> {
		if (refs.length === 0) return [];
		assertSafeProviderHost(config.apiBaseUrl, 'Vaultwarden');
		const res = await vwGet(config, `/secrets${filterQuery(config)}`);
		if (res.statusCode === 401 || res.statusCode === 403) {
			throw new Error(statusMessage(res.statusCode, 'Vaultwarden'));
		}
		if (res.statusCode < 200 || res.statusCode >= 300 || !isJsonResponse(res.body)) {
			return []; // transient (rate limit / 5xx / blip): "unknown", not an error
		}
		const parsed = JSON.parse(res.body) as { secrets?: Array<{ name?: unknown }> };
		const present = new Set(
			(parsed.secrets ?? [])
				.map((s) => (typeof s.name === 'string' ? s.name.toLowerCase() : ''))
				.filter(Boolean)
		);
		return refs.filter((ref) => present.has(refName(ref).toLowerCase()));
	},

	async listBulkKeys(config: VaultwardenConfig, selector: string): Promise<string[]> {
		assertSafeProviderHost(config.apiBaseUrl, 'Vaultwarden');
		const trimmed = (selector ?? '').trim();
		const collectionOverride =
			trimmed && !WILDCARD_SELECTORS.has(trimmed.toLowerCase()) ? trimmed : undefined;
		const names = await listSecretNames(config, collectionOverride);
		const keys = new Set<string>();
		for (const name of names) {
			const key = vaultwardenNameToEnvKey(name);
			if (key) keys.add(key);
		}
		return [...keys];
	}
};
