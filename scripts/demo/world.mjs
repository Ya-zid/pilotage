// The fictional world of the Pilotage demo (see make-demo.mjs for how it is turned into files).
//
// Alex Rivera is a freelance full-stack developer with 8 projects in 4 workspaces. Every name, client, number and
// path here is made up. Keep it that way: this file feeds public screenshots.
//
// Times: `day` is a day offset from today (0 = today, -3 = three days ago) with `at` = 'HH:MM' local time; sessions of
// today use `ago` (minutes before now) instead, so they always land in the past.
// Exchanges: [prompt, tools, reply, minutesUntilNextPrompt?]. Tools are short strings:
//   'R path' Read · 'E path' Edit · 'W path' Write · 'G pattern' Grep · 'B command | output' Bash · 'F url' WebFetch
// A reply of null means Claude is still working on that prompt (live sessions).

export const OWNER = { name: 'Alex', fullName: 'Alex Rivera', email: 'alex@example.com', user: 'alex' };

export const WORKSPACES = {
  clients: { name: 'Clients' },
  saas: { name: 'SaaS' },
  lab: { name: 'Lab' },
  oss: { name: 'Open source' },
};

const pkg = (name, deps = {}, dev = {}, extra = {}) =>
  `${JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', ...extra, dependencies: deps, devDependencies: dev }, null, 2)}\n`;

export const PROJECTS = {
  'northwind-shop': {
    dir: 'clients/northwind-shop',
    born: -38,
    files: {
      'package.json': pkg('northwind-shop', { next: '15.3.2', react: '19.1.0', 'react-dom': '19.1.0', stripe: '18.2.0', '@prisma/client': '6.8.2' }, { typescript: '5.8.3', prisma: '6.8.2', tailwindcss: '4.1.7', '@playwright/test': '1.52.0' }, { scripts: { dev: 'next dev', build: 'next build', test: 'playwright test' } }),
      'README.md': '# Northwind Shop\n\nOnline store for Northwind Coffee Roasters: single-origin beans, monthly subscription boxes and gift cards.\n\n- Next.js app router, Prisma + Postgres, Stripe\n- `npm run dev`, then http://localhost:3000\n',
      'CLAUDE.md': '# Northwind Shop\n\nClient project (Northwind Coffee Roasters). Staging: staging.northwind.example\n\n- Prices are stored in cents. Never hard-code VAT; it comes from Stripe Tax.\n- Run `npm test` (Playwright) before asking for review.\n- The client reviews every checkout change on staging first.\n',
      '.gitignore': 'node_modules/\n.next/\n.env*\n',
      'app/page.tsx': "export default function Home() {\n  return <main className=\"home\">Northwind Coffee Roasters</main>;\n}\n",
      'app/checkout/page.tsx': "import { CheckoutForm } from '@/components/CheckoutForm';\n\nexport default function CheckoutPage() {\n  return <CheckoutForm />;\n}\n",
      'components/CheckoutForm.tsx': "'use client';\nexport function CheckoutForm() {\n  return <form className=\"checkout\" />;\n}\n",
      'lib/stripe/webhooks.ts': "import Stripe from 'stripe';\n\nexport async function handleEvent(event: Stripe.Event) {\n  switch (event.type) {\n    default:\n      return;\n  }\n}\n",
      'prisma/schema.prisma': 'generator client {\n  provider = "prisma-client-js"\n}\n\ndatasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
      'docs/catalog.csv': 'slug,name,origin,roast\nethiopia-guji,Guji Natural,Ethiopia,light\ncolombia-huila,Huila Washed,Colombia,medium\n',
    },
    dirty: { 'components/PaymentForm.tsx': "'use client';\n// Payment Element + wallets (work in progress)\nexport function PaymentForm() {\n  return null;\n}\n", 'app/checkout/page.tsx': "import { PaymentForm } from '@/components/PaymentForm';\n\nexport default function CheckoutPage() {\n  return <PaymentForm />;\n}\n" },
    archived: [
      { day: -38, at: '09:30', prompts: ['set up a next.js 15 app router project for northwind coffee: tailwind, prisma with postgres, eslint. product pages come later', 'add a /health route and a basic layout with the logo from public/brand'], d: { title: 'Next.js storefront skeleton', summary: 'Set up the Next.js app router project with Tailwind, Prisma and Postgres.', outcome: 'Project skeleton with a health route and the base layout.', status: 'done', nextStep: '', topic: 'Setup', kind: 'build', cvWorthy: false, highlights: [] } },
      { day: -35, at: '14:10', prompts: ['make the tailwind theme match the brand guide in docs/brand.pdf: cream background, espresso brown text, the serif for headings', 'the buttons look too rounded, use 6px radius everywhere'], d: { title: 'Brand theme in Tailwind', summary: 'Matched the Tailwind theme to the client brand guide.', outcome: 'Colours, the heading serif and a 6px radius applied everywhere.', status: 'done', nextStep: '', topic: 'Setup', kind: 'design', cvWorthy: false, highlights: [] } },
    ],
  },
  'bloom-clinic': {
    dir: 'clients/bloom-clinic',
    born: -40,
    files: {
      'package.json': pkg('bloom-clinic', { react: '19.1.0', 'react-dom': '19.1.0', '@supabase/supabase-js': '2.49.4', twilio: '5.6.1', 'date-fns': '4.1.0' }, { vite: '6.3.5', typescript: '5.8.3', tailwindcss: '4.1.7', vitest: '3.1.4' }, { scripts: { dev: 'vite', test: 'vitest' } }),
      'README.md': '# Bloom Clinic booking\n\nOnline booking for Bloom Physio (3 locations): patients pick a therapist and a slot, get SMS reminders, staff manage schedules.\n',
      'CLAUDE.md': '# Bloom Clinic\n\nClient: Bloom Physio. Contact: Priya (clinic manager).\n\n- Supabase project `bloom-prod`; row level security on every table.\n- SMS through Twilio; templates live in `supabase/functions/reminders/templates.ts`.\n- Times are stored in UTC, shown in the clinic time zone.\n',
      '.gitignore': 'node_modules/\ndist/\n.env*\n',
      'src/App.tsx': "export default function App() {\n  return <div className=\"app\">Bloom</div>;\n}\n",
      'src/booking/Calendar.tsx': 'export function Calendar() {\n  return null;\n}\n',
      'supabase/functions/reminders/index.ts': "// Sends appointment reminders\nexport {};\n",
      'supabase/migrations/0001_init.sql': 'create table patients (id uuid primary key);\n',
    },
    archived: [{ day: -40, at: '10:15', prompts: ['data model for a physio clinic booking app: patients, therapists, rooms, appointments, 3 locations. use supabase', 'add row level security so therapists only see their own patients'], d: { title: 'Clinic data model with row level security', summary: 'Designed the Supabase schema for patients, therapists, rooms and appointments across 3 locations.', outcome: 'Schema and row level security in place: therapists only see their own patients.', status: 'done', nextStep: '', topic: 'Data model', kind: 'build', cvWorthy: false, highlights: [] } }],
  },
  invoicely: {
    dir: 'saas/invoicely',
    born: -41,
    files: {
      'package.json': pkg('invoicely', { next: '15.3.2', react: '19.1.0', 'react-dom': '19.1.0', 'drizzle-orm': '0.43.1', pg: '8.16.0', stripe: '18.2.0', '@react-pdf/renderer': '4.3.0' }, { typescript: '5.8.3', 'drizzle-kit': '0.31.1', tailwindcss: '4.1.7', vitest: '3.1.4' }, { workspaces: ['packages/*'] }),
      'README.md': '# Invoicely\n\nInvoicing for freelancers and small studios: recurring invoices, payment links, reminders. Beta.\n\n`packages/slack-bot` is the Slack app (create and chase invoices from Slack).\n',
      'CLAUDE.md': '# Invoicely\n\n- Monorepo: the web app at the root, the Slack app in `packages/slack-bot`.\n- Money is integer minor units + ISO currency. Never floats.\n- Drizzle migrations: `npm run db:generate` then `npm run db:migrate`.\n- Beta users: 6 Slack workspaces. Do not break `/invoice`.\n',
      '.gitignore': 'node_modules/\n.next/\n.env*\n.claude/worktrees/\n',
      'app/page.tsx': 'export default function Dashboard() {\n  return null;\n}\n',
      'db/schema.ts': "import { pgTable, text, integer } from 'drizzle-orm/pg-core';\n\nexport const invoices = pgTable('invoices', { id: text('id').primaryKey(), total: integer('total') });\n",
      'lib/stripe/webhooks.ts': "import Stripe from 'stripe';\n\nexport async function handleEvent(event: Stripe.Event) {\n  return event.type;\n}\n",
      'lib/pdf/InvoicePdf.tsx': 'export function InvoicePdf() {\n  return null;\n}\n',
      'packages/slack-bot/package.json': pkg('@invoicely/slack-bot', { '@slack/bolt': '4.4.0' }, { typescript: '5.8.3' }),
      'packages/slack-bot/README.md': '# Invoicely for Slack\n\n`/invoice @client 1200 "Design sprint"` creates and sends an invoice. Overdue reminders are posted in the channel.\n',
      'packages/slack-bot/src/app.ts': "import { App } from '@slack/bolt';\n\nexport const app = new App({ token: process.env.SLACK_BOT_TOKEN });\n",
    },
    dirty: { 'packages/slack-bot/src/digest.ts': '// Weekly revenue digest (work in progress)\nexport {};\n' },
    notes: 'Beta: 6 Slack workspaces use the bot. Pricing idea for the bot alone: €9 per workspace per month.',
    pinned: true,
    worktree: { name: 'slack-oauth', branch: 'slack-oauth' },
    memory: { 'slack-bot.md': '---\nname: Slack bot\ndescription: how the Invoicely Slack app is wired\n---\n\n- Slash command `/invoice` → `packages/slack-bot/src/commands/invoice.ts`\n- Overdue reminders run from the same cron as recurring invoices\n- OAuth install flow on branch `slack-oauth` (worktree)\n' },
    archived: [
      { day: -41, at: '20:40', prompts: ['drizzle schema for invoicely: clients, invoices, line items, payments. postgres', 'money as integer cents plus currency code, no floats anywhere'], d: { title: 'Drizzle schema for invoices', summary: 'Designed the Postgres schema for clients, invoices, line items and payments.', outcome: 'Schema with money stored as integer minor units plus a currency code.', status: 'done', nextStep: '', topic: 'Data model', kind: 'build', cvWorthy: false, highlights: [] } },
      { day: -33, at: '11:05', prompts: ['invoice numbers should restart every year: INV-2026-0001', 'make it per account, two users can both have INV-2026-0001'], d: { title: 'Yearly invoice numbering', summary: 'Invoice numbers restart every year and are unique per account.', outcome: 'Numbering like INV-2026-0001 works per account.', status: 'done', nextStep: '', topic: 'Data model', kind: 'build', cvWorthy: false, highlights: [] } },
    ],
  },
  'invoicely-mobile': {
    dir: 'saas/invoicely-mobile',
    born: -21,
    files: {
      'package.json': pkg('invoicely-mobile', { expo: '53.0.9', 'react-native': '0.79.2', react: '19.0.0', 'expo-camera': '16.1.6', 'expo-notifications': '0.31.2' }, { typescript: '5.8.3' }),
      'README.md': '# Invoicely mobile\n\nExpo app: invoice list, receipt scanning, paid notifications, offline drafts.\n',
      'app.json': '{ "expo": { "name": "Invoicely", "slug": "invoicely" } }\n',
      'app/(tabs)/index.tsx': 'export default function Invoices() {\n  return null;\n}\n',
      '.gitignore': 'node_modules/\n.expo/\n',
    },
  },
  'homelab-dashboard': {
    dir: 'lab/homelab-dashboard',
    born: -32,
    files: {
      'package.json': pkg('homelab-dashboard', { svelte: '5.33.1' }, { vite: '6.3.5', '@sveltejs/vite-plugin-svelte': '5.0.3', typescript: '5.8.3' }),
      'README.md': '# Homelab dashboard\n\nOne page for the home server: containers, disks, uptime, alerts. Runs in Docker on the NAS.\n',
      Dockerfile: 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci && npm run build\nCMD ["node", "server.js"]\n',
      'docker-compose.yml': 'services:\n  dashboard:\n    build: .\n    ports: ["8080:8080"]\n',
      'src/App.svelte': '<main>homelab</main>\n',
      'server.js': "// tiny API in front of the Docker socket\nexport {};\n",
      '.gitignore': 'node_modules/\ndist/\n',
    },
    archived: [{ day: -32, at: '21:30', prompts: ['svelte + vite dashboard that shows my homelab: docker containers, disk usage, uptime. it runs in a container on the NAS', 'read the docker socket from a tiny node server, never expose it to the browser'], d: { title: 'Dashboard skeleton behind a small API', summary: 'Started the Svelte dashboard with a small Node server in front of the Docker socket.', outcome: 'Skeleton runs in a container on the NAS; the socket is never exposed to the browser.', status: 'done', nextStep: '', topic: 'Setup', kind: 'build', cvWorthy: false, highlights: [] } }],
  },
  'rss-digest': {
    dir: 'lab/rss-digest',
    born: -18,
    files: {
      'requirements.txt': 'feedparser==6.0.11\nanthropic==0.52.0\njinja2==3.1.6\n',
      'README.md': '# rss-digest\n\nFetches ~10 feeds every morning and writes a 5-bullet digest to `out/digest.md` (cron + `claude -p`).\n',
      'digest.py': 'import feedparser\n\nFEEDS = open("feeds.txt").read().split()\n',
      'feeds.txt': 'https://example.com/feed.xml\n',
      'run.sh': '#!/bin/sh\npython3 digest.py && claude -p "$(cat prompt.txt)"\n',
      '.gitignore': 'out/\n__pycache__/\n',
    },
  },
  'portfolio-site': {
    dir: 'lab/portfolio-site',
    born: -30,
    files: {
      'package.json': pkg('portfolio-site', { astro: '5.8.0' }, { tailwindcss: '4.1.7', typescript: '5.8.3' }),
      'README.md': '# alexrivera.dev\n\nPersonal site: case studies, contact form. Astro.\n',
      'src/pages/index.astro': '---\n---\n<h1>Alex Rivera</h1>\n',
      'src/content/work/northwind.md': '---\ntitle: Northwind Coffee shop\n---\n',
      '.gitignore': 'node_modules/\ndist/\n',
    },
    dirty: { 'src/pages/contact.astro': '---\n// contact form, not deployed yet\n---\n<form method="post"></form>\n', 'src/pages/api/contact.ts': 'export const prerender = false;\n' },
  },
  'tiny-queue': {
    dir: 'oss/tiny-queue',
    born: -26,
    files: {
      'package.json': pkg('tiny-queue', { 'better-sqlite3': '11.10.0' }, { typescript: '5.8.3', vitest: '3.1.4' }, { description: 'A small job queue on SQLite. No Redis.', license: 'MIT' }),
      'README.md': '# tiny-queue\n\nA small, persistent job queue for Node.js backed by SQLite. No Redis, no daemon.\n\n```ts\nconst q = queue("emails");\nawait q.add({ to: "sam@example.com" }, { retries: 3 });\n```\n',
      LICENSE: 'MIT License\n\nCopyright (c) 2026 Alex Rivera\n',
      'src/index.ts': "export { queue } from './queue';\n",
      'src/queue.ts': 'export function queue(name: string) {\n  return { name };\n}\n',
      'src/scheduler.ts': 'export function nextRun(attempt: number) {\n  return 2 ** attempt * 1000;\n}\n',
      'bench/bullmq.ts': '// compare with BullMQ\nexport {};\n',
      '.gitignore': 'node_modules/\ndist/\n*.db\n',
    },
  },
};

