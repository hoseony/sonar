// "Layout" menu: live controls for the map's forces (like Obsidian's graph view), remembered per browser.
import { h } from '../shared/dom.ts';

export interface LayoutPrefs {
  /** Pull toward the middle */
  center: number;
  /** Push between nodes */
  repel: number;
  /** How strongly connections pull their ends together */
  linkForce: number;
  /** Preferred length of a connection, in pixels */
  linkDistance: number;
  /** Keep nodes from overlapping */
  noOverlap: boolean;
  paused: boolean;
}

export const DEFAULT_PREFS: LayoutPrefs = {
  center: 0.04,
  // Tuned on a real 2,000-artist scene so the connections between bands stay readable:
  // one-band members tuck in close (see TUNING.leafRepel), busy hubs get room.
  repel: 300,
  linkForce: 1,
  linkDistance: 45,
  noOverlap: true,
  paused: false,
};

// v3: defaults were re-tuned for complex scenes, so older saved settings don't apply.
const STORAGE_KEY = 'sonar:layout:v3';

export function loadPrefs(): LayoutPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (saved && typeof saved === 'object') return { ...DEFAULT_PREFS, ...saved, paused: false };
  } catch {
    // private mode, blocked storage, bad JSON: just use defaults
  }
  return { ...DEFAULT_PREFS };
}

function savePrefs(p: LayoutPrefs) {
  try {
    const { paused: _paused, ...rest } = p;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
  } catch {
    // ignore
  }
}

type SliderKey = 'center' | 'repel' | 'linkForce' | 'linkDistance';

interface SliderSpec {
  key: SliderKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  /** Log-scale sliders feel even across values that span orders of magnitude. */
  log: boolean;
  format: (v: number) => string;
}

const SLIDERS: SliderSpec[] = [
  { key: 'center', label: 'Center force', hint: 'Pull everything toward the middle', min: 0, max: 0.3, log: false, format: (v) => v.toFixed(2) },
  { key: 'repel', label: 'Repel force', hint: 'Push nodes apart', min: 5, max: 2000, log: true, format: (v) => v.toFixed(0) },
  { key: 'linkForce', label: 'Link force', hint: 'How tightly connections pull together', min: 0, max: 2, log: false, format: (v) => v.toFixed(2) },
  { key: 'linkDistance', label: 'Link distance', hint: 'Preferred length of a connection', min: 10, max: 400, log: true, format: (v) => v.toFixed(0) },
];

/**
 * Builds the menu into `root`. `onChange` fires on every tweak (forces update live);
 * `onRerun` shakes the layout up even if nothing changed.
 */
export function mountLayoutControls(root: HTMLElement, prefs: LayoutPrefs, onChange: () => void, onRerun: () => void) {
  const toPos = (s: SliderSpec, v: number) =>
    s.log ? (Math.log(v) - Math.log(s.min)) / (Math.log(s.max) - Math.log(s.min)) : (v - s.min) / (s.max - s.min);
  const fromPos = (s: SliderSpec, p: number) =>
    s.log ? Math.exp(Math.log(s.min) + p * (Math.log(s.max) - Math.log(s.min))) : s.min + p * (s.max - s.min);

  const changed = () => {
    savePrefs(prefs);
    onChange();
  };

  const sliders = SLIDERS.map((s) => {
    const out = h('output', { class: 'val' }, s.format(prefs[s.key]));
    const input = h('input', {
      type: 'range',
      min: '0',
      max: '1000',
      step: '1',
      value: String(Math.round(toPos(s, prefs[s.key]) * 1000)),
      'aria-label': s.label,
      oninput: () => {
        prefs[s.key] = fromPos(s, Number(input.value) / 1000);
        out.textContent = s.format(prefs[s.key]);
        changed();
      },
    });
    return { s, input, out, row: h('label', { class: 'slider', title: s.hint }, h('span', { class: 'name' }, s.label), out, input) };
  });

  const overlap = h('input', {
    type: 'checkbox',
    checked: prefs.noOverlap,
    onchange: () => {
      prefs.noOverlap = overlap.checked;
      changed();
    },
  });

  const pauseBtn = h('button', { type: 'button' }, prefs.paused ? 'Resume' : 'Freeze');
  pauseBtn.addEventListener('click', () => {
    prefs.paused = !prefs.paused;
    pauseBtn.textContent = prefs.paused ? 'Resume' : 'Freeze';
    onChange();
  });

  const rerunBtn = h('button', { type: 'button', onclick: onRerun }, 'Shake it up');

  const resetBtn = h(
    'button',
    {
      type: 'button',
      class: 'linklike',
      onclick: () => {
        Object.assign(prefs, { ...DEFAULT_PREFS, paused: prefs.paused });
        for (const { s, input, out } of sliders) {
          input.value = String(Math.round(toPos(s, prefs[s.key]) * 1000));
          out.textContent = s.format(prefs[s.key]);
        }
        overlap.checked = prefs.noOverlap;
        changed();
      },
    },
    'Reset to defaults',
  );

  root.replaceChildren(
    ...sliders.map((x) => x.row),
    h('label', { class: 'toggle', title: 'Nodes never sit on top of each other' }, overlap, 'No overlap'),
    h('div', { class: 'layout-buttons' }, pauseBtn, rerunBtn),
    resetBtn,
    h('p', { class: 'muted hint' }, 'Tip: drag any node to move it. The map settles and stops on its own.'),
  );
}
