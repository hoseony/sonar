// Tiny DOM helper: h('div', { class: 'x', onclick }, child, 'text')
type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2), v as EventListener);
    } else if (k in el && k !== 'list') {
      (el as unknown as Record<string, unknown>)[k] = v;
    } else {
      el.setAttribute(k === 'className' ? 'class' : k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** "1966–1967", "1966–", or "" */
export function years(begin?: string, end?: string): string {
  const b = begin?.slice(0, 4);
  const e = end?.slice(0, 4);
  if (!b && !e) return '';
  if (b && e && b === e) return b;
  return `${b ?? '?'}–${e ?? ''}`;
}
