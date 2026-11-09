import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function scripts(directory) {return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?scripts(join(directory,entry.name)):entry.name.endsWith('.js')?[join(directory,entry.name)]:[]);}
const files=[...scripts('public'),'sw.js','shell-manifest.js'];
for(const file of files){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status!==0){process.stderr.write(result.stderr||result.error?.message||`Syntax check failed: ${file}\n`);process.exit(1);}}
console.log(`PASS: syntax checked ${files.length} browser and worker modules.`);
