import '../shared/base.css';
import './review.css';
import { h, years } from '../shared/dom.ts';
import {
  EDGE_LABEL,
  type Artist,
  type EdgeType,
  type SearchHit,
  type Suggestion,
  type SuggestResponse,
} from '../shared/types.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const searchForm = $<HTMLFormElement>('search-form');
const searchInput = $<HTMLInputElement>('search');
const resultsEl = $<HTMLUListElement>('results');
const frontierEl = $<HTMLUListElement>('frontier');
const statsEl = $<HTMLParagraphElement>('stats');
const main = $<HTMLElement>('main');

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body as T;
}

function toast(msg: string) {
  const el = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(el);
  setTimeout(() => el.remove(), 2500);
}

// ---------- Sidebar ----------

async function refreshSidebar() {
  const [stats, front] = await Promise.all([
    api<{ artists: number; albums: number; edges: number; rejected: number }>('/api/stats'),
    api<(Artist & { degree: number })[]>('/api/frontier'),
  ]);
  statsEl.textContent = `${stats.artists} artists · ${stats.albums} albums · ${stats.edges} connections · ${stats.rejected} rejected`;
  frontierEl.replaceChildren(
    ...(front.length
      ? front.map((a) =>
          h(
            'li',
            null,
            h(
              'button',
              { onclick: () => openArtist(a.id), 'data-id': a.id },
              h('span', { class: `dot ${a.kind}` }),
              a.name,
              h('span', { class: 'meta' }, `${a.degree} link${a.degree === 1 ? '' : 's'}`),
            ),
          ),
        )
      : [h('li', { class: 'muted' }, 'Nothing waiting. Search for a new artist.')]),
  );
}

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (!q) return;
  resultsEl.replaceChildren(h('li', { class: 'muted' }, 'Searching…'));
  try {
    const hits = await api<SearchHit[]>(`/api/search?q=${encodeURIComponent(q)}`);
    resultsEl.replaceChildren(
      ...hits.map((hit) =>
        h(
          'li',
          null,
          h(
            'button',
            { onclick: () => openArtist(hit.id) },
            h('span', { class: `dot ${hit.kind}` }),
            h(
              'span',
              null,
              hit.name,
              hit.inGraph ? h('span', { class: 'badge' }, 'in graph') : null,
              h(
                'span',
                { class: 'sub' },
                [hit.disambiguation, hit.country, years(hit.begin, hit.end)].filter(Boolean).join(' · ') || ' ',
              ),
            ),
          ),
        ),
      ),
    );
    if (!hits.length) resultsEl.replaceChildren(h('li', { class: 'muted' }, 'No matches.'));
  } catch (err) {
    resultsEl.replaceChildren(h('li', { class: 'error' }, String((err as Error).message)));
  }
});

// ---------- Focus view ----------

let current: SuggestResponse | null = null;

async function openArtist(mbid: string, fresh = false) {
  main.replaceChildren(h('p', { class: 'muted' }, 'Loading from MusicBrainz… (about one request per second)'));
  document.querySelectorAll('.list button.active').forEach((b) => b.classList.remove('active'));
  document.querySelector(`.list button[data-id="${mbid}"]`)?.classList.add('active');
  history.replaceState(null, '', `#${mbid}`);
  try {
    current = await api<SuggestResponse>(`/api/suggest/${mbid}${fresh ? '?fresh=1' : ''}`);
    renderFocus(current);
    window.scrollTo(0, 0);
  } catch (err) {
    main.replaceChildren(h('p', { class: 'error' }, `Couldn't load: ${(err as Error).message}`));
  }
}

const EDGE_ORDER: EdgeType[] = ['member_of', 'founded', 'subgroup_of', 'collaborated', 'supporting'];

/** How the other artist relates to the focus, worded from the focus's point of view. */
function roleLabel(s: Extract<Suggestion, { kind: 'edge' }>, focusId: string): string {
  const out = s.edge.source === focusId; // focus is the source → other is the target
  switch (s.edge.type) {
    case 'member_of':
      return out ? 'band' : 'member';
    case 'founded':
      return out ? 'founded' : 'founder';
    case 'subgroup_of':
      return out ? 'parent group' : 'subgroup';
    case 'collaborated':
      return out ? 'collaboration' : 'collaborator';
    case 'supporting':
      return out ? 'supported' : 'supporting musician';
    default:
      return '';
  }
}

