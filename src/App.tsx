import { UX_NAVIGATE } from './services/uxNavigation';
import { MessageNotice } from './appNotice';
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
} from 'lucide-react';
import { PERSONAL_APP_NAME, PERSONAL_APP_INITIAL } from './personalEdition';
import { CoreRuntimeProvider, useCoreRuntime } from './coreRuntime';
import { CoreUpdateProvider, useCoreUpdate } from './coreUpdate';
import { ConfigPanelPage } from './pages/ConfigPanel';
import { ApiAccessPage } from './pages/ApiAccessPage';
import { KernelPage } from './pages/Kernel';
import { VersionManagementPage } from './pages/VersionManagementPage';
import { OAuthManagementPage } from './pages/ManagementPages';
import { QuotaPage } from './pages/QuotaPage';
import { AgentsPage } from './pages/AgentsPage';
import { GlossaryDialog } from './components/GlossaryDialog';
import { UsageRecordsPage } from './pages/UsageRecordsPage';
import { PluginsPage } from './pages/PluginsPage';
import { ConnectorsPage } from './pages/ConnectorsPage';
import { languageOptions, useI18n } from './i18n';
import { AppUpdateDialog, AppUpdateProvider, useAppUpdate } from './appUpdate';
import { appUpdateIndicatorState } from './appUpdateModel';
import { canOpenAppPage, isAlwaysAvailablePage } from './navigation';
import { useThemePreference } from './theme';
import { useDialogFocusTrap } from './components/useDialogFocusTrap';
import { CommandPalette, type PaletteCommand } from './components/CommandPalette';
import { confirmLeave } from './services/unsavedChanges';


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
// Six everyday pages; the rest live under Advanced tools. Quota Lookup and Proxy are part of Home.
const primaryNav: PageId[] = ['home', 'oauth', 'usage-records', 'agents', 'connectors', 'config'];
const advancedNav: PageId[] = ['api', 'plugins', 'quota', 'proxy', 'versions'];
const LAST_PAGE_KEY = 'personal.lastPage';

function initialPage(): PageId {
  try {
    const saved = localStorage.getItem(LAST_PAGE_KEY);
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
  const { status } = useCoreRuntime();
  const coreReady = Boolean(status?.ready);
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
  useEffect(() => {
    if (!canOpenAppPage(active, coreReady)) {
      setActive('home');
    }
  }, [active, coreReady]);

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
      if (mod && /^[1-6]$/.test(event.key)) {
        event.preventDefault();
        const target = primaryNav[Number(event.key) - 1];
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
      if ((target === 'home' || target === 'oauth' || target === 'agents') && canOpenAppPage(target, coreReady) && (target === active || confirmLeave())) setActive(target);
    };
    window.addEventListener(UX_NAVIGATE, navigate);
    return () => window.removeEventListener(UX_NAVIGATE, navigate);
  }, [coreReady, active]);

  const select = useCallback((pageId: PageId) => {
    if (!canOpenAppPage(pageId, coreReady)) {
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
    } catch (error) {
      setWindowsClosePrompt((current) =>
        current
          ? {
              ...current,
              resolvingAction: null,
              error: error instanceof Error ? error.message : String(error),
            }
          : {
              resolvingAction: null,
              rememberChoice: false,
              error: error instanceof Error ? error.message : String(error),
            },
      );
    }
  };

  const paletteCommands: PaletteCommand[] = [
    ...[...primaryNav, ...advancedNav].map((id, position) => {
      const page = pages.find((item) => item.id === id)!;
      return {
        id: `page-${id}`, label: t(page.labelKey), group: t('palette.pages'),
        hint: position < primaryNav.length ? t('palette.pageShortcut', { key: position + 1 }) : undefined,
        disabled: !canOpenAppPage(id, coreReady), run: () => select(id),
      };
    }),
    { id: 'theme-light', label: t('app.theme.switchToLight'), group: t('palette.appearance'), run: () => setTheme('light') },
    { id: 'theme-dark', label: t('app.theme.switchToDark'), group: t('palette.appearance'), run: () => setTheme('dark') },
    { id: 'theme-system', label: t('app.theme.switchToSystem'), group: t('palette.appearance'), run: () => setTheme('system') },
    { id: 'density-compact', label: t('density.compact'), group: t('palette.appearance'), disabled: density === 'compact', run: () => setDensity('compact') },
    { id: 'density-comfortable', label: t('density.comfortable'), group: t('palette.appearance'), disabled: density === 'comfortable', run: () => setDensity('comfortable') },
    { id: 'glossary', label: t('glossary.title'), group: t('palette.help'), run: () => setGlossaryOpen(true) },
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
          <nav className="nav-section" aria-label={t('app.navigation')}>
            {primaryNav.map((id) => pages.find((page) => page.id === id)!).map(renderNavigationPage)}
            <details className="personal-advanced" open={advancedNav.includes(active) || undefined}>
              <summary>{t('personal.advanced')}</summary>
              <div>{advancedNav.map((id) => pages.find((page) => page.id === id)!).map(renderNavigationPage)}
              </div>
            </details>
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
            {isAlwaysAvailablePage(activePage.id) || coreReady ? (
              <ActivePage />
            ) : (
              <CoreLockedPage />
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
    </>
  );
}

function CoreLockedPage() {
  const { t } = useI18n();
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
