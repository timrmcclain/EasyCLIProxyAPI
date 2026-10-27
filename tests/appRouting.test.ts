import { describe, expect, it } from 'bun:test';
import { whyThisAccount } from '../src/services/activityFeed';
import { appIdFromUserAgent, appRoutingService, readRules, routingAccounts, ruleFor, ruleUses } from '../src/services/appRouting';
import { pluginsApi } from '../src/services/plugins';
import type { AuthFile } from '../src/services/quotaService';
import type { ProviderPlan } from '../src/services/routingOrder';

const file = (name: string, provider: string, extra: Partial<AuthFile> = {}): AuthFile =>
  ({ name, provider, email: name.replace(/\.json$/, ''), ...extra }) as AuthFile;

describe('App Routing', () => {
  it('reads rules, dropping malformed ones and rules without accounts', () => {
    expect(readRules({ rules: {
      'claude-desktop': { accounts: ['work@x.json', 7, ''], providers: ['claude'], only: 'yes' },
      codex: { accounts: [] },
      bad: 'nope',
      hermes: { accounts: ['h.json'], only: true },
    } })).toEqual({
      'claude-desktop': { accounts: ['work@x.json'], providers: ['claude'], only: false },
      hermes: { accounts: ['h.json'], providers: [], only: true },
    });
    expect(readRules({})).toEqual({});
    expect(readRules({ rules: ['x'] })).toEqual({});
  });

  it('names apps the way the plugin does, Claude Desktop before Claude Code', () => {
    expect(appIdFromUserAgent('claude-cli/2.1.0 (claude-desktop-3p)')).toBe('claude-desktop');
    expect(appIdFromUserAgent('claude-cli/2.1.0 (external, cli)')).toBe('claude-code');
    expect(appIdFromUserAgent('codex_cli_rs/0.50.0')).toBe('codex');
    expect(appIdFromUserAgent('curl/8.5')).toBe('other');
  });

  it('offers enabled accounts, and a rule covers only the providers of the accounts picked', () => {
    const accounts = routingAccounts([
      file('work@x.com.json', 'claude'), file('me@x.com.json', 'anthropic'), file('c@x.com.json', 'codex'),
      file('off@x.com.json', 'claude', { disabled: true }),
    ]);
    expect(accounts.map(account => account.name)).toEqual(['me@x.com.json', 'work@x.com.json', 'c@x.com.json']);
    expect(ruleFor(accounts, ['work@x.com.json'], false)).toEqual({ accounts: ['work@x.com.json'], providers: ['claude'], only: false });
    expect(ruleFor(accounts, ['nothing'], true)).toBeNull();
    expect(ruleUses({ accounts: ['Work@X.com.json'], providers: [], only: false }, 'work@x.com.json')).toBe(true);
  });

  it("says when an app's own accounts explain why it used one", () => {
    const entry = (name: string) => ({ file: file(name, 'claude'), name }) as unknown as ProviderPlan['entries'][number];
    const plans = [{ entries: [entry('top@x.com.json'), entry('work@x.com.json')], next: null }] as unknown as ProviderPlan[];
    const rule = { accounts: ['work@x.com.json'], providers: ['claude'], only: false };
    expect(whyThisAccount('work@x.com', plans, rule)).toEqual({ kind: 'rule' });
    expect(whyThisAccount('work@x.com', plans).kind).toBe('below');
    expect(whyThisAccount('top@x.com', plans, rule).kind).toBe('first');
  });

  it('keeps other apps when setting one, removes a rule completely, and installs only for the first rule', async () => {
    const original = { getConfig: pluginsApi.getConfig, putConfig: pluginsApi.putConfig, getSettings: pluginsApi.getSettings, updateSettings: pluginsApi.updateSettings };
    const writes: Record<string, unknown>[] = [];
    let config: Record<string, unknown> = { enabled: true, priority: 100, rules: { codex: { accounts: ['c.json'], providers: ['codex'] } } };
    pluginsApi.getConfig = async () => config;
    pluginsApi.putConfig = async (_id, next) => { writes.push(next); config = next; };
    pluginsApi.getSettings = async () => ({ enabled: true, dir: 'plugins', storeSources: [], storeAuth: [] });
    pluginsApi.updateSettings = async () => undefined;
    try {
      await appRoutingService.setRule('claude-desktop', { accounts: ['w.json'], providers: ['claude'], only: true });
      expect(writes[0].rules).toEqual({
        codex: { accounts: ['c.json'], providers: ['codex'], only: false },
        'claude-desktop': { accounts: ['w.json'], providers: ['claude'], only: true },
      });
      await appRoutingService.setRule('codex', null);
      expect(Object.keys(writes[1].rules as object)).toEqual(['claude-desktop']);
      expect(writes[1].enabled).toBe(true);
    } finally {
      Object.assign(pluginsApi, original);
    }
  });

  it('never writes the rules when the current config could not be read', async () => {
    const original = { getConfig: pluginsApi.getConfig, putConfig: pluginsApi.putConfig };
    const writes: unknown[] = [];
    pluginsApi.getConfig = async () => { throw new Error('Management API error (500): busy'); };
    pluginsApi.putConfig = async (_id, next) => { writes.push(next); };
    try {
      await expect(appRoutingService.setRule('codex', null)).rejects.toThrow('busy');
      expect(writes).toEqual([]);
    } finally {
      Object.assign(pluginsApi, original);
    }
  });
});