function renderFocus(r: SuggestResponse) {
  const { focus } = r;
  const checks = new Map<string, HTMLInputElement>();

  const edgeSugs = r.suggestions.filter((s): s is Extract<Suggestion, { kind: 'edge' }> => s.kind === 'edge');
  const albumSugs = r.suggestions.filter((s): s is Extract<Suggestion, { kind: 'album' }> => s.kind === 'album');

  const row = (s: Suggestion, checked: boolean, content: Node[], extra?: Node) => {
    const cb = h('input', { type: 'checkbox', checked, onchange: updateSummary });
    checks.set(s.edge.id, cb);
    return h('div', { class: 'row' }, h('label', null, cb, ...content), extra);
  };

  const section = (title: string, rows: HTMLElement[], note?: string) => {
    if (!rows.length) return null;
    const toggle = h('button', {
      class: 'toggle-all',
      type: 'button',
      onclick: () => {
        const boxes = rows.map((r) => r.querySelector('input') as HTMLInputElement);
        const allOn = boxes.every((b) => b.checked);
        boxes.forEach((b) => (b.checked = !allOn));
        updateSummary();
      },
    }, 'Toggle all');
    return h(
      'section',
      { class: 'group' },
      h('h2', null, title, h('span', { class: 'muted' }, `${rows.length}`), toggle),
      note ? h('p', { class: 'muted', style: 'margin:4px 0 6px;font-size:12px' }, note) : null,
      rows,
    );
  };

  const edgeSections = EDGE_ORDER.map((type) => {
    const rows = edgeSugs
      .filter((s) => s.edge.type === type)
      .map((s) =>
        row(
          s,
          true,
          [
            h('span', { class: `dot ${s.other.kind}` }),
            h(
              'span',
              null,
              h('span', { class: 'name' }, s.other.name),
              s.otherInGraph ? h('span', { class: 'badge' }, 'in graph') : null,
              h(
                'span',
                { class: 'detail' },
                ' · ',
                [roleLabel(s, focus.id), years(s.edge.begin, s.edge.end), s.edge.attributes?.join(', '), s.other.disambiguation]
                  .filter(Boolean)
                  .join(' · '),
              ),
            ),
          ],
          h('button', { class: 'expand', type: 'button', onclick: () => openArtist(s.other.id) }, 'Open →'),
        ),
      );
    return section(EDGE_LABEL[type], rows);
  });

  const albumRows = albumSugs.map((s) =>
    row(s, false, [
      h('span', { class: 'dot album' }),
      h('span', null, h('span', { class: 'name' }, s.album.title), h('span', { class: 'detail' }, s.album.year ? ` · ${s.album.year}` : '')),
    ]),
  );

  const summary = h('span', { class: 'summary muted' });
  const saveBtn = h('button', { class: 'primary', type: 'button', onclick: save }, 'Save');

  function updateSummary() {
    let accept = 0;
    let reject = 0;
    for (const s of r.suggestions) {
      const on = checks.get(s.edge.id)?.checked;
      if (on) accept++;
      else if (s.kind === 'edge') reject++;
    }
    summary.textContent = `${accept} to add · ${reject} connection${reject === 1 ? '' : 's'} to reject`;
  }

  async function save() {
    const accept = r.suggestions.filter((s) => checks.get(s.edge.id)?.checked);
    // Unchecked connections are rejected for good; unchecked albums are just skipped.
    const reject = edgeSugs.filter((s) => !checks.get(s.edge.id)?.checked).map((s) => s.edge.id);
    saveBtn.disabled = true;
    try {
      const res = await api<{ artists: number; edges: number }>('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ focus, accept, reject }),
      });
      toast(`Saved ${focus.name}: now ${res.artists} artists, ${res.edges} connections`);
      await refreshSidebar();
      await openArtist(focus.id);
    } catch (err) {
      toast(`Save failed: ${(err as Error).message}`);
      saveBtn.disabled = false;
    }
  }

  const hiddenNote = [
    r.hidden.accepted ? `${r.hidden.accepted} already in graph` : '',
    r.hidden.rejected ? `${r.hidden.rejected} rejected earlier` : '',
  ].filter(Boolean);

  main.replaceChildren(h('div', null,
    h(
      'div',
      { class: 'focus-head' },
      h('h1', null, h('span', { class: `dot ${focus.kind}` }), focus.name),
      h(
        'p',
        { class: 'muted' },
        [focus.kind, focus.disambiguation, focus.country, years(focus.begin, focus.end)].filter(Boolean).join(' · '),
        ' · ',
        h('a', { href: `https://musicbrainz.org/artist/${focus.id}`, target: '_blank', rel: 'noopener' }, 'MusicBrainz ↗'),
        ' · ',
        h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), openArtist(focus.id, true)) }, 'Refetch'),
      ),
      hiddenNote.length ? h('p', { class: 'muted' }, `Hidden: ${hiddenNote.join(', ')}.`) : null,
    ),
    ...edgeSections.filter((s): s is HTMLElement => !!s),
    section('Studio albums', albumRows, 'Unchecked by default. Unchecked albums stay available for later.'),
    r.suggestions.length
      ? null
      : h('p', { class: 'muted', style: 'margin-top:24px' }, 'No new suggestions. Save to mark this artist as reviewed.'),
    h('div', { class: 'savebar' }, summary, saveBtn),
  ));
  updateSummary();
}

// ---------- Boot ----------

refreshSidebar().catch((err) => (statsEl.textContent = String(err)));
const initial = location.hash.slice(1);
if (/^[0-9a-f-]{36}$/.test(initial)) openArtist(initial);
