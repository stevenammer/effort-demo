import { IntegrityError } from '../public/primitives.js';
// Optional operator-supplied POSIX lock shared with other callers of the same worker.
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
export function fileGenerationLease(path,{python='python3'}={}) {
  if(typeof path!=='string'||!isAbsolute(path)||path.length>1024)throw Error('Configure an absolute shared generation-lock path.');
  return async function withLease(run,signal){
    if(signal?.aborted)throw signal.reason;
    const leaseAbort=new AbortController(),combined=signal?AbortSignal.any([signal,leaseAbort.signal]):leaseAbort.signal;
    const child=spawn(python,['-c',"import os,sys,fcntl,stat\np=sys.argv[1]\nf=os.open(p,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)\nif not stat.S_ISREG(os.fstat(f).st_mode): sys.exit(4)\ntry: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(3)\nprint('acquired',flush=True)\nsys.stdin.buffer.read()\nos.close(f)",path],{stdio:['pipe','pipe','ignore']});
    child.stdin.on('error',()=>{});
    let acquired=false,output='';const exited=new Promise(resolve=>child.once('close',code=>{leaseAbort.abort(new IntegrityError('The shared worker lease ended. No output was accepted.'));resolve(code);}));
    try{await new Promise((resolve,reject)=>{const fail=()=>reject(new IntegrityError('The shared generation lease is busy or unavailable. No call was started.'));child.once('error',fail);child.once('exit',fail);child.stdout.on('data',chunk=>{output+=chunk;if(output==='acquired\n'){acquired=true;resolve();}else if(output.length>30)fail();});signal?.addEventListener('abort',fail,{once:true});});if(signal?.aborted)throw signal.reason;const result=await run(combined);if(child.exitCode!==null||child.killed||combined.aborted)throw new IntegrityError('The shared worker lease ended. No output was accepted.');return result;}finally{child.stdin.end();if(!acquired)child.kill();await exited;}
  };
}
