#!/usr/bin/env node
// Screenshots of the running demo (scripts/demo/run-demo.sh) and the launch images, into docs/images.
//
//   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright node scripts/demo/shoot.mjs [--out DIR] [--only a,b] [--no-compose]
//
// Needs Playwright with Chromium (`npx playwright install chromium`). Without PLAYWRIGHT_MODULE it uses
// require('playwright') from this repo. Env: PILOTAGE_DEMO_DIR, PILOTAGE_DEMO_PORT as for run-demo.sh.
//
// Shots: desktop 1440×900 and phone 390×844, dark theme, device scale 2. Then two compositions rendered from HTML:
// hero.png (desktop Home + phone Sessions on a dark gradient, title and tagline) and scout.png (the Possible projects cards).
// The visible text of every page is saved to $PILOTAGE_DEMO_DIR/shot-text/*.txt for leak checks.
// PNGs are written as-is; scripts/demo/optimize.py shrinks them (palette PNG) if Pillow is installed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
const OUT = path.resolve(opt('--out') || path.join(ROOT, 'docs', 'images'));
const ONLY = opt('--only') ? new Set(opt('--only').split(',')) : null;
const DEMO_DIR = path.resolve(process.env.PILOTAGE_DEMO_DIR || '/tmp/pilotage-demo');
const PORT = Number(process.env.PILOTAGE_DEMO_PORT || 4963);
const BASE = `http://pilotage.localhost:${PORT}`;
const FAKE_HOME = path.join(DEMO_DIR, 'home', OWNER.user);
const TEXT_DIR = path.join(DEMO_DIR, 'shot-text');

