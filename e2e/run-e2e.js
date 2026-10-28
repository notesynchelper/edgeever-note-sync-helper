'use strict';

/**
 * EdgeEver「笔记同步助手」E2E driver.
 *
 * Modes
 *   tutorial : real UI install (paste manifest URL), trust dialog, settings form;
 *              produces the screenshots used by the tutorial.
 *   fast     : `PUT /api/v1/workspace-extensions/:id` + preset trust/settings
 *              (`addInitScript`), then the same sync/assertion path.
 *   real     : fast path but against the public article API with NOTEHELPER_API_KEY
 *              (covers the public-relay image branch that localhost mocks cannot).
 *
 * Default runs tutorial + fast. Every mode starts from a fresh instance unless
 * `--skip-reset` is passed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { loadConfig } = require('./lib/env');
const { startStaticServer, resolvePluginPackage } = require('./lib/static-server');
const { startMockArticles, installMockArticleRoutes } = require('./lib/mock-articles');
const { launchBrowser, attachDiagnostics, freezeAnimations } = require('./lib/browser');
const { EdgeEverApi } = require('./lib/edgeever-api');
const { Screenshots } = require('./lib/shots');
const {
  installLocalStorageSeed,
  seedPluginSecret,
  readPluginData,
  waitForPluginCard,
  waitForEnabledSwitch,
  openPluginMenu,
  clickPluginCommand,
  waitForNotice,
  dismissNotice,
} = require('./lib/page-helpers');

const MOCK_TITLES = ['E2E 同步：图片本地化', 'E2E 同步：图床不可用', 'E2E 同步：分页文章'];

const parseArgs = (argv) => {
  const options = {
    mode: process.env.E2E_MODE || 'both',
    source: process.env.E2E_PLUGIN_SOURCE || '',
    runName: process.env.E2E_RUN_NAME || '',
    skipReset: false,
    realKey: false,
    stub: false,
    routeMock: false,
    headless: process.env.E2E_HEADLESS !== '0',
  };
  for (const arg of argv) {
    if (arg.startsWith('--mode=')) options.mode = arg.slice(7);
    else if (arg.startsWith('--source=')) options.source = arg.slice(9);
    else if (arg.startsWith('--run=')) options.runName = arg.slice(6);
    else if (arg === '--skip-reset') options.skipReset = true;
    else if (arg === '--real-key') options.realKey = true;
    else if (arg === '--stub') options.stub = true;
    else if (arg === '--route-mock') options.routeMock = true;
    else if (arg === '--queue-nudge') options.queueNudge = true;
    else if (arg === '--headful') options.headless = false;
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node run-e2e.js [--mode=tutorial|fast|real|both] [--source=<manifest-or-github-url>] [--run=<shots-subdir>] [--skip-reset] [--real-key] [--stub] [--route-mock] [--queue-nudge] [--headful]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!['tutorial', 'fast', 'real', 'both'].includes(options.mode)) {
    throw new Error(`Unknown mode: ${options.mode}`);
  }
  return options;
};

const assert = (condition, message) => {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
};

/** Reads the host's local-first sync queue (IndexedDB `edgeever-local`). */
const readSyncQueue = (page) => page.evaluate(() => new Promise((resolve) => {
  const open = indexedDB.open('edgeever-local');
  open.onerror = () => resolve([]);
  open.onsuccess = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('syncQueue')) { resolve([]); return; }
    const request = db.transaction('syncQueue', 'readonly').objectStore('syncQueue').getAll();
    request.onsuccess = () => resolve(request.result.map((item) => ({
      kind: item.kind,
      entityId: item.memoId ?? item.entityId,
      status: item.status,
      error: item.lastError ?? null,
      notebookId: item.payload?.notebookId ?? null,
    })));
    request.onerror = () => resolve([]);
  };
}));

