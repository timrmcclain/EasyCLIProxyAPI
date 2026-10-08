export type HelpDestination = 'home' | 'oauth' | 'agents' | 'compression';
export const UX_NAVIGATE = 'personal:navigate-help';
export function navigateHelp(destination: HelpDestination) {
  window.dispatchEvent(new CustomEvent(UX_NAVIGATE, { detail: destination }));
}
