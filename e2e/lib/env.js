'use strict';

const fs = require('node:fs');
const path = require('node:path');

const E2E_DIR = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(E2E_DIR, '..');

/**
 * Minimal `.work/secrets.env` loader. The file is gitignored and never printed.
 * Existing environment variables always win so CI / one-off runs can override.
 */
const loadSecrets = (file = path.join(PROJECT_ROOT, '.work', 'secrets.env')) => {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
};

const bool = (value, fallback = false) => {
  if (value === undefined) return fallback;
  return !['0', 'false', 'no', 'off', ''].includes(String(value).toLowerCase());
};

const loadConfig = () => {
  loadSecrets();
  return {
    projectRoot: PROJECT_ROOT,
    e2eDir: E2E_DIR,
    workDir: path.join(PROJECT_ROOT, '.work'),
    shotsRoot: path.join(E2E_DIR, 'shots'),
    baseUrl: (process.env.EDGEEVER_E2E_BASE_URL || 'http://127.0.0.1:18787').replace(/\/$/, ''),
    username: process.env.EDGEEVER_E2E_USERNAME || 'admin',
    password: process.env.EDGEEVER_E2E_PASSWORD || '',
    chromePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    image: process.env.EDGEEVER_E2E_IMAGE || 'ghcr.io/tianma-if/edgeever:v2.12.0',
    notehelperApiKey: process.env.NOTEHELPER_API_KEY || '',
    pluginId: 'com.bijitongbu.note-sync-helper',
    pluginName: '笔记同步助手',
    commandTitle: '同步笔记',
    headless: bool(process.env.E2E_HEADLESS, true),
    // When a GitHub repository URL is used, the host's GitHub installer is exercised instead
    // of the local manifest server. The repo does not exist yet, so this is opt-in.
    source: process.env.E2E_PLUGIN_SOURCE || '',
    pluginVersion: process.env.E2E_PLUGIN_VERSION || '1.0.0',
  };
};

module.exports = { loadConfig, loadSecrets, PROJECT_ROOT, E2E_DIR };