// ------------------------------------------------------------------------------------------------ sessions

export const SESSIONS = [
  // ---------------------------------------------------------------- northwind-shop
  {
    key: 'N1', p: 'northwind-shop', day: -27, at: '10:05', title: 'Product catalog with Prisma seed data',
    x: [
      ['set up the product catalog: prisma models for products, variants (bag size, grind) and roast profiles. seed it from docs/catalog.csv, the client sent 12 coffees', ['R docs/catalog.csv', 'E prisma/schema.prisma', 'W prisma/seed.ts', 'B npx prisma migrate dev --name catalog | Applying migration `20261020093112_catalog`\nYour database is now in sync with your schema.', 'B npx prisma db seed | Seeded 12 products, 36 variants.'], 'Added `Product`, `Variant` and `RoastProfile` to the schema and a seed script that reads `docs/catalog.csv`. Migration applied; **12 products and 36 variants** seeded (3 bag sizes each).', 6],
      ['product page at /products/[slug] with the variant picker. grind options only for the 250g bag', ['W app/products/[slug]/page.tsx', 'W components/VariantPicker.tsx', 'B npm run build | ✓ Compiled successfully'], 'The product page renders server-side from Prisma; `VariantPicker` hides grind options unless the 250 g bag is selected. Build passes.', 9],
      ['looks good. commit it', ['B git add -A && git commit -m "feat(catalog): Prisma models, seed and product page" | [main 4e1a2c9] feat(catalog): Prisma models, seed and product page'], 'Committed as `feat(catalog): Prisma models, seed and product page`.'],
    ],
    commits: ['feat(catalog): Prisma models, seed and product page'],
    d: { title: 'Product catalog and product pages', summary: 'Built the coffee catalog on Prisma (products, variants, roast profiles) and the product page with a variant picker.', outcome: 'Catalog seeded with 12 coffees and 36 variants; product pages render and the build passes.', status: 'done', nextStep: '', topic: 'Catalog', kind: 'build', cvWorthy: true, highlights: ['Modelled a 12-product coffee catalog with 36 variants in Prisma and seeded it from the client spreadsheet'] },
  },
  {
    key: 'N2', p: 'northwind-shop', day: -24, at: '15:20', title: 'Product search with Postgres full-text',
    x: [
      ['customers can\'t find anything. add search over name, origin and tasting notes. postgres full text is enough, no algolia', ['G tasting_notes', 'E prisma/schema.prisma', 'W lib/search.ts', 'B npx prisma migrate dev --name search | Applying migration `20261023152210_search`'], 'Added a generated `tsvector` column (name, origin, tasting notes, weighted A/B/C) with a GIN index, and `lib/search.ts` that ranks with `ts_rank`. "fruity ethiopia" returns Guji Natural first.', 7],
      ['add it to the header with a debounced input, results in a dropdown', ['W components/SearchBox.tsx', 'E app/layout.tsx', 'B npx playwright test search | 3 passed (4.1s)'], 'Search box in the header (250 ms debounce, keyboard navigation, Esc closes). Playwright: 3 tests pass.'],
    ],
    commits: ['feat(search): Postgres full-text search in the header'],
    d: { title: 'Product search with Postgres full-text', summary: 'Added full-text search over coffee names, origins and tasting notes, with a header search box.', outcome: 'Ranked search works with a GIN index; header dropdown with keyboard support; 3 Playwright tests pass.', status: 'done', nextStep: '', topic: 'Search', kind: 'build', cvWorthy: true, highlights: ['Shipped Postgres full-text product search with weighted ranking instead of a paid search service'] },
  },
  {
    key: 'N3', p: 'northwind-shop', day: -19, at: '09:40', title: 'Monthly subscription boxes',
    x: [
      ['northwind wants subscription boxes: 1, 2 or 3 bags a month, customer picks roast preference, ships on the 1st. stripe subscriptions', ['R lib/stripe/webhooks.ts', 'E prisma/schema.prisma', 'W app/subscribe/page.tsx', 'W lib/stripe/subscriptions.ts'], 'Plan: one Stripe product with three prices (1/2/3 bags), a `Subscription` row per customer with the roast preference, and a subscribe page. I created the page and the Stripe helpers; the webhook side is next.', 8],
      ['skip the webhook for now, just make the subscribe flow work end to end in test mode', ['E app/subscribe/page.tsx', 'B stripe trigger checkout.session.completed | Trigger succeeded!', 'B npx playwright test subscribe | 2 passed (6.3s)'], 'Subscribe flow works in test mode: Checkout session in subscription mode, success page, Subscription row created on return. Renewals still need the webhook.'],
    ],
    commits: ['feat(subscriptions): subscribe page and Stripe Checkout in subscription mode'],
    d: { title: 'Monthly subscription boxes', summary: 'Added coffee subscription boxes (1–3 bags a month) on Stripe subscriptions with a roast preference.', outcome: 'Subscribe flow works end to end in test mode; renewals wait for webhook handling.', status: 'done', nextStep: '', topic: 'Subscriptions', kind: 'build', cvWorthy: true, highlights: ['Launched a monthly subscription box on Stripe Billing with three tiers'] },
  },
  {
    key: 'N4', p: 'northwind-shop', day: -13, at: '14:00', title: 'Fix layout shift on product pages',
    x: [
      ['lighthouse says CLS 0.31 on product pages, the hero image jumps. fix it', ['R app/products/[slug]/page.tsx', 'E components/ProductImage.tsx', 'B npx lighthouse http://localhost:3000/products/ethiopia-guji --only-categories=performance --quiet | Performance: 96  CLS: 0.01'], 'The hero `<img>` had no size, so the page reflowed when it loaded. Switched to `next/image` with the real aspect ratio and a blurred placeholder. CLS is now **0.01**, performance score 96.'],
    ],
    commits: ['fix(product): reserve image space, CLS 0.31 → 0.01'],
    d: { title: 'Layout shift fixed on product pages', summary: 'Fixed the jumping hero image on product pages.', outcome: 'CLS went from 0.31 to 0.01 with next/image and a blurred placeholder; Lighthouse performance 96.', status: 'done', nextStep: '', topic: 'Performance', kind: 'fix', cvWorthy: true, highlights: ['Cut cumulative layout shift on product pages from 0.31 to 0.01'] },
  },
  {
    key: 'N5', p: 'northwind-shop', day: -8, at: '11:15', title: 'Stripe webhooks for subscription renewals',
    x: [
      ['now the webhook: invoice.paid creates the monthly order, invoice.payment_failed emails the customer. verify signatures and make it idempotent, stripe retries a lot', ['R lib/stripe/webhooks.ts', 'E lib/stripe/webhooks.ts', 'W app/api/stripe/webhook/route.ts', 'E prisma/schema.prisma'], 'Webhook route verifies the signature on the raw body, stores every `event.id` in a `ProcessedEvent` table (unique) and skips duplicates. `invoice.paid` creates the monthly order; `invoice.payment_failed` sends the "card declined" email.', 6],
      ['test it with the stripe cli', ['B stripe listen --forward-to localhost:3000/api/stripe/webhook | Ready! Forwarding events to localhost:3000/api/stripe/webhook', 'B stripe trigger invoice.paid | Trigger succeeded!', 'B npx vitest run webhooks | ✓ 7 tests passed'], 'Replayed `invoice.paid` twice: one order created, the duplicate was skipped. 7 unit tests pass.'],
    ],
    commits: ['feat(stripe): idempotent webhook for renewals and failed payments'],
    d: { title: 'Idempotent Stripe webhooks for renewals', summary: 'Added the Stripe webhook that turns subscription renewals into orders and emails customers when a payment fails.', outcome: 'Signature check, idempotency table and handlers for invoice.paid and invoice.payment_failed; replayed events are skipped; 7 tests pass.', status: 'done', nextStep: '', topic: 'Payments', kind: 'build', cvWorthy: true, highlights: ['Built idempotent Stripe webhook handling for subscription renewals'] },
  },
  {
    key: 'N6', p: 'northwind-shop', day: -3, at: '16:30', title: 'Checkout: move to the Stripe Payment Element', branch: 'feat/payment-element',
    recap: 'You were moving checkout from the old Card Element to the Payment Element. Card payments work end to end in test mode; 3-D Secure cards are not tested yet. Next: run the 3DS test cards in staging.',
    x: [
      ['our checkout still uses the old Card Element. move it to the Payment Element so we get wallets and local methods later. keep the address form as is', ['R app/checkout/page.tsx', 'R components/CheckoutForm.tsx', 'W components/PaymentForm.tsx', 'E app/api/checkout/route.ts'], 'Checkout now creates a PaymentIntent first and mounts the Payment Element with `automatic_payment_methods`. The address form is unchanged and passes the shipping address to the intent.', 11],
      ['test card 4242 works. what about 3d secure?', ['G confirmPayment', 'E components/PaymentForm.tsx', 'B npx playwright test checkout | 4 passed (12.8s)'], '`confirmPayment` now uses `redirect: "if_required"`, so 3-D Secure opens Stripe\'s challenge and comes back to `/checkout/done`. Playwright passes with 4242, but I can\'t click through a real 3DS challenge headlessly: worth testing the 3DS test cards on staging.'],
    ],
    commits: ['feat(checkout): Payment Element instead of Card Element'],
    d: { title: 'Checkout moved to the Stripe Payment Element', summary: 'Replaced the Card Element with the Payment Element so checkout can offer wallets and local payment methods.', outcome: 'Card payments work in test mode and the Playwright suite passes; 3-D Secure has not been tested on staging yet.', status: 'in_progress', nextStep: 'Test 3-D Secure cards on the Payment Element in staging', topic: 'Checkout', kind: 'build', cvWorthy: true, highlights: ['Migrated checkout to the Stripe Payment Element'] },
  },
  {
    key: 'N7', p: 'northwind-shop', ago: 48, title: 'Apple Pay and Google Pay', branch: 'feat/payment-element',
    live: { kind: 'interactive', status: 'busy', name: 'northwind-checkout' },
    x: [
      ['client asked for apple pay and google pay before the holiday sale. the payment element should show them, but nothing appears on staging', ['R components/PaymentForm.tsx', 'G wallets', 'F https://docs.stripe.com/payments/payment-methods/pmd-registration'], 'Wallets only show on registered domains. `staging.northwind.example` isn\'t registered for Apple Pay, and Google Pay needs HTTPS plus a saved card in the browser. I\'ll add the domain registration step and the verification file.', 6],
      ['ok do it, and add the wallets to the playwright smoke test where possible', ['W public/.well-known/apple-developer-merchantid-domain-association', 'E components/PaymentForm.tsx', 'E tests/checkout.spec.ts', 'B npx playwright test checkout'], null],
    ],
    d: { title: 'Apple Pay and Google Pay on checkout', summary: 'Enabling wallets in the new Payment Element checkout for the holiday sale.', outcome: 'Found that wallets need a registered domain; adding the Apple Pay verification file and extending the smoke test.', status: 'in_progress', nextStep: 'Register staging for Apple Pay and test it in Safari', topic: 'Checkout', kind: 'build', cvWorthy: false, highlights: [] },
  },

  // ---------------------------------------------------------------- bloom-clinic
  {
    key: 'B1', p: 'bloom-clinic', day: -26, at: '09:10', title: 'Booking calendar with Supabase',
    x: [
      ['booking page: patient picks a location, a therapist, then a free 45 min slot in the next 3 weeks. slots come from therapist hours minus existing appointments', ['R supabase/migrations/0001_init.sql', 'W supabase/migrations/0002_slots.sql', 'W src/booking/Calendar.tsx', 'W src/booking/useSlots.ts'], 'Added a `free_slots(therapist, from, to)` SQL function and the 3-step booking page (location → therapist → slot). Slots are 45 min and never overlap existing appointments.', 10],
      ['double booking is still possible if two people click the same slot at the same time', ['E supabase/migrations/0002_slots.sql', 'B npx vitest run booking | ✓ 9 tests passed'], 'Added an exclusion constraint on `(therapist_id, tstzrange(starts_at, ends_at))`, so the second insert fails and the UI shows "This slot was just taken". 9 tests pass.'],
    ],
    commits: ['feat(booking): 3-step booking with free slots', 'fix(booking): exclusion constraint against double booking'],
    d: { title: 'Booking calendar with free slots', summary: 'Built the three-step booking flow (location, therapist, slot) on Supabase.', outcome: 'Free slots are computed in SQL and an exclusion constraint prevents double booking; 9 tests pass.', status: 'done', nextStep: '', topic: 'Booking flow', kind: 'build', cvWorthy: true, highlights: ['Prevented double bookings with a Postgres exclusion constraint'] },
  },
  {
    key: 'B2', p: 'bloom-clinic', day: -21, at: '13:45', title: 'Therapist schedules and time off',
    x: [
      ['staff need to set their weekly hours per location and block time off. priya wants to see everyone on one screen', ['W src/staff/Schedule.tsx', 'W supabase/migrations/0003_time_off.sql', 'E src/booking/useSlots.ts'], 'Weekly hours per location plus a time-off table; free slots now subtract time off. The manager view shows all therapists for one week, one row each.', 7],
      ['time off should cancel nothing automatically, just warn about existing appointments', ['E src/staff/Schedule.tsx', 'B npx vitest run staff | ✓ 6 tests passed'], 'Saving time off that overlaps appointments now shows the list of affected patients instead of cancelling them.'],
    ],
    commits: ['feat(staff): weekly hours, time off and manager week view'],
    d: { title: 'Therapist schedules and time off', summary: 'Added weekly hours per location, time off and a manager week view.', outcome: 'Schedules and time off feed the free-slot search; overlapping appointments trigger a warning, never an automatic cancel.', status: 'done', nextStep: '', topic: 'Staff schedules', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'B3', p: 'bloom-clinic', day: -15, at: '10:20', title: 'SMS reminders with Twilio',
    x: [
      ['no-shows are killing them. send an sms reminder the day before with a link to cancel. twilio, from a supabase edge function on a cron', ['R supabase/functions/reminders/index.ts', 'W supabase/functions/reminders/templates.ts', 'E supabase/functions/reminders/index.ts', 'B supabase functions deploy reminders | Deployed Function reminders'], 'The `reminders` edge function runs every 15 min, picks appointments 24 h ahead without a reminder, sends the SMS through Twilio and stores the message SID. The cancel link is signed and expires after the appointment.', 9],
      ['reminders work 🎉 honestly this reminder thing could be its own product, every small clinic needs it. ok next: send one 24h before and another 2h before', ['E supabase/functions/reminders/index.ts', 'B npx vitest run reminders | ✓ 11 tests passed'], 'Two reminders now (24 h and 2 h before), each sent once, tracked per appointment. 11 tests pass.'],
    ],
    commits: ['feat(reminders): SMS reminders 24 h and 2 h before, signed cancel link'],
    d: { title: 'SMS reminders through Twilio', summary: 'Added SMS appointment reminders with a signed cancel link, sent from a Supabase edge function.', outcome: 'Reminders go out 24 h and 2 h before each appointment; 11 tests pass.', status: 'done', nextStep: '', topic: 'SMS reminders', kind: 'build', cvWorthy: true, highlights: ['Built SMS appointment reminders with Twilio and Supabase edge functions'] },
  },
  {
    key: 'B4', p: 'bloom-clinic', day: -10, at: '15:05', title: 'No-show stats for the clinic manager',
    x: [
      ['priya wants to know if reminders helped. a stats page: no-show rate per week and per location, before and after reminders started', ['W supabase/migrations/0004_no_show_view.sql', 'W src/stats/NoShows.tsx'], 'Added a weekly no-show view and a stats page with a line per location. Since reminders started, the no-show rate went from **14% to 6%**.', 8],
      ['nice. she will want this by email every monday, but let\'s stop here today', [], 'Stopping here. The stats page is live for managers; a weekly Monday email is the natural next step.'],
    ],
    commits: ['feat(stats): weekly no-show rate per location'],
    d: { title: 'No-show stats per week and location', summary: 'Built a no-show stats page for the clinic manager to see whether reminders helped.', outcome: 'No-show rate dropped from 14% to 6% since reminders started; the weekly email for the manager is not built yet.', status: 'in_progress', nextStep: 'Add a weekly no-show email for the clinic manager', topic: 'Reporting', kind: 'build', cvWorthy: true, highlights: ['Showed a no-show drop from 14% to 6% after SMS reminders'] },
  },
  {
    key: 'B5', p: 'bloom-clinic', day: -5, at: '11:30', title: 'STOP replies and reminder retries',
    x: [
      ['if we ever sell the reminders to other clinics we\'ll need per-clinic twilio numbers. for now just handle STOP replies and retry failed sends twice', ['W supabase/functions/sms-inbound/index.ts', 'E supabase/functions/reminders/index.ts', 'W supabase/migrations/0005_opt_out.sql'], 'Inbound webhook marks the patient as opted out on STOP (and back in on START). Failed sends are retried twice with 10 min between tries; the status of each try is stored.', 9],
      ['some sends fail with error 30003, is that retryable?', ['F https://www.twilio.com/docs/api/errors/30003', 'E supabase/functions/reminders/index.ts'], '30003 means the handset was unreachable: worth retrying. 30005/30006 (unknown or landline number) are not. Only retryable codes are retried now; the others show as "number problem" for the front desk.'],
    ],
    commits: ['feat(reminders): STOP/START opt-out and retries for retryable errors'],
    d: { title: 'Opt-out handling and reminder retries', summary: 'Handled STOP/START replies and retried failed reminder SMS for retryable Twilio errors.', outcome: 'Opt-out works both ways; retries only for retryable errors; unreachable numbers flagged for the front desk.', status: 'in_progress', nextStep: 'Show failed reminders on the front desk screen', topic: 'SMS reminders', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'B6', p: 'bloom-clinic', ago: 22, title: 'Reminder retry queue',
    live: { kind: 'background', state: 'working', status: 'busy', name: 'sms-retries', jobId: 'b7e2c41a', detail: 'Running the reminder tests (31 of 48 passed so far)' },
    x: [
      ['move reminder retries out of the edge function into a small queue table so a slow twilio call can\'t block the cron. run the tests when done', ['R supabase/functions/reminders/index.ts', 'W supabase/migrations/0006_sms_queue.sql', 'W supabase/functions/sms-worker/index.ts', 'E supabase/functions/reminders/index.ts', 'B npx vitest run reminders'], null],
    ],
    d: { title: 'Reminder retries through a queue table', summary: 'Moving SMS retries into a queue table so slow Twilio calls cannot block the reminder cron.', outcome: 'Queue table and worker written; the reminder tests are running.', status: 'in_progress', nextStep: 'Check that the worker skips numbers flagged as landlines', topic: 'SMS reminders', kind: 'build', cvWorthy: false, highlights: [] },
  },

  // ---------------------------------------------------------------- invoicely
  {
    key: 'I1', p: 'invoicely', day: -29, at: '20:15', title: 'Recurring invoices on a schedule',
    x: [
      ['recurring invoices: monthly, quarterly, yearly, starting on a date. a cron creates the invoice as draft or sends it directly, user\'s choice', ['R db/schema.ts', 'E db/schema.ts', 'W lib/recurring.ts', 'W app/api/cron/recurring/route.ts', 'B npm run db:generate && npm run db:migrate | 1 migration applied'], 'Added `recurring_rules` (interval, anchor date, mode draft/send) and a daily cron that creates due invoices. Month ends are handled (a rule on the 31st runs on Feb 28).', 10],
      ['add tests for month ends and leap years', ['W lib/recurring.test.ts', 'B npx vitest run recurring | ✓ 14 tests passed'], '14 tests, including 31st → Feb 28/29 and quarterly from Nov 30.'],
    ],
    commits: ['feat(recurring): recurring invoice rules and daily cron'],
    d: { title: 'Recurring invoices on a schedule', summary: 'Added recurring invoice rules (monthly, quarterly, yearly) created by a daily cron as drafts or sent directly.', outcome: 'Rules, cron and 14 date-edge-case tests in place.', status: 'done', nextStep: '', topic: 'Recurring invoices', kind: 'build', cvWorthy: true, highlights: ['Built recurring invoicing with month-end and leap-year safe scheduling'] },
  },
  {
    key: 'I2', p: 'invoicely', day: -25, at: '10:40', title: 'PDF invoices with react-pdf',
    x: [
      ['invoice PDF: logo, client address, line items, tax lines, totals, payment link as a QR code. react-pdf', ['W lib/pdf/InvoicePdf.tsx', 'W app/api/invoices/[id]/pdf/route.ts', 'B npx tsx scripts/render-sample.ts | wrote out/sample-invoice.pdf (2 pages)'], 'PDF route renders with react-pdf: header with logo, addresses, line items, tax breakdown and a QR code for the payment link. Long invoices break across pages with a repeated table header.'],
    ],
    commits: ['feat(pdf): invoice PDF with QR payment link'],
    d: { title: 'Invoice PDFs with a QR payment link', summary: 'Built the invoice PDF with react-pdf, including a QR code for the payment link.', outcome: 'PDF route works; multi-page invoices repeat the table header.', status: 'done', nextStep: '', topic: 'PDF export', kind: 'build', cvWorthy: true, highlights: ['Generated multi-page invoice PDFs with QR payment links'] },
  },
  {
    key: 'I3', p: 'invoicely', day: -22, at: '14:25', title: 'Stripe payment links on invoices',
    x: [
      ['each sent invoice gets a stripe payment link. when it\'s paid, mark the invoice paid', ['R lib/stripe/webhooks.ts', 'W lib/stripe/paymentLinks.ts', 'E lib/stripe/webhooks.ts', 'B npx vitest run stripe | ✓ 5 tests passed'], 'Sending an invoice now creates a Payment Link with the invoice id in metadata; `checkout.session.completed` marks it paid. 5 tests pass.'],
    ],
    commits: ['feat(stripe): payment links on sent invoices'],
    d: { title: 'Stripe payment links on invoices', summary: 'Every sent invoice gets a Stripe payment link and is marked paid automatically.', outcome: 'Payment links created on send; paid status set from the webhook; 5 tests pass.', status: 'done', nextStep: '', topic: 'Payments', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'I4', p: 'invoicely', day: -18, at: '21:05', title: 'Slack bot: /invoice command',
    x: [
      ['start a slack bot in packages/slack-bot so I can create invoices from slack: /invoice @client 1200 "design sprint". bolt, socket mode for now', ['W packages/slack-bot/src/app.ts', 'W packages/slack-bot/src/commands/invoice.ts', 'W packages/slack-bot/src/api.ts', 'B npm -w packages/slack-bot run dev | ⚡️ Bolt app is running (socket mode)'], '`/invoice` parses client, amount and description, calls the Invoicely API and replies with a preview and a "Send" button. Runs in socket mode.', 8],
      ['works in our test workspace. make the reply nicer, with the PDF link', ['E packages/slack-bot/src/commands/invoice.ts'], 'The reply is now a Block Kit card: client, amount, due date, "Open PDF" and "Send" buttons.'],
    ],
    commits: ['feat(slack-bot): /invoice slash command with Block Kit preview'],
    d: { title: 'Slack bot with an /invoice command', summary: 'Started a Slack bot in packages/slack-bot that creates invoices from a slash command.', outcome: '/invoice creates a draft and replies with a Block Kit card with PDF and Send buttons.', status: 'done', nextStep: '', topic: 'Slack bot', kind: 'build', cvWorthy: true, highlights: ['Built a Slack app that creates and sends invoices from a slash command'] },
  },
  {
    key: 'I5', p: 'invoicely', day: -14, at: '09:50', title: 'Multi-currency totals',
    x: [
      ['some beta users bill in EUR and USD. dashboard totals should convert to the account currency with the rate of the invoice date', ['W lib/fx.ts', 'E app/page.tsx', 'E db/schema.ts', 'B npx vitest run fx | ✓ 8 tests passed'], 'Rates are fetched daily from the ECB feed and stored; each invoice keeps the rate of its date, so old totals never move. Dashboard totals convert to the account currency.'],
    ],
    commits: ['feat(fx): multi-currency totals with stored daily rates'],
    d: { title: 'Multi-currency dashboard totals', summary: 'Dashboard totals now convert invoices in other currencies with the rate of the invoice date.', outcome: 'Daily ECB rates stored; totals stable over time; 8 tests pass.', status: 'done', nextStep: '', topic: 'Multi-currency', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'I6', p: 'invoicely', day: -11, at: '16:10', title: 'Slack bot: overdue reminders',
    x: [
      ['people in the beta use the slack bot more than the web app. maybe this should be its own product. anyway, for now: post overdue reminders in the channel where the invoice was created', ['R packages/slack-bot/src/commands/invoice.ts', 'W packages/slack-bot/src/reminders.ts', 'E app/api/cron/recurring/route.ts'], 'Invoices created from Slack remember their channel. The daily cron posts a reminder there 1, 7 and 14 days after the due date, with a "Mark as paid" button.', 7],
      ['the 14 day one should mention the owner', ['E packages/slack-bot/src/reminders.ts', 'B npx vitest run reminders | ✓ 6 tests passed'], 'The 14-day reminder now @-mentions the invoice owner.'],
    ],
    commits: ['feat(slack-bot): overdue reminders in the source channel'],
    d: { title: 'Overdue reminders posted in Slack', summary: 'The Slack bot now chases overdue invoices in the channel where they were created.', outcome: 'Reminders at 1, 7 and 14 days with a Mark as paid button; the last one mentions the owner.', status: 'done', nextStep: '', topic: 'Slack bot', kind: 'build', cvWorthy: true, highlights: ['Automated overdue invoice reminders in Slack channels'] },
  },
  {
    key: 'I7', p: 'invoicely', day: -7, at: '10:35', title: 'Reuse the Northwind webhook code',
    x: [
      ['copy the webhook verification + idempotency code from the northwind shop, it\'s the third time I write this. same retry rules', ['R lib/stripe/webhooks.ts', 'W lib/stripe/verify.ts', 'W lib/stripe/idempotency.ts', 'E lib/stripe/webhooks.ts', 'B npx vitest run stripe | ✓ 9 tests passed'], 'Ported signature verification and the processed-events table from Northwind, adapted to Drizzle. Duplicate events are skipped; 9 tests pass. The two copies are now almost identical.'],
    ],
    commits: ['refactor(stripe): idempotent webhook handling (ported from the shop project)'],
    d: { title: 'Idempotent webhooks, shared with the shop', summary: 'Ported the Stripe signature check and idempotency table from the Northwind shop.', outcome: 'Duplicate Stripe events are skipped; the code is now nearly the same in both projects.', status: 'done', nextStep: '', topic: 'Payments', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'I8', p: 'invoicely', day: -4, at: '20:50', title: 'Slack OAuth install for other workspaces', worktree: true, branch: 'slack-oauth',
    x: [
      ['the bot only works in our workspace because of the hardcoded token. add the proper oauth install flow so beta users can add it to theirs', ['R packages/slack-bot/src/app.ts', 'W packages/slack-bot/src/oauth.ts', 'W packages/slack-bot/src/installationStore.ts', 'E packages/slack-bot/src/app.ts'], 'Added "Add to Slack" with Bolt\'s OAuth flow and an installation store in Postgres (one row per workspace, tokens encrypted at rest).', 10],
      ['switch from socket mode to http so it can run on vercel', ['E packages/slack-bot/src/app.ts', 'B npm -w packages/slack-bot run build | built in 1.4s'], 'Switched to the HTTP receiver with request signing. Next: test the install on a second workspace; tokens per workspace are stored but not yet read back for every request.'],
    ],
    commits: ['feat(slack-bot): OAuth install flow and HTTP receiver'],
    d: { title: 'Slack OAuth install flow', summary: 'Adding a proper OAuth install so beta users can add the bot to their own Slack workspaces.', outcome: 'Add to Slack flow and encrypted installation store work; the bot now uses HTTP mode. Per-workspace tokens are not read back yet.', status: 'in_progress', nextStep: 'Store bot tokens per workspace and test the install on a second Slack workspace', topic: 'Slack bot', kind: 'build', cvWorthy: true, highlights: ['Added multi-workspace OAuth installation to a Slack app'] },
  },
  {
    key: 'I9', p: 'invoicely', day: -1, at: '15:40', title: 'Dunning emails for failed payments',
    recap: 'You set up the schedule for failed-payment emails (day 1, 4 and 10). The templates themselves are still placeholders.',
    x: [
      ['two beta customers had cards fail this week and nobody noticed. dunning: email the client when a payment fails, again after 3 days, last one after 10', ['R lib/stripe/webhooks.ts', 'W lib/dunning.ts', 'E app/api/cron/recurring/route.ts', 'W emails/dunning/first.tsx'], 'On `invoice.payment_failed` a dunning sequence starts (day 1, 4, 10), stopped as soon as the invoice is paid. The schedule runs from the daily cron.', 9],
      ['the emails can wait, I\'ll write the copy myself. make sure nothing is sent twice', ['E lib/dunning.ts', 'B npx vitest run dunning | ✓ 7 tests passed'], 'Each step is recorded with a unique `(invoice_id, step)`, so a cron that runs twice sends nothing twice. The three templates are placeholders for now.'],
    ],
    commits: ['feat(dunning): failed-payment email schedule'],
    d: { title: 'Dunning schedule for failed payments', summary: 'Added a dunning sequence for failed card payments (day 1, 4 and 10), stopped when the invoice is paid.', outcome: 'Scheduling works and never sends twice; the three email templates are still placeholders.', status: 'in_progress', nextStep: 'Write the three dunning email templates for day 1, 4 and 10', topic: 'Payments', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'I10', p: 'invoicely', ago: 35, title: 'Slack bot: weekly revenue digest',
    live: { kind: 'interactive', status: 'waiting', waitingFor: 'input needed', name: 'slack-digest' },
    x: [
      ['every monday the bot should post a short revenue digest: paid this week, overdue, biggest client. per workspace', ['R packages/slack-bot/src/reminders.ts', 'W packages/slack-bot/src/digest.ts', 'G account_owner'], 'Drafted `digest.ts`: paid this week, overdue total and count, top client, compared with the previous week.', 7],
      ['looks right', ['E packages/slack-bot/src/digest.ts'], 'One decision before I wire the schedule: should the digest go to **a channel the workspace picks** (e.g. #finance) or as **a DM to the account owner**? A channel is more visible, a DM is safer for revenue numbers.'],
    ],
    d: { title: 'Weekly revenue digest in Slack', summary: 'Adding a Monday revenue digest to the Slack bot: paid, overdue and top client per workspace.', outcome: 'Digest content is drafted; waiting for a decision on where it is posted.', status: 'in_progress', nextStep: 'Decide whether the weekly digest goes to a channel or to the account owner', topic: 'Slack bot', kind: 'build', cvWorthy: false, highlights: [] },
  },

  // ---------------------------------------------------------------- invoicely-mobile
  {
    key: 'M1', p: 'invoicely-mobile', day: -20, at: '19:30', title: 'Expo app with the invoice list',
    x: [
      ['new expo app for invoicely: login with the same magic link, a tab with invoices (status chips), pull to refresh', ['W app/(tabs)/index.tsx', 'W app/login.tsx', 'W lib/api.ts', 'B npx expo start --tunnel | Metro waiting on exp://…'], 'Expo Router app with magic-link login (deep link back into the app), an invoice list with status chips and pull to refresh.'],
    ],
    commits: ['feat: Expo app with magic-link login and invoice list'],
    d: { title: 'Mobile app with the invoice list', summary: 'Started the Invoicely mobile app with Expo: magic-link login and an invoice list.', outcome: 'Login and invoice list work on iOS and Android in Expo Go.', status: 'done', nextStep: '', topic: 'App shell', kind: 'build', cvWorthy: true, highlights: ['Built an Expo companion app for the invoicing SaaS'] },
  },
  {
    key: 'M2', p: 'invoicely-mobile', day: -12, at: '20:00', title: 'Receipt scanning with the camera',
    x: [
      ['scan a receipt with the camera and attach it to an expense. crop + compress before upload', ['W app/scan.tsx', 'W lib/upload.ts', 'E app/(tabs)/index.tsx'], 'Camera screen with edge detection, crop, and JPEG compression to ~300 KB before upload. The receipt is attached to a new expense draft.'],
    ],
    commits: ['feat(scan): receipt scanning with crop and compression'],
    d: { title: 'Receipt scanning', summary: 'Added receipt scanning with crop and compression to the mobile app.', outcome: 'Receipts are scanned, compressed to about 300 KB and attached to expense drafts.', status: 'done', nextStep: '', topic: 'Receipts', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'M3', p: 'invoicely-mobile', day: -6, at: '18:20', title: 'Push notifications when an invoice is paid',
    x: [
      ['push notification when an invoice gets paid. expo notifications, server sends from the stripe webhook', ['W lib/notifications.ts', 'E app/_layout.tsx', 'B npx expo prebuild | ✓ Prebuild finished'], 'Android push works end to end (token registered at login, sent from the webhook). iOS needs an APNs key from the Apple developer account, which I can\'t create from here.'],
    ],
    commits: ['feat(push): paid notifications (Android)'],
    d: { title: 'Paid notifications, Android done', summary: 'Added a push notification when an invoice is paid.', outcome: 'Works on Android; iOS is blocked on an APNs key from the Apple developer account.', status: 'blocked', nextStep: 'Get the APNs key from the Apple developer account and finish iOS push', topic: 'Push notifications', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'M4', p: 'invoicely-mobile', day: -2, at: '21:10', title: 'Offline drafts',
    x: [
      ['let me write invoice drafts offline (on the train) and sync when back online', ['W lib/offline.ts', 'E app/(tabs)/index.tsx', 'W app/draft/[id].tsx'], 'Drafts are saved to SQLite on the device and pushed when the connection comes back; a small "Not synced" badge shows on pending drafts.', 8],
      ['what if I edit the same draft on the web meanwhile', [], 'Right now the last write wins, which can silently lose an edit. Options: keep both and ask, or compare `updatedAt` per field. I\'d keep both and show a "conflict" choice; not done yet.'],
    ],
    commits: ['feat(offline): offline drafts with background sync'],
    d: { title: 'Offline invoice drafts', summary: 'Invoice drafts can be written offline and sync when the phone is back online.', outcome: 'Offline save and sync work; conflicts with web edits are not handled yet (last write wins).', status: 'in_progress', nextStep: 'Handle sync conflicts when a draft was edited on two devices', topic: 'Offline drafts', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'M5', p: 'invoicely-mobile', ago: 260, title: 'Fix the Android build after the Expo upgrade',
    x: [
      ['android build fails after the expo sdk upgrade: duplicate class kotlin.collections', ['B npx expo-doctor | ✖ 2 checks failed', 'E app.json', 'B npx expo prebuild --clean && cd android && ./gradlew assembleDebug | BUILD SUCCESSFUL in 1m 52s'], 'Two libraries pulled different Kotlin stdlib versions. Aligned the Kotlin version in `app.json` (expo-build-properties) and cleaned the prebuild: the Android build passes again.'],
    ],
    commits: ['fix(android): align Kotlin version after SDK upgrade'],
    d: { title: 'Android build fixed after the SDK upgrade', summary: 'Fixed the Android build that broke after the Expo SDK upgrade.', outcome: 'Kotlin versions aligned; the debug build passes again.', status: 'done', nextStep: '', topic: 'App shell', kind: 'fix', cvWorthy: false, highlights: [] },
  },

  // ---------------------------------------------------------------- homelab-dashboard
  {
    key: 'H1', p: 'homelab-dashboard', day: -23, at: '21:40', title: 'Docker container stats',
    x: [
      ['list all docker containers with cpu, memory and status. the node server reads the socket, the page polls every 5s', ['R server.js', 'E server.js', 'W src/lib/Containers.svelte'], 'The server exposes `/api/containers` (name, state, CPU %, memory) from the Docker socket; the Svelte page polls every 5 s and sorts by CPU.'],
    ],
    commits: ['feat: container list with CPU and memory'],
    d: { title: 'Container stats from the Docker API', summary: 'Built the container list with CPU, memory and state from the Docker socket.', outcome: 'Live container stats on the dashboard, refreshed every 5 seconds.', status: 'done', nextStep: '', topic: 'Containers', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'H2', p: 'homelab-dashboard', day: -16, at: '22:05', title: 'Uptime checks with history',
    x: [
      ['uptime checks for my services (nextcloud, jellyfin, the router). ping every minute, keep 30 days, show a 90-day bar like status pages', ['W server/uptime.js', 'W src/lib/Uptime.svelte', 'B node server/uptime.js --once | 6 checks, 6 up'], 'Checks run every minute and are stored in SQLite (30 days, then daily rollups). The page shows a 90-day bar per service.'],
    ],
    commits: ['feat: uptime checks with 90-day bars'],
    d: { title: 'Uptime checks with history bars', summary: 'Added minute-level uptime checks with a status-page style history.', outcome: 'Six services checked every minute; 90-day bars on the dashboard.', status: 'done', nextStep: '', topic: 'Uptime', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'H3', p: 'homelab-dashboard', day: -9, at: '20:30', title: 'Disk usage alerts to ntfy',
    x: [
      ['alert me on my phone when a disk is above 85%. I use ntfy', ['W server/alerts.js', 'E server.js', 'B node server/alerts.js --test | sent test notification to topic homelab'], 'Disk usage is checked every 10 min; above 85% a push goes to the ntfy topic, at most once every 6 hours per disk.'],
    ],
    commits: ['feat: disk alerts through ntfy'],
    d: { title: 'Disk alerts through ntfy', summary: 'Added push alerts when a disk goes above 85%.', outcome: 'Alerts go to ntfy with a 6-hour cooldown per disk.', status: 'done', nextStep: '', topic: 'Alerts', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'H4', p: 'homelab-dashboard', day: -1, at: '22:15', title: 'Compact layout for the wall tablet',
    x: [
      ['I put an old tablet on the wall for this. make a compact dark layout that fits 1280x800 without scrolling', ['E src/App.svelte', 'W src/lib/compact.css'], 'Added a `?wall` mode: dark, larger text, everything on one 1280×800 screen, no scrolling, and the screen dims at night.'],
    ],
    commits: ['feat: wall tablet mode'],
    d: { title: 'Wall tablet layout', summary: 'Added a compact dark layout for a wall-mounted tablet.', outcome: 'The ?wall mode fits 1280×800 without scrolling and dims at night.', status: 'done', nextStep: '', topic: 'UI', kind: 'design', cvWorthy: false, highlights: [] },
  },
  {
    key: 'H5', p: 'homelab-dashboard', ago: 130, title: 'Proxmox VM list',
    live: { kind: 'interactive', status: 'idle', name: 'homelab' },
    x: [
      ['add my proxmox VMs to the dashboard: name, status, cpu, memory. read only', ['F https://pve.proxmox.com/wiki/Proxmox_VE_API', 'W server/proxmox.js'], 'Proxmox needs an API token. Create a read-only one (role `PVEAuditor`) for a dedicated user, then put it in `.env` as `PROXMOX_TOKEN`; I left a stub in `server/proxmox.js` that reads it.'],
    ],
    d: { title: 'Proxmox VMs on the dashboard', summary: 'Adding a read-only Proxmox VM list to the dashboard.', outcome: 'API client stub written; it waits for a read-only Proxmox token.', status: 'in_progress', nextStep: 'Create a read-only Proxmox token and list the VMs', topic: 'Proxmox', kind: 'build', cvWorthy: false, highlights: [] },
  },

  // ---------------------------------------------------------------- rss-digest
  {
    key: 'R1', p: 'rss-digest', day: -17, at: '08:15', title: 'Daily digest script',
    x: [
      ['python script: fetch the feeds in feeds.txt, keep items from the last 24h, dedupe by link, write out/items.json', ['W digest.py', 'B python3 digest.py | 9 feeds, 41 items, 37 new'], '`digest.py` fetches the feeds with feedparser, keeps the last 24 h, dedupes by link and title, and writes `out/items.json`.'],
    ],
    commits: ['feat: fetch feeds into out/items.json'],
    d: { title: 'Feed fetcher for the daily digest', summary: 'Wrote the script that collects the last day of items from about ten feeds.', outcome: 'Feeds fetched and deduplicated into out/items.json.', status: 'done', nextStep: '', topic: 'Digest script', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'R2', p: 'rss-digest', day: -16, at: '08:40', title: 'Run the digest every morning with claude -p',
    x: [
      ['now run it every morning at 7 with cron: fetch, then claude -p writes 5 bullets to out/digest.md. no tools needed', ['W run.sh', 'W prompt.txt', 'B crontab -l | 0 7 * * * ~/lab/rss-digest/run.sh'], '`run.sh` runs the fetcher, then `claude -p` with `prompt.txt`; cron runs it at 07:00. The digest lands in `out/digest.md`.'],
    ],
    commits: ['feat: morning run with cron and claude -p'],
    d: { title: 'Morning digest on a schedule', summary: 'Scheduled the digest every morning at 7 with cron and a headless Claude run.', outcome: 'The digest is written to out/digest.md every morning.', status: 'done', nextStep: '', topic: 'Scheduling', kind: 'ops', cvWorthy: false, highlights: [] },
  },

  // ---------------------------------------------------------------- portfolio-site
  {
    key: 'P1', p: 'portfolio-site', day: -28, at: '17:20', title: 'Case study pages from markdown',
    x: [
      ['case studies as markdown in src/content/work, one page each with a cover image and a short results section', ['W src/content/config.ts', 'W src/pages/work/[slug].astro', 'E src/content/work/northwind.md'], 'Content collection `work` with a schema (title, client, cover, results); each case study gets a page at `/work/<slug>`.'],
    ],
    commits: ['feat: case study pages'],
    d: { title: 'Case study pages', summary: 'Added case study pages generated from markdown files.', outcome: 'Case studies render from a typed content collection.', status: 'done', nextStep: '', topic: 'Case studies', kind: 'build', cvWorthy: false, highlights: [] },
  },
  {
    key: 'P2', p: 'portfolio-site', day: -22, at: '18:05', title: 'Contact form with spam protection',
    x: [
      ['contact form that emails me. no captcha, use a honeypot and a time check', ['W src/pages/contact.astro', 'W src/pages/api/contact.ts'], 'Form with a hidden honeypot field and a minimum fill time of 3 s; the API route sends the message by email. It needs the server adapter to be deployed; not deployed yet.'],
    ],
    d: { title: 'Contact form with spam protection', summary: 'Added a contact form protected by a honeypot and a time check.', outcome: 'Form and API route written; not deployed yet because the site is still fully static.', status: 'in_progress', nextStep: 'Deploy the contact form and test it from the live site', topic: 'Contact form', kind: 'build', cvWorthy: false, highlights: [] },
  },

  // ---------------------------------------------------------------- tiny-queue
  {
    key: 'T1', p: 'tiny-queue', day: -21, at: '11:00', title: 'Retries with exponential backoff',
    x: [
      ['retries with exponential backoff and jitter. failed jobs go to a dead letter table after the last try', ['R src/queue.ts', 'E src/scheduler.ts', 'E src/queue.ts', 'B npx vitest run | ✓ 23 tests passed'], 'Backoff is `base * 2^attempt` with full jitter, capped at 1 h. After the last try a job moves to `dead_jobs` with its error. 23 tests pass.'],
    ],
    commits: ['feat: retries with backoff and a dead letter table'],
    d: { title: 'Retries with backoff and dead letters', summary: 'Added retries with exponential backoff and jitter, plus a dead letter table.', outcome: 'Backoff capped at one hour; failed jobs kept with their error; 23 tests pass.', status: 'done', nextStep: '', topic: 'Retries', kind: 'build', cvWorthy: true, highlights: ['Implemented retries with jittered exponential backoff in an open-source queue'] },
  },
  {
    key: 'T3', p: 'tiny-queue', day: -4, at: '10:10', title: 'Docs site and v0.4 release notes',
    x: [
      ['docs site with vitepress: getting started, retries, scheduling, comparison with bullmq. reuse the benchmark numbers', ['W docs/index.md', 'W docs/retries.md', 'W docs/vs-bullmq.md', 'B npx vitepress build docs | build complete in 3.2s'], 'Docs site with four pages; the comparison page uses the benchmark results (about 2× fewer moving parts, no Redis).', 6],
      ['write the release notes for 0.4', ['W CHANGELOG.md'], 'Release notes for 0.4.0 are in `CHANGELOG.md`: retries with jitter, dead letters, `queue.drain()`, Node 20+.'],
    ],
    commits: ['docs: vitepress site and 0.4.0 release notes'],
    d: { title: 'Docs site and 0.4 release notes', summary: 'Built a VitePress docs site and wrote the 0.4.0 release notes.', outcome: 'Docs and changelog ready; the release itself is not published yet.', status: 'in_progress', nextStep: 'Publish v0.4.0 to npm and tag the release', topic: 'Release 0.4', kind: 'writing', cvWorthy: false, highlights: [] },
  },
];

// Codex CLI sessions (written as ~/.codex/sessions rollouts). Tools: 'shell command | output'.
export const CODEX_SESSIONS = [
  {
    key: 'T2', p: 'tiny-queue', day: -9, at: '14:30', model: 'gpt-5-codex',
    x: [
      ['add a benchmark against bullmq: 10k jobs, measure throughput and p95 latency, print a table', ['shell npm run bench | tiny-queue  9,840 jobs/s  p95 3.1 ms\nbullmq      7,210 jobs/s  p95 4.8 ms (Redis 7, local)'], 'Added `bench/bullmq.ts`. On this machine tiny-queue does about 9.8k jobs/s (p95 3.1 ms) against 7.2k for BullMQ with a local Redis. Results go to `bench/results.md`.'],
    ],
    commits: ['bench: compare with BullMQ'],
    d: { title: 'Benchmark against BullMQ', summary: 'Added a throughput and latency benchmark against BullMQ.', outcome: 'About 9.8k jobs/s and p95 3.1 ms, versus 7.2k jobs/s for BullMQ with local Redis.', status: 'done', nextStep: '', topic: 'Benchmarks', kind: 'research', cvWorthy: true, highlights: ['Benchmarked the queue at ~9.8k jobs/s, 35% faster than BullMQ on the same machine'] },
  },
  {
    key: 'T4', p: 'tiny-queue', day: -2, at: '09:20', model: 'gpt-5-codex',
    x: [
      ['the scheduler test fails about 1 in 20 runs on CI. find out why', ['shell npx vitest run scheduler --repeat 50 | 2 failed, 48 passed', 'shell rg -n "Date.now" src/scheduler.ts | 14: const now = Date.now();'], 'The test compared two `Date.now()` calls across a tick. I made the scheduler take a clock and used fake timers in the test; 200 repeated runs pass.'],
    ],
    commits: ['test: deterministic clock in the scheduler'],
    d: { title: 'Flaky scheduler test fixed', summary: 'Found and fixed a flaky scheduler test on CI.', outcome: 'The scheduler takes an injectable clock; 200 repeated runs pass.', status: 'done', nextStep: '', topic: 'Retries', kind: 'fix', cvWorthy: false, highlights: [] },
  },
];

// rss-digest: a headless `claude -p` run every morning (shown as Automations).
export const AUTOMATION = {
  p: 'rss-digest',
  at: '07:00',
  days: 12,
  model: 'claude-haiku-5-5',
  prompt: "'Morning digest' run: read the new items in out/items.json and write a 5-bullet digest to out/digest.md. Plain language, one line per bullet, link each one.",
  results: [
    'Wrote out/digest.md: 5 bullets from 37 new items (9 feeds). Top: SQLite 3.50 adds JSON5 support.',
    'Wrote out/digest.md: 5 bullets from 29 new items. Top: Node 24 becomes LTS next week.',
    'Wrote out/digest.md: 5 bullets from 44 new items. Top: Postgres 18 async I/O benchmarks.',
    'Wrote out/digest.md: 5 bullets from 31 new items. Top: a long read on local-first sync engines.',
    'Wrote out/digest.md: 5 bullets from 26 new items (2 feeds timed out). Top: Svelte 5.34 release notes.',
    'Wrote out/digest.md: 5 bullets from 40 new items. Top: Stripe changes default 3DS behaviour in Europe.',
  ],
};

// ------------------------------------------------------------------------------------------------ AI layer

/** Project summaries (briefs). Threads ("workstreams") group sessions by their digest topic. */
export const BRIEFS = {
  'northwind-shop': {
    oneLiner: 'Online coffee shop with subscriptions for Northwind Coffee Roasters',
    description: 'Next.js store for Northwind Coffee Roasters, a small specialty roaster: a 12-coffee catalog with variants, full-text search, monthly subscription boxes and Stripe payments. The client reviews every checkout change on staging before it goes live.',
    currentState: 'Checkout is moving to the Stripe Payment Element on a branch; cards work in test mode, Apple Pay and Google Pay are being enabled for the holiday sale.',
    nextSteps: ['Test 3-D Secure cards on the Payment Element in staging', 'Register staging for Apple Pay and test it in Safari', 'Move product images to the CDN before the holiday sale'],
    attention: ['Checkout changes sit on a branch; the client has not seen them on staging yet.'],
    threads: [
      ['Checkout and wallets', 'Payment Element migration, 3-D Secure and wallets for the holiday sale.', 'active', ['Checkout']],
      ['Payments and subscriptions', 'Subscription boxes on Stripe Billing and idempotent webhooks for renewals.', 'done', ['Subscriptions', 'Payments']],
      ['Storefront', 'Project setup, brand theme, catalog, search and image performance.', 'done', ['Setup', 'Catalog', 'Search', 'Performance']],
    ],
    cv: { title: 'Northwind Coffee online store', role: 'Full-stack developer (freelance)', bullets: ['Built a Next.js store with subscriptions on Stripe Billing', 'Shipped Postgres full-text search', 'Cut layout shift from 0.31 to 0.01'] },
  },
  'bloom-clinic': {
    oneLiner: 'Online booking and SMS reminders for a three-location physio clinic',
    description: 'Booking app for Bloom Physio: patients book a therapist and a slot online, get SMS reminders and can cancel by link; staff manage weekly hours and time off; the manager sees no-show stats. Supabase backend, Twilio for SMS.',
    currentState: 'Reminders cut no-shows from 14% to 6%. Retries are moving to a queue table; the weekly no-show email for the manager is the next request.',
    nextSteps: ['Check that the worker skips numbers flagged as landlines', 'Add a weekly no-show email for the clinic manager', 'Export the no-show report as CSV for the clinic accountant'],
    attention: [],
    threads: [
      ['SMS reminders', 'Reminders 24 h and 2 h before, opt-out handling and retries.', 'active', ['SMS reminders']],
      ['Booking and schedules', 'Data model, booking flow, free slots, therapist hours and time off.', 'done', ['Data model', 'Booking flow', 'Staff schedules']],
      ['Reporting', 'No-show stats for the clinic manager.', 'active', ['Reporting']],
    ],
    cv: { title: 'Bloom Physio booking', role: 'Full-stack developer (freelance)', bullets: ['Built online booking with conflict-free slots', 'Cut no-shows from 14% to 6% with SMS reminders'] },
  },
  invoicely: {
    oneLiner: 'Invoicing for freelancers, with a Slack bot that beta users love',
    description: 'Invoicely is a small invoicing SaaS in beta: recurring invoices, PDF invoices with payment links, multi-currency totals and dunning for failed payments. A Slack app in packages/slack-bot creates and chases invoices from Slack and is used more than the web app by beta users.',
    currentState: 'The Slack bot is getting a proper OAuth install (on the slack-oauth worktree) and a weekly revenue digest; dunning for failed payments is scheduled but its emails are not written.',
    nextSteps: ['Decide whether the weekly digest goes to a channel or to the account owner', 'Write the three dunning email templates for day 1, 4 and 10', 'Store bot tokens per workspace and test the install on a second Slack workspace'],
    attention: ['Two beta customers had failed payments this week and the dunning emails are still placeholders.'],
    threads: [
      ['Slack bot', 'The /invoice command, overdue reminders, OAuth install and the weekly digest.', 'active', ['Slack bot']],
      ['Payments and dunning', 'Payment links, idempotent webhooks and failed-payment emails.', 'active', ['Payments']],
      ['Core invoicing', 'Schema, numbering, recurring invoices, PDFs and multi-currency totals.', 'done', ['Data model', 'Recurring invoices', 'PDF export', 'Multi-currency']],
    ],
    cv: { title: 'Invoicely', role: 'Founder and developer', bullets: ['Built an invoicing SaaS with recurring billing and Stripe payment links', 'Built a Slack app used by 6 beta workspaces'] },
  },
  'invoicely-mobile': {
    oneLiner: 'Expo companion app for Invoicely: invoices, receipts, offline drafts',
    description: 'React Native (Expo) app for Invoicely users: invoice list with status, receipt scanning, push notifications when an invoice is paid and offline drafts.',
    currentState: 'Offline drafts sync, but edits on two devices can overwrite each other. iOS push waits for an APNs key.',
    nextSteps: ['Get the APNs key from the Apple developer account and finish iOS push', 'Handle sync conflicts when a draft was edited on two devices', 'Submit the 1.2 build to TestFlight'],
    attention: ['iOS push has been blocked on the APNs key for 6 days.'],
    threads: [
      ['Offline and sync', 'Offline drafts and conflict handling.', 'active', ['Offline drafts']],
      ['Notifications', 'Paid notifications on Android and iOS.', 'paused', ['Push notifications']],
      ['App basics', 'App shell, login, receipt scanning and build fixes.', 'done', ['App shell', 'Receipts']],
    ],
    cv: { title: 'Invoicely mobile', role: 'Mobile developer', bullets: ['Built an Expo app with offline drafts and receipt scanning'] },
  },
  'homelab-dashboard': {
    oneLiner: 'One-page dashboard for the home server, also on a wall tablet',
    description: 'Svelte dashboard for the home server: Docker containers, uptime checks with history, disk alerts to the phone through ntfy and a wall-tablet mode. Runs in Docker on the NAS.',
    currentState: 'Everything works; a Proxmox VM list is started and waits for a read-only API token.',
    nextSteps: ['Create a read-only Proxmox token and list the VMs', 'Renew the TLS certificate for dash.home.arpa'],
    attention: [],
    threads: [
      ['Monitoring', 'Dashboard setup, containers, uptime and disk alerts.', 'done', ['Setup', 'Containers', 'Uptime', 'Alerts']],
      ['Proxmox', 'VM list from the Proxmox API.', 'active', ['Proxmox']],
      ['Wall tablet', 'Compact dark layout.', 'done', ['UI']],
    ],
    cv: { title: 'Homelab dashboard', role: 'Personal project', bullets: ['Built a self-hosted monitoring dashboard with push alerts'] },
  },
  'rss-digest': {
    oneLiner: 'Morning news digest from ten feeds, written by a scheduled Claude run',
    description: 'A small Python fetcher plus a headless Claude run every morning at 7 that turns the last day of ten feeds into five bullets.',
    currentState: 'Runs every morning without trouble; two feeds time out now and then.',
    nextSteps: ['Add a weekly best-of digest on Sundays'],
    attention: [],
    threads: [['Digest pipeline', 'Fetcher and the scheduled run.', 'done', ['Digest script', 'Scheduling']]],
    cv: { title: 'rss-digest', role: 'Personal project', bullets: ['Automated a daily news digest with a scheduled LLM run'] },
  },
  'portfolio-site': {
    oneLiner: 'Personal site with case studies and a contact form',
    description: 'Astro site with case studies written in markdown and a contact form protected without a captcha.',
    currentState: 'Case studies are live; the contact form is written but was never deployed.',
    nextSteps: ['Deploy the contact form and test it from the live site'],
    attention: ['The contact form has been waiting to be deployed for three weeks.'],
    threads: [
      ['Contact form', 'Honeypot form and its API route.', 'paused', ['Contact form']],
      ['Case studies', 'Markdown case studies.', 'done', ['Case studies']],
    ],
    cv: { title: 'alexrivera.dev', role: 'Personal project', bullets: ['Built a fast static portfolio with Astro'] },
  },
  'tiny-queue': {
    oneLiner: 'Small persistent job queue for Node.js on SQLite, no Redis',
    description: 'Open-source job queue library: persistent jobs in SQLite, retries with jittered backoff, dead letters and scheduling. Benchmarks show it faster than BullMQ for single-machine use.',
    currentState: 'Version 0.4 is ready: docs site and release notes are written, the npm release is not published yet.',
    nextSteps: ['Publish v0.4.0 to npm and tag the release', 'Write a migration guide from BullMQ'],
    attention: [],
    threads: [
      ['Release 0.4', 'Docs site, release notes and publishing.', 'active', ['Release 0.4']],
      ['Reliability', 'Retries, backoff and test stability.', 'done', ['Retries']],
      ['Benchmarks', 'Comparison with BullMQ.', 'done', ['Benchmarks']],
    ],
    cv: { title: 'tiny-queue', role: 'Author and maintainer', bullets: ['Wrote an SQLite-backed job queue for Node.js', 'Benchmarked it 35% faster than BullMQ on one machine'] },
  },
};

/** Today's plan (Home). `project` is a project folder name. */
export const DAILY = {
  headline: 'Northwind’s new checkout is one test away from review, and the Slack bot needs a decision.',
  focus: [
    { project: 'northwind-shop', title: 'Test 3-D Secure cards on the Payment Element in staging', why: 'It is the last check before Northwind can review the new checkout, and the holiday sale is close.', action: 'Run the 3-D Secure test cards against the Payment Element on staging and fix anything that does not come back to /checkout/done.' },
    { project: 'invoicely', title: 'Write the three dunning email templates', why: 'Two beta customers had failed payments this week; the schedule is ready and only the copy is missing.', action: 'Write the three dunning email templates (day 1, 4 and 10) in emails/dunning and hook them to the schedule in lib/dunning.ts.' },
  ],
  forgotten: [{ project: 'portfolio-site', note: 'The contact form was written three weeks ago and never deployed.' }],
  ideas: [
    'Pull the Stripe webhook code that Northwind Shop and Invoicely share into one small package.',
    'Show the homelab uptime bars on a public Invoicely status page.',
    'Offer the Bloom reminder flow to other small clinics as a monthly plan.',
  ],
};

/** Possible projects (scout), per source project. Evidence: [sessionKey|null, text]; a session key adds its date. */
export const SCOUT = {
  invoicely: {
    ago: 26 * 60,
    candidates: [
      {
        kind: 'spin-off', confidence: 'high', title: 'Slack Invoice Bot',
        pitch: 'A standalone Slack app that creates, sends and chases invoices from any channel, for freelancers and small studios who live in Slack.',
        why: 'The bot already has its own package, its own install flow and its own users, and you said it could be its own product.',
        evidence: [['I6', '“maybe this should be its own product”, about the Slack bot'], [null, 'packages/slack-bot has its own package.json and README; 4 sessions edited it'], ['I8', '“Slack OAuth install for other workspaces” in progress']],
        threadName: 'Slack bot',
        firstSteps: ['Move packages/slack-bot into its own repo with a small Invoicely API client', 'List the app privately for the 6 beta workspaces', 'Decide pricing: per workspace or per seat'],
      },
      {
        kind: 'reusable', confidence: 'medium', title: 'Stripe Webhook Kit',
        pitch: 'A small TypeScript package for Stripe webhooks (signature check, idempotency, retry rules) shared by Northwind Shop and Invoicely.',
        why: 'The same webhook code now lives in two projects and you called it the third time you wrote it.',
        evidence: [['I7', '“it’s the third time I write this”, about the webhook code'], ['N5', 'Northwind Shop: “Idempotent Stripe webhooks for renewals”'], [null, 'lib/stripe/webhooks.ts edited in both projects']],
        threadName: 'Payments and dunning',
        firstSteps: ['Extract verify + idempotency into packages/stripe-webhooks with the tests from both projects', 'Use it in Invoicely first, then in Northwind Shop', 'Publish privately on GitHub Packages'],
      },
    ],
  },
  'bloom-clinic': {
    ago: 30 * 60,
    candidates: [
      {
        kind: 'idea', confidence: 'medium', title: 'Clinic SMS Reminders',
        pitch: 'Appointment reminders by SMS, with STOP handling and no-show stats, sold to small clinics that have no booking system of their own.',
        why: 'You voiced it as a product twice while building Bloom’s reminders, and the reminder code depends very little on the booking app.',
        evidence: [['B3', '“honestly this reminder thing could be its own product, every small clinic needs it”'], ['B5', '“if we ever sell the reminders to other clinics we’ll need per-clinic twilio numbers”'], ['B4', 'No-show rate dropped from 14% to 6% after reminders']],
        threadName: 'SMS reminders',
        firstSteps: ['Write a one-page offer and ask two clinics near Bloom if they would pay for it', 'Make the Twilio sender configurable per clinic', 'Import appointments from a CSV for clinics without a booking app'],
      },
    ],
  },
  'northwind-shop': { ago: 26 * 60, candidates: [], note: 'The webhook code is shared with Invoicely; proposed there once instead of twice.' },
  'tiny-queue': { ago: 3 * 24 * 60, candidates: [], note: 'Looked at the benchmark scripts and the docs site; both belong to the library itself.' },
};

/** Tasks Alex made or kept. The Suggested ones are added by Pilotage's own extractor from the summaries when the server starts. */
export const TASKS = [
  { status: 'todo', p: 'northwind-shop', title: 'Test 3-D Secure cards on the Payment Element in staging', priority: 2, today: true, createdDay: -3 },
  { status: 'todo', p: 'bloom-clinic', title: 'Reply to Priya about the Saturday opening hours', priority: 1, today: true, createdDay: -1 },
  { status: 'todo', p: 'invoicely-mobile', title: 'Get the APNs key from the Apple developer account and finish iOS push', priority: 1, kept: 'M3', createdDay: -6 },
  { status: 'todo', p: 'tiny-queue', title: 'Publish v0.4.0 to npm and tag the release', priority: 1, createdDay: -4 },
  { status: 'todo', p: 'homelab-dashboard', title: 'Renew the TLS certificate for dash.home.arpa', priority: 1, createdDay: -9 },
  { status: 'todo', p: 'northwind-shop', title: 'Send Northwind the staging link for the checkout review', priority: 1, createdDay: -3 },
  { status: 'doing', p: 'invoicely', title: 'Store bot tokens per workspace and test the install on a second Slack workspace', priority: 2, kept: 'I8', createdDay: -4, startedDay: -1 },
  { status: 'done', p: 'invoicely-mobile', title: 'Fix the Android build after the Expo upgrade', doneAgo: 240, createdDay: -1 },
  { status: 'done', p: 'northwind-shop', title: 'Fix image layout shift on product pages', doneDay: -13, createdDay: -14 },
  { status: 'done', p: 'invoicely', title: 'Overdue reminders in Slack channels', doneDay: -11, createdDay: -15 },
  { status: 'done', p: 'bloom-clinic', title: 'Therapist time off in the schedule', doneDay: -21, createdDay: -24 },
  { status: 'done', p: 'homelab-dashboard', title: 'Disk alerts on the phone', doneDay: -9, createdDay: -12 },
  { status: 'done', p: 'tiny-queue', title: 'Retries with exponential backoff', doneDay: -21, createdDay: -25 },
];

export const IDEAS = [
  { text: 'Weekly “what I shipped” email to clients, written from the session summaries', p: null, day: -6, source: 'Pixel 8 · Chrome' },
  { text: 'Pricing page experiment for Invoicely: per-seat vs flat', p: 'invoicely', day: -9, source: 'Desktop · Chrome' },
  { text: 'Self-host Plausible on the homelab for the portfolio stats', p: 'homelab-dashboard', day: -15, source: 'Pixel 8 · Chrome' },
];

export const DEVICES = [
  { name: 'Pixel 8 · Chrome', ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', via: 'pair', createdDay: -30, seenAgo: 50 },
  { name: 'Desktop · Chrome', ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', via: 'desktop', createdDay: -41, seenAgo: 3 },
];

/** Usage meters in the sidebar footer. */
// claude.ai chats (Settings → Sources → import an export): shown on the Map and in Sessions. Fictional, like the rest.
export const CHATS = [
  { uuid: '0d2f6a3e-1c4b-4e8a-9f10-5a1b2c3d4e01', name: 'Stripe Tax vs. hard-coded VAT for a coffee shop', day: -3, messages: 14, first: 'For a small EU coffee shop on Stripe, should VAT come from Stripe Tax or a table in the app?', last: 'OK, Stripe Tax it is. How do I test it on staging?', project: 'clients/northwind-shop' },
  { uuid: '0d2f6a3e-1c4b-4e8a-9f10-5a1b2c3d4e02', name: 'Invoice numbering rules (France, Germany)', day: -6, messages: 9, first: 'What are the legal rules for invoice numbers in France and Germany? Gaps allowed?', last: 'Can a credit note use the same sequence?', project: 'saas/invoicely' },
  { uuid: '0d2f6a3e-1c4b-4e8a-9f10-5a1b2c3d4e03', name: 'Proxmox backups to a NAS: retention plan', day: -11, messages: 7, first: 'Retention for daily Proxmox backups to a 4 TB NAS, 6 VMs?', last: 'And how do I check a restore actually works?', project: 'lab/homelab-dashboard' },
  { uuid: '0d2f6a3e-1c4b-4e8a-9f10-5a1b2c3d4e04', name: 'Talk outline: queues without Redis', day: -15, messages: 5, first: 'Help me outline a 20-minute talk about job queues on plain Postgres.', last: '', project: 'oss/tiny-queue' },
];

export const USAGE = { fiveHourPct: 34, fiveHourResetsInMin: 140, sevenDayPct: 41, sevenDayResetsInDays: 3 };
