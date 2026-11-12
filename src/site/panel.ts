// Side panel for the selected node: details, connections, albums, and the path finder.
import type Graph from 'graphology';
import { h, years } from '../shared/dom.ts';
import type { Edge, EdgeType, ExportNode } from '../shared/types.ts';
import type { AlbumInfo } from './live.ts';
import { DISTANT_STEPS } from './connect.ts';
import type { PathResult } from './path.ts';
import { attachSearch, type SearchIndex } from './search.ts';

export interface PanelContext {
  graph: Graph;
  node: (id: string) => ExportNode;
  edge: (id: string) => Edge;
  isEdgeVisible: (id: string) => boolean;
  index: SearchIndex;
  /** Live-fetch status of an artist's connections */
  status: (id: string) => 'idle' | 'loading' | 'done' | 'error';
  /** Progress text while second-level connections load, else null */
  progress: (id: string) => string | null;
  expand: (id: string) => void;
  albums: (id: string) => Promise<AlbumInfo[]>;
  /** Total connections on record for an artist (null if unknown) */
  count: (id: string) => Promise<number | null>;
  /** True while a found connection is shown on its own */
  inChainView: () => boolean;
  /** Leave the connection view and grow the map outward from this artist */
  exploreFrom: (id: string) => void;
  /** The node's scene color on the map, so the panel's dots match */
  hue: (id: string) => string;
  select: (id: string | null) => void;
  /** Highlight a node on the map while its name is hovered here (null to clear) */
  peek: (id: string | null) => void;
  /** Recently visited artists, oldest first */
  trail: () => string[];
  collapse: () => void;
  connect: (from: string, to: string) => PathResult | null;
}

/** Section headings from the selected node's point of view: [as source, as target]. */
const ROLES: Record<EdgeType, [string, string]> = {
  member_of: ['Member of', 'Members'],
  founded: ['Founded', 'Founders'],
  subgroup_of: ['Part of', 'Subgroups'],
  collaborated: ['Collaborations', 'Collaborators'],
  supporting: ['Supported', 'Supporting musicians'],
  worked_with: ['Worked with', 'Worked with'],
  released: ['Albums', 'By'],
};
const ROLE_ORDER = ['Members', 'Member of', 'Founders', 'Founded', 'Part of', 'Subgroups', 'Collaborators', 'Collaborations', 'Supporting musicians', 'Supported', 'Worked with', 'By'];

/**
 * One step of a connection chain as a sentence, e.g. "David Sylvian was a member of Japan
 * (1974–1982), on vocals" or "Ichiko Aoba and Ryuichi Sakamoto worked together on «Disappearance»
 * (2013)". Built from what the link already carries: years, instruments, the shared record.
 */
function stepSentence(ctx: PanelContext, e: Edge, from: string): Node {
  const name = (id: string) => h('strong', null, ctx.node(id).label);
  const [a, b] = [name(e.source), name(e.target)];
  const when = years(e.begin, e.end);
  // Working together has no direction: name them in the order the chain walks.
  const [first, second] = e.source === from ? [a, b] : [b, a];
  const extras = (e.attributes ?? []).filter((x) => x !== 'original');
  const parts: (Node | string)[] = (() => {
    switch (e.type) {
      case 'member_of':
        return [a, ' was a member of ', b, when && ` (${when})`, extras.length ? `, on ${extras.join(', ')}` : ''];
      case 'founded':
        return [a, ' founded ', b, when && ` (${when})`];
      case 'subgroup_of':
        return [a, ' is part of ', b];
      case 'collaborated':
        return [a, ' took part in ', b, when && ` (${when})`];
      case 'supporting':
        return [a, ' played with ', b, extras.length ? ` (${extras.join(', ')})` : '', when && `, ${when}`];
      case 'worked_with': {
        const record = extras[0];
        // One record, one year (not "2013–").
        return [first, ' and ', second, ' worked together', record ? [' on ', h('em', null, record)] : '', e.begin ? ` (${e.begin.slice(0, 4)})` : ''] as (Node | string)[];
      }
      case 'released':
        return [b, ' is a record by ', a];
    }
  })();
  return h('span', null, ...parts.flat().filter((x) => x !== '' && x !== undefined));
}

const coverUrl = (albumId: string) => `https://coverartarchive.org/release-group/${albumId}/front-250`;

