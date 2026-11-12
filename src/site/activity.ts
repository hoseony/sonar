// The "Searching…" pill under the top bar. Several things can be busy at once; the most
// specific one wins (member lookups > loading an artist > typing a search).
type Key = 'deep' | 'load' | 'search';
const ORDER: Key[] = ['deep', 'load', 'search'];

interface Entry {
  text: string;
  action?: { label: string; onClick: () => void };
  /** 0–1 when the task has a known length */
  fraction?: number;
  count?: string;
}

const entries = new Map<Key, Entry>();

function el() {
  return document.getElementById('activity') as HTMLDivElement;
}

function render() {
  const root = el();
  const key = ORDER.find((k) => entries.has(k));
  if (!key) {
    root.classList.remove('show');
    return;
  }
  const e = entries.get(key)!;
  root.querySelector('.text')!.textContent = e.text;
  root.querySelector('.count')!.textContent = e.count ?? '';
  const bar = root.querySelector('.bar') as HTMLElement;
  bar.style.transform = `scaleX(${e.fraction ?? 0})`;
  root.classList.toggle('determinate', e.fraction !== undefined);
  root.classList.toggle('idle', !!e.action); // no spinner when it's waiting on you
  const btn = root.querySelector('.action') as HTMLButtonElement;
  btn.hidden = !e.action;
  btn.textContent = e.action?.label ?? '';
  btn.onclick = e.action ? () => e.action!.onClick() : null;
  root.classList.add('show');
}

export const activity = {
  set(key: Key, text: string, fraction?: number, count?: string, action?: Entry['action']) {
    entries.set(key, { text, fraction, count, action });
    render();
  },
  clear(key: Key) {
    if (entries.delete(key)) render();
  },
  clearAll() {
    entries.clear();
    render();
  },
};
