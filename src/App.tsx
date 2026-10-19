import { UX_NAVIGATE } from './services/uxNavigation';
import { FloatingNotice, MessageNotice, useAppNotice } from './appNotice';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  Bot,
  Check,
  ChevronUp,
  ExternalLink,
  Gauge,
  History,
  House,
  Languages,
  Lock,
  LogIn,
  Network,
  PackageOpen,
  Plug,
  Puzzle,
  ServerCog,
  Settings,
  X,
  Search,
  Shrink,
  Blocks, KeyRound, ShieldCheck, Stethoscope,
} from 'lucide-react';
import { PERSONAL_APP_NAME, PERSONAL_APP_INITIAL } from './personalEdition';
import { CoreRuntimeProvider, useCoreRuntime, type CoreStatus } from './coreRuntime';
import { useConfirmation } from './components/ConfirmationDialog';
import { noticeStillInTray, startProxyWatcher, startQuotaWatcher } from './services/quotaWatcher';
import { endAccountFocus, readAccountFocus } from './services/accountFocus';
import { applyQuotaRouting, readQuotaRoutingPreference } from './services/quotaRoutingControl';
import { startSecretGuardWatcher } from './services/secretGuardWatcher';
import { readGlobalHotkeyPreference, saveGlobalHotkeyPreference } from './services/dashboardPreferences';
import { CoreUpdateProvider, useCoreUpdate } from './coreUpdate';
import { ConfigPanelPage } from './pages/ConfigPanel';
import { ApiAccessPage } from './pages/ApiAccessPage';
import { KernelPage } from './pages/Kernel';
import { VersionManagementPage } from './pages/VersionManagementPage';
import { OAuthManagementPage } from './pages/ManagementPages';
import { QuotaPage } from './pages/QuotaPage';
import { requestAccountsView } from './oauthNavigation';
import { NEW_NAVIGATION_EVENT, groupForPage, mainNavGroups, pageForGroup, readNewNavigationPreference, utilityNavGroups, type NavGroup } from './navigationGroups';
import { AgentsPage } from './pages/AgentsPage';
import { GlossaryDialog } from './components/GlossaryDialog';
import { UsageRecordsPage } from './pages/UsageRecordsPage';
import { PluginsPage } from './pages/PluginsPage';
import { ConnectorsPage } from './pages/ConnectorsPage';
import CompressionPage from './pages/CompressionPage';
import { HealthCheckPage } from './pages/HealthCheckPage';
import { JevPage } from './pages/JevPage';
import { SecretGuardPage } from './pages/SecretGuardPage';
import { ClaudeExtensionsPage } from './pages/ClaudeExtensionsPage';
import { languageOptions, useI18n } from './i18n';
import { AppUpdateDialog, AppUpdateProvider, useAppUpdate } from './appUpdate';
import { appUpdateIndicatorState } from './appUpdateModel';
import { canOpenAppPage, isAlwaysAvailablePage } from './navigation';
import { useThemePreference } from './theme';
import { useDialogFocusTrap } from './components/useDialogFocusTrap';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { confirmLeave } from './services/unsavedChanges';
import { readableError } from './services/readableError';


const pages = [
  {
    id: 'home',
    labelKey: 'app.nav.home',
    icon: House,
    component: HomePage,
  },
  {
    id: 'api',
    labelKey: 'app.nav.api',
    icon: Network,
    component: ApiAccessPage,
  },
  {
    id: 'oauth',
    labelKey: 'app.nav.oauth',
    icon: LogIn,
    component: OAuthManagementPage,
  },
  {
    id: 'quota',
    labelKey: 'app.nav.quota',
    icon: Gauge,
    component: QuotaPage,
  },
  {
    id: 'agents',
    labelKey: 'app.nav.agents',
    icon: Bot,
    component: AgentsPage,
  },
  {
    id: 'proxy',
    labelKey: 'app.nav.proxy',
    icon: ServerCog,
    component: ProxyPage,
  },
  {
    id: 'usage-records',
    labelKey: 'app.nav.usageRecords',
    icon: History,
    component: UsageRecordsPage,
  },
  {
    id: 'secret-guard',
    labelKey: 'app.nav.secretGuard',
    icon: KeyRound,
    component: SecretGuardPage,
  },
  {
    id: 'plugins',
    labelKey: 'app.nav.plugins',
    icon: Puzzle,
    component: PluginsPage,
  },
  {
    id: 'connectors',
    labelKey: 'app.nav.connectors',
    icon: Plug,
    component: ConnectorsPage,
  },
  {
    id: 'compression',
    labelKey: 'app.nav.compression',
    icon: Shrink,
    component: CompressionPage,
  },
  {
    id: 'health',
    labelKey: 'app.nav.health',
    icon: Stethoscope,
    component: HealthCheckPage,
  },
  {
    id: 'jev',
    labelKey: 'app.nav.jev',
    icon: ShieldCheck,
    component: JevPage,
  },
  {
    id: 'claude-extensions',
    labelKey: 'app.nav.claudeExtensions',
    icon: Blocks,
    component: ClaudeExtensionsPage,
  },
  {
    id: 'config',
    labelKey: 'app.nav.config',
    icon: Settings,
    component: ConfigPanelPage,
  },
  {
    id: 'versions',
    labelKey: 'app.nav.versions',
    icon: PackageOpen,
    component: VersionManagementPageWrapper,
  },
] as const;

