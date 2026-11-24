// A session as markdown, for a handoff or a bug report (GET /api/sessions/:id/export, `pilotage export`; pure, tested).
// Input: views.sessionDetail(), the turns the session page lists (views.turns) and each turn's detail read from the
// transcript (index.turnDetail). Prompts and final replies in full (as stored: redacted, long ones clipped), tool calls
// counted, not shown. The whole text goes through redact() once more before it leaves.
import { redact, compactNum } from './util.js';

const HARNESS = { claude: ['Claude Code', 'Claude'], codex: ['Codex CLI', 'Codex'], gemini: ['Gemini CLI', 'Gemini'] };
const SPEAKER = { h: 'You', s: 'Script (SDK prompt)', p: 'Another session', n: 'Task notification', c: 'Scheduled run', y: 'System' };

const pad = (n) => String(n).padStart(2, '0');
/** Local "2026-11-23 10:05". */
export function fmtTime(t) {
  if (!t) return '?';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Tool calls of one turn: "3 tool calls (Edit ×2, Bash), 1 failed". */
function toolLine(n, tools) {
  if (!n) return '';
  const by = new Map();
  for (const t of tools) by.set(t.name || '?', (by.get(t.name || '?') || 0) + 1);
  const names = [...by].sort((a, b) => b[1] - a[1]).map(([k, c]) => (c > 1 ? `${k} ×${c}` : k));
  const failed = tools.filter((t) => t.error).length;
  return `${n} tool call${n > 1 ? 's' : ''}${names.length ? ` (${names.join(', ')})` : ''}${failed ? `, ${failed} failed` : ''}`;
}

/**
 * @param d       views.sessionDetail(id)
 * @param turns   views.turns(id).turns (oldest first)
 * @param details index.turnDetail() result per turn (or null: no detail on disk, the indexed text is used)
 * @param opts    { home, total }  home: shown as ~ in paths; total: how many turns the session has (when only the last ones are exported)
 */
export function renderSessionMarkdown(d, turns, details, { home = '', total = turns.length } = {}) {
  const [tool, agent] = HARNESS[d.harness] || HARNESS.claude;
  const tilde = (p) => (p && home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p || '');
  const L = [`# ${d.title}`, ''];
  const where = [tilde(d.cwd), d.branch ? `branch ${d.branch}` : '', d.worktree ? `worktree ${d.worktree}` : ''].filter(Boolean).join(', ');
  L.push(`- Project: ${d.projectName || 'no project'}${where ? ` (${where})` : ''}`);
  L.push(`- Session: \`${d.id}\` · ${tool}${d.version ? ` ${d.version}` : ''}${d.model ? ` · ${d.model}` : ''}`);
  L.push(`- From ${fmtTime(d.startedAt)} to ${fmtTime(d.lastAt)} · ${d.humanPrompts || 0} prompt${d.humanPrompts === 1 ? '' : 's'} · ${d.counts?.toolUse || 0} tool calls`);
  const t = d.tokens;
  // "Usage: N tokens", not "Tokens: N": redact() would take a `token: value` pair for a secret.
  if (t?.total) L.push(`- Usage: ${compactNum(t.total)} tokens (output ${compactNum(t.output)}, input ${compactNum(t.input)}, cache write ${compactNum(t.cacheWrite)}, cache read ${compactNum(t.cacheRead)})`);
  if (d.harness === 'claude' && !d.archived) L.push(`- Resume: \`claude --resume ${d.id}\` (in that folder)`);
  if (turns.length < total) L.push(`- Showing the last ${turns.length} of ${total} turns`);
  L.push('', '---');
  turns.forEach((t, k) => {
    const det = details[k];
    const items = det?.items || [];
    const prompt = items.find((x) => x.kind === 'prompt');
    const texts = items.filter((x) => x.kind === 'text');
    const tools = items.filter((x) => x.kind === 'tool');
    L.push('');
    if (t.o === 'x') {
      L.push(`_Context compacted here (${fmtTime(t.t)}): ${tool} carried a summary of the conversation over._`, '', '---');
      return;
    }
    L.push(`## ${SPEAKER[t.o] || 'You'} · ${fmtTime(t.t)}`, '');
    // The indexed text for slash commands ("/review 12"): the transcript has them as <command-name> markup.
    const ptext = prompt && !/^\s*</.test(prompt.text) ? prompt.text : t.p;
    L.push(ptext ? ptext.trim() : '_(no text)_', '');
    const n = det ? tools.length : t.n || 0;
    const reply = texts.length ? texts[texts.length - 1].text : t.a;
    const tl = toolLine(n, tools);
    L.push(`**${agent}**${tl ? ` · ${tl}` : ''}`, '');
    L.push(reply ? reply.trim() : '_(no reply)_', '', '---');
  });
  return redact(L.join('\n')) + '\n';
}
