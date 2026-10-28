'use strict';

const PLUGIN_SETTINGS_PREFIX = 'edgeever.plugin-settings.v1';
const PLUGIN_DATA_PREFIX = 'edgeever.plugin-data.v1';
const TRUST_KEY = 'edgeever:plugins:trusted-code:1';

const settingsStorageKey = (scope, pluginId, key) => `${PLUGIN_SETTINGS_PREFIX}:${scope}:${pluginId}:${key}`;
const dataStorageKey = (scope, pluginId, key) => `${PLUGIN_DATA_PREFIX}:${scope}:${pluginId}:${key}`;

/**
 * Seeds plugin settings *before* the app boots. Non-secret settings live in
 * localStorage (plugin-host.ts:64 / setSettingValue), so an init script is enough.
 */
const installLocalStorageSeed = (context, seed) => context.addInitScript((payload) => {
  try {
    for (const [key, value] of Object.entries(payload.settings || {})) {
      localStorage.setItem(`${payload.settingsPrefix}:${payload.scope}:${payload.pluginId}:${key}`, JSON.stringify(value));
    }
    for (const [key, value] of Object.entries(payload.data || {})) {
      localStorage.setItem(`${payload.dataPrefix}:${payload.scope}:${payload.pluginId}:${key}`, JSON.stringify(value));
    }
    if (payload.trusted) localStorage.setItem(payload.trustKey, 'acknowledged');
  } catch {
    // about:blank frames have no storage; ignore.
  }
}, {
  scope: seed.scope,
  pluginId: seed.pluginId,
  settings: seed.settings || {},
  data: seed.data || {},
  trusted: seed.trusted !== false,
  settingsPrefix: PLUGIN_SETTINGS_PREFIX,
  dataPrefix: PLUGIN_DATA_PREFIX,
  trustKey: TRUST_KEY,
});

/** Writes localStorage from an already-loaded page (no reload semantics). */
const seedLocalStorageNow = (page, seed) => page.evaluate((payload) => {
  for (const [key, value] of Object.entries(payload.settings || {})) {
    localStorage.setItem(`${payload.settingsPrefix}:${payload.scope}:${payload.pluginId}:${key}`, JSON.stringify(value));
  }
  for (const [key, value] of Object.entries(payload.data || {})) {
    localStorage.setItem(`${payload.dataPrefix}:${payload.scope}:${payload.pluginId}:${key}`, JSON.stringify(value));
  }
  if (payload.trusted) localStorage.setItem(payload.trustKey, 'acknowledged');
}, {
  ...seed,
  settingsPrefix: PLUGIN_SETTINGS_PREFIX,
  dataPrefix: PLUGIN_DATA_PREFIX,
  trustKey: TRUST_KEY,
});

const readPluginData = (page, { scope, pluginId, key }) => page.evaluate((payload) => {
  const raw = localStorage.getItem(`${payload.prefix}:${payload.scope}:${payload.pluginId}:${payload.key}`);
  return raw === null ? null : JSON.parse(raw);
}, { prefix: PLUGIN_DATA_PREFIX, scope, pluginId, key });

const readPluginSettings = (page, { scope, pluginId }) => page.evaluate((payload) => {
  const prefix = `${payload.prefix}:${payload.scope}:${payload.pluginId}:`;
  const result = {};
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    try { result[key.slice(prefix.length)] = JSON.parse(localStorage.getItem(key)); } catch { result[key.slice(prefix.length)] = localStorage.getItem(key); }
  }
  return result;
}, { prefix: PLUGIN_SETTINGS_PREFIX, scope, pluginId });

/**
 * Secret settings are AES-GCM encrypted with a per-device master key stored in
 * IndexedDB `edgeever-plugin-secrets-v1` (plugin-secret-store.ts). This mirrors
 * WebPluginSecretStore.set so automation can skip the settings UI.
 */
const seedPluginSecret = (page, { scope, pluginId, key, value }) => page.evaluate(async (payload) => {
  const DB_NAME = 'edgeever-plugin-secrets-v1';
  const open = indexedDB.open(DB_NAME, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
    if (!db.objectStoreNames.contains('secrets')) db.createObjectStore('secrets', { keyPath: 'id' });
  };
  const db = await new Promise((resolve, reject) => {
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  const request = (store, mode, action) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = action(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  let masterKey = await request('keys', 'readonly', (store) => store.get('device-master-key'));
  if (!masterKey) {
    masterKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await request('keys', 'readwrite', (store) => store.put(masterKey, 'device-master-key'));
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    masterKey,
    new TextEncoder().encode(payload.value),
  );
  const id = `${payload.scope}:${payload.pluginId}:setting:${payload.key}`;
  await request('secrets', 'readwrite', (store) => store.put({ id, iv, ciphertext }));
  db.close();
  return id;
}, { scope, pluginId, key, value });

const waitForPluginCard = async (page, pluginName, timeout = 40_000) => {
  await page.getByText(pluginName, { exact: true }).first().waitFor({ state: 'visible', timeout });
};

const waitForEnabledSwitch = async (page, pluginName, enabled, timeout = 40_000) => {
  const toggle = page.getByRole('switch', { name: `启用或停用 ${pluginName}`, exact: true }).first();
  await toggle.waitFor({ state: 'visible', timeout });
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await toggle.isChecked() === enabled) return toggle;
    await page.waitForTimeout(200);
  }
  throw new Error(`Plugin switch did not become ${enabled ? 'enabled' : 'disabled'}`);
};

/** Opens the puzzle menu in the top bar (PluginToolbarMenu, aria-label "插件"). */
const openPluginMenu = async (page, pluginName) => {
  await page.getByRole('button', { name: '插件', exact: true }).first().click();
  const menu = page.getByRole('menu');
  await menu.waitFor({ state: 'visible', timeout: 10_000 });
  await menu.getByText(pluginName, { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 });
  return menu;
};

const clickPluginCommand = async (page, commandTitle) => {
  await page.getByRole('menu').getByRole('menuitem', { name: commandTitle, exact: true }).click();
};

const runPluginCommand = async (page, { pluginName, commandTitle }) => {
  await openPluginMenu(page, pluginName);
  await clickPluginCommand(page, commandTitle);
};

const waitForNotice = async (page, text, timeout = 120_000) => {
  const dialog = page.getByRole('dialog');
  await dialog.filter({ hasText: text }).first().waitFor({ state: 'visible', timeout });
  return dialog.filter({ hasText: text }).first();
};

const dismissNotice = async (page) => {
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) {
    const button = dialog.getByRole('button', { name: '知道了', exact: true });
    if (await button.count()) await button.first().click();
  }
};

module.exports = {
  installLocalStorageSeed,
  seedLocalStorageNow,
  seedPluginSecret,
  readPluginData,
  readPluginSettings,
  waitForPluginCard,
  waitForEnabledSwitch,
  openPluginMenu,
  clickPluginCommand,
  runPluginCommand,
  waitForNotice,
  dismissNotice,
  settingsStorageKey,
  dataStorageKey,
};
