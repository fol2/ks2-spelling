import { readFile, writeFile } from 'node:fs/promises';

const PRODUCT_PATH = 'src/app/ProductApp.jsx';
const STYLES_PATH = 'src/app/app.css';

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Trail patch anchor missing: ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Trail patch anchor repeated: ${label}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function removeRange(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Trail range start missing: ${label}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Trail range end missing: ${label}`);
  return `${source.slice(0, start)}${source.slice(end)}`;
}

let product = await readFile(PRODUCT_PATH, 'utf8');
product = replaceOnce(
  product,
  "import { buildCodex, setupExpeditionCompanion, trailMeadowCompanions } from './codex-model.js';\n",
  "import { buildCodex, setupExpeditionCompanion, trailMeadowCompanions } from './codex-model.js';\n"
    + "import { TrailMeadow } from './trail/TrailMeadow.jsx';\n",
  'TrailMeadow import',
);
product = removeRange(
  product,
  '// Four painted positions on the downs, nearest and largest first so a single\n',
  'function TrailScreen({',
  'legacy meadow slots and component',
);
product = replaceOnce(
  product,
  `  const [poked, setPoked] = useState(null);\n  const codex = useMemo(\n    () => buildCodex(learningState.monsters),\n    [learningState.monsters],\n  );\n\n  useEffect(() => {\n    if (!poked) return undefined;\n    const timer = setTimeout(() => setPoked(null), 2600);\n    return () => clearTimeout(timer);\n  }, [poked]);\n`,
  `  const codex = useMemo(\n    () => buildCodex(learningState.monsters),\n    [learningState.monsters],\n  );\n`,
  'legacy Trail poke state',
);
product = replaceOnce(
  product,
  `        plate={regionArt(REGION, 'a1')}\n        veil={[\n          'radial-gradient(110% 58% at 66% 30%,rgba(8,12,18,.02),rgba(8,12,18,.54) 58%,rgba(8,12,18,.92))',\n          'linear-gradient(180deg,rgba(8,12,18,.68) 0%,rgba(8,12,18,.1) 16%,rgba(8,12,18,.22) 44%,rgba(8,12,18,.62) 74%,rgba(8,12,18,.92) 100%)',\n        ].join(',')}\n`,
  `        plate={regionArt(REGION, 'a1')}\n        plateY="58%"\n        plateOpacity={0.96}\n        veil={[\n          'radial-gradient(118% 70% at 50% 48%,rgba(8,12,18,0) 18%,rgba(8,12,18,.34) 66%,rgba(8,12,18,.82))',\n          'linear-gradient(180deg,rgba(8,12,18,.52) 0%,rgba(8,12,18,.06) 24%,rgba(8,12,18,.16) 56%,rgba(8,12,18,.76) 100%)',\n        ].join(',')}\n`,
  'Trail region crop and veil',
);
const trailFunction = product.indexOf('function TrailScreen({');
const meadowStart = product.indexOf('          <div className="meadow">', trailFunction);
const audioStart = product.indexOf("\n\n          {audioState.status !== 'ready'", meadowStart);
if (meadowStart < 0 || audioStart < 0) {
  throw new Error('Trail meadow JSX anchors are missing.');
}
product = `${product.slice(0, meadowStart)}          <TrailMeadow\n`
  + '            companions={trailMeadowCompanions(codex.roster)}\n'
  + '            seed={`${learningState.learnerId}:${profile.yearGroup}`}\n'
  + '          />'
  + product.slice(audioStart);
await writeFile(PRODUCT_PATH, product);

let styles = await readFile(STYLES_PATH, 'utf8');
styles = removeRange(
  styles,
  '\n.meadow {\n',
  '\n.trail-due {\n',
  'legacy meadow presentation',
);
styles = removeRange(
  styles,
  '\n@keyframes roamG {\n',
  '\n/* --- accessibility',
  'legacy generic meadow motion',
);
styles = replaceOnce(
  styles,
  '  .quest-tile-sheen,\n  .meadow-halo,\n  .results-halo::before {\n',
  '  .quest-tile-sheen,\n  .results-halo::before {\n',
  'forced-colours legacy meadow selector',
);
await writeFile(STYLES_PATH, styles);
