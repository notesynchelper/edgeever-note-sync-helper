'use strict';

const { chromium } = require('playwright-core');

const launchBrowser = async ({ chromePath, headless = true }) => {
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    colorScheme: 'light',
  });
  return { browser, context };
};

const attachDiagnostics = (page) => {
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(String(error?.stack || error)));
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? '';
    // CORS failures for the intentionally broken image bed are expected.
    if (/\/img\/no-cors\.png|\/img\/missing\.png/.test(request.url())) return;
    failedRequests.push(`${request.method()} ${request.url()} :: ${failure}`);
  });
  return {
    consoleErrors,
    pageErrors,
    failedRequests,
    report(label) {
      const lines = [];
      if (pageErrors.length) lines.push(`[${label}] pageerror:\n${pageErrors.join('\n')}`);
      if (consoleErrors.length) lines.push(`[${label}] console.error:\n${consoleErrors.slice(0, 20).join('\n')}`);
      if (failedRequests.length) lines.push(`[${label}] requestfailed:\n${failedRequests.slice(0, 20).join('\n')}`);
      return lines.join('\n');
    },
  };
};

/** Adds a style tag that disables animations so screenshots are deterministic. */
const freezeAnimations = async (page) => {
  await page.addStyleTag({
    content: '*,*::before,*::after{animation-duration:0s !important;animation-delay:0s !important;transition-duration:0s !important;caret-color:transparent !important;}',
  }).catch(() => undefined);
};

const waitForAppShell = async (page, timeout = 30_000) => {
  await page.waitForLoadState('domcontentloaded');
  // The workspace renders the memo list or a login screen; wait for either the
  // "新建笔记" button or the plugin market heading to appear.
  await Promise.race([
    page.getByRole('button', { name: '新建笔记', exact: true }).first().waitFor({ state: 'visible', timeout }),
    page.getByText('插件市场', { exact: true }).first().waitFor({ state: 'visible', timeout }),
  ]);
};

module.exports = { launchBrowser, attachDiagnostics, freezeAnimations, waitForAppShell };
