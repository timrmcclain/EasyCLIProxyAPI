import { LogIn } from 'lucide-react';
import { useI18n } from '../i18n';
import { authFileHealth } from '../services/authFileHealth';
import type { MessageKey } from '../i18n/resources';
import antigravityIcon from '../assets/icons/antigravity.svg';
import claudeIcon from '../assets/icons/claude.svg';
import codexIcon from '../assets/icons/codex.svg';
import deepseekIcon from '../assets/icons/deepseek.svg';
import devinIcon from '../assets/icons/devin.svg';
import geminiIcon from '../assets/icons/gemini.svg';
import grokIcon from '../assets/icons/grok.svg';
import kimiIcon from '../assets/icons/kimi-light.svg';
import metaIcon from '../assets/icons/meta.svg';
import vertexIcon from '../assets/icons/vertex.svg';

/** One source of truth for provider brand marks: account cards, group headings, summary tiles and Saved accounts rows. */
const providerIconSources: Record<string, string> = {
  antigravity: antigravityIcon,
  claude: claudeIcon,
  codex: codexIcon,
  deepseek: deepseekIcon,
  devin: devinIcon,
  gemini: geminiIcon,
  kimi: kimiIcon,
  meta: metaIcon,
  vertex: vertexIcon,
  xai: grokIcon,
};

const providerAliases: Record<string, string> = {
  anthropic: 'claude', openai: 'codex', 'x-ai': 'xai', grok: 'xai', cognition: 'devin',
  'anti-gravity': 'antigravity', muse: 'meta', 'gemini-cli': 'gemini', aistudio: 'gemini', moonshot: 'kimi',
};

export const normalizeProviderIconKey = (provider: string | null | undefined) => {
  const value = (provider ?? '').trim().toLowerCase().replace(/_/g, '-');
  return providerAliases[value] ?? value;
};

export const providerIconSrc = (provider: string | null | undefined): string | undefined =>
  providerIconSources[normalizeProviderIconKey(provider)];

/** Brand logo when an asset exists, otherwise the provider's first letter (⌘ for the "all" filter). */
export function ProviderLogo({ provider, className = '' }: { provider: string | null | undefined; className?: string }) {
  const key = normalizeProviderIconKey(provider);
  const src = providerIconSources[key];
  if (src) return <img className={`quota-provider-icon quota-icon-${key} ${className}`.trim()} src={src} alt="" data-provider={key} />;
  return <span aria-hidden="true" className={`ledger-provider-icon ${className}`.trim()}>{key === 'all' ? '⌘' : (key.slice(0, 1) || '?').toUpperCase()}</span>;
}

// Health states that only a fresh sign-in can fix (as opposed to quota pauses or upstream errors).
const signInLabels = new Set<MessageKey>([
  'authFiles.health.reason.invalidGrant',
  'authFiles.health.reason.unauthorized',
  'authFiles.health.reason.tokenExpired',
]);

export function needsSignIn(file: Record<string, unknown>) {
  const health = authFileHealth(file);
  return !health.disabled && signInLabels.has(health.label);
}

export const openSignIn = () => { window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'oauth' })); };

export function SignInAgainButton({ className = 'secondary-button compact-button', account }: { className?: string; account?: string }) {
  const { t } = useI18n();
  return <button type="button" className={`auth-sign-in-again ${className}`} onClick={openSignIn}
    title={t('authFiles.signInAgainHint')} aria-label={account ? `${t('authFiles.signInAgain')} · ${account}` : undefined}>
    <LogIn size={14} aria-hidden="true" />{t('authFiles.signInAgain')}
  </button>;
}
