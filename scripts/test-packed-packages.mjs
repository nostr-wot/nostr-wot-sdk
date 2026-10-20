// Verify the distribution a consumer installs, with no workspace source aliases.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const root=resolve(import.meta.dirname,'..');
const fixture=mkdtempSync(join(tmpdir(),'nostr-wot-packages-'));
const npm=(args,cwd=root)=>execFileSync('npm',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],maxBuffer:16*1024*1024});
try {
 const workspaces=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).workspaces;
 const packages=workspaces.map(dir=>({dir,manifest:JSON.parse(readFileSync(join(root,dir,'package.json'),'utf8'))}));
 const tarballs=join(fixture,'tarballs');mkdirSync(tarballs);
 for(const item of packages){const result=JSON.parse(npm(['pack','--json','--pack-destination',tarballs],join(root,item.dir)))[0];item.tarball=join(tarballs,result.filename);}
 const consumer=join(fixture,'consumer');mkdirSync(consumer);
 writeFileSync(join(consumer,'package.json'),JSON.stringify({name:'packed-consumer',private:true,type:'module',dependencies:Object.fromEntries(packages.map(p=>[p.manifest.name,`file:${p.tarball}`]))}));
 npm(['install','--ignore-scripts','--no-audit','--no-fund'],consumer);
 const pairs=[];
 const moves=JSON.parse(readFileSync(join(root,'scripts/package-moves.json'),'utf8'));
 for(const [old,move] of Object.entries(moves)){
  const p=packages.find(p=>p.dir===`packages/${old}`);
  for(const [sub,conditions] of Object.entries(p.manifest.exports)) pairs.push([p.manifest.name+(sub==='.'?'':sub.slice(1)),move.package+'/'+move.subpath+(sub==='.'?'':sub.slice(1)),Boolean(conditions.require)]);
 }
 writeFileSync(join(consumer,'check.mjs'),`import assert from 'node:assert/strict';\nimport {createRequire} from 'node:module';\nconst require=createRequire(import.meta.url);\nfor(const [old,next,cjs] of ${JSON.stringify(pairs)}){const a=await import(old),b=await import(next);assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort(),old);for(const key of Object.keys(a))assert.equal(a[key],b[key],old+': '+key);if(cjs){const a=require(old),b=require(next);for(const key of Object.keys(a))assert.equal(a[key],b[key],old+' CJS: '+key);}}\nconsole.log('Packed legacy/new exports and runtime identity match.');\n`);
 console.log(execFileSync(process.execPath,['check.mjs'],{cwd:consumer,encoding:'utf8'}));
 const typedPairs=pairs.map(([old,next],i)=>`import * as old${i} from '${old}';\nimport * as next${i} from '${next}';\nconst compatible${i}: typeof next${i} = old${i};\nvoid compatible${i};`).join('\n');
 writeFileSync(join(consumer,'check.ts'),typedPairs);
 execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--noEmit','--module','NodeNext','--moduleResolution','NodeNext','--target','ES2022','--lib','ES2022,DOM','--skipLibCheck','check.ts'],{cwd:consumer,stdio:'pipe'});
 console.log('Installed legacy and replacement TypeScript entrypoints are compatible.');
 const minimal=join(fixture,'minimal');mkdirSync(minimal);
 writeFileSync(join(minimal,'package.json'),JSON.stringify({name:'minimal-consumer',private:true,type:'module',dependencies:Object.fromEntries(packages.filter(p=>['nostr-wot-sdk','@nostr-wot/pq','@nostr-wot/wot'].includes(p.manifest.name)).map(p=>[p.manifest.name,`file:${p.tarball}`]))}));
 npm(['install','--ignore-scripts','--omit=optional','--no-audit','--no-fund'],minimal);
 writeFileSync(join(minimal,'check.mjs'),`import {createRequire} from 'node:module';import assert from 'node:assert/strict';const require=createRequire(import.meta.url);assert.throws(()=>require.resolve('react'));for(const path of ['nostr-wot-sdk','nostr-wot-sdk/relay','nostr-wot-sdk/data','nostr-wot-sdk/signers','nostr-wot-sdk/storage','nostr-wot-sdk/blossom'])await import(path);console.log('Core modules load without React, wallet, authentication or identity packages.');`);
 console.log(execFileSync(process.execPath,['check.mjs'],{cwd:minimal,encoding:'utf8'}));
} finally { rmSync(fixture,{recursive:true,force:true}); }
