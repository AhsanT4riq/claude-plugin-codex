#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { bundleFiles } from './install.mjs';
const source = fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function auditBundle(root=source) {
 const files=bundleFiles(root), hashes={};
 for(const file of files) {
  const allowed=['README.md','LICENSE','package.json','package-lock.json','scripts/install.mjs','skills/runtime.md'].includes(file)||/^src\/[a-z-]+\.mjs$/.test(file)||/^bin\/[a-z-]+\.mjs$/.test(file)||/^skills\/claude-[a-z-]+\/(SKILL\.md|agents\/openai\.yaml)$/.test(file);
  if(!allowed)throw new Error(`Unexpected distribution file: ${file}`);
  const bytes=fs.readFileSync(path.join(root,file)),text=bytes.toString('utf8');
  if(/-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}/.test(text))throw new Error(`Potential credential in distribution: ${file}`);
  if(/\/Users\/[a-zA-Z0-9_-]+\/|\/Volumes\/|\/var\/folders\//.test(text))throw new Error(`Personal machine path in distribution: ${file}`);
  hashes[file]=hash(bytes);
 }
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 // The source is public on GitHub; npm publication stays off until separately decided.
 if(!pkg.private)throw new Error('package.json must stay private: npm publication has not been decided.');
 if(pkg.license!=='Apache-2.0')throw new Error('package.json must declare the Apache-2.0 license.');
 return {format:1,name:pkg.name,version:pkg.version,license:pkg.license||null,npmPublication:false,files:hashes};
}
function tarEntry(name,bytes) {
 const header=Buffer.alloc(512);
 if(Buffer.byteLength(name)>100)throw new Error(`Distribution path too long for canonical tar: ${name}`);
 const put=(value,offset,length)=>header.write(String(value),offset,length,'utf8');
 const oct=(value,offset,length)=>put(value.toString(8).padStart(length-1,'0')+'\0',offset,length);
 put(name,0,100);oct(name.startsWith('bin/')||name==='scripts/install.mjs'?0o755:0o644,100,8);oct(0,108,8);oct(0,116,8);oct(bytes.length,124,12);oct(0,136,12);
 header.fill(32,148,156);put('0',156,1);put('ustar\0',257,6);put('00',263,2);
 const checksum=header.reduce((sum,b)=>sum+b,0);put(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);
 return Buffer.concat([header,bytes,Buffer.alloc((512-bytes.length%512)%512)]);
}
export function releaseBytes(root=source) {
 const manifest=auditBundle(root);const contents=new Map(Object.keys(manifest.files).map(file=>{
  const bytes=fs.readFileSync(path.join(root,file));if(hash(bytes)!==manifest.files[file])throw new Error('Source changed while packaging; retry after edits finish.');return [file,bytes];
 }));
 contents.set('release-manifest.json',Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
 const bytes=Buffer.concat([...contents.keys()].sort().map(file=>tarEntry(file,contents.get(file))).concat([Buffer.alloc(1024)]));
 return {manifest,bytes,sha256:hash(bytes)};
}
export function buildRelease(root=source,outDir=path.join(source,'artifacts')) {
 const release=releaseBytes(root),name=`${release.manifest.name}-${release.manifest.version}.tar`;
 fs.mkdirSync(outDir,{recursive:true});const target=path.join(outDir,name),receipt=target+'.sha256';
 for(const [file,bytes]of [[target,release.bytes],[receipt,Buffer.from(release.sha256+'  '+name+'\n')]]) {
  if(fs.existsSync(file)){if(!fs.readFileSync(file).equals(bytes))throw new Error(`Refusing to replace a different release artifact: ${file}`);}
  else fs.writeFileSync(file,bytes,{flag:'wx'});
 }
 return {artifact:target,sha256:release.sha256,files:Object.keys(release.manifest.files).length,publicationAuthorized:false,licenseDecision:'pending'};
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=process.argv.slice(2);if(args.length>1)throw new Error('Usage: node scripts/package.mjs [OUTPUT_DIRECTORY]');console.log(JSON.stringify(buildRelease(source,args[0]?path.resolve(args[0]):undefined),null,2));}catch(e){console.error(JSON.stringify({error:e.message}));process.exitCode=1;}
}
