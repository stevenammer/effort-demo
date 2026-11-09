// Synthetic certificates are generated in a private temporary directory, never tracked.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
export async function createTLSFixture(){const directory=await mkdtemp(join(tmpdir(),'effort-tls-fixture-'));try{execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});return{tls:{key:await readFile(join(directory,'key.pem')),cert:await readFile(join(directory,'cert.pem'))},close:()=>rm(directory,{recursive:true,force:true})};}catch(e){await rm(directory,{recursive:true,force:true});throw e;}}
