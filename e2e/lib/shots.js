'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Screenshot helper: `e2e/shots/<run>/NN-name.png`, numbered in capture order.
 * `shots/` is gitignored; the tutorial shots are picked from there by hand.
 */
class Screenshots {
  constructor(rootDir, runName, page) {
    this.dir = path.join(rootDir, runName);
    this.page = page;
    this.index = 0;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  async capture(name, { fullPage = false, settleMs = 350 } = {}) {
    if (!this.page) throw new Error('Screenshots has no page attached');
    this.index += 1;
    const file = path.join(this.dir, `${String(this.index).padStart(2, '0')}-${name}.png`);
    if (settleMs > 0) await this.page.waitForTimeout(settleMs);
    await this.page.screenshot({ path: file, fullPage, scale: 'css' });
    console.log(`[shot] ${path.relative(process.cwd(), file)}`);
    return file;
  }
}

module.exports = { Screenshots };
