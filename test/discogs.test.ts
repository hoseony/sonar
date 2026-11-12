import { describe, expect, it } from 'vitest';
import { isMusicalRole, releasePairs } from '../scripts/discogs.ts';

const artist = (id: number, name: string, role = '') =>
  `<artist><id>${id}</id><name>${name}</name><anv></anv><join></join><role>${role}</role><tracks></tracks></artist>`;

// Shaped like a Discogs releases dump record (Ryuichi Sakamoto + Taylor Deupree, guest vocal on one track).
const release = `<release id="4700000" status="Accepted">
<artists>${artist(1, 'Ryuichi Sakamoto')}${artist(2, 'Taylor Deupree')}</artists>
<title>Disappearance</title>
<extraartists>${artist(3, 'Mastering Person', 'Mastered By')}${artist(4, 'Designer', 'Design')}${artist(5, 'Cellist', 'Cello')}</extraartists>
<released>2013-04-01</released>
<master_id is_main_release="true">555</master_id>
<tracklist><track><position>1</position><title>Song</title><extraartists>${artist(6, 'Ichiko Aoba', 'Vocals [Featuring]')}</extraartists></track></tracklist>
</release>`;

describe('Discogs credits', () => {
  it('keeps musical roles and drops studio, business and design credits', () => {
    for (const r of ['Vocals', 'Featuring', 'Guitar, Bass', 'Arranged By', 'Producer', 'Written-By', 'Lyrics By', 'Remix', 'Cello [Solo]'])
      expect(isMusicalRole(r), r).toBe(true);
    for (const r of ['Mastered By', 'Mixed By', 'Recorded By', 'Design', 'Photography By', 'A&R', 'Executive-Producer', 'Liner Notes', 'Lacquer Cut By'])
      expect(isMusicalRole(r), r).toBe(false);
  });

  it('connects the main artists with each other and with everyone who played on it', () => {
    const r = releasePairs(release)!;
    const set = new Set(r.pairs.map(([a, b]) => [a, b].sort().join('-')));
    expect(set.has('1-2')).toBe(true); // Sakamoto × Deupree
    expect(set.has('1-6') && set.has('2-6')).toBe(true); // both × Ichiko Aoba (track credit)
    expect(set.has('1-5')).toBe(true); // × cellist
    expect([...set].some((p) => p.includes('3') || p.includes('4'))).toBe(false); // mastering, design
    expect(r.title).toBe('Disappearance');
    expect(r.year).toBe('2013');
    expect(r.master).toBe('555');
  });

  it('skips compilations and ignores placeholder artists', () => {
    const comp = `<release id="9"><artists>${artist(194, 'Various')}</artists><title>Hits</title><tracklist>${[10, 11, 12, 13, 14]
      .map((i) => `<track><artists>${artist(i, `A${i}`)}</artists></track>`)
      .join('')}</tracklist></release>`;
    expect(releasePairs(comp)).toBeNull();
  });
});