function cover(albumId: string, big = false) {
  const img = h('img', {
    class: big ? 'cover big' : 'cover',
    src: coverUrl(albumId),
    alt: '',
    loading: 'lazy',
    decoding: 'async',
  });
  // No cover on file: keep the neutral square.
  img.addEventListener('error', () => img.replaceWith(h('span', { class: img.className })), { once: true });
  return img;
}

/**
 * Second-level links under each connection: for a band's member, the other bands they were in;
 * for a person's band, the other people in it.
 */
function alsoLine(ctx: PanelContext, selected: string, other: ExportNode, max = 5) {
  const names: ExportNode[] = [];
  ctx.graph.forEachEdge(other.id, (edgeKey, _a, s, t) => {
    if (!ctx.isEdgeVisible(edgeKey)) return;
    const nid = s === other.id ? t : s;
    if (nid === selected) return;
    const node = ctx.node(nid);
    if (node.kind === 'album' || names.some((x) => x.id === nid)) return;
    names.push(node);
  });
  if (!names.length) return null;
  // People list the groups they were in; groups list their people.
  names.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === (other.kind === 'person' ? 'group' : 'person') ? -1 : 1));
  const shown = names.slice(0, max);
  return h(
    'div',
    { class: 'also' },
    other.kind === 'person' ? 'also in ' : 'with ',
    shown.flatMap((x, i) => [
      i ? ', ' : '',
      h(
        'button',
        { class: 'linklike', onclick: () => ctx.select(x.id), onmouseenter: () => ctx.peek(x.id), onmouseleave: () => ctx.peek(null) },
        x.label,
      ),
    ]),
    names.length > max ? ` +${names.length - max}` : '',
  );
}

/**
 * "+14": how many of this artist's connections aren't on the map yet. Only for artists that
 * haven't been loaded; counts come from the index (cached, so re-renders don't refetch).
 */
const counts = new Map<string, number | null>();
function moreBadge(ctx: PanelContext, id: string) {
  if (ctx.status(id) === 'done') return null;
  const badge = h('span', { class: 'more', title: 'Connections not on the map yet' });
  const fill = (total: number | null) => {
    const onMap = ctx.graph.hasNode(id) ? ctx.graph.degree(id) : 0;
    const more = total === null ? 0 : total - onMap;
    if (more > 0) badge.textContent = `+${more}`;
    else badge.remove();
  };
  if (counts.has(id)) fill(counts.get(id)!);
  else {
    // Counting needs that artist's index file: only for rows you can actually see (a hub's panel
    // lists thousands of people, and fetching all their files made B.B. King download 10 MB).
    badgeJobs.set(badge, () =>
      void ctx.count(id).then((n) => {
        counts.set(id, n);
        fill(n);
      }),
    );
    badgeObserver.observe(badge);
  }
  return badge;
}

/**
 * Growing the map is your call: picking an artist shows them, and this button adds their
 * connections. It says how many first, so a 2,000-connection composer doesn't surprise you.
 */
function showConnections(ctx: PanelContext, id: string) {
  const button = h('button', { class: 'primary explore-here', type: 'button', onclick: () => ctx.expand(id) }, 'Show connections');
  const label = (total: number | null) => {
    const onMap = ctx.graph.hasNode(id) ? ctx.graph.degree(id) : 0;
    if (total === null) return;
    const more = total - onMap;
    button.textContent = more > 0 ? `Show ${more.toLocaleString()} more connection${more === 1 ? '' : 's'}` : 'Show connections';
    if (total >= 150) button.title = 'That is a lot of artists: the map will get busy';
  };
  if (counts.has(id)) label(counts.get(id)!);
  else void ctx.count(id).then((n) => (counts.set(id, n), label(n)));
  return button;
}

const badgeJobs = new WeakMap<Element, () => void>();
const badgeObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      badgeObserver.unobserve(e.target);
      badgeJobs.get(e.target)?.();
      badgeJobs.delete(e.target);
    }
  },
  { rootMargin: '200px' },
);

/** People shown per section before "Show all": hubs have thousands. */
const ROWS_SHOWN = 60;
/** Sections opened with "Show all", as `${artistId}:${role}` (kept across re-renders). */
const shownAll = new Set<string>();

