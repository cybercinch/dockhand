// Unit tests for the Vaultwarden secret provider. `undici` is mocked at the
// module boundary (bun ships its own `undici`, so MockAgent is not reliable);
// the real vaultwardenProvider is driven end to end.
import { describe, test, expect, beforeEach, mock } from 'bun:test';

/** Registered responders: exact `${method} ${path}` (path includes query) -> handler. */
type Route = (req: { url: URL; headers: Record<string, string> }) => {
	statusCode: number;
	body: unknown;
};
let routes: Map<string, Route>;
let requestLog: Array<{
	method: string;
	path: string;
	auth: string | undefined;
	ua: string | undefined;
}>;

function route(key: string, statusCode: number, body: unknown) {
	routes.set(key, () => ({ statusCode, body }));
}

mock.module('undici', () => ({
	async request(url: string, opts: { method?: string; headers?: Record<string, string> }) {
		const u = new URL(url);
		const method = opts.method ?? 'GET';
		const path = u.pathname + u.search;
		requestLog.push({
			method,
			path,
			auth: opts.headers?.authorization,
			ua: opts.headers?.['user-agent']
		});
		const handler = routes.get(`${method} ${path}`) ?? routes.get(`${method} ${u.pathname}`);
		if (!handler) {
			throw Object.assign(new Error(`fetch failed: no mock for ${method} ${path}`), {
				code: 'ENOTFOUND'
			});
		}
		const { statusCode, body } = handler({ url: u, headers: opts.headers ?? {} });
		const text = typeof body === 'string' ? body : JSON.stringify(body);
		return { statusCode, body: { text: async () => text, json: async () => JSON.parse(text) } };
	}
}));

const { vaultwardenProvider, vaultwardenNameToEnvKey, resetVaultwardenRefreshCooldown } = await import(
	'../src/lib/server/secretproviders/vaultwarden.ts'
);
type VaultwardenConfig = import('../src/lib/server/secretproviders/shared.ts').VaultwardenConfig;

const BASE = 'https://vwapi.test.internal';
const config: VaultwardenConfig = { apiBaseUrl: BASE, apiKey: 'test-key' };

beforeEach(() => {
	routes = new Map();
	requestLog = [];
	resetVaultwardenRefreshCooldown();
});

describe('vaultwardenNameToEnvKey', () => {
	test('valid keys pass through, others are normalised', () => {
		expect(vaultwardenNameToEnvKey('POSTGRES_PASSWORD')).toBe('POSTGRES_PASSWORD');
		expect(vaultwardenNameToEnvKey('pg password')).toBe('PG_PASSWORD');
		expect(vaultwardenNameToEnvKey('redis-url.prod')).toBe('REDIS_URL_PROD');
		expect(vaultwardenNameToEnvKey('123 leading digits')).toBe('LEADING_DIGITS');
	});
});

describe('isReference', () => {
	test('matches vw:// and nothing else', () => {
		expect(vaultwardenProvider.isReference('vw://POSTGRES_PASSWORD')).toBe(true);
		expect(vaultwardenProvider.isReference('"vw://POSTGRES_PASSWORD"')).toBe(true);
		expect(vaultwardenProvider.isReference('op://vault/item/field')).toBe(false);
		expect(vaultwardenProvider.isReference('vw://')).toBe(false);
		expect(vaultwardenProvider.isReference('plain-value')).toBe(false);
	});
});

describe('testConnection', () => {
	test('health ok + list ok -> ok', async () => {
		route('GET /health', 200, { status: 'ok', service: 'vaultwarden-api' });
		route('GET /secrets', 200, { count: 4, secrets: [] });
		expect(await vaultwardenProvider.testConnection(config)).toEqual({ ok: true });
	});

	test('sends the API key as a Bearer Authorization header + a Dockhand user-agent', async () => {
		route('GET /health', 200, { status: 'ok' });
		route('GET /secrets', 200, { count: 0, secrets: [] });
		await vaultwardenProvider.testConnection(config);
		expect(requestLog.every((r) => r.auth === 'Bearer test-key')).toBe(true);
		expect(requestLog.every((r) => /^Dockhand\/.+vaultwarden-secret-provider/.test(r.ua ?? ''))).toBe(
			true
		);
	});

	test('does not double the Bearer prefix if the key already has one', async () => {
		route('GET /health', 200, { status: 'ok' });
		route('GET /secrets', 200, { count: 0, secrets: [] });
		await vaultwardenProvider.testConnection({ apiBaseUrl: BASE, apiKey: 'Bearer test-key' });
		expect(requestLog.every((r) => r.auth === 'Bearer test-key')).toBe(true);
	});

	test('401 on the list -> auth failed message', async () => {
		route('GET /health', 200, { status: 'ok' });
		route('GET /secrets', 401, { error: 'unauthorized' });
		const res = await vaultwardenProvider.testConnection(config);
		expect(res.ok).toBe(false);
		expect(res.error).toContain('authentication failed');
	});

	test('non-vaultwarden host -> clear message', async () => {
		route('GET /health', 200, '<html>hi</html>');
		const res = await vaultwardenProvider.testConnection(config);
		expect(res.ok).toBe(false);
		expect(res.error).toContain('health check');
	});

	test('unreachable host -> friendly message', async () => {
		const res = await vaultwardenProvider.testConnection(config); // no routes registered
		expect(res.ok).toBe(false);
		expect(res.error).toContain('unreachable');
	});

	test('missing config is reported without a request', async () => {
		const res = await vaultwardenProvider.testConnection({ apiBaseUrl: '', apiKey: '' });
		expect(res).toEqual({ ok: false, error: 'API base URL is required' });
		expect(requestLog).toHaveLength(0);
	});
});

