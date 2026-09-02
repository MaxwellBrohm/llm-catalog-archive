#!/usr/bin/env node
/**
 * The share card, rendered once into src/site/og.png.
 *
 * WHY A REAL BROWSER. The card is set in the site's own typefaces on the site's
 * own ground, and the only thing here that can lay out Space Grotesk is the
 * thing that lays out the site. Drawing it in a raster library would mean
 * approximating the type, which is exactly the tell a share card exists to
 * avoid.
 *
 * WHY STATIC. A card per page would need a browser in the deploy, which is a
 * heavy dependency for an asset that says the same thing on every page. This is
 * branding, not data: the per-page specificity already lives in og:title and
 * og:description, which are generated.
 *
 * Run: node tools/make-og-image.mjs        (needs the site built and served)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = process.argv[2] ?? 'http://localhost:5199';

const card = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${origin}/style.css">
<style>
  html,body{margin:0;padding:0;background:#050505;width:1200px;height:630px;overflow:hidden}
  .card{position:relative;width:1200px;height:630px;display:flex;flex-direction:column;
        justify-content:center;padding:0 90px;box-sizing:border-box}
  .rail{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
  h1{font-family:var(--display);font-size:74px;line-height:1.02;letter-spacing:-0.025em;
     color:#f6f1ea;margin:0 0 26px;font-weight:700}
  p{font-family:var(--body);font-size:27px;line-height:1.45;color:#9b948c;margin:0;max-width:22ch}
  .kicker{font-family:var(--mono);font-size:19px;letter-spacing:0.2em;color:#ff6a00;
          margin:0 0 30px;text-transform:uppercase}
  .foot{position:absolute;left:90px;bottom:56px;font-family:var(--mono);font-size:20px;color:#6f6862}
</style></head><body>
<div class="card">
  <svg class="rail" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="b" cx="78%" cy="42%" r="55%">
      <stop offset="0%" stop-color="#ff6a00" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#ff6a00" stop-opacity="0"/>
    </radialGradient></defs>
    <rect width="1200" height="630" fill="url(#b)"/>
    <rect x="884" y="70" width="7" height="490" rx="3.5" fill="#3a1c07"/>
    <rect x="884" y="70" width="7" height="300" rx="3.5" fill="#a8450b"/>
    <circle cx="887.5" cy="150" r="34" fill="#050505"/><circle cx="887.5" cy="150" r="26" fill="#ff6a00"/>
    <circle cx="878" cy="140" r="9" fill="#ffb680"/>
    <circle cx="887.5" cy="320" r="24" fill="#050505"/><circle cx="887.5" cy="320" r="15" fill="#ff6a00"/>
    <circle cx="887.5" cy="470" r="18" fill="#050505"/><circle cx="887.5" cy="470" r="9" fill="#8a3c0a"/>
  </svg>
  <p class="kicker">AI news for developers</p>
  <h1>What providers<br>actually published</h1>
  <p>Every claim links the exact bytes it came from, at the commit that stored them.</p>
  <div class="foot">no ads &middot; no paywall &middot; keyless API and CLI</div>
</div></body></html>`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
const file = path.join(tmp, 'card.html');
fs.writeFileSync(file, card);
const out = path.join(root, 'src', 'site', 'og.png');
try {
  execFileSync(
    CHROME,
    /*
     * No device-scale flag: 1 is the headless default, and spelling it trips the
     * force-push guard in test/git.test.ts, which scans everything that can hand
     * git an argument and now covers tools/. The guard is deliberately broader
     * than git's syntax and has been worked around four times; the right move on
     * a false positive is to write the command differently.
     */
    ['--headless', '--disable-gpu', '--hide-scrollbars',
     '--window-size=1200,630', '--virtual-time-budget=6000', `--screenshot=${out}`, `file://${file}`],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
const { size } = fs.statSync(out);
if (size < 4000) throw new Error(`og.png is ${size} bytes, which is a blank card`);
console.log(`wrote src/site/og.png (${size} bytes)`);
