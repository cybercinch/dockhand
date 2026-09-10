import { describe, test, expect } from 'bun:test';
import {
	refSchemeFor,
	isProviderRef,
	stripQuotes,
	providerRefStatuses,
	ALL_PROVIDER_REF_SCHEMES
} from '../src/lib/utils/provider-ref.ts';

describe('refSchemeFor', () => {
	test('maps known provider types, undefined for bulk-only / null', () => {
		expect(refSchemeFor('vaultwarden')).toBe('vw://');
		expect(refSchemeFor('op-service-account')).toBe('op://');
		expect(refSchemeFor('op-connect')).toBe('op://');
		expect(refSchemeFor('keepass')).toBe('keepass://');
		expect(refSchemeFor('doppler')).toBeUndefined();
		expect(refSchemeFor(null)).toBeUndefined();
	});
});

describe('stripQuotes / isProviderRef', () => {
	test('strips one matching quote layer for detection', () => {
		expect(stripQuotes('  "vw://X"  ')).toBe('vw://X');
		expect(stripQuotes("'vw://X'")).toBe('vw://X');
		expect(stripQuotes('vw://X"')).toBe('vw://X"'); // mismatched - left as-is
	});
	test('isProviderRef matches only the given provider scheme', () => {
		expect(isProviderRef('vw://DB_PASSWORD', 'vaultwarden')).toBe(true);
		expect(isProviderRef('"vw://DB_PASSWORD"', 'vaultwarden')).toBe(true);
		expect(isProviderRef('op://v/i/f', 'vaultwarden')).toBe(false);
		expect(isProviderRef('vw://X', 'doppler')).toBe(false);
		expect(isProviderRef('plain', 'vaultwarden')).toBe(false);
	});
	test('ALL_PROVIDER_REF_SCHEMES is de-duped', () => {
		expect(ALL_PROVIDER_REF_SCHEMES).toContain('op://');
		expect(ALL_PROVIDER_REF_SCHEMES.filter((s) => s === 'op://')).toHaveLength(1);
	});
});

describe('providerRefStatuses', () => {
	const vars = [
		{ key: 'DB_PASSWORD', value: 'vw://DB_PASSWORD' },
		{ key: 'REDIS_URL', value: 'vw://redis' },
		{ key: 'PLAIN', value: 'hello' },
		{ key: 'OP_ONE', value: 'op://a/b/c' }
	];

	test('resolved when the probe found the var key', () => {
		const m = providerRefStatuses(vars, 'vaultwarden', new Set(['DB_PASSWORD']));
		expect(m.get('DB_PASSWORD')).toBe('resolved');
		expect(m.get('REDIS_URL')).toBe('unresolved');
		expect(m.has('PLAIN')).toBe(false);
		expect(m.has('OP_ONE')).toBe(false); // wrong scheme for this provider
	});

	test('checking while a probe is in flight', () => {
		const m = providerRefStatuses(vars, 'vaultwarden', new Set(), { probing: true });
		expect(m.get('DB_PASSWORD')).toBe('checking');
		expect(m.get('REDIS_URL')).toBe('checking');
	});

	test('unknown (not amber) when the probe could not complete', () => {
		const m = providerRefStatuses(vars, 'vaultwarden', new Set(['DB_PASSWORD']), {
			probeFailed: true
		});
		expect(m.get('DB_PASSWORD')).toBe('resolved'); // a hit still stands
		expect(m.get('REDIS_URL')).toBe('unknown'); // absent + probe failed -> unknown
	});

	test('empty when the provider has no ref scheme', () => {
		expect(providerRefStatuses(vars, 'doppler', new Set()).size).toBe(0);
		expect(providerRefStatuses(vars, null, new Set()).size).toBe(0);
	});
});
