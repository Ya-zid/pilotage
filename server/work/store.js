// Work items (tasks / open loops) and spin-off relations, persisted in data/work.json.
// Atomic writes (tmp + rename) and one backup per day, like store.js. A file that exists but can't be read is kept
// aside (work.json.corrupt-<ts>) and the newest readable daily backup is loaded instead of starting empty.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, paths } from '../config.js';
import { writeJSONSync, debounce, isoDay, log, randomToken, clip } from '../util.js';

export const STATUSES = ['inbox', 'todo', 'doing', 'done', 'dropped'];
export const OPEN_STATUSES = new Set(['inbox', 'todo', 'doing']);
/** Items whose status the extractor may change (unless userEdited). 'user' and 'idea' items are never touched. */
export const AI_KINDS = new Set(['ai', 'brief', 'spinoff']);
export const SOURCE_KINDS = new Set(['ai', 'brief', 'user', 'idea', 'spinoff']);
export const WHO = ['you', 'claude', 'waiting'];

const BACKUPS_KEPT = 21;
const MAX_TOMBSTONES = 3000;

function emptyData() {
  return { version: 1, items: [], spinoffs: [], tombstones: [], meta: { lastExtractAt: 0, lastExtract: null } };
}

/** Fill defaults so older files and hand-made fixtures always have every field. */
export function normalizeItem(it) {
  const now = Date.now();
  const source = it.source && typeof it.source === 'object' ? { ...it.source } : { kind: 'user' };
  if (!SOURCE_KINDS.has(source.kind)) source.kind = 'user';
  const prefix = { user: 'u', idea: 'i', spinoff: 'k', ai: 'ai', brief: 'ai' }[source.kind] || 'u';
  return {
    id: String(it.id || `${prefix}_${randomToken(6)}`),
    projectPath: String(it.projectPath || ''),
    title: clip(String(it.title || '').trim(), 200) || 'Untitled',
    detail: String(it.detail || ''),
    status: STATUSES.includes(it.status) ? it.status : 'inbox',
    priority: Number.isInteger(it.priority) ? Math.max(0, Math.min(3, it.priority)) : 1,
    source,
    createdAt: it.createdAt || now,
    updatedAt: it.updatedAt || it.createdAt || now,
    doneAt: it.doneAt || null,
    dueAt: it.dueAt || null,
    userEdited: !!it.userEdited,
    aiStatus: it.aiStatus || null,
    closedBy: it.closedBy || null,
    closedEvidenceAt: it.closedEvidenceAt || 0,
    keys: Array.isArray(it.keys) ? it.keys.slice() : [],
    sourceAt: it.sourceAt || it.createdAt || now,
    aiBucket: it.aiBucket || null,
    launches: Array.isArray(it.launches) ? it.launches.slice() : [],
    startedAt: it.startedAt || null,
    plannedFor: typeof it.plannedFor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(it.plannedFor) ? it.plannedFor : null, // Home › Today
    snoozeUntil: it.snoozeUntil || null, // Suggested: hidden until then
    restoredAt: it.restoredAt || null, // the user restored it from Dropped: expiry counts from here
    dismissReason: it.dismissReason || null, // not-a-task | done | duplicate | old
    who: WHO.includes(it.who) ? it.who : null, // who does it: you | claude | waiting (from the AI; null = unknown)
    titleBy: it.titleBy === 'short' ? 'short' : null, // 'short': retitled by the cleanup pass (work/retitle.js), never lengthened again
  };
}

