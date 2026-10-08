import { getCurrentLocale, type AppLocale } from './index';
import { createTraditionalMessages } from './traditional';

const messages = {
  title: ['上下文压缩', 'Compression', 'コンテキスト圧縮'],
  description: [
    '在请求到达 Claude 之前压缩工具输出、日志和文件内容，让套餐额度用得更久。',
    'Shrinks tool output, logs and file dumps before they reach Claude, so your plans last longer.',
    'ツール出力・ログ・ファイル内容を Claude に届く前に圧縮し、プランを長持ちさせます。',
  ],
  howItWorks: ['工作方式', 'How it works', '仕組み'],
  howItWorksDetail: [
    '压缩服务（Headroom，开源）在本机运行于代理之前：应用 → 压缩 → 代理 → 服务商。账号轮换、额度和日志仍由代理处理。不会向外发送任何遥测数据。如果压缩服务停止响应，应用会自动改回直接连接代理。',
    'The compression service (Headroom, open source) runs on this computer in front of the proxy: apps → compression → proxy → providers. The proxy still handles account rotation, quota and logging. No telemetry leaves this computer. If the service stops answering, apps are switched straight back to the proxy.',
    '圧縮サービス（オープンソースの Headroom）はこの PC 上でプロキシの手前で動作します：アプリ → 圧縮 → プロキシ → プロバイダー。アカウントの切り替え・クォータ・ログは引き続きプロキシが処理します。テレメトリは送信されません。サービスが応答しなくなると、アプリは自動的にプロキシへ直接接続に戻ります。',
  ],
  switchLabel: ['压缩上下文', 'Compress context', 'コンテキストを圧縮'],
  stateOn: ['已开启 · 端口 {port}', 'On · port {port}', 'オン · ポート {port}'],
  stateOff: ['已关闭', 'Off', 'オフ'],
  stateStarting: ['正在启动…', 'Starting…', '起動中…'],
  stateFallback: ['压缩服务未响应，应用已直接连接代理', 'Compression service isn’t answering — apps are using the proxy directly', '圧縮サービスが応答しません。アプリはプロキシに直接接続しています'],
  notInstalled: ['未安装压缩服务', 'Compression service not installed', '圧縮サービスが未インストールです'],
  notInstalledBody: [
    '在终端中运行 uv tool install "headroom-ai[proxy]"，然后回到此页面。',
    'Run uv tool install "headroom-ai[proxy]" in a terminal, then come back to this page.',
    'ターミナルで uv tool install "headroom-ai[proxy]" を実行してから、このページに戻ってください。',
  ],
  appsTitle: ['经过压缩的应用', 'Apps that use compression', '圧縮を使うアプリ'],
  appClaudeCode: ['Claude Code', 'Claude Code', 'Claude Code'],
  appClaudeDesktop: ['Claude Desktop', 'Claude Desktop', 'Claude Desktop'],
  appsRestart: [
    '新的 Claude Code 会话会立即使用新设置；Claude Desktop 需要重新启动。',
    'New Claude Code sessions pick this up right away; Claude Desktop needs a restart.',
    '新しい Claude Code セッションにはすぐ反映されます。Claude Desktop は再起動が必要です。',
  ],
  tokensSaved: ['节省的 token', 'Tokens saved', '節約したトークン'],
  savedPercent: ['输入减少', 'Input removed', '入力の削減'],
  dollarsSaved: ['估算节省', 'Estimated savings', '推定節約額'],
  requests: ['经过的请求', 'Requests through it', '経由したリクエスト'],
  compressedRequests: ['{count} 个请求被压缩', '{count} compressed', '{count} 件を圧縮'],
  estimated: ['估算', 'Estimated', '推定'],
  lifetime: ['开启以来', 'Since first turned on', '初回オン以降'],
  daily: ['近 14 天每日节省', 'Saved per day, last 14 days', '過去 14 日間の日別節約'],
  byModel: ['按模型', 'By model', 'モデル別'],
  byApp: ['按应用', 'By app', 'アプリ別'],
  recent: ['最近的请求', 'Recent requests', '最近のリクエスト'],
  colModel: ['模型', 'Model', 'モデル'],
  colApp: ['应用', 'App', 'アプリ'],
  colBefore: ['压缩前', 'Before', '圧縮前'],
  colAfter: ['压缩后', 'After', '圧縮後'],
  colSaved: ['节省', 'Saved', '節約'],
  colRequests: ['请求', 'Requests', 'リクエスト'],
  colTime: ['时间', 'Time', '時刻'],
  noTraffic: [
    '还没有请求经过压缩服务。在 Claude Code 中开始一个新会话后，这里会显示节省情况。',
    'Nothing has gone through compression yet. Start a new Claude Code session and savings will show here.',
    'まだ圧縮を経由したリクエストはありません。Claude Code で新しいセッションを始めると、ここに節約量が表示されます。',
  ],
  statsUnavailable: ['无法读取压缩统计 — 服务正在运行吗？', 'Couldn’t read compression stats — is the service running?', '圧縮の統計を読み取れません。サービスは実行中ですか？'],
  openLog: ['日志文件', 'Log file', 'ログファイル'],
  turnOnFailed: ['无法开启压缩：{error}', 'Couldn’t turn compression on: {error}', '圧縮をオンにできません：{error}'],
  turnOffFailed: ['无法关闭压缩：{error}', 'Couldn’t turn compression off: {error}', '圧縮をオフにできません：{error}'],
  routeFailed: ['无法更改应用设置：{error}', 'Couldn’t change app settings: {error}', 'アプリの設定を変更できません：{error}'],
  learnTitle: ['项目经验', 'Project learnings', 'プロジェクトの学習'],
  learnBody: [
    '分析某个项目过去的 Claude Code 会话，找出反复出现的错误（错误路径、重复读取、反复截图），并写入该项目的 CLAUDE.local.md，让以后的会话少走弯路。',
    'Analyzes a project’s past Claude Code sessions for repeated mistakes (wrong paths, re-reading files, repeated screenshots) and writes them to that project’s CLAUDE.local.md so future sessions avoid them.',
    'プロジェクトの過去の Claude Code セッションから繰り返しのミス（誤ったパス、同じファイルの再読込、繰り返しのスクリーンショット）を分析し、そのプロジェクトの CLAUDE.local.md に書き込んで今後のセッションで避けられるようにします。',
  ],
  learnPrivacy: [
    '分析请求通过你的代理发送，使用 Claude Sonnet，会消耗少量额度。只写入 CLAUDE.local.md（个人文件，不会提交到 git），写入前会备份。',
    'The analysis goes through your proxy using Claude Sonnet and uses a little quota. Only CLAUDE.local.md is written (personal, not committed to git), with a backup first.',
    '分析はプロキシ経由で Claude Sonnet を使って行われ、少しクォータを使用します。書き込むのは CLAUDE.local.md（個人用、git にはコミットされません）のみで、事前にバックアップします。',
  ],
  learnFolder: ['项目文件夹', 'Project folder', 'プロジェクトフォルダー'],
  learnChoose: ['选择…', 'Choose…', '選択…'],
  learnAnalyze: ['分析', 'Analyze', '分析'],
  learnAnalyzing: ['正在分析会话…可能需要一两分钟', 'Analyzing sessions… this can take a minute or two', 'セッションを分析中…1〜2 分かかることがあります'],
  learnNothing: ['没有发现值得写入的模式。', 'No patterns worth writing were found.', '書き込むべきパターンは見つかりませんでした。'],
  learnWillWrite: ['将写入 {path}', 'Will write {path}', '{path} に書き込みます'],
  learnApply: ['写入 CLAUDE.local.md', 'Write CLAUDE.local.md', 'CLAUDE.local.md に書き込む'],
  learnApplied: ['已写入，旧文件已备份为 .before-learn', 'Written; the old file was kept as .before-learn', '書き込みました。以前のファイルは .before-learn として保存されています'],
  learnFailed: ['分析失败：{error}', 'Analysis failed: {error}', '分析に失敗しました：{error}'],
  memoryLabel: ['跨会话记忆', 'Memory across sessions', 'セッションをまたぐ記憶'],
  memoryBody: [
    '让 Claude 在会话之间保存和查找项目事实（按项目分开存储）。开启后每个请求都会多两个记忆工具。Claude Code 已有自己的记忆功能，通常不需要开启。',
    'Lets Claude save and look up project facts between sessions (stored per project). When on, every request gets two extra memory tools. Claude Code already has its own memory, so most setups don’t need this.',
    'Claude がセッション間でプロジェクトの事実を保存・検索できるようにします（プロジェクトごとに保存）。オンにすると各リクエストにメモリツールが 2 つ追加されます。Claude Code には独自のメモリ機能があるため、通常は不要です。',
  ],
  chipLabel: ['压缩', 'Compression', '圧縮'],
  chipSaved: ['已节省 {tokens}', '{tokens} saved', '{tokens} 節約'],
  chipOff: ['已关闭', 'off', 'オフ'],
  chipFallback: ['未响应', 'not answering', '応答なし'],
} as const;

export type CompressionTextKey = keyof typeof messages;

export function compressionText(
  key: CompressionTextKey,
  locale: AppLocale = getCurrentLocale(),
  values: Record<string, string | number> = {},
): string {
  let text: string = messages[key][locale === 'en' ? 1 : locale === 'ja' ? 2 : 0];
  if (locale === 'zh-TW') text = createTraditionalMessages({ text }).text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match));
}