describe('resolveSecretReferences', () => {
	test('resolves each unique ref, url-encodes the name, dedupes', async () => {
		route('GET /secret/my%20secret', 200, { name: 'my secret', value: 's3cret' });
		route('GET /secret/REDIS_URL', 200, { name: 'REDIS_URL', value: 'redis://x' });

		const out = await vaultwardenProvider.resolveSecretReferences(config, [
			'vw://my secret',
			'vw://REDIS_URL',
			'vw://my secret'
		]);
		expect(out.get('vw://my secret')).toBe('s3cret');
		expect(out.get('vw://REDIS_URL')).toBe('redis://x');
		expect(out.size).toBe(2);
		expect(requestLog.filter((r) => r.path.startsWith('/secret/')).length).toBe(2);
	});

	test('a 404 forces one POST /refresh and retries; still-missing -> warning, no error', async () => {
		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (...a: unknown[]) => warnings.push(a.join(' '));
		try {
			route('GET /secret/GONE', 404, { error: 'not found' });
			route('POST /refresh', 200, { status: 'ok' });
			const out = await vaultwardenProvider.resolveSecretReferences(config, ['vw://GONE']);
			expect(out.size).toBe(0);
			expect(requestLog.filter((r) => r.path === '/refresh' && r.method === 'POST')).toHaveLength(1);
			// GONE fetched once, then re-fetched after the refresh.
			expect(requestLog.filter((r) => r.path === '/secret/GONE')).toHaveLength(2);
			expect(warnings.some((w) => w.includes('vw://GONE') && w.includes('not found'))).toBe(true);
		} finally {
			console.warn = origWarn;
		}
	});

	test('a recently-added item resolves after the forced re-sync', async () => {
		let synced = false;
		routes.set('POST /refresh', () => {
			synced = true;
			return { statusCode: 200, body: { status: 'ok' } };
		});
		routes.set('GET /secret/NEW', () =>
			synced
				? { statusCode: 200, body: { name: 'NEW', value: 's3cret' } }
				: { statusCode: 404, body: { error: 'not found' } }
		);
		const out = await vaultwardenProvider.resolveSecretReferences(config, ['vw://NEW']);
		expect(out.get('vw://NEW')).toBe('s3cret');
	});

	test('the refresh is rate-limited: a second miss does not re-refresh within the cooldown', async () => {
		route('GET /secret/A', 404, { error: 'nope' });
		route('GET /secret/B', 404, { error: 'nope' });
		route('POST /refresh', 200, { status: 'ok' });
		await vaultwardenProvider.resolveSecretReferences(config, ['vw://A']);
		await vaultwardenProvider.resolveSecretReferences(config, ['vw://B']);
		expect(requestLog.filter((r) => r.path === '/refresh')).toHaveLength(1);
	});

	test('401 propagates as a thrown error (fails the deploy)', async () => {
		route('GET /secret/X', 401, { error: 'nope' });
		await expect(
			vaultwardenProvider.resolveSecretReferences(config, ['vw://X'])
		).rejects.toThrow(/authentication failed/);
	});

	test('never logs the API key or a secret value', async () => {
		const logs: string[] = [];
		const orig = { log: console.log, warn: console.warn, error: console.error };
		console.log = console.warn = console.error = (...a: unknown[]) => logs.push(a.join(' '));
		try {
			route('GET /secret/A', 200, { name: 'A', value: 'TOPSECRET' });
			await vaultwardenProvider.resolveSecretReferences(config, ['vw://A']);
		} finally {
			Object.assign(console, orig);
		}
		const joined = logs.join('\n');
		expect(joined).not.toContain('TOPSECRET');
		expect(joined).not.toContain('test-key');
	});
});

