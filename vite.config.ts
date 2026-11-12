import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { handleApi, handleExport } from './server/api.ts';
import { setContact } from './server/mb.ts';

/** Dev-only: mounts the review API and a live graph export. Not part of the built site. */
function reviewApi(contact: string | undefined): Plugin {
  return {
    name: 'sonar-review-api',
    apply: 'serve',
    configureServer(server) {
      setContact(contact);
      if (!contact && !process.env.VITEST) {
        server.config.logger.warn(
          'MB_CONTACT is not set. Add MB_CONTACT=<your email or project URL> to .env.local so MusicBrainz can reach you.',
        );
      }
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        if (path === '/graph.export.json') return void handleExport(req, res);
        if (path?.startsWith('/api/')) return void handleApi(req, res, next);
        next();
      });
    },
  };
}

/**
 * Works around a sigma 4 limitation: label text is drawn from a glyph atlas, but only the atlas's
 * FIRST texture is ever uploaded ("Currently only support single atlas texture"). With the default
 * 64 px × devicePixelRatio glyphs in a 2048 px texture, only ~180 distinct characters fit on a
 * Retina screen, so maps with many Japanese/Korean names overflowed into a second texture and
 * labels showed fragments of other glyphs (e.g. 佐々木宏人 → "佐h,木-ヨ人").
 *
 * This patches two numbers in sigma's build: a 4096 px texture and fixed 40 px glyphs (distance-
 * field text scales cleanly, so labels stay sharp). Capacity: ~5,000 distinct characters.
 * Applies to dev and production builds alike. Re-check after upgrading sigma.
 */
function sigmaGlyphAtlas(): Plugin {
  return {
    name: 'sonar-sigma-glyph-atlas',
    enforce: 'pre',
    transform(code, id) {
      // In dev, ids carry a version query (…/factory-xxxx.esm.js?v=abc), so match on the path part.
      const file = id.split('?')[0];
      if (!/[\\/]sigma[\\/]dist[\\/].*\.js$/.test(file) || !code.includes('DEFAULT_SDF_ATLAS_OPTIONS')) return null;
      let out = code;
      out = out.replace(/(DEFAULT_SDF_ATLAS_OPTIONS = \{[^}]*?fontSize:\s*)64/, '$140');
      out = out.replace(/(DEFAULT_SDF_ATLAS_OPTIONS = \{[^}]*?maxTextureSize:\s*)2048/, '$14096');
      out = out.replace('DEFAULT_SDF_ATLAS_OPTIONS.fontSize * getPixelRatio()', 'DEFAULT_SDF_ATLAS_OPTIONS.fontSize');
      return out === code ? null : { code: out, map: null };
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    // GitHub Pages serves project sites under /<repo>/; the deploy workflow sets BASE_PATH.
    base: process.env.BASE_PATH ?? '/',
    plugins: [sigmaGlyphAtlas(), reviewApi(env.MB_CONTACT)],
    optimizeDeps: {
      // sigma is served as-is in dev so the glyph-atlas patch above applies to it; its two small
      // CommonJS helpers still get pre-bundled.
      exclude: ['sigma', '@sigma/node-border'],
      include: ['sigma > events', 'sigma > graphology-utils/is-graph'],
    },
    build: {
      // Only the public explorer is built; the review page stays local.
      rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html') } },
    },
  };
});
