import type { SecretGuardFinding } from './secretGuard';

/**
 * How bad a leaked credential of each kind is, and where to revoke it. Critical keys can spend money or change code
 * and infrastructure; high ones open an account or its data; medium ones are narrow or short-lived.
 */
export type Severity = 'critical' | 'high' | 'medium';

const SEVERITY: Record<string, Severity> = {
  aws_access_key: 'critical', stripe_key: 'critical', private_key: 'critical', azure_client_secret: 'critical',
  azure_storage_key: 'critical', github_token: 'critical', gitlab_token: 'critical', connection_string_password: 'critical',
  google_oauth: 'critical',
  anthropic_key: 'high', openai_key: 'high', openrouter_key: 'high', xai_key: 'high', groq_key: 'high',
  google_api_key: 'high', npm_token: 'high', huggingface_token: 'high', slack_token: 'high',
  slack_webhook: 'medium', jwt: 'medium', password_assignment: 'medium',
};

/** Pages where each kind of key is revoked or replaced. Kinds without one (passwords, JWTs) have no single place. */
const ROTATE_URLS: Record<string, string> = {
  github_token: 'https://github.com/settings/tokens',
  anthropic_key: 'https://console.anthropic.com/settings/keys',
  openai_key: 'https://platform.openai.com/api-keys',
  openrouter_key: 'https://openrouter.ai/settings/keys',
  xai_key: 'https://console.x.ai/',
  groq_key: 'https://console.groq.com/keys',
  google_api_key: 'https://console.cloud.google.com/apis/credentials',
  google_oauth: 'https://console.cloud.google.com/apis/credentials',
  aws_access_key: 'https://console.aws.amazon.com/iam/home#/security_credentials',
  slack_token: 'https://api.slack.com/apps',
  slack_webhook: 'https://api.slack.com/apps',
  stripe_key: 'https://dashboard.stripe.com/apikeys',
  gitlab_token: 'https://gitlab.com/-/user_settings/personal_access_tokens',
  huggingface_token: 'https://huggingface.co/settings/tokens',
  npm_token: 'https://www.npmjs.com/settings/~/tokens',
  azure_storage_key: 'https://portal.azure.com/#view/HubsExtension/BrowseResource/resourceType/Microsoft.Storage%2FStorageAccounts',
  azure_client_secret: 'https://portal.azure.com/#view/Microsoft_AAD_IAM/ActiveDirectoryMenuBlade/~/RegisteredApps',
};

export const secretSeverity = (kind: string): Severity => SEVERITY[kind] ?? 'medium';
export const rotateUrl = (kind: string): string | undefined => ROTATE_URLS[kind];

export type SafetySummary = { caught: number; stopped: number; reported: number; critical: number };

/** The last week: secrets seen, how many were blocked or masked before reaching a provider, and how many were critical. */
export function weeklySafety(findings: SecretGuardFinding[], now: number, days = 7): SafetySummary {
  const recent = findings.filter(item => now - item.lastSeen <= days * 86_400_000);
  const stopped = recent.filter(item => item.actions.some(action => action === 'blocked' || action === 'redacted')).length;
  return {
    caught: recent.length, stopped, reported: recent.length - stopped,
    critical: recent.filter(item => secretSeverity(item.kind) === 'critical').length,
  };
}

/** Which of a sensitive-words list appear in some text, ignoring case, in list order and without repeats. */
export function wordsFoundIn(text: string, words: string[]): string[] {
  const haystack = text.toLocaleLowerCase();
  const seen = new Set<string>();
  return words.map(word => word.trim()).filter(word => {
    const key = word.toLocaleLowerCase();
    if (!word || seen.has(key) || !haystack.includes(key)) return false;
    seen.add(key);
    return true;
  });
}
