#!/usr/bin/env node
// The animated GIF at the top of README.md, recorded from the running demo (scripts/demo/run-demo.sh).
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node scripts/demo/record.mjs [--out FILE] [--width PX] [--viewport WxH] [--no-gif]
//
// Needs Playwright with Chromium (`npx playwright install chromium`) and, for the GIF itself, python3 with Pillow
// (scripts/demo/make-gif.py). Without PLAYWRIGHT_MODULE it uses require('playwright') from this repo.
// Env: PILOTAGE_DEMO_DIR, PILOTAGE_DEMO_PORT as for run-demo.sh.
//
// What it records (desktop 1152×720, dark theme, device scale 2), about 21 s: Home with the pulse tiles and Needs you,
// a scroll down to Pick up, yesterday's session opened from there, its summary and next step, Resume, and a message
// typed into the Resume dialog. It stops before Start: the demo has no terminal, a launch would fail.
// The GIF is 1100 px wide (--width). 1152×720 rather than a wider window: README images are shown about 880 px wide,
// and the smaller the scale-down, the more legible the text; it is still the full desktop layout (2 columns > 1100 px).
// Build a fresh world first (run-demo.sh without --keep) so the "minutes ago" of the running sessions stay small.
//
// Frames are taken one by one on a virtual clock (each screenshot gets the duration it stands for), so the result does
// not depend on how fast the machine takes screenshots. Headless Chromium draws no mouse pointer: a fake one (arrow,
// hand over clickable things, I-beam over text fields) follows the mouse. The frames and frames.json go to
// $PILOTAGE_DEMO_DIR/gif-frames, the visible text of each scene to $PILOTAGE_DEMO_DIR/shot-text/demo-*.txt (leak
// checks), then make-gif.py builds docs/images/demo.gif (--no-gif skips that step; run make-gif.py yourself later).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { OWNER } from './world.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : null;
};
const OUT = path.resolve(opt('--out') || path.join(ROOT, 'docs', 'images', 'demo.gif'));
const WIDTH = Number(opt('--width') || 1100);
const DEMO_DIR = path.resolve(process.env.PILOTAGE_DEMO_DIR || '/tmp/pilotage-demo');
const PORT = Number(process.env.PILOTAGE_DEMO_PORT || 4963);
const BASE = `http://pilotage.localhost:${PORT}`;
const FAKE_HOME = path.join(DEMO_DIR, 'home', OWNER.user);
const FRAMES = path.join(DEMO_DIR, 'gif-frames');
const TEXT_DIR = path.join(DEMO_DIR, 'shot-text');
const [VW, VH] = (opt('--viewport') || '1152x720').split('x').map(Number);
const VIEWPORT = { width: VW, height: VH };

// The session to pick up (yesterday's, first in Pick up) and the message typed into the Resume dialog.
const PICK = 'Dunning emails for failed payments';
const MESSAGE = "Let's write the three dunning emails";

