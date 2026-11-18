// One project as a CV entry, folded by default (glyph, title, period, role, Include switch); tap to see the tagline,
// bullets, stack, a quiet provenance line and the actions.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, CircleDashed, ExternalLink, FileText, Github, Pencil, RotateCcw, Sparkles } from 'lucide-react';
import type { PortfolioProject } from '../../types';
import { Button, IconButton, Meta, ProjectGlyph, Spinner, Switch } from '../ui';
import { fmtDate, fmtDateTime, plural } from '../../util';
import { Entry, L, Lang, Source, asLang, shortUrl } from './model';

const MAX_BULLETS = 3;

function Provenance({ source, p, lang }: { source: Source; p: PortfolioProject; lang: Lang }) {
  const g = p.generated;
  let icon: React.ReactNode;
  let text: React.ReactNode;
  let title: string;
  switch (source) {
    case 'edited':
      icon = <Pencil aria-hidden="true" />;
      text = 'Edited by you';
      title = 'Your text takes priority over the AI version';
      break;
    case 'ai':
      icon = <Sparkles aria-hidden="true" />;
      text = (
        <>
          Written by AI · {fmtDate(g?.at)}
          {g && asLang(g.lang) !== lang && <span className="cv-lang">{g.lang.toUpperCase()}</span>}
        </>
      );
      title = g ? `Written by ${g.model || 'AI'} on ${fmtDateTime(g.at)}` : 'Written by AI';
      break;
    case 'brief':
      icon = <FileText aria-hidden="true" />;
      text = 'From the project summary';
      title = 'Taken from the project summary. Write the entry with AI (or edit it) for stronger bullets.';
      break;
    case 'draft':
      icon = <CircleDashed aria-hidden="true" />;
      text = 'Draft from session highlights';
      title = 'Assembled from session highlights. Write the entry for a polished version.';
      break;
    default:
      icon = <CircleDashed aria-hidden="true" />;
      text = 'Nothing written yet';
      title = 'No summary or highlights yet';
  }
  return (
    <span className={`cv-prov ${source}`} title={title}>
      {icon}
      {text}
    </span>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="num">{Math.max(0, Math.round((now - since) / 1000))} s</span>;
}

export function EntryCard({
  p,
  e,
  included,
  lang,
  aiOn,
  runningSince,
  onToggle,
  onEdit,
  onWrite,
}: {
  p: PortfolioProject;
  e: Entry;
  included: boolean;
  lang: Lang;
  aiOn: boolean;
  runningSince: number | undefined;
  onToggle: (on: boolean) => void;
  onEdit: () => void;
  onWrite: () => void;
}) {
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(false);
  const writing = runningSince !== undefined;
  // Folded by default: the title line and the Include switch. Tap the title to see the bullets and the actions.
  const show = open || writing;
  const ready = e.source === 'edited' || e.source === 'ai';
  const isGithub = /github\.com/i.test(e.link);
  const bullets = more ? e.bullets : e.bullets.slice(0, MAX_BULLETS);
  const hidden = e.bullets.length - MAX_BULLETS;

  return (
    <article className={`card cv-entry${included ? '' : ' off'}${ready ? '' : ' draft'}${writing ? ' writing' : ''}`} aria-busy={writing} aria-label={e.title}>
      <div className="cv-main">
        <header className="cv-head">
          <Link to={`/projects/${p.id}`} className="cv-glyph" title={`${p.name} · ${p.workspaceName}`}>
            <ProjectGlyph name={p.name} ws={p.workspace} color={p.color} size={32} />
          </Link>
          <button type="button" className="cv-toggle" aria-expanded={show} onClick={() => setOpen(!open)}>
            <span className="cv-titles">
              <span className="cv-title-row">
                <span className="cv-title">{e.title}</span>
                {e.period && <span className="cv-period num">{e.period}</span>}
              </span>
              <span className="cv-role">
                <span className="truncate">{[e.period ? <span key="p" className="cv-period-m">{e.period} · </span> : null, [e.role, p.workspaceName].filter(Boolean).join(' · ')]}</span>
              </span>
            </span>
            <ChevronRight className="cv-chev" aria-hidden="true" />
          </button>
          {!show && (
            <label className="cv-include cv-include-head" title={included ? 'Included in the CV' : 'Not included in the CV'}>
              <Switch on={included} onChange={onToggle} label={`Include ${e.title} in the CV`} />
            </label>
          )}
        </header>

        {show && e.tagline && <p className="cv-tagline">{e.tagline}</p>}

        {!show ? null : writing ? (
          <div className="cv-writing" role="status">
            <Spinner size={15} />
            <span>
              Writing this entry in {L[lang].name} from your sessions and commits… <span className="faint">usually 20–60 s · </span>
              <Elapsed since={runningSince!} />
            </span>
          </div>
        ) : e.bullets.length > 0 ? (
          <div className="cv-bullets-wrap">
            <ul className="cv-bullets">
              {bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
            {hidden > 0 && (
              <button type="button" className="more-link" onClick={() => setMore(!more)} aria-expanded={more}>
                {more ? 'Show less' : `Show ${hidden} more`}
              </button>
            )}
          </div>
        ) : (
          <p className="small faint">No highlights yet. Write the entry with AI, or add your own bullets.</p>
        )}

        {show && e.stack.length > 0 && (
          <div className="cv-stack" aria-label="Stack">
            {e.stack.slice(0, 10).map((s) => (
              <span key={s} className="chip">
                {s}
              </span>
            ))}
            {e.stack.length > 10 && <span className="tiny faint">+{e.stack.length - 10}</span>}
          </div>
        )}
      </div>

      {show && (
      <footer className="cv-foot">
        <div className="cv-foot-info">
          <Provenance source={e.source} p={p} lang={lang} />
          <Meta
            className="cv-stats"
            items={[
              p.humanPrompts ? <span className="num">{plural(p.humanPrompts, 'prompt')}</span> : null,
              p.commits ? <span className="num">{plural(p.commits, 'commit')}</span> : null,
              e.link ? (
                <a href={e.link} target="_blank" rel="noreferrer noopener" className="cv-link" title={e.link}>
                  {isGithub ? <Github aria-hidden="true" /> : <ExternalLink aria-hidden="true" />}
                  {isGithub ? 'GitHub' : shortUrl(e.link)}
                </a>
              ) : null,
            ]}
          />
        </div>
        <div className="cv-foot-actions">
          <label className="cv-include">
            <span className="small">{included ? 'Included' : 'Not included'}</span>
            <Switch on={included} onChange={onToggle} label={`Include ${e.title} in the CV`} />
          </label>
          <IconButton icon={<Pencil />} label={`Edit the entry for ${e.title}`} onClick={onEdit} />
          <Button
            size="sm"
            variant={ready ? 'ghost' : 'secondary'}
            icon={writing ? undefined : p.generated ? <RotateCcw /> : <Sparkles />}
            loading={writing}
            disabled={!aiOn}
            onClick={onWrite}
            title={!aiOn ? 'AI is turned off in Settings' : p.generated ? `Write it again in ${L[lang].name}` : `Let AI write this entry in ${L[lang].name}`}
          >
            {writing ? 'Writing…' : p.generated ? 'Rewrite' : 'Write with AI'}
          </Button>
        </div>
      </footer>
      )}
    </article>
  );
}
