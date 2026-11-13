// Site statistics with GoatCounter (https://www.goatcounter.com): no cookies, no personal data.
// The script tag in index.html counts page views; this counts what people do on the map, as events
// with readable names ("open: Ichiko Aoba", "connect: Ichiko Aoba → David Sylvian").
// GoatCounter ignores localhost, so local development isn't counted.

interface GoatCounter {
  count: (vars: { path: string; title?: string; event?: boolean }) => void;
}

const pending: string[] = [];
let waiting = false;

const counter = () => (window as unknown as { goatcounter?: Partial<GoatCounter> }).goatcounter;

function send(name: string) {
  try {
    counter()!.count!({ path: name, title: name, event: true });
  } catch {
    // Statistics must never break the site.
  }
}

/** Counts one event. Safe when the script is blocked (ad blockers) or still loading. */
export function track(name: string) {
  if (typeof counter()?.count === 'function') return send(name);
  // The script loads async: a shared link can open an artist before it's ready. Hold a few events
  // and retry for a few seconds; if it never arrives (blocked), they're dropped.
  if (pending.length < 20) pending.push(name);
  if (waiting) return;
  waiting = true;
  let tries = 0;
  const retry = () => {
    if (typeof counter()?.count === 'function') {
      waiting = false;
      for (const n of pending.splice(0)) send(n);
    } else if (++tries < 10) setTimeout(retry, 500);
    else {
      waiting = false;
      pending.length = 0;
    }
  };
  setTimeout(retry, 500);
}
