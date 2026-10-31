import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectReview, REVIEW_LIMIT } from '../src/review.mjs';
import { validateReview } from '../src/contracts.mjs';
import { delegate } from '../src/runtime.mjs';
const fixture = fileURLToPath(new URL('./fake-claude.fixture.mjs', import.meta.url));
function context(t) {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-review-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
 const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd);
 const git = (...args) => { const p = spawnSync('git', ['-c','core.hooksPath=/dev/null',...args], { cwd, encoding:'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_AUTHOR_NAME:'Fixture', GIT_AUTHOR_EMAIL:'fixture@example.invalid', GIT_COMMITTER_NAME:'Fixture', GIT_COMMITTER_EMAIL:'fixture@example.invalid' } }); assert.equal(p.status,0,p.stderr); return p.stdout.trim(); };
 git('init','-b','main'); fs.writeFileSync(path.join(cwd,'a.txt'),'original\n'); git('add','.'); git('commit','-m','fixture');
 return { cwd, root, git, stateDir:path.join(root,'state'), binary:fixture, kind:'review',prompt:'Inspect changes',timeoutMs:3000 };
}
test('auto review includes staged, unstaged, untracked and unusual paths from nested cwd', t => {
 const o=context(t); fs.writeFileSync(path.join(o.cwd,'a.txt'),'staged\n');o.git('add','.'); fs.writeFileSync(path.join(o.cwd,'a.txt'),'unstaged\n');
 const name='odd\tline\n"--file.txt';fs.writeFileSync(path.join(o.cwd,name),'untracked evidence');fs.mkdirSync(path.join(o.cwd,'nested'));
 const r=collectReview(path.join(o.cwd,'nested'));
 assert.equal(r.metadata.scope,'working-tree'); assert.ok(r.metadata.files.includes(name));
 for(const marker of ['staged','unstaged','untracked evidence'])assert.ok(r.text.includes(marker));
 assert.equal(fs.readFileSync(path.join(o.cwd,'a.txt'),'utf8'),'unstaged\n');
});
test('untracked-only and unborn workspaces are reviewed; external diff programs are disabled', t => {
 const o=context(t);o.git('config','diff.external','false');fs.writeFileSync(path.join(o.cwd,'only.txt'),'new');
 assert.equal(collectReview(o.cwd).metadata.scope,'working-tree');
 fs.writeFileSync(path.join(o.cwd,'a.txt'),'changed');assert.ok(collectReview(o.cwd).text.includes('changed'));
 const unborn=path.join(o.root,'unborn');fs.mkdirSync(unborn);spawnSync('git',['init','-b','main',unborn]);fs.writeFileSync(path.join(unborn,'new'),'unborn');
 assert.ok(collectReview(unborn).metadata.files.includes('new'));
});
test('branch review uses merge base and explicitly excludes dirty changes', t => {
 const o=context(t);o.git('switch','-c','feature');fs.writeFileSync(path.join(o.cwd,'feature'),'feature change');o.git('add','.');o.git('commit','-m','feature');
 const original=o.git('merge-base','main','HEAD');o.git('switch','main');fs.writeFileSync(path.join(o.cwd,'main-only'),'base advance');o.git('add','.');o.git('commit','-m','advance');o.git('switch','feature');
 const r=collectReview(o.cwd,{scope:'branch',base:'main'});assert.equal(r.metadata.mergeBase,original);assert.ok(r.text.includes('feature change'));assert.ok(!r.metadata.files.includes('main-only'));
 assert.equal(collectReview(o.cwd).metadata.scope,'branch');fs.writeFileSync(path.join(o.cwd,'dirty'),'excluded');
 const dirty=collectReview(o.cwd,{base:'main'});assert.equal(dirty.metadata.scope,'branch');assert.equal(dirty.metadata.warnings.length,1);assert.ok(!dirty.metadata.files.includes('dirty'));
});
test('symlinks and binary files are explicit limitations; oversized context never silently truncates', t => {
 const o=context(t);const outside=path.join(o.root,'outside');fs.writeFileSync(outside,'SECRET_OUTSIDE');fs.symlinkSync(outside,path.join(o.cwd,'link'));
 fs.writeFileSync(path.join(o.cwd,'binary'),Buffer.from([0,1,2]));let r=collectReview(o.cwd);assert.ok(!r.text.includes('SECRET_OUTSIDE'));assert.equal(r.metadata.warnings.length,2);
 fs.writeFileSync(path.join(o.cwd,'huge'),'x'.repeat(REVIEW_LIMIT+1));assert.throws(()=>collectReview(o.cwd),/size limit/);
});
test('invalid scope/base fail; non-Git auto remains an explicitly manual review', t => {
 const o=context(t);assert.throws(()=>collectReview(o.cwd,{base:'--help'}),/Invalid/);assert.throws(()=>collectReview(o.cwd,{base:'missing'}),/Cannot resolve/);
 assert.throws(()=>collectReview(o.cwd,{scope:'oops'}),/scope/);assert.throws(()=>collectReview(o.cwd,{scope:'working-tree',base:'main'}),/cannot/);
 assert.equal(collectReview(o.root).metadata.scope,'manual');assert.throws(()=>collectReview(o.root,{scope:'branch'}),/Git workspace/);
});
test('review schemas reject malformed findings and references outside changes', () => {
 const valid={summary:'Review',completion:'completed',uncertainties:[],findings:[{severity:'high',file:'a.txt',line:1,title:'Issue',body:'Evidence'}]};
 assert.equal(validateReview(valid,{scope:'working-tree',files:['a.txt']}),valid);
 for(const change of [{line:0},{severity:'invalid'},{file:'../outside'},{file:'unreviewed'}]) assert.throws(()=>validateReview({...valid,findings:[{...valid.findings[0],...change}]},{scope:'working-tree',files:['a.txt']}),/Invalid/);
 assert.throws(()=>validateReview({summary:'missing fields'}),/Invalid/);
});
test('both review workflows enforce schema and preserve workspace bytes', async t => {
 const o=context(t);fs.writeFileSync(path.join(o.cwd,'a.txt'),'review me\n');
 for(const kind of ['review','adversarial-review']) {
  const result=await delegate({...o,kind,prompt:undefined});assert.equal(result.status,'completed');assert.equal(result.reviewContext.scope,'working-tree');assert.deepEqual(result.review.findings,[]);
  assert.equal(fs.readFileSync(path.join(o.cwd,'a.txt'),'utf8'),'review me\n');
 }
 const invalid=await delegate({...o,prompt:'BAD_SCHEMA'});assert.equal(invalid.status,'failed');assert.match(invalid.error,/Invalid structured/);
});

test('tracked binary changes report incomplete review coverage',async t=>{
 const o=context(t);fs.writeFileSync(path.join(o.cwd,'binary'),Buffer.from([0,1,2]));o.git('add','.');o.git('commit','-m','binary fixture');fs.writeFileSync(path.join(o.cwd,'binary'),Buffer.from([0,3,4]));
 const reviewContext=collectReview(o.cwd);assert.ok(reviewContext.metadata.warnings.some(w=>w.includes('Tracked binary')));
 const result=await delegate(o);assert.equal(result.status,'incomplete');assert.equal(result.report.task.independentlyVerified,false);
});
