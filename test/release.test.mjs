import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {auditBundle,releaseBytes,buildRelease} from '../scripts/package.mjs';
const source=fileURLToPath(new URL('../',import.meta.url));
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-release-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function run(bin,args,cwd,env={}){const r=spawnSync(bin,args,{cwd,encoding:'utf8',env:{...process.env,...env},timeout:15000});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;}
test('canonical distribution is reproducible and audited without tests, state or dependencies',t=>{
 const root=temp(t);const a=releaseBytes(source),b=releaseBytes(source);assert.equal(a.sha256,b.sha256);assert.ok(a.bytes.equals(b.bytes));assert.equal(a.manifest.npmPublication,false);assert.equal(a.manifest.license,'Apache-2.0');assert.ok(a.manifest.files.LICENSE);assert.ok(a.manifest.files['skills/runtime.md']);assert.ok(Object.keys(a.manifest.files).every(f=>!f.startsWith('docs/')));
 assert.ok(Object.keys(a.manifest.files).every(f=>!f.startsWith('test/')&&!f.includes('node_modules')));
 const built=buildRelease(source,root);assert.equal(buildRelease(source,root).sha256,built.sha256);fs.writeFileSync(built.artifact,'unowned');assert.throws(()=>buildRelease(source,root),/Refusing/);
});
test('distribution audit rejects unexpected files, private machine paths, credentials and symlinks',t=>{
 const root=temp(t);const manifest=auditBundle(source);for(const name of Object.keys(manifest.files)){const target=path.join(root,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(source,name),target);}
 const file=path.join(root,'src','audit-fixture.mjs');
 for(const text of ['-----BEGIN PRIVATE KEY-----','/Users/example/private/file']){fs.writeFileSync(file,text);assert.throws(()=>auditBundle(root),/credential|Personal machine/);}
 fs.unlinkSync(file);fs.writeFileSync(path.join(root,'src','.env'),'SECRET');assert.throws(()=>auditBundle(root),/Unexpected/);fs.unlinkSync(path.join(root,'src','.env'));
 fs.symlinkSync('/no/such/file',file);assert.throws(()=>auditBundle(root),/symlink/);
});
test('extracted archive installs outside checkout and performs both review workflows',t=>{
 const root=temp(t),out=path.join(root,'artifacts'),extracted=path.join(root,'extracted');fs.mkdirSync(extracted);const release=buildRelease(source,out);run('tar',['-xf',release.artifact,'-C',extracted],root);
 const manifest=JSON.parse(fs.readFileSync(path.join(extracted,'release-manifest.json'),'utf8'));assert.equal(manifest.version,JSON.parse(fs.readFileSync(path.join(source,'package.json'))).version);
 const codex=path.join(root,'codex');run(process.execPath,[path.join(extracted,'scripts','install.mjs'),'install','--codex-home',codex],root);
 const cli=path.join(codex,'claude-plugin-codex','current','bin','claude-companion.mjs'),cwd=path.join(root,'target');fs.mkdirSync(cwd);run('git',['init','-b','main'],cwd);fs.writeFileSync(path.join(cwd,'change.txt'),'review fixture\n');
 const state=path.join(root,'history'),env={CLAUDE_CODE_BINARY:path.join(source,'test','fake-claude.fixture.mjs')};
 for(const kind of ['review','adversarial-review']){const report=JSON.parse(run(process.execPath,[cli,kind,'--cwd',cwd,'--state-dir',state,'--prompt','Inspect changes'],root,env));assert.equal(report.status,'completed');assert.equal(report.report.version,1);assert.equal(report.reviewContext.scope,'working-tree');assert.equal(report.report.task.independentlyVerified,false);}
 assert.equal(fs.readFileSync(path.join(cwd,'change.txt'),'utf8'),'review fixture\n');
 run(process.execPath,[path.join(extracted,'scripts','install.mjs'),'uninstall','--codex-home',codex],root);assert.ok(fs.readdirSync(state).length>0);
});