/** Polls an async probe until `predicate` passes (EdgeEver writes are local-first). */
const waitFor = async (label, probe, predicate, { timeout = 60_000, interval = 400 } = {}) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (predicate(last)) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${String(JSON.stringify(last)).slice(0, 600)}`);
};

const resetInstance = (config) => {
  const script = path.join(config.e2eDir, 'scripts', 'reset-instance.sh');
  const result = spawnSync('bash', [script], {
    stdio: 'inherit',
    env: { ...process.env, EDGEEVER_E2E_PASSWORD: config.password, EDGEEVER_E2E_IMAGE: config.image },
  });
  if (result.status !== 0) throw new Error(`reset-instance.sh failed with exit code ${result.status}`);
};

const isGithubSource = (source) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/?$/.test(source);

const readPackageVersion = (packageDir) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8'));
  return { version: manifest.version, id: manifest.id, name: manifest.name };
};

const cookieValue = (setCookieLine) => setCookieLine.slice('edgeever_session='.length);

const runMode = async ({ mode, config, options, staticServer, mock, packageKind }) => {
  const runName = options.runName || mode;
  console.log(`\n=== E2E mode: ${mode} (shots -> shots/${runName}) ===`);
  if (!options.skipReset) resetInstance(config);

  const api = new EdgeEverApi(config.baseUrl);
  const session = await api.login(config.username, config.password);
  const scope = api.localScope;
  console.log(`[e2e] logged in as ${session.user.username} (${session.user.id}), scope=${scope}`);

  const usingRealKey = mode === 'real' || options.realKey;
  const useMock = !usingRealKey;
  if (usingRealKey && !config.notehelperApiKey) {
    throw new Error('NOTEHELPER_API_KEY is required for the real-key case');
  }
  const apiKey = usingRealKey ? config.notehelperApiKey : `dev-${'e2e'}-token`;

  const source = options.source || (isGithubSource(config.source) ? config.source : '') || '';
  const installSource = source || staticServer.manifestUrl;

  const { browser, context } = await launchBrowser({ chromePath: config.chromePath, headless: options.headless });
  let diagnostics = null;
  let page = null;
  try {
    // Harness-only queue nudge: EdgeEver's web sync worker returns the active
    // promise for events fired mid-run and does not schedule a follow-up pass,
    // so creates queued during an active run can sit until the next event.
    // Re-dispatching the host's own event keeps the queue draining; this is
    // also what the app's own repository does after every local mutation.
    // Off by default since the plugin re-announces this event itself while it
    // waits; `--queue-nudge` keeps the old harness behaviour for comparison.
    if (options.queueNudge) await context.addInitScript(() => {
      setInterval(() => {
        try { window.dispatchEvent(new CustomEvent('edgeever:sync-queue-changed')); } catch { /* page is tearing down */ }
      }, 750);
    });

    await context.addCookies([{
      name: 'edgeever_session',
      value: cookieValue(api.cookie),
      url: config.baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    }]);

    // Seed per-device state before the app boots. Tutorial mode deliberately does
    // NOT preset the trust acknowledgement so the real dialog is captured.
    installLocalStorageSeed(context, {
      scope,
      pluginId: config.pluginId,
      trusted: mode !== 'tutorial',
      settings: mode === 'tutorial' ? {} : {
        'folder-template': '笔记同步助手/{{{date}}}',
        'folder-date-format': 'yyyy-MM-dd',
        'title-template': '{{{title}}}',
        'image-mode': 'local',
        'sync-on-start': false,
        frequency: 0,
      },
      // `sync.devEndpoint` is the plugin's localhost-only development entry
      // (`sync.devEndpoint`); the stub reads `devEndpoint`. Both point at the mock.
      data: useMock && !options.routeMock
        ? { devEndpoint: mock.endpoint, 'sync.devEndpoint': mock.endpoint }
        : {},
    });
    if (useMock && options.routeMock) {
      // Fallback for plugin builds without `sync.devEndpoint`: intercept the
      // official GraphQL URLs in the browser and forward to the mock.
      await installMockArticleRoutes(context, mock);
      console.log('[e2e] routed official article endpoints to the local mock (--route-mock)');
    }

    // Harness-only: the browser and the instance share one egress IP, and the
    // host's own update checks for its bundled plugins can drain GitHub's
    // anonymous 60/hour quota. A read-only token from the environment lifts
    // that limit for api.github.com only; it never touches the plugin.
    if (process.env.E2E_GITHUB_TOKEN) {
      const token = process.env.E2E_GITHUB_TOKEN;
      await context.route('https://api.github.com/**', (route) =>
        route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } }));
    }

    page = await context.newPage();
    diagnostics = attachDiagnostics(page);
    const shots = new Screenshots(config.shotsRoot, runName, page);

    if (mode !== 'tutorial') {
      const manifestUrl = isGithubSource(installSource)
        ? `${installSource.replace(/\/$/, '')}/releases/download/v${config.pluginVersion}/manifest.json`
        : installSource;
      await api.upsertWorkspaceExtension(config.pluginId, {
        type: 'plugin',
        version: config.pluginVersion,
        enabled: true,
        installedAt: new Date().toISOString(),
        manifestUrl,
        sourceKind: isGithubSource(installSource) ? 'github' : 'manifest',
        verified: false,
        ...(isGithubSource(installSource) ? { repositoryUrl: installSource.replace(/\/$/, '') } : {}),
      });
      console.log('[e2e] pre-registered workspace extension, relying on syncFromCatalog()');

      await page.goto(`${config.baseUrl}/plugins`);
      await waitForPluginCard(page, config.pluginName);
      await waitForEnabledSwitch(page, config.pluginName, true);
      await shots.capture('plugin-auto-installed');

      const needsSettingsSeed = true;
      if (needsSettingsSeed) {
        await seedPluginSecret(page, { scope, pluginId: config.pluginId, key: 'api-key', value: apiKey });
        console.log('[e2e] seeded encrypted api-key via IndexedDB');
        await page.reload();
        await waitForEnabledSwitch(page, config.pluginName, true);
      }
    } else {
      // ---------------------------------------------------------------
      // Tutorial path: real UI install, no preset trust acknowledgement.
      // ---------------------------------------------------------------
      await page.goto(`${config.baseUrl}/plugins`);
      await page.getByText('插件市场', { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
      await freezeAnimations(page);
      await shots.capture('plugins-page');

      const sourceInput = page.getByLabel('GitHub 仓库或 Manifest 地址', { exact: true });
      await sourceInput.waitFor({ state: 'visible', timeout: 20_000 });
      await sourceInput.fill(installSource);
      await shots.capture('manifest-url-filled');

      await sourceInput.locator('xpath=..').getByRole('button', { name: '安装', exact: true }).click();
      await waitForPluginCard(page, config.pluginName);
      await shots.capture('plugin-installed');

      const toggle = page.getByRole('switch', { name: `启用或停用 ${config.pluginName}`, exact: true }).first();
      await toggle.click();
      const trustDialog = page.getByRole('dialog').filter({ hasText: '开启社区插件？' }).first();
      await trustDialog.waitFor({ state: 'visible', timeout: 20_000 });
      await shots.capture('trust-dialog');
      await trustDialog.getByRole('button', { name: '开启社区插件', exact: true }).click();
      await waitForEnabledSwitch(page, config.pluginName, true);
      await shots.capture('plugin-enabled');

      // Open the detail page and its host-rendered settings form.
      await page.getByRole('link', { name: `查看 ${config.pluginName} 详情`, exact: true }).first().click();
      await page.getByRole('link', { name: '插件设置', exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
      await shots.capture('plugin-detail');
      await page.getByRole('link', { name: '插件设置', exact: true }).click();
      await page.getByLabel(/^密钥/).waitFor({ state: 'visible', timeout: 20_000 });
      await shots.capture('settings-empty');

      await page.getByLabel(/^密钥/).fill(apiKey);
      await page.getByLabel('文章文件夹', { exact: true }).fill('笔记同步助手/{{{date}}}');
      await page.getByLabel('文章文件夹日期格式', { exact: true }).fill('yyyy-MM-dd');
      await page.getByLabel('文章文件名', { exact: true }).fill('{{{title}}}');
      await page.getByLabel('图片处理模式', { exact: true }).click();
      await page.getByRole('option', { name: '保存到 EdgeEver', exact: true }).click();
      // Leave 启动时同步 off: enabling it would let the plugin auto-sync on
      // later page loads and steal the incremental/dedupe steps below.

      // Blur the secret input so the host swaps it for the "configured" placeholder.
      await page.getByLabel('文章模板', { exact: true }).click();
      await page.waitForTimeout(500);
      await shots.capture('settings-filled');

      const secretPlaceholder = await page.getByLabel(/^密钥/).getAttribute('placeholder');
      assert(secretPlaceholder === '已配置，留空表示保持不变', `secret placeholder was "${secretPlaceholder}"`);

      await seedPluginSecret(page, { scope, pluginId: config.pluginId, key: 'api-key', value: apiKey });
      // Restart the app so plugin activation sees the stored secret through context.settings.
      await page.goto(`${config.baseUrl}/plugins`);
      await waitForEnabledSwitch(page, config.pluginName, true);
    }

    // Snapshot existing notes before the run so the real-key case can tell
    // which notes this sync created.
    const preexistingMemoIds = usingRealKey
      ? new Set((await api.listMemos({ limit: 200 })).memos.map((memo) => memo.id))
      : null;

    // -----------------------------------------------------------------
    // Trigger the command from the plugin toolbar menu (the "command palette").
    // -----------------------------------------------------------------
    await page.goto(`${config.baseUrl}/`);
    await page.getByRole('button', { name: '新建笔记', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
    await freezeAnimations(page);
    await openPluginMenu(page, config.pluginName);
    await shots.capture('command-menu');
    await clickPluginCommand(page, config.commandTitle);

    const firstNotice = await waitForNotice(page, '同步完成', usingRealKey ? 600_000 : 120_000);
    await shots.capture('sync-notice');
    const firstNoticeText = await firstNotice.innerText();
    console.log(`[e2e] first sync notice: ${firstNoticeText.replace(/\s+/g, ' ').slice(0, 200)}`);
    await dismissNotice(page);

    // -----------------------------------------------------------------
    // Black-box assertions through the EdgeEver REST API.
    // -----------------------------------------------------------------
    // Notes are created locally and land on the server through EdgeEver's sync
    // queue; poll instead of assuming the notice implies the REST view updated.
    // Do not hardcode the notebook name: the real plugin renders the folder
    // template (e.g. 笔记同步助手/2026-10-28) while the stub uses a fixed one.
    let memos;
    if (usingRealKey) {
      memos = await waitFor(
        'new notes from the real API',
        async () => (await api.listMemos({ limit: 200 })).memos.filter((memo) => !preexistingMemoIds.has(memo.id)),
        (items) => items.length > 0,
        { timeout: 300_000 },
      );
    } else {
      memos = await waitFor(
        'three synced notes',
        async () => (await api.listMemos({ limit: 200 })).memos.filter((memo) => MOCK_TITLES.includes(memo.title)),
        (items) => items.length >= 3,
      );
    }
    const notebookId = memos[0].notebookId;
    const notebook = { id: notebookId };
    const notebookName = (await api.listNotebooks()).notebooks.find((item) => item.id === notebookId)?.name || '';
    console.log(`[e2e] notebook ${notebookId} (${notebookName}) has ${memos.length} notes`);
    assert(memos.every((memo) => !String(memo.id).startsWith('local_')), 'every synced note has a cloud id');

    // Folder template renders a notebook path; walk parents to prove multi-level.
    const allNotebooks = (await api.listNotebooks()).notebooks;
    const chain = [];
    const seenNotebooks = new Set();
    let cursorId = notebookId;
    while (cursorId && !seenNotebooks.has(cursorId)) {
      seenNotebooks.add(cursorId);
      const entry = allNotebooks.find((item) => item.id === cursorId);
      if (!entry) break;
      chain.unshift(entry.name);
      cursorId = entry.parentId;
    }
    if (packageKind !== 'stub') {
      assert(chain.length >= 2, `folder template produced a nested notebook path (got ${chain.join('/') || notebookName})`);
      assert(chain[0] === '笔记同步助手', `top level notebook is 笔记同步助手 (got ${chain[0]})`);
    }

    if (usingRealKey) {
      assert(memos.length > 0, 'real-key sync created at least one note');
      const resources = await waitFor(
        'resource from the public relay',
        async () => (await api.listResources()).resources,
        (items) => items.length > 0,
        { timeout: 300_000 },
      );
      assert(resources.length > 0, 'real-key sync localized at least one image resource');
      const withResource = await waitFor(
        'a note referencing an EdgeEver resource URL',
        async () => Promise.all(memos.slice(0, 10).map((memo) => api.getMemo(memo.id))),
        (details) => details.some((detail) => detail.memo.contentMarkdown.includes('/api/v1/resources/')),
        { timeout: 300_000 },
      );
      assert(withResource.length > 0, 'a note references an EdgeEver resource URL');
      assert(memos.every((memo) => !String(memo.id).startsWith('local_')), 'every synced note has a cloud id');
      const realLastRun = await readPluginData(page, { scope, pluginId: config.pluginId, key: 'lastRun' });
      assert(realLastRun && realLastRun.ok === true, `real-key lastRun.ok (got ${JSON.stringify(realLastRun)})`);
      console.log(`[e2e] real-key: ${memos.length} notes, imagesLocal=${realLastRun.imagesLocal}, imagesRemote=${realLastRun.imagesRemote}, resources=${resources.length}`);
      await page.getByText(notebookName, { exact: true }).first().click();
      await page.waitForTimeout(500);
      await shots.capture('note-list');
      // Open a note whose body already points at an EdgeEver-hosted image.
      const shown = withResource.find((detail) => detail.memo.contentMarkdown.includes('/api/v1/resources/'));
      const card = page.locator(`[data-memo-id="${shown.memo.id}"]`).first();
      if (await card.count()) {
        await card.locator('button').first().click();
        await page.waitForTimeout(1500);
        await shots.capture('note-detail');
      }
      console.log('[e2e] real-key assertions passed');
      return { mode, notebook, memos };
    }

    assert(memos.length === 3, `first sync created 3 notes (got ${memos.length})`);
    const byTitle = Object.fromEntries(memos.map((memo) => [memo.title, memo]));
    const localized = byTitle['E2E 同步：图片本地化'];
    const broken = byTitle['E2E 同步：图床不可用'];
    const paged = byTitle['E2E 同步：分页文章'];
    assert(localized && broken && paged, 'all three mock articles produced notes');

    const localizedDetail = await waitFor(
      'localized image URL in note markdown',
      async () => (await api.getMemo(localized.id)).memo,
      (memo) => memo.contentMarkdown.includes('/api/v1/resources/'),
    );
    const brokenDetail = (await api.getMemo(broken.id)).memo;
    const pagedDetail = (await api.getMemo(paged.id)).memo;
    assert(localizedDetail.contentMarkdown.includes('/api/v1/resources/'), 'CORS image was localized to an EdgeEver resource');
    assert(!localizedDetail.contentMarkdown.includes(`${mock.imageBase}/img/ok.png`), 'localized note no longer points at the mock image bed');
    assert(localized.title === 'E2E 同步：图片本地化', `title template rendered the article title (got ${localized.title})`);
    if (packageKind !== 'stub') {
      assert(localizedDetail.contentMarkdown.includes('author: E2E 测试作者'), 'front matter author');
      assert(localizedDetail.contentMarkdown.includes('source: E2E 测试站点'), 'front matter source');
      assert(localizedDetail.contentMarkdown.includes('url: https://example.test/articles/mock-e2e-0001'), 'front matter url');
      assert(localizedDetail.contentMarkdown.includes('tags: [笔记同步助手'), 'front matter tags');
      assert(localizedDetail.contentMarkdown.includes('## 图片本地化'), 'article body rendered');
    }
    assert(brokenDetail.contentMarkdown.includes(`${mock.imageBase}/img/no-cors.png`), 'no-CORS image kept its remote URL');
    assert(brokenDetail.contentMarkdown.includes(`${mock.imageBase}/img/missing.png`), '404 image kept its remote URL');
    assert(pagedDetail.contentMarkdown.includes('第二页'), 'second page article fetched');

    const resources = await waitFor(
      'uploaded ok.png resource',
      async () => (await api.listResources()).resources.filter((resource) => resource.memoId === localized.id),
      (items) => items.length >= 1,
    );
    assert(resources.length >= 1, 'resource uploaded for the localized image');
    assert(resources.some((resource) => /ok\.png$/.test(resource.filename || '')), 'resource filename is ok.png');
    assert(resources.every((resource) => resource.mimeType === 'image/png'), 'resource mime type is image/png');

    const lastRun = await readPluginData(page, { scope, pluginId: config.pluginId, key: 'lastRun' });
    assert(lastRun && lastRun.ok === true, `lastRun.ok is true (got ${JSON.stringify(lastRun)})`);
    assert(lastRun.created === 3, `lastRun.created === 3 (got ${lastRun.created})`);
    if (packageKind === 'stub') {
      assert(lastRun.imagesLocal === 1, `lastRun.imagesLocal === 1 (got ${lastRun.imagesLocal})`);
      assert(lastRun.imagesRemote === 2, `lastRun.imagesRemote === 2 (got ${lastRun.imagesRemote})`);
    } else {
      assert(lastRun.imagesLocal >= 1, `lastRun.imagesLocal >= 1 (got ${lastRun.imagesLocal})`);
      assert(lastRun.imagesRemote >= 2, `lastRun.imagesRemote >= 2 (got ${lastRun.imagesRemote})`);
    }

    assert(mock.requests.length >= 2, 'mock received paginated requests');
    assert(mock.requests.some((request) => request.after === 0), 'first page requested with after=0');
    assert(mock.requests.some((request) => request.after === 2), 'second page requested with after=2');
    assert(mock.requests.every((request) => request.hasApiKey), 'every article request carried x-api-key');

    // -----------------------------------------------------------------
    // Screenshots of the synced workspace.
    // -----------------------------------------------------------------
    await page.getByText(notebookName, { exact: true }).first().click();
    await page.waitForTimeout(600);
    await shots.capture('note-list');
    const imageCard = page.locator('[data-memo-id]').filter({ hasText: 'E2E 同步：图片本地化' }).first();
    await imageCard.waitFor({ state: 'visible', timeout: 20_000 });
    await imageCard.locator('button').first().click();
    await page.waitForTimeout(800);
    await shots.capture('note-detail');

    // -----------------------------------------------------------------
    // Dedupe: a second sync must not create more notes.
    // -----------------------------------------------------------------
    await page.goto(`${config.baseUrl}/`);
    await page.getByRole('button', { name: '新建笔记', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
    await openPluginMenu(page, config.pluginName);
    await clickPluginCommand(page, config.commandTitle);
    const secondNotice = await waitForNotice(page, '同步完成', 120_000);
    console.log(`[e2e] second sync notice: ${(await secondNotice.innerText()).replace(/\s+/g, ' ').slice(0, 200)}`);
    await dismissNotice(page);

    const memosAfter = (await api.listMemos({ limit: 200 })).memos.filter((memo) => MOCK_TITLES.includes(memo.title));
    assert(memosAfter.length === 3, `second sync kept note count at 3 (got ${memosAfter.length})`);
    const lastRunAfter = await readPluginData(page, { scope, pluginId: config.pluginId, key: 'lastRun' });
    assert(lastRunAfter.created === 0, `second run created 0 notes (got ${lastRunAfter.created})`);
    assert(lastRunAfter.skipped === 3, `second run skipped 3 notes (got ${lastRunAfter.skipped})`);

    // -----------------------------------------------------------------
    // User edits must win: a later sync cannot overwrite the note.
    // -----------------------------------------------------------------
    const editSession = (await api.request(`/api/v1/memos/${localized.id}/edit-sessions`, { method: 'POST' })).editSession;
    const beforeEdit = (await api.getMemo(localized.id)).memo;
    const userMarker = '用户手动修改的段落（E2E）';
    await api.request(`/api/v1/memos/${localized.id}`, {
      method: 'PATCH',
      body: {
        expectedRevision: editSession.baseRevision,
        expectedContentHash: editSession.baseContentHash,
        editSessionId: editSession.id,
        title: beforeEdit.title ?? '',
        contentMarkdown: `${beforeEdit.contentMarkdown}\n\n${userMarker}`,
        tags: beforeEdit.tags,
      },
    });
    // Reload so the local mirror bootstraps the edited note before the plugin reads it.
    await page.reload();
    await page.getByRole('button', { name: '新建笔记', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(1_500);
    await openPluginMenu(page, config.pluginName);
    await clickPluginCommand(page, config.commandTitle);
    const editNotice = await waitForNotice(page, '同步', 120_000);
    await dismissNotice(page);
    const editedMemo = (await api.getMemo(localized.id)).memo;
    assert(editedMemo.contentMarkdown.includes(userMarker), 'user edit survives the next sync');
    const lastRunEdit = await readPluginData(page, { scope, pluginId: config.pluginId, key: 'lastRun' });
    assert(lastRunEdit.created === 0, `edit run created 0 notes (got ${lastRunEdit.created})`);
    console.log('[e2e] user-edited note was not overwritten');

    // -----------------------------------------------------------------
    // Incremental: the mock now returns one new article; only one note is added.
    // -----------------------------------------------------------------
    mock.setScenario('incremental');
    await page.goto(`${config.baseUrl}/`);
    await page.getByRole('button', { name: '新建笔记', exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 });
    await openPluginMenu(page, config.pluginName);
    await clickPluginCommand(page, config.commandTitle);
    await waitForNotice(page, '同步完成', 120_000);
    await dismissNotice(page);
    const incrementalTitle = 'E2E 增量：新文章';
    const incrementalMemos = await waitFor(
      'incremental article note',
      async () => (await api.listMemos({ limit: 200 })).memos.filter((memo) => memo.title === incrementalTitle),
      (items) => items.length === 1,
    );
    const lastRunIncremental = await readPluginData(page, { scope, pluginId: config.pluginId, key: 'lastRun' });
    assert(lastRunIncremental.created === 1, `incremental run created 1 note (got ${lastRunIncremental.created})`);
    const totalAfterIncremental = (await api.listMemos({ limit: 200 })).memos.filter((memo) => MOCK_TITLES.includes(memo.title) || memo.title === incrementalTitle);
    assert(totalAfterIncremental.length === 4, `incremental sync added exactly one note (got ${totalAfterIncremental.length})`);
    console.log(`[e2e] incremental article -> ${incrementalMemos[0].id}`);
    mock.setScenario('batch');

    // -----------------------------------------------------------------
    // The host sync queue must settle with no stuck entries.
    // -----------------------------------------------------------------
    const finalQueue = await waitFor(
      'empty host sync queue',
      async () => readSyncQueue(page),
      (items) => items.filter((item) => ['pending', 'syncing', 'error'].includes(item.status)).length === 0,
      { timeout: 30_000 },
    );
    assert(finalQueue.length === 0, `host sync queue is empty (got ${JSON.stringify(finalQueue)})`);

    console.log(`[e2e] ${mode} assertions passed`);
    return { mode, notebook, memos };
  } catch (error) {
    // Local-first writes hide server rejections; surface the queue so a failing
    // assertion points at the real reason (e.g. a local notebook id).
    if (page) {
      try {
        const queue = await page.evaluate(() => new Promise((resolve) => {
          const open = indexedDB.open('edgeever-local');
          open.onerror = () => resolve([]);
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains('syncQueue')) { resolve([]); return; }
            const request = db.transaction('syncQueue', 'readonly').objectStore('syncQueue').getAll();
            request.onsuccess = () => resolve(request.result.map((item) => ({
              kind: item.kind,
              entityId: item.memoId ?? item.entityId,
              status: item.status,
              error: item.lastError ?? null,
              notebookId: item.payload?.notebookId ?? null,
            })));
            request.onerror = () => resolve([]);
          };
        }));
        if (queue.length) console.error(`[e2e] local sync queue:\n${JSON.stringify(queue, null, 2)}`);
      } catch {
        // Diagnostics must never hide the original failure.
      }
    }
    throw error;
  } finally {
    if (diagnostics) {
      const report = diagnostics.report(mode);
      if (report) console.warn(report);
    }
    await browser.close();
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  if (!config.password) throw new Error('EDGEEVER_E2E_PASSWORD is missing (source .work/secrets.env)');

  const pkg = resolvePluginPackage({ e2eDir: config.e2eDir, projectRoot: config.projectRoot, forceStub: options.stub });
  const meta = readPackageVersion(pkg.dir);
  console.log(`[e2e] plugin package: ${pkg.kind} (${pkg.dir}) id=${meta.id} version=${meta.version}`);
  if (meta.id !== config.pluginId) throw new Error(`Plugin package id ${meta.id} !== ${config.pluginId}`);
  config.pluginVersion = meta.version;
  config.pluginName = meta.name;

  const staticServer = await startStaticServer({ rootDir: pkg.dir });
  const mock = await startMockArticles();
  console.log(`[e2e] manifest URL: ${staticServer.manifestUrl}`);
  console.log(`[e2e] mock article API: ${mock.endpoint} (image bed ${mock.imageBase})`);

  const modes = options.mode === 'both' ? ['tutorial', 'fast'] : [options.mode];
  const results = [];
  try {
    for (const mode of modes) {
      results.push(await runMode({ mode, config, options, staticServer, mock, packageKind: pkg.kind }));
    }
  } finally {
    await staticServer.close();
    await mock.close();
  }
  console.log('\n=== E2E summary ===');
  for (const result of results) {
    console.log(`- ${result.mode}: notebook ${result.notebook.id}, ${result.memos.length} notes`);
  }
};

main().catch((error) => {
  console.error('\nE2E FAILED');
  console.error(error?.stack || error);
  process.exitCode = 1;
});
