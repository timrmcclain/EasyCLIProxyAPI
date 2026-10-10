const alwaysAvailablePages = new Set(['home', 'proxy', 'versions', 'config', 'usage-records', 'agents', 'connectors', 'compression', 'health']);

export function isAlwaysAvailablePage(pageId: string) {
  return alwaysAvailablePages.has(pageId);
}

export function canOpenAppPage(pageId: string, coreReady: boolean) {
  return coreReady || isAlwaysAvailablePage(pageId);
}