type PageId = (typeof pages)[number]['id'];
// Everyday pages; the rest live under Advanced tools. Quota Lookup and Proxy are part of Home.
// Extra words people search for that are not in the page name.
const paletteKeywords: Partial<Record<PageId, readonly string[]>> = {
  home: ['dashboard', 'status', 'quota'],
  oauth: ['sign in', 'login', 'accounts'],
  'usage-records': ['requests', 'logs', 'usage', 'history', 'export'],
  'secret-guard': ['credentials', 'leak', 'redact', 'security'],
  agents: ['claude code', 'codex', 'clients', 'connected apps'],
  config: ['settings', 'preferences', 'routing'],
  proxy: ['start', 'stop', 'port', 'core'],
  api: ['keys', 'api key', 'gemini', 'openai', 'provider'],
  versions: ['update', 'upgrade', 'version', 'about'],
  health: ['diagnostics', 'doctor', 'uptime', 'report'],
  quota: ['limits', 'usage', 'quota', 'quotas'],
};

const primaryNav: PageId[] = ['home', 'oauth', 'usage-records', 'secret-guard', 'agents', 'connectors', 'config'];
// Grouped by what they manage, so the proxy's pages sit together and the two kinds of "plugins" are told apart.
const advancedGroups: ReadonlyArray<{ labelKey: 'personal.advanced.proxy' | 'personal.advanced.claude' | 'personal.advanced.diagnostics'; ids: PageId[] }> = [
  { labelKey: 'personal.advanced.proxy', ids: ['proxy', 'api', 'plugins', 'versions'] },
  { labelKey: 'personal.advanced.claude', ids: ['claude-extensions', 'compression', 'jev'] },
  { labelKey: 'personal.advanced.diagnostics', ids: ['health'] },
];
const advancedNav: PageId[] = advancedGroups.flatMap((group) => group.ids);
// Icons for the prototype groups whose first page's icon doesn't describe the group.
const groupIcons: Partial<Record<string, typeof House>> = { 'ai-apps': Bot, tools: Plug, safety: ShieldCheck, diagnostics: Stethoscope };
const LAST_PAGE_KEY = 'personal.lastPage';

function initialPage(): PageId {
  try {
    const saved = localStorage.getItem(LAST_PAGE_KEY);
    // Quota Lookup is now a view of Accounts.
    if (saved === 'quota') { requestAccountsView('quotas'); return 'oauth'; }
    return saved && pages.some((page) => page.id === saved) ? saved as PageId : 'home';
  } catch { return 'home'; }
}

/** Typing in a field should never trigger single-key shortcuts. */
function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)));
}
type WindowsCloseAction = 'exit' | 'minimize-to-tray';
type WindowsCloseBehavior = 'ask' | WindowsCloseAction;

type WindowsClosePrompt = {
  resolvingAction: WindowsCloseAction | null;
  rememberChoice: boolean;
  error: string | null;
};

type GuiSettings = {
  closeBehavior: WindowsCloseBehavior;
};

function HomePage() {
  return <KernelPage view="home" />;
}

function ProxyPage() {
  return <KernelPage view="proxy" />;
}

function VersionManagementPageWrapper() {
  return <VersionManagementPage />;
}

function App() {
  return (
    <AppUpdateProvider>
      <CoreRuntimeProvider>
        <CoreUpdateProvider>
          <AppContent />
        </CoreUpdateProvider>
      </CoreRuntimeProvider>
    </AppUpdateProvider>
  );
}

