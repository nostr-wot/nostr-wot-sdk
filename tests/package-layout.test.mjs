import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const pkg = name => JSON.parse(fs.readFileSync(`packages/${name}/package.json`, 'utf8'));
const moves = { relay:['sdk','relay'], data:['sdk','data'], signers:['sdk','signers'], blossom:['sdk','blossom'], storage:['sdk','storage'], accounts:['identity','accounts'], vault:['identity','vault'], permissions:['identity','permissions'], 'signer-core':['identity','signing'], bunker:['identity','bunker'], graph:['wot','graph'] };
test('retired packages are forwarders to maintained owners with a migration notice', () => {
  for (const [old, [owner, sub]] of Object.entries(moves)) {
    assert.ok(pkg(old).deprecated, old);
    const target = `${pkg(owner).name}/${sub}`;
    assert.equal(fs.readFileSync(`packages/${old}/src/index.ts`,'utf8').trim(), `export * from '${target}';`);
    assert.ok(pkg(owner).exports[`./${sub}`], target);
  }
});
test('maintained packages never depend on retired packages and hard dependencies are acyclic', () => {
 const names=['sdk','identity','dm','wallet','auth','ui','pq','wot'];
 const manifests=names.map(pkg); const retired=new Set(Object.keys(moves).map(n=>pkg(n).name));
 for(const m of manifests) for(const key of ['dependencies','peerDependencies']) for(const d of Object.keys(m[key]||{})) assert.ok(!retired.has(d),`${m.name} -> ${d}`);
 const map=new Map(manifests.map(m=>[m.name,m]));
 function visit(name,path=[]) { assert.ok(!path.includes(name),[...path,name].join(' -> ')); for(const d of Object.keys(map.get(name)?.dependencies||{})) if(map.has(d)) visit(d,[...path,name]); }
 for(const m of manifests) visit(m.name);
});
test('legacy graph installs its relay runtime rather than relying on an optional peer', () => {
 assert.equal(pkg('graph').dependencies['nostr-wot-sdk'], `^${pkg('sdk').version}`);
});
test('workspace source aliases point to real public entrypoints', () => {
 const config=JSON.parse(fs.readFileSync('tsconfig.workspace.json','utf8'));
 for(const [name, paths] of Object.entries(config.compilerOptions.paths)) assert.ok(fs.existsSync(paths[0]),name);
});