export function renderPanel(panel: HTMLElement, ctx: PanelContext, id: string | null, path: PathResult | null) {
  if (!id) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  const n = ctx.node(id);
  const groups = new Map<string, { other: ExportNode; edge: Edge }[]>();
  const albums: ExportNode[] = [];

  ctx.graph.forEachEdge(id, (edgeKey) => {
    if (!ctx.isEdgeVisible(edgeKey)) return;
    const e = ctx.edge(edgeKey);
    const asSource = e.source === id;
    const other = ctx.node(asSource ? e.target : e.source);
    if (e.type === 'released' && asSource) return void albums.push(other);
    const role = ROLES[e.type][asSource ? 0 : 1];
    if (!groups.has(role)) groups.set(role, []);
    groups.get(role)!.push({ other, edge: e });
  });

  const meta =
    n.kind === 'album'
      ? ['album', n.year]
      : [n.kind, n.disambiguation, n.country, years(n.begin, n.end)];

  const mbUrl = `https://musicbrainz.org/${n.kind === 'album' ? 'release-group' : 'artist'}/${n.id}`;

  const self = id;
  const row = ({ other, edge }: { other: ExportNode; edge: Edge }) =>
    h(
      'li',
      null,
      h(
        'button',
        {
          onclick: () => ctx.select(other.id),
          onmouseenter: () => ctx.peek(other.id),
          onmouseleave: () => ctx.peek(null),
          onfocus: () => ctx.peek(other.id),
          onblur: () => ctx.peek(null),
        },
        h('span', { class: `dot ${other.kind}`, style: `background:${ctx.hue(other.id)}` }),
        other.label,
        moreBadge(ctx, other.id),
        h('span', { class: 'sub' }, [years(edge.begin, edge.end), edge.attributes?.filter((a) => a !== 'original').join(', ')].filter(Boolean).join(' · ')),
      ),
      alsoLine(ctx, self, other),
    );

  const sections = ROLE_ORDER.filter((r) => groups.has(r)).map((role) => {
    const all = groups.get(role)!.sort((a, b) => (a.edge.begin ?? '9').localeCompare(b.edge.begin ?? '9'));
    const key = `${id}:${role}`;
    const items = shownAll.has(key) ? all : all.slice(0, ROWS_SHOWN);
    const more =
      items.length < all.length
        ? h(
            'button',
            {
              class: 'linklike show-all',
              onclick: (ev: Event) => {
                shownAll.add(key);
                const list = (ev.currentTarget as HTMLElement).previousElementSibling;
                list?.append(...all.slice(ROWS_SHOWN).map(row));
                (ev.currentTarget as HTMLElement).remove();
              },
            },
            `Show all ${all.length.toLocaleString()}`,
          )
        : null;
    return [h('h3', null, all.length > 1 ? `${role} · ${all.length.toLocaleString()}` : role), h('ul', { class: 'people' }, items.map(row)), more];
  });

  albums.sort((a, b) => (a.year ?? '9').localeCompare(b.year ?? '9'));
  let albumSection: Node[] = [];
  if (albums.length) {
    // Albums you added to the map yourself are clickable nodes.
    albumSection = [
      h('h3', null, `Albums · ${albums.length}`),
      h(
        'div',
        { class: 'covers' },
        albums.map((a) => h('button', { onclick: () => ctx.select(a.id), title: a.label }, cover(a.id), a.label)),
      ),
    ];
  } else if (n.kind !== 'album') {
    // Otherwise fetch the discography live and link out to MusicBrainz.
    const grid = h('div', { class: 'covers' }, h('p', { class: 'muted note' }, 'Loading albums…'));
    const heading = h('h3', null, 'Studio albums');
    albumSection = [heading, grid];
    ctx
      .albums(id)
      .then((list) => {
        heading.textContent = list.length ? `Studio albums · ${list.length}` : 'Studio albums';
        grid.replaceChildren(
          ...(list.length
            ? list.map((a) =>
                h(
                  'a',
                  { class: 'album', href: `https://musicbrainz.org/release-group/${a.id}`, target: '_blank', rel: 'noopener', title: a.title },
                  cover(a.id),
                  a.year ? `${a.title} (${a.year})` : a.title,
                ),
              )
            : [h('p', { class: 'muted note' }, 'None listed on MusicBrainz.')]),
        );
      })
      .catch(() => grid.replaceChildren(h('p', { class: 'muted note' }, "Couldn't load albums.")));
  }

  const st = n.kind === 'album' ? 'done' : ctx.status(id);
  const statusLine =
    st === 'loading'
      ? h('p', { class: 'muted note' }, 'Loading connections from MusicBrainz…')
      : st === 'error'
        ? h('p', { class: 'note error' }, "Couldn't load connections. ", h('button', { class: 'linklike', onclick: () => ctx.expand(id) }, 'Retry'))
        : st === 'done' && !sections.length
          ? h('p', { class: 'muted note' }, 'No band or collaborator links on MusicBrainz yet.')
          : null;

  // Path finder
  const connectInput = h('input', { type: 'search', placeholder: 'Connect to another artist…', autocomplete: 'off' });
  const connectList = h('ul', { class: 'dropdown', role: 'listbox', hidden: true });
  const pathOut = h('div');
  attachSearch(
    connectInput,
    connectList,
    ctx.index,
    (target) => {
      const p = ctx.connect(id, target.id);
      if (!p) pathOut.replaceChildren(h('p', { class: 'muted' }, `No connection to ${target.label} on the map yet. Try expanding artists in between.`));
    },
    { exclude: () => id },
  );

  if (path && path.nodes[0] === id) {
    const steps: Node[] = [];
    path.nodes.forEach((nid, i) => {
      const node = ctx.node(nid);
      steps.push(h('li', null, h('span', { class: `dot ${node.kind}`, style: `background:${ctx.hue(node.id)}` }), h('button', { onclick: () => ctx.select(nid) }, node.label)));
      if (i < path.edges.length) steps.push(h('li', { class: 'hop' }, stepSentence(ctx, ctx.edge(path.edges[i]), nid)));
    });
    // "via Ryuichi Sakamoto and Japan": the artists in between, at a glance.
    const between = path.nodes.slice(1, -1).map((nid) => ctx.node(nid).label);
    const via = between.length
      ? ` · via ${between.length <= 3 ? between.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${between.slice(0, 2).join(', ')} and ${between.length - 2} more`}`
      : ' · directly';
    pathOut.replaceChildren(
      h(
        'p',
        { class: 'muted path-summary' },
        `${path.edges.length} step${path.edges.length === 1 ? '' : 's'}${via}`,
        // Long chains exist mostly because the data only has band memberships and collaborations:
        // say so, rather than presenting 17 steps as a close relationship.
        path.edges.length > DISTANT_STEPS ? ' · a distant connection' : '',
      ),
      h('ol', { class: 'path' }, steps),
    );
  }

  const chainFirst = ctx.inChainView() && !!path && path.nodes[0] === id && n.kind !== 'album';
  const trail = ctx.trail().filter((t) => t !== id).slice(-4);
  panel.replaceChildren(h('div', null,
    h(
      'div',
      { class: 'panel-actions' },
      h('button', { class: 'icon', 'aria-label': 'Hide panel', title: 'Hide panel', onclick: () => ctx.collapse() }, '›'),
      h('button', { class: 'icon', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => ctx.select(null) }, '×'),
    ),
    trail.length
      ? h(
          'nav',
          { class: 'trail', 'aria-label': 'Recently viewed' },
          trail.map((t) =>
            h(
              'button',
              { onclick: () => ctx.select(t), onmouseenter: () => ctx.peek(t), onmouseleave: () => ctx.peek(null) },
              ctx.node(t).label,
            ),
          ),
          h('span', { class: 'here' }, n.label),
        )
      : null,
    h('h2', null, n.label),
    h('p', { class: 'meta muted' }, meta.filter(Boolean).join(' · ')),
    h(
      'div',
      { class: 'links' },
      h('a', { href: mbUrl, target: '_blank', rel: 'noopener' }, 'MusicBrainz ↗'),
      n.wikidata
        ? h('a', { href: `https://www.wikidata.org/wiki/Special:GoToLinkedPage/enwiki/${n.wikidata}`, target: '_blank', rel: 'noopener' }, 'Wikipedia ↗')
        : null,
    ),
    n.kind === 'album' ? cover(n.id, true) : null,
    // In the connection view nothing grows on its own: this is how you dig in from a step.
    chainFirst ? [h('h3', null, 'How they are connected'), pathOut] : null,
    ctx.inChainView() && n.kind !== 'album'
      ? h('button', { class: 'primary explore-here', type: 'button', onclick: () => ctx.exploreFrom(id) }, 'Explore from here')
      : st === 'idle'
        ? showConnections(ctx, id)
        : statusLine,
    ctx.progress(id) ? h('p', { class: 'muted note progress' }, ctx.progress(id)) : null,
    sections,
    albumSection,
    // In the connection view the chain is the point: it goes first (above). Otherwise it's a tool at the end.
    n.kind === 'album' || chainFirst ? null : [h('h3', null, 'How are they connected?'), h('div', { class: 'connect' }, connectInput, connectList), pathOut],
  ));
  panel.hidden = false;
}