function AppContent() {
  const { locale, setLocale, t } = useI18n();
  const { info: appUpdateInfo, hasUpdate, processing: appUpdateProcessing } = useAppUpdate();
  const { latest: coreLatest, hasUpdate: coreHasUpdate } = useCoreUpdate();
  const [active, setActive] = useState<PageId>(initialPage);
  // The prototype navigation from the UI review, switched on in Settings → App preferences.
  const [newNav, setNewNav] = useState(readNewNavigationPreference);
  useEffect(() => {
    const changed = (event: Event) => setNewNav(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(NEW_NAVIGATION_EVENT, changed);
    return () => window.removeEventListener(NEW_NAVIGATION_EVENT, changed);
  }, []);
  const lastInGroup = useRef<Record<string, string>>({});
  useEffect(() => {
    const group = groupForPage(active);
    if (group) lastInGroup.current[group.id] = active;
  }, [active]);
  // Ctrl+1–7 open the six main groups and Settings, or the old primary pages with the switch off.
  const shortcutTargets = (): PageId[] => newNav
    ? [...mainNavGroups, utilityNavGroups[0]].map((group) => pageForGroup(group, lastInGroup.current) as PageId)
    : primaryNav;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [homeProblems, setHomeProblems] = useState(0);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() => {
    try { return localStorage.getItem('personal.density') === 'compact' ? 'compact' : 'comfortable'; } catch { return 'comfortable'; }
  });
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false);
  const [theme, setTheme] = useThemePreference();
  const [windowsClosePrompt, setWindowsClosePrompt] = useState<WindowsClosePrompt | null>(null);
  const closeDialogRef = useDialogFocusTrap<HTMLElement>({
    active: Boolean(windowsClosePrompt),
    onEscape: windowsClosePrompt?.resolvingAction
      ? undefined
      : () => setWindowsClosePrompt(null),
    preventEscape: Boolean(windowsClosePrompt?.resolvingAction),
  });
  const languageMenuRef = useRef<HTMLDivElement>(null);
  const languageButtonRef = useRef<HTMLButtonElement>(null);
  const { status, publishStatus } = useCoreRuntime();
  const coreReady = Boolean(status?.ready);
  const { askConfirmation, confirmationDialog } = useConfirmation();
  const paletteFeedback = useAppNotice();
  const restartingRef = useRef(false);
  // Quota checks, run-out forecasts and Windows notifications keep working with the window in the tray.
  useEffect(() => (coreReady ? startQuotaWatcher() : undefined), [coreReady]);
  // Ends "use this account for an hour" on time, and on the next start if the hub was closed when the hour ran out.
  useEffect(() => {
    if (!coreReady) return;
    let running = false;
    const check = async () => {
      const focus = readAccountFocus();
      if (running || !focus || Date.now() < focus.until) return;
      running = true;
      try {
        const routing = readQuotaRoutingPreference();
        await endAccountFocus(routing);
        if (routing) await applyQuotaRouting();
      } catch { /* the proxy is unreachable: try again on the next tick */ }
      finally { running = false; }
    };
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    return () => window.clearInterval(timer);
  }, [coreReady]);
  // Runs whether or not the proxy is up, so it can notice the proxy stopping and coming back.
  useEffect(() => startProxyWatcher(), []);
  useEffect(() => startSecretGuardWatcher(), []);
  useEffect(() => {
    // Re-claim the shortcut each launch. If another app now owns it, say so and switch the setting off,
    // rather than leaving Settings showing a shortcut that does nothing.
    if (readGlobalHotkeyPreference()) invoke('set_global_hotkey', { enabled: true }).catch((error) => {
      saveGlobalHotkeyPreference(false);
      paletteFeedback.showNotice({ key: 'hotkey.failed', variables: { error: readableError(error) } }, 'error');
    });
  }, []);
  const activePage = pages.find((page) => page.id === active) ?? pages[0];
  const ActivePage = activePage.component;
  const selectedLanguage = languageOptions.find((option) => option.value === locale)
    ?? languageOptions[0];
  const availableUpdateLabel = [
    hasUpdate
      ? t('appUpdate.badgeAvailable', { version: appUpdateInfo?.latestVersion ?? '' })
      : '',
    coreHasUpdate
      ? `${t('kernel.versions.coreCardTitle')}: ${t('kernel.update.available')} ${coreLatest?.version ?? ''}`.trim()
      : '',
  ].filter(Boolean).join(' · ');
  // Until the proxy has reported in (or while it's starting) the last page can't be judged yet; falling back
  // to Overview then would throw away the page you left the hub on every time it launches.
  const coreSettling = status === null || (status.starting && !status.ready);
  useEffect(() => {
    if (!coreSettling && !canOpenAppPage(active, coreReady)) {
      setActive('home');
    }
  }, [active, coreReady, coreSettling]);

  useEffect(() => {
    try { localStorage.setItem(LAST_PAGE_KEY, active); } catch { /* Remembering the page is optional. */ }
  }, [active]);

  useEffect(() => {
    document.documentElement.dataset.density = density;
    try { localStorage.setItem('personal.density', density); } catch { /* Density is a display preference. */ }
  }, [density]);

  useEffect(() => {
    const openGlossary = () => setGlossaryOpen(true);
    window.addEventListener('app:glossary', openGlossary);
    return () => window.removeEventListener('app:glossary', openGlossary);
  }, []);

  useEffect(() => {
    const onProblems = (event: Event) => setHomeProblems(Number((event as CustomEvent<number>).detail) || 0);
    window.addEventListener('app:account-problems', onProblems);
    return () => window.removeEventListener('app:account-problems', onProblems);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (mod && /^[1-7]$/.test(event.key)) {
        event.preventDefault();
        const target = shortcutTargets()[Number(event.key) - 1];
        if (target && canOpenAppPage(target, coreReady) && (target === active || confirmLeave())) setActive(target);
        return;
      }
      if (event.key === '/' && !mod && !event.altKey && !isTypingTarget(event.target)) {
        const search = document.querySelector<HTMLInputElement>('main input[type="search"]');
        if (search) { event.preventDefault(); search.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [coreReady, active]);

  useEffect(() => {
    if (!languageMenuOpen) return undefined;
    const closeFromOutside = (event: PointerEvent) => {
      if (!languageMenuRef.current?.contains(event.target as Node)) {
        setLanguageMenuOpen(false);
      }
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setLanguageMenuOpen(false);
      languageButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', closeFromOutside);
    document.addEventListener('keydown', closeFromKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside);
      document.removeEventListener('keydown', closeFromKeyboard);
    };
  }, [languageMenuOpen]);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;

    const handleWindowsCloseRequest = async () => {
      try {
        const settings = await invoke<GuiSettings>('get_gui_settings');
        if (settings.closeBehavior !== 'ask') {
          await resolveWindowsCloseRequest(settings.closeBehavior, false);
          return;
        }
      } catch (error) {
        console.error('Failed to read close behavior settings', error);
      }

      setWindowsClosePrompt((current) =>
        current ?? {
          resolvingAction: null,
          rememberChoice: false,
          error: null,
        },
      );
    };

    void listen('windows-close-requested', () => {
      void handleWindowsCloseRequest();
    })
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          stopListening = stop;
        }
      })
      .catch((error) => {
        console.error('Failed to listen for Windows close confirmation events', error);
      });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  const handleLanguageListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    if (!options.length) return;
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowDown'
          ? (Math.max(current, -1) + 1) % options.length
          : (current <= 0 ? options.length : current) - 1;
    event.preventDefault();
    options[next]?.focus();
  };

  useEffect(() => {
    const navigate = (event: Event) => {
      const target = (event as CustomEvent<unknown>).detail;
      if ((target === 'home' || target === 'oauth' || target === 'agents' || target === 'compression' || target === 'secret-guard') && canOpenAppPage(target, coreReady) && (target === active || confirmLeave())) setActive(target);
    };
    window.addEventListener(UX_NAVIGATE, navigate);
    return () => window.removeEventListener(UX_NAVIGATE, navigate);
  }, [coreReady, active]);

  // The sidebar scrolls on short windows; fade its bottom edge while pages are hidden below.
  const navSectionRef = useRef<HTMLElement>(null);
  const [navMoreBelow, setNavMoreBelow] = useState(false);
  const updateNavMoreBelow = useCallback(() => {
    const nav = navSectionRef.current;
    setNavMoreBelow(Boolean(nav) && nav!.scrollHeight - nav!.scrollTop - nav!.clientHeight > 4);
  }, []);
  useEffect(() => {
    const nav = navSectionRef.current;
    if (!nav) return;
    updateNavMoreBelow();
    const observer = new ResizeObserver(updateNavMoreBelow);
    observer.observe(nav);
    for (const child of Array.from(nav.children)) observer.observe(child);
    nav.addEventListener('toggle', updateNavMoreBelow, true);
    return () => { observer.disconnect(); nav.removeEventListener('toggle', updateNavMoreBelow, true); };
  }, [updateNavMoreBelow]);

  // Advanced tools can sit below the sidebar's fold: keep the open page's entry in view.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.nav-section [aria-current="page"]')?.scrollIntoView({ block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  const select = useCallback((requested: PageId) => {
    // Quota Lookup is now Accounts' Quotas view; old links and searches still land there.
    if (requested === 'quota') requestAccountsView('quotas');
    const pageId: PageId = requested === 'quota' ? 'oauth' : requested;
    if (!canOpenAppPage(pageId, coreReady)) {
      // Say why nothing happened rather than ignoring the click.
      paletteFeedback.showNotice({ key: 'app.locked.notice' }, 'info', { action: { label: { key: 'app.nav.home' }, onAction: () => setActive('home') } });
      return;
    }
    if (pageId !== active && !confirmLeave()) return;
    setActive(pageId);
  }, [coreReady, active]);

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const customEvent = event as CustomEvent<PageId>;
      if (customEvent.detail) {
        select(customEvent.detail);
      }
    };
    window.addEventListener('app:navigate', handleNavigate);
    return () => window.removeEventListener('app:navigate', handleNavigate);
  }, [select]);

  const resolveWindowsCloseRequest = async (
    action: WindowsCloseAction,
    remember = windowsClosePrompt?.rememberChoice ?? false,
  ) => {
    setWindowsClosePrompt((current) =>
      current
        ? {
            ...current,
            resolvingAction: action,
            error: null,
          }
        : current,
    );

    try {
      await invoke('resolve_windows_close_request', { action, remember });
      setWindowsClosePrompt(null);
      if (action === 'minimize-to-tray') void noticeStillInTray().catch(() => undefined);
    } catch (error) {
      setWindowsClosePrompt((current) =>
        current
          ? {
              ...current,
              resolvingAction: null,
              error: readableError(error),
            }
          : {
              resolvingAction: null,
              rememberChoice: false,
              error: readableError(error),
            },
      );
    }
  };

  const paletteCommands: PaletteCommand[] = [
    ...[...primaryNav, ...advancedNav].map((id, position) => {
      const page = pages.find((item) => item.id === id)!;
      return {
        id: `page-${id}`, label: t(page.labelKey), group: t('palette.pages'),
        hint: newNav ? undefined : position < primaryNav.length ? t('palette.pageShortcut', { key: position + 1 }) : undefined,
        keywords: paletteKeywords[id], disabled: !canOpenAppPage(id, coreReady), run: () => select(id),
      };
    }),
    { id: 'theme-light', label: t('app.theme.switchToLight'), group: t('palette.appearance'), run: () => setTheme('light') },
    { id: 'theme-dark', label: t('app.theme.switchToDark'), group: t('palette.appearance'), run: () => setTheme('dark') },
    { id: 'theme-system', label: t('app.theme.switchToSystem'), group: t('palette.appearance'), run: () => setTheme('system') },
    { id: 'density-compact', label: t('density.compact'), group: t('palette.appearance'), disabled: density === 'compact', run: () => setDensity('compact') },
    { id: 'density-comfortable', label: t('density.comfortable'), group: t('palette.appearance'), disabled: density === 'comfortable', run: () => setDensity('comfortable') },
    { id: 'page-quota', label: t('app.nav.quota'), group: t('palette.pages'), keywords: paletteKeywords.quota,
      disabled: !canOpenAppPage('oauth', coreReady), run: () => select('quota') },
    { id: 'glossary', label: t('glossary.title'), group: t('palette.help'), run: () => setGlossaryOpen(true) },
    { id: 'check-quota', label: t('palette.action.checkQuota'), group: t('palette.actions'), disabled: !coreReady,
      run: () => window.dispatchEvent(new CustomEvent('app:check-quota')) },
    { id: 'restart-proxy', label: t('palette.action.restartProxy'), group: t('palette.actions'), disabled: !status?.installed,
      run: () => void (async () => {
        // The palette closes at once, so a second run would otherwise start an overlapping restart.
        if (restartingRef.current) return;
        if (!(await askConfirmation({ title: t('palette.action.restartProxy'), message: t('palette.action.restartProxyConfirm'), confirmText: t('palette.action.restartProxy') }))) return;
        restartingRef.current = true;
        try {
          publishStatus(await invoke<CoreStatus>('restart_core_process'));
        } catch (error) {
          paletteFeedback.showNotice({ key: 'palette.action.restartFailed', variables: { error: readableError(error) } }, 'error');
        } finally {
          restartingRef.current = false;
        }
      })() },
  ];

  const renderNavigationPage = (page: (typeof pages)[number]) => {
              const Icon = page.icon;
              const locked = !canOpenAppPage(page.id, coreReady);
              const updateIndicator = page.id === 'versions'
                ? appUpdateIndicatorState(hasUpdate, coreHasUpdate, appUpdateProcessing)
                : null;
              return (
                <button
                  key={page.id}
                  type="button"
                  className={[
                    page.id === active ? 'active' : '',
                    locked ? 'locked' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-current={page.id === active ? 'page' : undefined}
                  disabled={locked}
                  title={locked ? t('app.nav.lockedHint') : undefined}
                  onClick={() => select(page.id)}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{t(page.labelKey)}</span>
                  {page.id === 'home' && homeProblems > 0 ? (
                    <i className="nav-attention-dot" title={t('app.nav.attention', { count: homeProblems })} aria-label={t('app.nav.attention', { count: homeProblems })} />
                  ) : null}
                  {locked ? (
                    <Lock size={14} className="nav-lock-icon" aria-hidden="true" />
                  ) : updateIndicator ? (
                    <i
                      className={`nav-update-indicator ${updateIndicator}`}
                      title={updateIndicator === 'processing'
                        ? t('appUpdate.progressTitle')
                        : availableUpdateLabel}
                      aria-label={updateIndicator === 'processing'
                        ? t('appUpdate.progressTitle')
                        : availableUpdateLabel}
                    />
                  ) : null}
                </button>
              );

  };

  // A group lists its pages; opening it returns to the page last used there.
  const renderNavigationGroup = (group: NavGroup) => {
    const first = pages.find((page) => page.id === group.pages[0])!;
    const Icon = groupIcons[group.id] ?? first.icon;
    const current = group.pages.includes(active);
    const locked = group.pages.every((id) => !canOpenAppPage(id, coreReady));
    const updateIndicator = group.pages.includes('versions') ? appUpdateIndicatorState(hasUpdate, coreHasUpdate, appUpdateProcessing) : null;
    return (
      <button key={group.id} type="button" className={[current ? 'active' : '', locked ? 'locked' : ''].filter(Boolean).join(' ')}
        aria-current={current ? 'page' : undefined} disabled={locked} title={locked ? t('app.nav.lockedHint') : undefined}
        onClick={() => select(pageForGroup(group, lastInGroup.current) as PageId)}>
        <Icon size={16} aria-hidden="true" />
        <span>{t(group.labelKey as Parameters<typeof t>[0])}</span>
        {group.id === 'overview' && homeProblems > 0 ? (
          <i className="nav-attention-dot" title={t('app.nav.attention', { count: homeProblems })} aria-label={t('app.nav.attention', { count: homeProblems })} />
        ) : null}
        {locked ? <Lock size={14} className="nav-lock-icon" aria-hidden="true" />
          : updateIndicator ? <i className={`nav-update-indicator ${updateIndicator}`} aria-label={availableUpdateLabel} title={availableUpdateLabel} /> : null}
      </button>
    );
  };
  const activeGroup = newNav ? groupForPage(active) : undefined;

  return (
    <>
      <div className="app-shell">
        {(
          <aside className="sidebar">
          <div className="sidebar-brand" title={t('app.desktopConsole')}>
            <span className="personal-brand-mark" aria-hidden="true">{PERSONAL_APP_INITIAL}<span>↗</span></span>
            <div>
              <strong>{PERSONAL_APP_NAME}</strong>
              <span>{t('personal.tagline')}</span>
            </div>
          </div>

          <button type="button" className="sidebar-command-button" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K">
            <Search size={14} aria-hidden="true" /><span>{t('palette.open')}</span><kbd>{t('palette.shortcut')}</kbd>
          </button>
          <nav ref={navSectionRef} className={`nav-section${navMoreBelow ? ' nav-more-below' : ''}${newNav ? ' nav-grouped' : ''}`} aria-label={t('app.navigation')} onScroll={updateNavMoreBelow}>
            {newNav ? <>
              {mainNavGroups.map(renderNavigationGroup)}
              <div className="nav-utility-groups" role="group" aria-label={t('navGroup.utility')}>{utilityNavGroups.map(renderNavigationGroup)}</div>
            </> : <>
            {primaryNav.map((id) => pages.find((page) => page.id === id)!).map(renderNavigationPage)}
            <details className="personal-advanced" open={advancedNav.includes(active) || undefined}>
              <summary>{t('personal.advanced')}</summary>
              <div>{advancedGroups.map((group) => <div key={group.labelKey} className="personal-advanced-group" role="group" aria-label={t(group.labelKey)}>
                <span className="personal-advanced-heading" aria-hidden="true">{t(group.labelKey)}</span>
                {group.ids.map((id) => pages.find((page) => page.id === id)!).map(renderNavigationPage)}
              </div>)}
              </div>
            </details>
            </>}
          </nav>

          <div className="sidebar-bottom">
            <div
              className="sidebar-theme-selector"
              role="group"
              aria-label={t('app.theme.label')}
            >
              <button
                type="button"
                className={theme === 'light' ? 'active' : ''}
                aria-pressed={theme === 'light'}
                title={t('app.theme.switchToLight')}
                onClick={() => setTheme('light')}
              >
                {t('app.theme.light')}
              </button>
              <button
                type="button"
                className={theme === 'dark' ? 'active' : ''}
                aria-pressed={theme === 'dark'}
                title={t('app.theme.switchToDark')}
                onClick={() => setTheme('dark')}
              >
                {t('app.theme.dark')}
              </button>
              <button
                type="button"
                className={theme === 'system' ? 'active' : ''}
                aria-pressed={theme === 'system'}
                title={t('app.theme.switchToSystem')}
                onClick={() => setTheme('system')}
              >
                {t('app.theme.system')}
              </button>
            </div>
            <div className="sidebar-theme-selector sidebar-density-selector" role="group" aria-label={t('density.label')}>
              <button type="button" className={density === 'comfortable' ? 'active' : ''} aria-pressed={density === 'comfortable'} onClick={() => setDensity('comfortable')}>{t('density.comfortable')}</button>
              <button type="button" className={density === 'compact' ? 'active' : ''} aria-pressed={density === 'compact'} onClick={() => setDensity('compact')}>{t('density.compact')}</button>
            </div>
            <button type="button" className="sidebar-glossary-link" onClick={() => setGlossaryOpen(true)}>{t('glossary.open')}</button>
            <div ref={languageMenuRef} className="sidebar-language">
              <button
                ref={languageButtonRef}
                type="button"
                className="sidebar-language-trigger"
                aria-label={t('app.language')}
                aria-haspopup="listbox"
                aria-expanded={languageMenuOpen}
                aria-controls="sidebar-language-list"
                onClick={() => setLanguageMenuOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                  event.preventDefault();
                  setLanguageMenuOpen(true);
                  window.requestAnimationFrame(() => {
                    const options = languageMenuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]');
                    options?.[event.key === 'ArrowUp' ? options.length - 1 : 0]?.focus();
                  });
                }}
              >
                <Languages size={16} aria-hidden="true" />
                <span lang={selectedLanguage.value}>{selectedLanguage.nativeLabel}</span>
                <ChevronUp
                  size={14}
                  aria-hidden="true"
                  className={languageMenuOpen ? 'expanded' : ''}
                />
              </button>
              {languageMenuOpen ? (
                <div
                  id="sidebar-language-list"
                  className="sidebar-language-list"
                  role="listbox"
                  aria-label={t('app.language')}
                  onKeyDown={handleLanguageListKeyDown}
                >
                  {languageOptions.map((option) => {
                    const selected = option.value === locale;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        className={selected ? 'selected' : ''}
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          setLocale(option.value);
                          setLanguageMenuOpen(false);
                          window.requestAnimationFrame(() => languageButtonRef.current?.focus());
                        }}
                      >
                        <span lang={option.value}>{option.nativeLabel}</span>
                        {selected ? <Check size={14} aria-hidden="true" /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
            <div className="personal-runtime" role="status">
              <span className={`ad-dot ${coreReady ? 'online' : ''}`} aria-hidden="true" />
              <div><strong>{coreReady ? t('personal.running') : t('personal.notReady')}</strong><small>{t('personal.routing')}</small></div>
            </div>
          </div>
          </aside>
        )}

        <div className="workspace">
          <main className="content">
            {activeGroup && activeGroup.pages.length > 1 ? (
              <nav className="nav-group-sections" aria-label={t(activeGroup.labelKey as Parameters<typeof t>[0])}>
                {activeGroup.pages.map((id) => {
                  const page = pages.find((item) => item.id === id)!;
                  const locked = !canOpenAppPage(id, coreReady);
                  return <button key={id} type="button" className={id === active ? 'active' : ''} aria-current={id === active ? 'page' : undefined}
                    disabled={locked} title={locked ? t('app.nav.lockedHint') : undefined} onClick={() => select(id as PageId)}>{t(page.labelKey)}</button>;
                })}
              </nav>
            ) : null}
            {isAlwaysAvailablePage(activePage.id) || coreReady ? (
              <ActivePage />
            ) : (
              <CoreLockedPage waiting={coreSettling} />
            )}
          </main>
        </div>
      </div>

      {windowsClosePrompt ? (
        <div className="close-dialog-backdrop">
          <section
            ref={closeDialogRef}
            className="close-dialog"
            role="alertdialog"
            tabIndex={-1}
            aria-modal="true"
            aria-labelledby="close-dialog-title"
            aria-describedby="close-dialog-description"
          >
            <button
              type="button"
              className="close-dialog-dismiss"
              aria-label={t('common.cancel')}
              title={t('common.cancel')}
              disabled={windowsClosePrompt.resolvingAction !== null}
              onClick={() => setWindowsClosePrompt(null)}
            >
              <X size={16} aria-hidden="true" />
            </button>
            <div className="close-dialog-heading">
              <h2 id="close-dialog-title">{t('app.close.title')}</h2>
            </div>
            <p id="close-dialog-description">
              {t('app.close.description')}
            </p>
            {windowsClosePrompt.error ? (
              <MessageNotice message={windowsClosePrompt.error} onDismiss={() => setWindowsClosePrompt(current => current ? { ...current, error: null } : current)} />
            ) : null}
            <label className="close-dialog-remember">
              <input
                type="checkbox"
                checked={windowsClosePrompt.rememberChoice}
                disabled={windowsClosePrompt.resolvingAction !== null}
                onChange={(event) => {
                  const rememberChoice = event.currentTarget.checked;
                  setWindowsClosePrompt((current) =>
                    current ? { ...current, rememberChoice } : current,
                  );
                }}
              />
              <span>{t('app.close.remember')}</span>
            </label>
            <div className="close-dialog-actions">
              <button
                type="button"
                className="close-choice-button primary-button"
                disabled={windowsClosePrompt.resolvingAction !== null}
                onClick={() => void resolveWindowsCloseRequest('minimize-to-tray')}
              >
                <span>
                  {windowsClosePrompt.resolvingAction === 'minimize-to-tray'
                    ? t('app.close.minimizing')
                    : t('app.close.minimize')}
                </span>
              </button>
              <button
                type="button"
                className="close-choice-button danger-button"
                disabled={windowsClosePrompt.resolvingAction !== null}
                onClick={() => void resolveWindowsCloseRequest('exit')}
              >
                <span>
                  {windowsClosePrompt.resolvingAction === 'exit'
                    ? t('app.close.exiting')
                    : t('app.close.exit')}
                </span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <AppUpdateDialog />
      <GlossaryDialog open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={paletteCommands} />
      {confirmationDialog}
      <FloatingNotice key={paletteFeedback.revision} notice={paletteFeedback.notice} onDismiss={paletteFeedback.clearNotice} />
    </>
  );
}

function CoreLockedPage({ waiting = false }: { waiting?: boolean }) {
  const { t } = useI18n();
  if (waiting) return <section className="page core-locked-page"><div className="empty-state core-locked-panel" role="status"><ServerCog size={26} aria-hidden="true" /><strong>{t('app.coreWaiting')}</strong></div></section>;
  return (
    <section className="page core-locked-page">
      <div className="empty-state core-locked-panel">
        <ServerCog size={26} aria-hidden="true" />
        <strong>{t('app.coreRequired.title')}</strong>
        <span>{t('app.coreRequired.description')}</span>
      </div>
    </section>
  );
}

export default App;
