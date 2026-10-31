import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const MAX_FILES = 2000, MAX_FILE_BYTES = 1024 * 1024, MAX_TOTAL_BYTES = 16 * 1024 * 1024;
// Hashes, types and sizes only; never persist file contents in execution evidence.
export function snapshot(cwd) {
  const top=spawnSync('git',['rev-parse','--show-toplevel'],{cwd,encoding:'utf8',timeout:5000});
  if(top.status===0&&top.stdout.trim())cwd=fs.realpathSync(top.stdout.trim());
  const files = {}, warnings = []; let complete = true, total = 0;
  try {
    const git = spawnSync('git', ['-c','core.fsmonitor=false','ls-files','--cached','--others','--exclude-standard','-z'], { cwd, encoding:'utf8', timeout:5000,maxBuffer:1024*1024,env:{...process.env,GIT_OPTIONAL_LOCKS:'0'} });
    let names;
    if (git.status === 0 && !git.error) names = [...new Set(git.stdout.split('\0').filter(Boolean))];
    else {
      names = [];
      const walk = (dir, prefix='') => {
        for (const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
          if (['.git','.claude','node_modules'].includes(entry.name)) continue;
          if (names.length >= MAX_FILES) { complete=false; return; }
          const relative = prefix + entry.name;
          if (entry.isDirectory()) walk(path.join(dir,entry.name), relative+'/'); else names.push(relative);
        }
      };
      walk(cwd); warnings.push('Non-Git snapshot excludes .git, .claude and node_modules.');
    }
    if (names.length>MAX_FILES) { names=names.slice(0,MAX_FILES);complete=false; }
    for (const name of names) {
      const file = path.resolve(cwd,name);
      if (!file.startsWith(path.resolve(cwd)+path.sep)) { complete=false;continue; }
      // A path through a symlink directory may leave the workspace: never traverse it.
      const parts=name.split(path.sep);let parent=cwd,unsafe=false;
      for (const part of parts.slice(0,-1)) { parent=path.join(parent,part);try{if(fs.lstatSync(parent).isSymbolicLink()){unsafe=true;break;}}catch{unsafe=true;break;} }
      if (unsafe) {complete=false;continue;}
      let stat;try{stat=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')continue;throw e;}
      if(stat.isSymbolicLink())files[name]={type:'symlink',sha256:createHash('sha256').update(fs.readlinkSync(file)).digest('hex')};
      else if(stat.isFile()) {
        if(stat.size>MAX_FILE_BYTES||total+stat.size>MAX_TOTAL_BYTES){complete=false;files[name]={type:'file',size:stat.size,sha256:null};continue;}
        total+=stat.size;files[name]={type:'file',size:stat.size,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};
      } else {complete=false;}
    }
  }catch(e){complete=false;warnings.push(`Snapshot unavailable: ${e.code||'error'}`);}
  if(!complete)warnings.push('File evidence is partial: file count, size, traversal or read limit reached.');
  return {root:cwd,files,complete,warnings,coverage:'Git tracked and nonignored untracked files, or bounded non-Git workspace files; excludes file contents, modes and external effects.'};
}
export function startEvidence(cwd) {
  return { version:1, baseline:snapshot(cwd), actions:[], counts:{started:0,finished:0,failed:0,permissionDenied:0}, actionsTruncated:false, fileChanges:[], partial:true, attribution:'Observed during the job; concurrent external changes cannot be attributed to Claude.' };
}
export function observe(evidence,event) {
  if(!evidence)return;
  if(event.type==='tool_started') {
    evidence.counts.started++;
    const action={id:event.toolUseId,tool:event.tool,path:event.path||null,command:event.command||null,outcome:'pending'};
    if(evidence.actions.length>=512){evidence.actions.shift();evidence.actionsTruncated=true;}
    if(event.commandTruncated)action.commandTruncated=true;
    if(event.pathTruncated)action.pathTruncated=true;
    evidence.actions.push(action);
  }else if(event.type==='tool_finished') {
    evidence.counts.finished++;if(event.failed)evidence.counts.failed++;
    const action=evidence.actions.find(a=>a.id===event.toolUseId);
    if(action){action.outcome=event.failed?'tool_reported_error':'tool_reported_success';action.exitCode=event.exitCode??null;}
  }else if(event.type==='permission_denied')evidence.counts.permissionDenied++;
}
export function finishEvidence(job,cwd) {
  if(!job.evidence?.baseline)return;
  const before=job.evidence.baseline,after=snapshot(cwd),changes=[];
  for(const name of new Set([...Object.keys(before.files),...Object.keys(after.files)])) {
    const a=before.files[name],b=after.files[name];
    if(!a&&before.complete&&b?.sha256)changes.push({file:name,change:'added',after:b.sha256});
    else if(!b&&after.complete&&a?.sha256)changes.push({file:name,change:'deleted',before:a.sha256});
    else if(a?.sha256&&b?.sha256&&(a.sha256!==b.sha256||a.type!==b.type))changes.push({file:name,change:'modified',before:a.sha256,after:b.sha256});
  }
  job.evidence.fileChanges=changes;job.evidence.partial=!before.complete||!after.complete||job.status!=='completed';
  job.evidence.warnings=[...new Set([...before.warnings,...after.warnings])];job.evidence.coverage=after.coverage; job.evidence.root=after.root;
  delete job.evidence.baseline;
}
export function resultContract(job) {
  const claimed=job.contractValid ? job.structuredOutput : null;
  return {
    version:1, selection:{model:job.model??null,actualModels:job.models||[],effort:job.effort??null,access:job.access??(typeof job.write==='boolean'?(job.allowBash?'shell':job.write?'edit':'read-only'):null),approvalMode:job.approvalMode??null}, process:{success:job.processSuccess??null,exitCode:job.exitCode??null,status:job.status},
    task:{claimedCompletion:claimed?.completion||'unknown',independentlyVerified:false,coordinatorEvaluationRequired:true},
    claims:claimed, observed:job.evidence||null, permissionDenials:job.permissionDenials||[],
    uncertainties:[...(claimed?.uncertainties||[]),...(job.evidence?.warnings||[]),...(job.error?[String(job.error)]:[])],
    unverifiedClaims:claimed?.unverifiedClaims||[],
  };
}
