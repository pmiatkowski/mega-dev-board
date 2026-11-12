// R6 — name the build. Copies app/ to dist/ and stamps the git sha into
// <meta name="build"> and the footer's build-sha hook.
//
//   node scripts/stamp-build.mjs [sha]        # sha defaults to `git rev-parse HEAD`
//
// deploys/recordings always use a stamped dist/, never raw app/, so the page
// that ships names the commit it was built from.
import { cpSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sha = process.argv[2]
  ?? execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

if (!/^[0-9a-f]{7,40}$/.test(sha)) {
  console.error(`stamp-build: not a git sha: ${sha}`);
  process.exit(1);
}

const src = join(root, 'app');
const dist = join(root, 'dist');
cpSync(src, dist, { recursive: true });

const page = join(dist, 'index.html');
writeFileSync(page, readFileSync(page, 'utf8').replaceAll('@BUILD_SHA@', sha));
console.log(`stamped ${sha} into dist/index.html`);