const isData = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/** Parsed work.json; null when there is none yet. Never starts empty over a damaged file (the next save would win). */
function loadWorkFile(file, backupsDir) {
  let why;
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isData(d)) return d;
    why = 'not a JSON object';
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    why = e.message;
  }
  let aside = `${file}.corrupt-${Date.now()}`;
  for (let n = 2; fs.existsSync(aside); n++) aside = `${file}.corrupt-${Date.now()}-${n}`; // never overwrite an earlier copy
  let kept = false;
  for (const keep of [fs.renameSync, fs.copyFileSync]) {
    try {
      keep(file, aside);
      kept = true;
      break;
    } catch {}
  }
  log.error(`work: ${path.basename(file)} is unreadable (${clip(why, 120)}); ${kept ? `kept it as ${path.basename(aside)}` : 'could not keep a copy'}`);
  let backups = [];
  try {
    backups = fs.readdirSync(backupsDir).filter((f) => /^work-.*\.json$/.test(f)).sort().reverse();
  } catch {}
  for (const f of backups) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(backupsDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!isData(d)) continue;
    log.warn(`work: restored ${Array.isArray(d.items) ? d.items.length : 0} items from backups/${f}`);
    try {
      if (kept) writeJSONSync(file, d); // so a restart before the next save doesn't find no file and start empty
    } catch {}
    return d;
  }
  log.error('work: no readable backup; starting with an empty board');
  return null;
}

export class WorkStore {
  constructor({ file = path.join(DATA, 'work.json'), backupsDir = paths.backups } = {}) {
    this.file = file;
    this.backupsDir = backupsDir;
    const loaded = loadWorkFile(file, backupsDir);
    this.data = { ...emptyData(), ...(loaded || {}) };
    this.data.items = (this.data.items || []).map(normalizeItem);
    this.data.spinoffs = Array.isArray(this.data.spinoffs) ? this.data.spinoffs : [];
    this.data.tombstones = Array.isArray(this.data.tombstones) ? this.data.tombstones : [];
    this.data.meta = { ...emptyData().meta, ...(this.data.meta || {}) };
    this.dirty = false;
    this._save = debounce(() => this.saveNow(), 500);
  }

  save() {
    this.dirty = true;
    this._save();
  }

  saveNow() {
    try {
      if (fs.existsSync(this.file) && this.backupsDir) {
        fs.mkdirSync(this.backupsDir, { recursive: true });
        const daily = path.join(this.backupsDir, `work-${isoDay(Date.now())}.json`);
        if (!fs.existsSync(daily)) {
          fs.copyFileSync(this.file, daily);
          this.pruneBackups();
        }
      }
      writeJSONSync(this.file, this.data);
      this.dirty = false;
    } catch (e) {
      log.error('work save failed', e);
    }
  }

  pruneBackups() {
    try {
      const files = fs.readdirSync(this.backupsDir).filter((f) => f.startsWith('work-')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - BACKUPS_KEPT))) fs.unlinkSync(path.join(this.backupsDir, f));
    } catch {}
  }

  get items() {
    return this.data.items;
  }

  get(id) {
    return this.data.items.find((x) => x.id === id) || null;
  }

  add(fields) {
    const item = normalizeItem(fields);
    this.data.items.push(item);
    this.save();
    return item;
  }

  /** Remove an item. AI-sourced items leave a tombstone so extraction never brings them back. */
  remove(id) {
    const i = this.data.items.findIndex((x) => x.id === id);
    if (i < 0) return null;
    const [item] = this.data.items.splice(i, 1);
    if (item.keys.length) {
      this.data.tombstones.push({ keys: item.keys, projectPath: item.projectPath, title: item.title, at: Date.now() });
      if (this.data.tombstones.length > MAX_TOMBSTONES) this.data.tombstones.splice(0, this.data.tombstones.length - MAX_TOMBSTONES);
    }
    this.save();
    return item;
  }

  addSpinoff(rel) {
    const r = { id: `s_${randomToken(6)}`, createdAt: Date.now(), ...rel };
    this.data.spinoffs.push(r);
    this.save();
    return r;
  }
}

let singleton = null;
export function getWorkStore() {
  if (!singleton) {
    singleton = new WorkStore();
    // index.js exits via process.exit() on SIGTERM/SIGINT; flush pending writes synchronously.
    process.on('exit', () => {
      if (singleton?.dirty) singleton.saveNow();
    });
  }
  return singleton;
}