let pw;
try {
  pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch {
  console.error('Playwright not found. Install it (npm i -D playwright && npx playwright install chromium) or set PLAYWRIGHT_MODULE.');
  process.exit(1);
}

function loginUrl() {
  const env = { PATH: process.env.PATH, HOME: FAKE_HOME, PILOTAGE_DATA: path.join(DEMO_DIR, 'data'), PILOTAGE_PORT: String(PORT) };
  return execFileSync(process.execPath, [path.join(ROOT, 'server', 'cli.js'), 'login-url'], { env }).toString().trim();
}

// ------------------------------------------------------------------------------------------------ fake mouse pointer

const SVG = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const STROKE = 'stroke="#000" stroke-width="1.3" stroke-linejoin="round"';
const POINTERS = {
  // [svg, hotspot x, hotspot y]
  arrow: [SVG(22, 28, `<path d="M2 2 L2 21.5 L7 16.8 L10.4 24.6 L13.6 23.2 L10.3 15.6 L17 15.6 Z" fill="#fff" ${STROKE}/>`), 2, 2],
  hand: [
    SVG(24, 28, `<path d="M8.6 2.2c-1 0-1.8.8-1.8 1.8v10.4L5.3 12.9c-.8-.8-2-.8-2.7-.1-.7.7-.7 1.8-.1 2.6l4.9 6.2c1.1 1.4 2.7 2.2 4.4 2.2h3.6c3 0 5.2-2.4 5.2-5.3v-5c0-1-.8-1.7-1.7-1.7-.9 0-1.6.7-1.6 1.6v-1c0-1-.8-1.7-1.7-1.7s-1.7.8-1.7 1.7v-.7c0-1-.8-1.7-1.7-1.7s-1.7.8-1.7 1.7V4c0-1-.8-1.8-1.8-1.8z" fill="#fff" ${STROKE}/>`),
    8.6,
    2.4,
  ],
  beam: [SVG(14, 24, `<path d="M3 2.5h2.5c.8 0 1.5.5 1.5 1.3 0-.8.7-1.3 1.5-1.3H11M3 21.5h2.5c.8 0 1.5-.5 1.5-1.3 0 .8.7 1.3 1.5 1.3H11M7 4v16M5 12h4" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><path d="M3 2.5h2.5c.8 0 1.5.5 1.5 1.3 0-.8.7-1.3 1.5-1.3H11M3 21.5h2.5c.8 0 1.5-.5 1.5-1.3 0 .8.7 1.3 1.5 1.3H11M7 4v16M5 12h4" fill="none" stroke="#000" stroke-width="1.3" stroke-linecap="round"/>`), 7, 12],
};

// Injected in every page: a pointer that follows mousemove and takes the shape the page asks for (cursor: pointer →
// hand, text fields → I-beam). window.__demoRing(n) draws the click ring (0 = none, 1 = pressed, 2 = released).
const POINTER_JS = `(() => {
  const P = ${JSON.stringify(POINTERS)};
  const TEXT = 'textarea, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), [contenteditable=""], [contenteditable=true]';
  function setup() {
    if (document.getElementById('demo-pointer')) return;
    const st = document.createElement('style');
    st.textContent = '#demo-pointer{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform}'
      + '#demo-pointer .shape{position:absolute;left:0;top:0;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.45))}'
      + '#demo-pointer .ring{position:absolute;border-radius:50%;border:2px solid rgba(160,170,255,.95);background:rgba(139,151,255,.18);display:none}'
      + '#demo-pointer[data-ring="1"] .ring{display:block;left:-13px;top:-13px;width:26px;height:26px}'
      + '#demo-pointer[data-ring="2"] .ring{display:block;left:-20px;top:-20px;width:40px;height:40px;opacity:.45}';
    const el = document.createElement('div');
    el.id = 'demo-pointer';
    el.innerHTML = '<div class="ring"></div><div class="shape"></div>';
    document.documentElement.append(st, el);
    const shape = el.querySelector('.shape');
    let kind = '';
    const set = (k) => {
      if (k === kind) return;
      kind = k;
      shape.innerHTML = P[k][0];
      shape.style.transform = 'translate(' + -P[k][1] + 'px,' + -P[k][2] + 'px)';
    };
    const place = (x, y) => {
      el.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      const t = document.elementFromPoint(x, y);
      const c = t ? getComputedStyle(t).cursor : 'auto';
      set(c === 'pointer' ? 'hand' : c === 'text' || (c === 'auto' && t && t.closest(TEXT)) ? 'beam' : 'arrow');
    };
    set('arrow');
    el.style.transform = 'translate(-100px,-100px)';
    document.addEventListener('mousemove', (e) => place(e.clientX, e.clientY), true);
    window.__demoPlace = place;
    window.__demoRing = (n) => (el.dataset.ring = String(n));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
  else setup();
})();`;

// ------------------------------------------------------------------------------------------------ frames on a virtual clock

const frames = [];
let page;
let mouse = { x: VW - 42, y: Math.round(VH * 0.6) }; // starts in the empty right margin
let showCaret = false; // the text caret, once the dialog has a focused message box (it blinks on its own)

async function frame(ms, { caret = showCaret } = {}) {
  const file = `${String(frames.length).padStart(4, '0')}.png`;
  await page.screenshot({ path: path.join(FRAMES, file), animations: 'disabled', caret: caret ? 'initial' : 'hide' });
  frames.push({ file, ms: Math.round(ms) });
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Move the pointer to (x, y) in `ms`, 20 frames a second. */
async function glide(x, y, ms = 700) {
  const from = { ...mouse };
  const n = Math.max(1, Math.round(ms / 50));
  for (let i = 1; i <= n; i++) {
    const k = ease(i / n);
    mouse = { x: from.x + (x - from.x) * k, y: from.y + (y - from.y) * k };
    await page.mouse.move(mouse.x, mouse.y);
    await page.waitForTimeout(16);
    await frame(50);
  }
}

/** Scroll the window to `top` in `ms` (eased), the pointer staying where it is. */
async function scrollTo(top, ms = 900) {
  const from = await page.evaluate(() => window.scrollY);
  const n = Math.max(1, Math.round(ms / 75));
  for (let i = 1; i <= n; i++) {
    const y = Math.round(from + (top - from) * ease(i / n));
    await page.evaluate((v) => window.scrollTo(0, v), y);
    await page.mouse.move(mouse.x, mouse.y); // refresh hover under the pointer
    await page.waitForTimeout(30);
    await frame(75);
  }
}

/** Press and release at the pointer, with a ring; `after` runs between the two ring frames (navigation, dialog…). */
async function click(after) {
  await page.evaluate(() => window.__demoRing(1));
  await page.mouse.down();
  await frame(120);
  await page.mouse.up();
  if (after) await after();
  await page.evaluate(() => window.__demoRing(2));
  await page.evaluate(([x, y]) => window.__demoPlace(x, y), [mouse.x, mouse.y]);
  await frame(90);
  await page.evaluate(() => window.__demoRing(0));
}

async function settle() {
  await page.waitForSelector('main h1', { timeout: 15000 });
  for (let i = 0; i < 20; i++) {
    if (!(await page.locator('.skeleton, [aria-busy="true"]').count())) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(900);
}

async function center(locator, dx = 0.5, dy = 0.5) {
  const b = await locator.boundingBox();
  if (!b) throw new Error(`not on screen: ${locator}`);
  return [b.x + b.width * dx, b.y + b.height * dy];
}

async function saveText(name) {
  fs.mkdirSync(TEXT_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEXT_DIR, `demo-${name}.txt`), await page.evaluate(() => document.body.innerText));
}

// ------------------------------------------------------------------------------------------------ run

fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });
const browser = await pw.chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'dark', locale: 'en-US' });
  // The Home greeting has the owner's first name compiled into the bundle; show the demo owner's name instead.
  await ctx.route(/\/assets\/.*\.js$/, async (route) => {
    const resp = await route.fetch({ url: route.request().url().replace('//pilotage.localhost:', '//127.0.0.1:') });
    const body = (await resp.text()).replace(/(`\$\{[A-Za-z0-9_$]+\(\)\}, )[A-Z][a-z]+`/g, `$1${OWNER.name}\``);
    await route.fulfill({ response: resp, body });
  });
  await ctx.addInitScript(POINTER_JS);
  page = await ctx.newPage();
  await page.goto(loginUrl(), { waitUntil: 'domcontentloaded' });
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
  await settle();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(mouse.x, mouse.y);
  await saveText('home');

  console.log('1. Home: the pulse tiles and Needs you');
  await frame(1500);
  const main = page.locator('main');
  await glide(...(await center(main.locator('.pulse-tile.t-amber'), 0.45, 0.6)), 750);
  await frame(1100);
  await glide(...(await center(main.locator('.needs-row .lrow-title .t').first(), 1.03, 0.6)), 600);
  await frame(1100);

  console.log('2. Scroll to Pick up, open yesterday’s session');
  const pickTitle = main.getByRole('heading', { name: 'Pick up', exact: true });
  const pickTop = await pickTitle.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
  const maxTop = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
  await scrollTo(Math.min(maxTop, Math.max(0, pickTop - 330)), 900);
  await frame(500);
  const row = main.locator('.pick-row', { hasText: PICK }).first();
  await glide(...(await center(row.locator('.lrow-title .t'), 1.03, 0.6)), 650);
  await frame(1000);
  await click(async () => {
    await page.waitForURL(/\/sessions\//, { timeout: 15000 });
    await settle();
    // The conversation opens at its latest turns; show the top of the page (title, summary, Resume).
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
  });
  await saveText('session');

  console.log('3. The session: summary and next step, then Resume');
  await frame(1200);
  const summary = main.getByRole('button', { name: /^Summary/ }).first();
  await glide(...(await center(summary, 0.12, 0.5)), 550);
  await frame(250);
  await click(async () => {
    await page.waitForTimeout(500);
  });
  await frame(1800);
  const resume = main.getByRole('button', { name: /^Resume$/ }).first();
  await glide(...(await center(resume, 0.55, 0.55)), 700);
  await frame(450);
  await click(async () => {
    await page.waitForSelector('textarea.ns-prompt', { timeout: 10000 });
    await page.waitForTimeout(500);
  });
  await saveText('dialog');

  console.log('4. The Resume dialog: type a message (no Start)');
  showCaret = true;
  await frame(900);
  const box = page.locator('textarea.ns-prompt');
  await glide(...(await center(box, 0.3, 0.55)), 500);
  await frame(200);
  await click(); // into the message box (it already has the focus)
  for (const ch of MESSAGE) {
    await page.keyboard.type(ch);
    await frame(ch === ' ' ? 110 : 75 + ((ch.charCodeAt(0) * 7) % 30));
  }
  // The message waits, the caret blinking. Chromium's own blink would land anywhere: retyping the last letter shows
  // the caret at a known moment, and the frames in between hide it.
  for (let i = 0; i < 5; i++) {
    if (i % 2 === 0 && i > 0) {
      await page.keyboard.press('Backspace');
      await page.keyboard.type(MESSAGE.at(-1));
    }
    await frame(500, { caret: i % 2 === 0 });
  }
  await saveText('typed');
  await ctx.close();
} finally {
  await browser.close();
}

const total = frames.reduce((s, f) => s + f.ms, 0);
fs.writeFileSync(path.join(FRAMES, 'frames.json'), JSON.stringify({ viewport: VIEWPORT, frames }, null, 1));
console.log(`${frames.length} frames, ${(total / 1000).toFixed(1)} s → ${FRAMES}`);

if (!argv.includes('--no-gif')) {
  const args = [path.join(HERE, 'make-gif.py'), FRAMES, OUT, '--width', String(WIDTH)];
  try {
    execFileSync('python3', args, { stdio: 'inherit' });
  } catch {
    console.error(`make-gif.py failed (needs python3 with Pillow). Run it yourself: python3 ${args.join(' ')}`);
    process.exit(1);
  }
}
