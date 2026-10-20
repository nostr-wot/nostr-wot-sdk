// Dry-run by default. Apply registry notices only after every replacement is public.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const moves = JSON.parse(readFileSync(resolve(root, 'scripts/package-moves.json'), 'utf8'));
const apply = process.argv.includes('--apply');
const commands = Object.entries(moves).map(([dir, move]) => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'packages', dir, 'package.json'), 'utf8'));
  return {pkg, move};
});
// Validate the entire set before changing even one registry entry.
if (apply) for (const {move} of commands) {
  const published = JSON.parse(execFileSync('npm', ['view', `${move.package}@${move.replacementVersion}`, 'version', '--json', '--registry=https://registry.npmjs.org/'], {encoding:'utf8'}));
  if (published !== move.replacementVersion) throw new Error(`Replacement is not published: ${move.package}@${move.replacementVersion}`);
}
for (const {pkg} of commands) {
  const args = ['deprecate', `${pkg.name}@*`, pkg.deprecated, '--registry=https://registry.npmjs.org/'];
  if (apply) execFileSync('npm', args, {stdio:'inherit'});
  else console.log(JSON.stringify({command:'npm',args}));
}
