/* Dev-only config for the design harness under `design/`.
 *
 * The product entry needs a native platform (SQLite, StoreKit, the audio
 * pack), so `vite serve` on `index.html` can only ever render the B2 proof
 * shell. This config serves `design/index.html` instead, which mounts the real
 * screens over in-memory services, and rewrites the art path that only exists
 * under `dist/` in a production build.
 *
 * Nothing here reaches a shipped bundle: `vite build` still uses
 * `vite.config.js`, whose single entry is `index.html`.
 */
import base from './vite.config.js';

const ART_PREFIX = '/mastery-art/';

export default function designConfig(env) {
  const resolved = typeof base === 'function' ? base(env) : base;
  return {
    ...resolved,
    plugins: [
      ...resolved.plugins,
      {
        name: 'design-harness-art',
        configureServer(server) {
          server.middlewares.use((request, _response, next) => {
            if (request.url?.startsWith(ART_PREFIX)) {
              request.url = `/content${request.url}`;
            }
            next();
          });
        },
      },
    ],
  };
}