let pw;
try {
  pw = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch {
  console.error('Playwright not found. Install it (npm i -D playwright && npx playwright install chromium) or set PLAYWRIGHT_MODULE.');
  process.exit(1);
}

const projectId = (rel) => crypto.createHash('sha256').update(path.join(FAKE_HOME, rel)).digest('hex').slice(0, 10);

function loginUrl() {
  const env = { PATH: process.env.PATH, HOME: FAKE_HOME, PILOTAGE_DATA: path.join(DEMO_DIR, 'data'), PILOTAGE_PORT: String(PORT) };
  return execFileSync(process.execPath, [path.join(ROOT, 'server', 'cli.js'), 'login-url'], { env }).toString().trim();
}

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

async function context(browser, opts) {
  const ctx = await browser.newContext({ colorScheme: 'dark', locale: 'en-US', ...opts });
  // The Home greeting has the owner's first name compiled into the bundle; show the demo owner's name instead.
  await ctx.route(/\/assets\/.*\.js$/, async (route) => {
    // (fetched by Node, which doesn't resolve *.localhost: ask 127.0.0.1 directly)
    const resp = await route.fetch({ url: route.request().url().replace('//pilotage.localhost:', '//127.0.0.1:') });
    const body = (await resp.text()).replace(/(`\$\{[A-Za-z0-9_$]+\(\)\}, )[A-Z][a-z]+`/g, `$1${OWNER.name}\``);
    await route.fulfill({ response: resp, body });
  });
  const page = await ctx.newPage();
  await page.goto(loginUrl(), { waitUntil: 'domcontentloaded' });
  await page.waitForURL(`${BASE}/`, { timeout: 15000 });
  return { ctx, page };
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('main h1', { timeout: 15000 });
  // let queries resolve and cards render
  for (let i = 0; i < 20; i++) {
    const loading = await page.locator('.skeleton, [aria-busy="true"]').count();
    if (!loading) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(900);
}

async function shot(page, name, url, { prepare, clip } = {}) {
  if (ONLY && !ONLY.has(name)) return null;
  await page.goto(BASE + url, { waitUntil: 'domcontentloaded' });
  await settle(page);
  if (prepare) await prepare(page);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide', ...(clip ? { clip } : {}) });
  // The text on screen, for leak checks (grep these before publishing the images)
  fs.mkdirSync(TEXT_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEXT_DIR, `${name}.txt`), await page.evaluate(() => document.body.innerText));
  console.log(`  ${path.relative(ROOT, file)}`);
  return file;
}

const dataUri = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

async function render(browser, html, file, { width, height, scale = 2 }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  await page.screenshot({ path: file, animations: 'disabled' });
  await ctx.close();
  console.log(`  ${path.relative(ROOT, file)}`);
}

// ------------------------------------------------------------------------------------------------ compositions

const FONT = `'Inter', 'Inter Display', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif`;

// Pilotage's own app icon (web/public/icon.svg), with a faint ring so it stands out on the dark background.
const LOGO = `<span class="logo">${fs.readFileSync(path.join(ROOT, 'web', 'public', 'icon.svg'), 'utf8').replace(/<\?xml[^>]*>/, '')}</span>`;
const LOGO_CSS = (size) => `.logo{display:inline-flex;width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.22)}px;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 6px 18px rgba(0,0,0,.4)}.logo svg{width:100%;height:100%}`;

function heroHtml({ desktop, phone }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:1000px;height:625px;overflow:hidden}
  body{font-family:${FONT};color:#ededf0;-webkit-font-smoothing:antialiased;
    background:
      radial-gradient(900px 420px at 18% -8%, rgba(139,151,255,.20), transparent 62%),
      radial-gradient(700px 500px at 100% 105%, rgba(108,120,240,.16), transparent 60%),
      linear-gradient(180deg,#0d0f17 0%,#0a0b10 100%);}
  .grain{position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.035) 1px,transparent 1px);background-size:3px 3px;opacity:.5;pointer-events:none}
  ${LOGO_CSS(34)}
  header{position:absolute;left:64px;top:30px;right:64px;display:flex;align-items:center;gap:14px}
  .word{font-size:30px;font-weight:700;letter-spacing:-.02em}
  .tag{position:absolute;left:64px;top:76px;font-size:16.5px;color:#a9acb8;letter-spacing:-.005em}
  .tag b{color:#d9dcff;font-weight:600}
  .browser{position:absolute;left:64px;top:114px;width:720px;border-radius:12px;overflow:hidden;background:#141519;
    border:1px solid rgba(255,255,255,.09);box-shadow:0 30px 80px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.6)}
  .bar{height:30px;display:flex;align-items:center;gap:7px;padding:0 12px;background:#17181d;border-bottom:1px solid rgba(255,255,255,.06)}
  .dot{width:10px;height:10px;border-radius:50%;background:#2d2f37}
  .url{margin-left:auto;margin-right:auto;transform:translateX(-24px);height:19px;width:250px;border-radius:6px;background:#0f1014;
    color:#8e919c;font-size:10.5px;display:flex;align-items:center;justify-content:center;gap:6px;letter-spacing:.01em}
  .url svg{opacity:.7}
  .browser img{display:block;width:100%}
  .phone{position:absolute;left:752px;top:164px;width:192px;padding:7px;border-radius:34px;background:#050608;
    border:1px solid rgba(255,255,255,.12);box-shadow:0 30px 70px rgba(0,0,0,.65),inset 0 0 0 1px rgba(255,255,255,.04)}
  .screen{border-radius:27px;overflow:hidden;background:#0a0b0d;position:relative}
  .status{height:20px;display:flex;align-items:center;justify-content:space-between;padding:0 16px 0 18px;font-size:9px;font-weight:600;color:#ededf0;background:#0a0b0d}
  .cam{position:absolute;top:6px;left:50%;width:8px;height:8px;margin-left:-4px;border-radius:50%;background:#000;box-shadow:0 0 0 1.5px #15161a}
  .icons{display:flex;gap:4px;align-items:center}
  .phone img{display:block;width:100%}
  </style></head><body><div class="grain"></div>
  <header>${LOGO}<span class="word">Pilotage</span></header>
  <p class="tag">A local cockpit for all your <b>Claude Code</b> sessions, on your PC and your phone.</p>
  <div class="browser"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span>
    <span class="url"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>localhost:4747</span></div>
    <img src="${desktop}"></div>
  <div class="phone"><div class="screen"><div class="status"><span>9:41</span><span class="cam"></span><span class="icons">
    <svg width="11" height="8" viewBox="0 0 22 16"><path d="M1 15h3V11H1zM7 15h3V8H7zM13 15h3V5h-3zM19 15h2V1h-2z" fill="#ededf0"/></svg>
    <svg width="15" height="8" viewBox="0 0 30 16"><rect x="1" y="1" width="25" height="14" rx="3.5" fill="none" stroke="#ededf0" stroke-width="1.6"/><rect x="3.5" y="3.5" width="17" height="9" rx="1.6" fill="#ededf0"/><rect x="27.5" y="5.5" width="2" height="5" rx="1" fill="#ededf0"/></svg></span></div>
    <img src="${phone}"></div></div>
  </body></html>`;
}

const PAD = 22;
function scoutHtml({ cards, w, h }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${w}px;height:${h}px;overflow:hidden}
  body{font-family:${FONT};color:#ededf0;-webkit-font-smoothing:antialiased;
    background:radial-gradient(700px 360px at 12% -10%, rgba(139,151,255,.18), transparent 62%),
      radial-gradient(600px 400px at 105% 110%, rgba(108,120,240,.12), transparent 60%),
      linear-gradient(180deg,#0d0f17,#0a0b10);}
  ${LOGO_CSS(30)}
  .head{position:absolute;left:56px;top:40px;display:flex;align-items:center;gap:12px}
  .head .t{font-size:24px;font-weight:700;letter-spacing:-.015em}
  .sub{position:absolute;left:56px;top:80px;font-size:15px;color:#a9acb8;max-width:${w - 112}px}
  .card{position:absolute;left:56px;top:124px;right:56px;padding:${PAD}px;border-radius:16px;overflow:hidden;background:#0e0f12;
    border:1px solid rgba(255,255,255,.09);box-shadow:0 28px 70px rgba(0,0,0,.55)}
  .card img{display:block;width:100%}
  </style></head><body>
  <div class="head">${LOGO}<span class="t">Possible projects</span></div>
  <p class="sub">Pilotage reads your sessions and spots the side project hiding in your work, with the quotes that prove it.</p>
  <div class="card"><img src="${cards}"></div>
  </body></html>`;
}

// ------------------------------------------------------------------------------------------------ run

fs.mkdirSync(OUT, { recursive: true });
const browser = await pw.chromium.launch();
try {
  console.log('desktop (1440×900, dark)');
  const d = await context(browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const desktopHome = await shot(d.page, 'home', '/');
  await shot(d.page, 'sessions', '/sessions');
  await shot(d.page, 'tasks-suggested', '/tasks?tab=suggested');
  await shot(d.page, 'project', `/projects/${projectId('saas/invoicely')}`);
  await shot(d.page, 'ideas-possible-projects', '/ideas');
  // The Map: wait for the layout to draw its nodes and come to rest.
  const mapReady = async (page) => {
    await page.waitForSelector('.mp-svg circle, .mp-svg [data-node]', { timeout: 15000 });
    await page.waitForTimeout(3000);
  };
  await shot(d.page, 'map', '/map', { prepare: mapReady });

  // The Possible projects section on its own (for scout.png)
  let cards = null;
  if (!ONLY || ONLY.has('scout')) {
    await d.page.goto(`${BASE}/ideas`, { waitUntil: 'domcontentloaded' });
    await settle(d.page);
    // the grid that holds every "Make it a project" button, with some app background around it
    const box = await d.page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')].filter((b) => /make it a project/i.test(b.textContent || ''));
      if (!btns.length) return null;
      let a = btns[0];
      while (a && !btns.every((b) => a.contains(b))) a = a.parentElement;
      const r = a.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    });
    if (box) {
      // just the grid; scoutHtml frames it with the app background
      cards = path.join(OUT, '.scout-cards.png');
      await d.page.screenshot({ path: cards, animations: 'disabled', fullPage: true, clip: box });
    } else console.warn('  (no Possible projects cards found)');
  }
  await d.ctx.close();

  console.log('phone (390×844, dark)');
  const p = await context(browser, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: PHONE_UA });
  await shot(p.page, 'phone-home', '/');
  const phoneSessions = await shot(p.page, 'phone-sessions', '/sessions');
  await shot(p.page, 'phone-map', '/map', {
    prepare: async (page) => {
      await page.waitForSelector('.mp-svg circle, .mp-svg [data-node]', { timeout: 15000 });
      await page.waitForTimeout(3000);
    },
  });
  await p.ctx.close();

  if (!argv.includes('--no-compose')) {
    console.log('compositions');
    const desk = desktopHome || path.join(OUT, 'home.png');
    const ph = phoneSessions || path.join(OUT, 'phone-sessions.png');
    if (fs.existsSync(desk) && fs.existsSync(ph)) await render(browser, heroHtml({ desktop: dataUri(desk), phone: dataUri(ph) }), path.join(OUT, 'hero.png'), { width: 1000, height: 625 });
    if (cards && fs.existsSync(cards)) {
      const meta = await (async () => {
        const ctx = await browser.newContext();
        const pg = await ctx.newPage();
        await pg.setContent(`<img id="i" src="${dataUri(cards)}">`);
        const r = await pg.evaluate(() => ({ w: document.getElementById('i').naturalWidth, h: document.getElementById('i').naturalHeight }));
        await ctx.close();
        return r;
      })();
      const w = 1000;
      const inner = w - 112 - PAD * 2 - 2;
      const h = Math.round(124 + (inner * meta.h) / meta.w + PAD * 2 + 2 + 44);
      await render(browser, scoutHtml({ cards: dataUri(cards), w, h }), path.join(OUT, 'scout.png'), { width: w, height: h });
      fs.rmSync(cards, { force: true });
    }
  }
} finally {
  await browser.close();
}
