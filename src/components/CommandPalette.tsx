import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Search } from 'lucide-react';
import { useI18n } from '../i18n';
import { useDialogFocusTrap } from './useDialogFocusTrap';
import { rankPalette } from './paletteSearch';
import './CommandPalette.css';

// searchOnly entries (single settings, accounts) appear once you type, so the opening list stays short.
export type PaletteCommand = { id: string; label: string; group: string; hint?: string; keywords?: readonly string[]; disabled?: boolean; searchOnly?: boolean; run: () => void };

/** Ctrl+K launcher: jump to any page or run a global action without hunting through menus. */
export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: PaletteCommand[]; onClose: () => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useDialogFocusTrap<HTMLDivElement>({ active: open, onEscape: onClose });

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const matches = useMemo(() => {
    const typed = query.trim() !== '';
    return rankPalette(commands.filter((command) => !command.disabled && (typed || !command.searchOnly)), query).slice(0, 60);
  }, [commands, query]);

  useEffect(() => { setIndex(0); }, [query]);

  if (!open) return null;

  const run = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setIndex((current) => (current + step + matches.length) % Math.max(matches.length, 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(matches[index]);
    }
  };

  return (
    <div className="command-palette-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="command-palette" role="dialog" aria-modal="true" aria-label={t('palette.title')}>
        <div className="command-palette-search">
          <Search size={16} aria-hidden="true" />
          <input ref={inputRef} type="text" value={query} placeholder={t('palette.placeholder')}
            aria-label={t('palette.placeholder')} aria-controls="command-palette-list"
            aria-activedescendant={matches[index] ? `palette-${matches[index].id}` : undefined}
            onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} />
        </div>
        <ul id="command-palette-list" className="command-palette-list" role="listbox" aria-label={t('palette.title')}>
          {matches.map((command, position) => (
            <li key={command.id} id={`palette-${command.id}`} role="option" aria-selected={position === index}
              className={position === index ? 'active' : undefined}
              onMouseEnter={() => setIndex(position)} onClick={() => run(command)}>
              <span>{command.label}</span>
              <small>{command.hint ?? command.group}</small>
            </li>
          ))}
          {!matches.length && <li className="command-palette-empty" role="presentation">{t('palette.empty')}</li>}
        </ul>
        <p className="command-palette-footer">{t('palette.footer')}</p>
      </div>
    </div>
  );
}
