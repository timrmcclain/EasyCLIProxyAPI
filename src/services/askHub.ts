import type { AppLocale } from '../i18n';
import type { HomeUsageSummary } from './homeOverview';

/** What "Ask the hub" tells the model about this hub. Counts and states only: no keys, emails or prompts. */
export type HubFacts = {
  proxyRunning: boolean;
  quotaLine: string | null;
  usage24h: HomeUsageSummary | null;
  settings: string[];
  page: string;
};

const languageName = (locale: AppLocale) =>
  locale === 'en' ? 'English' : locale === 'ja' ? 'Japanese' : locale === 'zh-TW' ? 'Traditional Chinese' : 'Simplified Chinese';

export const MAX_QUESTION = 2000;

/**
 * The system prompt for "Ask the hub". The answer has to come from these facts or from how the hub works in
 * general; anything else is "I can't tell from here", so a guess never reads like the hub's own state.
 */
export function buildHubPrompt(facts: HubFacts, locale: AppLocale): string {
  const lines = [
    "You answer questions about the user's own AI hub: a local proxy that sends their AI apps' requests to their",
    'subscription accounts (Claude, Codex, Gemini and others), choosing which account pays for each request.',
    'Use only the facts below about this hub. If they do not answer the question, say you cannot tell from here',
    'and name the page in the app that would show it (Overview, Accounts, Activity, AI apps, Settings).',
    `Answer in ${languageName(locale)}, in at most five short sentences, in plain words. No markdown tables.`,
    '',
    'Facts:',
    `- The proxy is ${facts.proxyRunning ? 'running' : 'not running'}.`,
    `- Quota now: ${facts.quotaLine ?? 'not checked yet'}.`,
    facts.usage24h
      ? `- Last 24 hours: ${facts.usage24h.totalRequests} requests, ${facts.usage24h.failureCount} failed, ${facts.usage24h.canceledCount} canceled.`
      : '- Last 24 hours: usage could not be read.',
    `- The user is on the ${facts.page} page.`,
    ...facts.settings.map(sentence => `- ${sentence}`),
  ];
  return lines.join('\n');
}