describe('resolveBulk', () => {
	test('lists then fetches each value, mapping names to env keys', async () => {
		route('GET /secrets?collection_name=prod', 200, {
			count: 2,
			secrets: [{ name: 'POSTGRES_PASSWORD' }, { name: 'redis url' }]
		});
		route('GET /secret/POSTGRES_PASSWORD', 200, { value: 'pw' });
		route('GET /secret/redis%20url', 200, { value: 'redis://y' });

		const out = await vaultwardenProvider.resolveBulk(config, 'prod');
		expect(out).toEqual({ POSTGRES_PASSWORD: 'pw', REDIS_URL: 'redis://y' });
	});

	test('wildcard selector adds no collection filter', async () => {
		route('GET /secrets', 200, { count: 0, secrets: [] });
		route('POST /refresh', 200, { status: 'ok' });
		expect(await vaultwardenProvider.resolveBulk(config, '*')).toEqual({});
	});

	test('an empty list forces a re-sync and re-lists once', async () => {
		let synced = false;
		routes.set('POST /refresh', () => {
			synced = true;
			return { statusCode: 200, body: { status: 'ok' } };
		});
		routes.set('GET /secrets?collection_name=prod', () => ({
			statusCode: 200,
			body: synced ? { count: 1, secrets: [{ name: 'API_TOKEN' }] } : { count: 0, secrets: [] }
		}));
		route('GET /secret/API_TOKEN', 200, { value: 'tok' });
		expect(await vaultwardenProvider.resolveBulk(config, 'prod')).toEqual({ API_TOKEN: 'tok' });
		expect(requestLog.filter((r) => r.path === '/refresh')).toHaveLength(1);
	});

	test('env-key collision is a hard error naming both items', async () => {
		route('GET /secrets', 200, {
			count: 2,
			secrets: [{ name: 'api key' }, { name: 'API-KEY' }]
		});
		await expect(vaultwardenProvider.resolveBulk(config, 'all')).rejects.toThrow(/API_KEY/);
	});
});

describe('probeReferences (cheap probe path)', () => {
	test('one GET /secrets, no value fetch, no refresh; returns the refs that exist', async () => {
		route('GET /secrets', 200, {
			count: 2,
			secrets: [{ name: 'DB_PASSWORD' }, { name: 'redis url' }]
		});
		const found = await vaultwardenProvider.probeReferences!(config, [
			'vw://DB_PASSWORD',
			'vw://redis url',
			'vw://MISSING'
		]);
		expect(found.sort()).toEqual(['vw://DB_PASSWORD', 'vw://redis url']);
		// exactly one request, and it is the list - never /secret/:name or /refresh
		expect(requestLog).toHaveLength(1);
		expect(requestLog[0]).toMatchObject({ method: 'GET', path: '/secrets' });
	});

	test('case-insensitive name match', async () => {
		route('GET /secrets', 200, { count: 1, secrets: [{ name: 'Watchtower_Notification_Url' }] });
		expect(
			await vaultwardenProvider.probeReferences!(config, ['vw://WATCHTOWER_NOTIFICATION_URL'])
		).toEqual(['vw://WATCHTOWER_NOTIFICATION_URL']);
	});

	test('a 429 THROWS (not swallowed) so "couldn\'t check" != "not found"', async () => {
		route('GET /secrets', 429, { error: 'too many requests' });
		await expect(vaultwardenProvider.probeReferences!(config, ['vw://X'])).rejects.toThrow(
			/rate limited/
		);
	});

	test('401 throws (real misconfig the operator should see)', async () => {
		route('GET /secrets', 401, { error: 'unauthorized' });
		await expect(vaultwardenProvider.probeReferences!(config, ['vw://X'])).rejects.toThrow(
			/authentication failed/
		);
	});
});

describe('listBulkKeys (cheap probe path)', () => {
	test('maps names to env keys, no value fetch', async () => {
		route('GET /secrets?collection_name=prod', 200, {
			count: 2,
			secrets: [{ name: 'POSTGRES_PASSWORD' }, { name: 'redis url' }]
		});
		expect((await vaultwardenProvider.listBulkKeys!(config, 'prod')).sort()).toEqual([
			'POSTGRES_PASSWORD',
			'REDIS_URL'
		]);
		expect(requestLog.every((r) => r.path.startsWith('/secrets'))).toBe(true);
	});
});
