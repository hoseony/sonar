// Autocomplete: artists already on the map first, then live MusicBrainz matches.
import { h } from '../shared/dom.ts';
import type { NodeKind } from '../shared/types.ts';

export interface SearchItem {
  id: string;
  label: string;
  kind: NodeKind;
  sub?: string;
  /** true when the item comes from MusicBrainz rather than the current map */
  remote?: boolean;
}

export interface SearchIndex {
  items: () => SearchItem[];
  degree: (id: string) => number;
}

const norm = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

export function matchLocal(index: SearchIndex, query: string, limit = 6, exclude?: string): SearchItem[] {
  const q = norm(query.trim());
  if (!q) return [];
  const scored: [number, SearchItem][] = [];
  for (const n of index.items()) {
    if (n.id === exclude) continue;
    const label = norm(n.label);
    const pos = label.indexOf(q);
    if (pos < 0) continue;
    // Prefix matches first, then word-start matches, then artists over albums, then by connectedness.
    const wordStart = pos === 0 || /\s|\(/.test(label[pos - 1]);
    const score = (pos === 0 ? 0 : wordStart ? 1 : 2) * 1000 + (n.kind === 'album' ? 500 : 0) - index.degree(n.id);
    scored.push([score, n]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, n]) => n);
}

export function attachSearch(
  input: HTMLInputElement,
  list: HTMLUListElement,
  index: SearchIndex,
  onPick: (item: SearchItem) => void,
  opts: {
    exclude?: () => string | undefined;
    remote?: (q: string) => Promise<SearchItem[]>;
    /** Called when a remote search starts or ends (for a loading indicator) */
    onBusy?: (busy: boolean) => void;
  } = {},
) {
  let local: SearchItem[] = [];
  let remote: SearchItem[] = [];
  let remoteState: 'idle' | 'loading' | 'error' = 'idle';
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  // Remote results that are already on the map are shown once, as local.
  const all = () => [...local, ...remote.filter((r) => !local.some((l) => l.id === r.id))];

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
  };

  const option = (n: SearchItem, i: number) =>
    h(
      'li',
      {
        role: 'option',
        'aria-selected': i === active ? 'true' : 'false',
        onmousedown: (e: Event) => (e.preventDefault(), pick(n)),
      },
      h('span', { class: `dot ${n.kind}` }),
      n.label,
      h('span', { class: 'sub' }, n.sub ?? ''),
    );

  const render = () => {
    const items = all();
    const remoteItems = items.slice(local.length);
    const rows: HTMLElement[] = local.map((n, i) => option(n, i));
    if (opts.remote && input.value.trim().length >= 2) {
      rows.push(h('li', { class: 'heading', 'aria-hidden': 'true' }, 'MusicBrainz'));
      if (remoteState === 'loading' && !remoteItems.length) rows.push(h('li', { class: 'note' }, 'Searching…'));
      else if (remoteState === 'error') rows.push(h('li', { class: 'note' }, "Couldn't reach MusicBrainz."));
      else if (!remoteItems.length && remoteState === 'idle') rows.push(h('li', { class: 'note' }, 'No other matches.'));
      remoteItems.forEach((n, i) => rows.push(option(n, local.length + i)));
    }
    list.replaceChildren(...rows);
    list.hidden = rows.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
  };

  const pick = (n: SearchItem) => {
    input.value = '';
    local = remote = [];
    close();
    input.blur();
    onPick(n);
  };

  input.addEventListener('input', () => {
    const q = input.value;
    local = matchLocal(index, q, opts.remote ? 5 : 8, opts.exclude?.());
    remote = [];
    active = 0;
    clearTimeout(timer);
    if (opts.remote && q.trim().length >= 2) {
      remoteState = 'loading';
      opts.onBusy?.(true);
      const mine = ++seq;
      timer = setTimeout(async () => {
        try {
          const res = await opts.remote!(q.trim());
          if (mine !== seq) return;
          remote = res;
          remoteState = 'idle';
        } catch {
          if (mine !== seq) return;
          remoteState = 'error';
        }
        opts.onBusy?.(false);
        if (document.activeElement === input) render();
      }, 350);
    }
    else {
      seq++; // drop any search still in flight
      opts.onBusy?.(false);
    }
    render();
  });
  input.addEventListener('focus', () => {
    if (input.value.trim()) render();
  });
  input.addEventListener('keydown', (e) => {
    const items = all();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!items.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      render();
    } else if (e.key === 'Enter' && items[active]) {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', close);
}
