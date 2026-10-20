// Workspace source aliases let declaration builds resolve optional compatibility entrypoints
// without requiring a previous dist/ or creating a dependency cycle between packages.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const dirs = readdirSync(resolve(root, 'packages'));
const order = ['pq','wot','sdk','identity','dm','wallet','auth','ui', ...dirs.filter(dir => !['pq','wot','sdk','identity','dm','wallet','auth','ui'].includes(dir))];
for (const dir of order) execFileSync('npm', ['run','build','--workspace',`packages/${dir}`], {cwd:root,stdio:'inherit'});
