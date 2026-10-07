import { getCurrentLocale, type AppLocale } from './index';
import { createTraditionalMessages } from './traditional';

const messages = {
  title: ['连接器', 'Connectors', 'コネクタ'],
  description: [
    '让 Claude 使用你的其他应用。更改保存在本机的 Claude Code 与 Claude Desktop 设置中，重启对应应用后生效。',
    'Let Claude use your other apps. Changes are saved to Claude Code and Claude Desktop settings on this computer and take effect after you restart that app.',
    'Claude から他のアプリを使えるようにします。変更はこの PC の Claude Code と Claude Desktop の設定に保存され、アプリの再起動後に反映されます。',
  ],
  profile: ['Claude Desktop 当前配置：', 'Claude Desktop profile in use:', '使用中の Claude Desktop プロファイル：'],
  noProfile: ['未找到 Claude Desktop 配置', 'No Claude Desktop profile found', 'Claude Desktop のプロファイルが見つかりません'],
  refresh: ['刷新', 'Refresh', '再読み込み'],
  refreshing: ['正在检查…', 'Checking…', '確認中…'],
  checkedAt: ['检查时间：', 'Checked at', '確認時刻：'],
  discardTitle: ['放弃未保存的更改？', 'Discard unsaved changes?', '保存していない変更を破棄しますか？'],
  discardMessage: [
    '刷新会重新读取设置，未保存的更改（包括已输入的令牌）将丢失。',
    'Refreshing re-reads the settings. Changes you have not saved, including anything typed into a token box, will be lost.',
    '再読み込みすると設定を読み直し、保存していない変更（入力したトークンを含む）は失われます。',
  ],
  discardConfirm: ['放弃并刷新', 'Discard and refresh', '破棄して再読み込み'],
  undo: ['撤销上一次更改', 'Undo last change', '直前の変更を元に戻す'],
  undone: ['已撤销上一次更改。', 'The last change was undone.', '直前の変更を元に戻しました。'],
  saved: ['已保存。重启 Claude Code 或 Claude Desktop 后生效。', 'Saved. Restart Claude Code or Claude Desktop to load the change.', '保存しました。Claude Code または Claude Desktop を再起動すると反映されます。'],
  loadFailed: ['无法读取连接器状态', 'Could not read connector status', 'コネクタの状態を読み込めませんでした'],
  save: ['保存', 'Save', '保存'],
  saving: ['保存中…', 'Saving…', '保存中…'],
  reset: ['取消', 'Cancel', 'キャンセル'],
  claudeCode: ['Claude Code', 'Claude Code', 'Claude Code'],
  claudeDesktop: ['Claude Desktop', 'Claude Desktop', 'Claude Desktop'],
  access: ['权限', 'Access', 'アクセス権'],
  accessReadonly: ['只读', 'Read only', '読み取りのみ'],
  accessDrafts: ['读取 + 草稿（不能发送）', 'Read + drafts (cannot send)', '読み取り＋下書き（送信不可）'],
  accessFull: ['完全（可发送、编辑和删除）', 'Full (can send, edit and delete)', 'フル（送信・編集・削除が可能）'],
  accessFullGithub: ['完全（可创建和修改）', 'Full (can create and change)', 'フル（作成・変更が可能）'],
  loginSettings: ['登录设置', 'Login settings', 'ログイン設定'],
  configured: ['已配置', 'Configured', '設定済み'],
  notConfigured: ['未配置', 'Not set', '未設定'],
  change: ['更改', 'Change', '変更'],
  secretHint: ['只保存在本机的 Claude 设置文件中，不会显示在这里。', 'Stored only in Claude\'s settings files on this computer. Never shown here.', 'この PC の Claude 設定ファイルにのみ保存され、ここには表示されません。'],
  missingSecret: ['请先填写：', 'Enter this first:', '先に入力してください：'],
  signedIn: ['已登录', 'Signed in', 'サインイン済み'],
  notSignedIn: ['首次使用时需登录', 'Sign in on first use', '初回使用時にサインイン'],
  builtIn: ['Claude Desktop 内置连接器，在 Claude Desktop 中登录', 'Built into Claude Desktop; sign in from Claude Desktop', 'Claude Desktop 内蔵。Claude Desktop でサインイン'],
  off: ['未开启', 'Off', 'オフ'],
  on: ['已开启', 'On', 'オン'],
  test: ['测试', 'Test', 'テスト'],
  testing: ['测试中…', 'Testing…', 'テスト中…'],
  testOk: ['正常，工具数：', 'Working. Tools:', '正常。ツール数：'],
  testNeedsSignIn: ['可以连接，但需要登录', 'Reachable, but needs sign-in', '接続できますが、サインインが必要です'],
  testBuiltIn: ['内置连接器，请在 Claude Desktop 中测试', 'Built-in connector; test it inside Claude Desktop', '内蔵コネクタです。Claude Desktop 内でテストしてください'],
  testFailed: ['未能启动：', 'Did not start:', '起動できませんでした：'],
  unavailable_uvx: ['需要 uv（Python 工具运行器），当前未安装。', 'Needs uv (the Python tool runner), which is not installed.', 'uv（Python ツールランナー）が必要ですが、インストールされていません。'],
  unavailable_playwright: ['未安装 Playwright MCP。', 'Playwright MCP is not installed.', 'Playwright MCP がインストールされていません。'],
  'unavailable_windows-mcp': ['未安装 Windows-MCP。', 'Windows-MCP is not installed.', 'Windows-MCP がインストールされていません。'],
  google_name: ['Google（个人）', 'Google (personal)', 'Google（個人）'],
  google_body: ['读取和管理你的个人 Gmail、日历、云端硬盘、文档和表格。', 'Read and manage your personal Gmail, Calendar, Drive, Docs and Sheets.', '個人の Gmail・カレンダー・ドライブ・ドキュメント・スプレッドシートを読み取り・管理します。'],
  google_note: ['首次使用时会打开 Google 登录页面；可能显示“Google 尚未验证此应用”，这是因为使用的是你自己的登录设置。', 'The first use opens a Google sign-in page. It may say "Google hasn\'t verified this app" because the login settings are your own.', '初回使用時に Google のサインイン画面が開きます。独自のログイン設定のため「Google はこのアプリを確認していません」と表示されることがあります。'],
  microsoft365_name: ['Microsoft 365（工作）', 'Microsoft 365 (work)', 'Microsoft 365（仕事）'],
  microsoft365_body: ['工作账号的 Outlook 邮件与日历、Teams 和 OneDrive。', 'Outlook mail and calendar, Teams and OneDrive for your work account.', '仕事用アカウントの Outlook メールとカレンダー、Teams、OneDrive。'],
  microsoft365_note: ['这是公司数据：需要公司 Microsoft 365 管理员批准，并遵守公司的数据规则。', 'This is company data: your company\'s Microsoft 365 admin must approve it, and company data rules apply.', '会社のデータです。Microsoft 365 管理者の承認が必要で、会社のデータ規則が適用されます。'],
  github_name: ['GitHub', 'GitHub', 'GitHub'],
  github_body: ['你的 GitHub 仓库、议题和拉取请求。', 'Your GitHub repositories, issues and pull requests.', 'GitHub のリポジトリ、Issue、プルリクエスト。'],
  github_note: ['需要你在 GitHub 设置中创建的个人访问令牌。开启后会关闭 Claude Code 中无法使用的官方 GitHub 插件。', 'Needs a personal access token you create in GitHub settings. Turning it on for Claude Code also turns off the broken official GitHub plugin there.', 'GitHub の設定で作成する個人アクセストークンが必要です。Claude Code で有効にすると、動作していない公式 GitHub プラグインはオフになります。'],
  playwright_name: ['浏览器（Playwright）', 'Browser (Playwright)', 'ブラウザー（Playwright）'],
  playwright_body: ['让 Claude 在浏览器中打开和使用网页。', 'Lets Claude open and use web pages in a browser.', 'Claude がブラウザーで Web ページを開いて操作できます。'],
  playwright_note: ['', '', ''],
  windows_name: ['Windows 控制', 'Windows control', 'Windows 操作'],
  windows_body: ['让 Claude 查看屏幕并操作 Windows 应用。', 'Lets Claude see your screen and operate Windows apps.', 'Claude が画面を見て Windows アプリを操作できます。'],
  windows_note: ['权限很大：只在需要的应用中开启。', 'Very powerful: turn it on only where you need it.', '強力な権限です。必要なアプリでのみオンにしてください。'],
  firecrawl_name: ['Firecrawl', 'Firecrawl', 'Firecrawl'],
  firecrawl_body: ['读取网页内容并搜索网络。', 'Reads web pages and searches the web.', 'Web ページを読み取り、Web を検索します。'],
  firecrawl_note: ['', '', ''],
  GOOGLE_OAUTH_CLIENT_ID: ['Google OAuth 客户端 ID', 'Google OAuth client ID', 'Google OAuth クライアント ID'],
  GOOGLE_OAUTH_CLIENT_SECRET: ['Google OAuth 客户端密钥', 'Google OAuth client secret', 'Google OAuth クライアントシークレット'],
  GITHUB_TOKEN: ['GitHub 个人访问令牌', 'GitHub personal access token', 'GitHub 個人アクセストークン'],
} as const;

export type ConnectorTextKey = keyof typeof messages;

export function connectorText(key: ConnectorTextKey, locale: AppLocale = getCurrentLocale()): string {
  const text = messages[key][locale === 'en' ? 1 : locale === 'ja' ? 2 : 0];
  return locale === 'zh-TW' ? createTraditionalMessages({ text }).text : text;
}

/** Looks up a key built at run time (connector id, access level, secret name), falling back to the raw value. */
export function connectorDynamicText(key: string, locale: AppLocale = getCurrentLocale()): string {
  return key in messages ? connectorText(key as ConnectorTextKey, locale) : key;
}
