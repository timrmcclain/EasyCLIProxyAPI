import { ArrowRight } from 'lucide-react';
import { useI18n } from '../i18n';
import { templateText } from '../i18n/templateConfig';
import type { TemplateConfigField, TemplateText } from '../services/templateConfig';

const T = (zh: string, en: string, ja: string): TemplateText => ({ zh, en, ja });

/** A one-line summary of what a config value holds, without its contents. */
export function summarizeSetting(value: unknown): TemplateText {
  if (value === undefined || value === null) return T('未设置', 'Not set', '未設定');
  if (Array.isArray(value)) return value.length ? T(`${value.length} 项`, `${value.length} entr${value.length === 1 ? 'y' : 'ies'}`, `${value.length} 件`) : T('未设置', 'Not set', '未設定');
  if (typeof value === 'object') {
    const count = Object.keys(value as object).length;
    return count ? T(`${count} 个条目`, `${count} configured`, `${count} 件設定済み`) : T('未设置', 'Not set', '未設定');
  }
  if (typeof value === 'boolean') return value ? T('开启', 'On', 'オン') : T('关闭', 'Off', 'オフ');
  return T(String(value), String(value), String(value));
}

function OwnedSetting({ value, id, owner, open, summary }: { value: unknown; id: string; owner: TemplateText; open: () => void; summary?: (value: unknown) => TemplateText }) {
  const { locale } = useI18n();
  return <div className="owned-setting" id={id}>
    <span className="owned-setting-summary">{templateText((summary ?? summarizeSetting)(value), locale)}</span>
    <button type="button" className="secondary-button compact-button" onClick={open}>
      {templateText(T(`在“${templateText(owner, 'zh-CN')}”中编辑`, `Edit in ${templateText(owner, 'en')}`, `${templateText(owner, 'ja')}で編集`), locale)}
      <ArrowRight size={14} aria-hidden="true" />
    </button>
  </div>;
}

/**
 * A setting that has its own editor elsewhere. Settings shows what it holds and links there instead of a second
 * editor: two editors saving the same value by different routes could overwrite each other. It never changes
 * the value, so saving this group never writes it.
 */
export function ownedField(path: readonly string[], label: TemplateText, owner: TemplateText, open: () => void,
  options: { description?: TemplateText; summary?: (value: unknown) => TemplateText } = {}): TemplateConfigField {
  return {
    path, label, type: 'custom', owned: true, description: options.description,
    render: ({ value, id }) => <OwnedSetting value={value} id={id} owner={owner} open={open} summary={options.summary} />,
  };
}
