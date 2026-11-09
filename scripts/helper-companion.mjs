import { llamaBackend } from './helper-llama.mjs';
import { fileGenerationLease } from './helper-lease.mjs';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { validateReview, validReviewRoute, companionURL } from '../public/thread-review.js';
import { exactKeys, validId, same, IntegrityError } from '../public/primitives.js';
import { readBoundedJSON } from '../public/helper-runtime.js';

import { helperPrompt, HELPER_RESULT_SCHEMA, validateHelperEnvelope } from '../public/helper-contract.js';
import { sha256 } from '../public/primitives.js';
export { helperPrompt } from '../public/helper-contract.js';
export function createHelperCompanion({model,backend='http://127.0.0.1:11434',token,origins=['https://stevenammer.github.io'],fetchImpl=globalThis.fetch,timeoutMs=40000,contextTokens=8192,publicOrigin=null,tls=null,engine='ollama',withLease=null,backendToken=null}={}) {
  if(!['ollama','llama.cpp'].includes(engine))throw Error('Choose ollama or llama.cpp explicitly.');
  if(backendToken!==null&&(typeof backendToken!=='string'||! /^[A-Za-z0-9._-]{1,512}$/.test(backendToken)))throw Error('Invalid self-hosted backend credential.');
  if(publicOrigin!==null&&(companionURL(publicOrigin)!==publicOrigin||!publicOrigin.startsWith('https://'))||Boolean(tls)!==(publicOrigin!==null)||tls&&(!tls.key||!tls.cert))throw Error('HTTPS requires an exact public origin and your TLS key/certificate.');
  if(!Number.isInteger(contextTokens)||contextTokens<2048||contextTokens>32768)throw Error('Choose a model context from2048 through32768 tokens.');
  const probe={companion:'http://127.0.0.1:1',backend,model,...(engine==='llama.cpp'?{engine}:{})};
  if(!validReviewRoute(probe)||typeof token!=='string'||!/^[A-Za-z0-9_-]{24,128}$/.test(token))throw Error('Configure an exact self-hosted backend address, local model and session token.');
  const allowed=new Set(origins);for(const origin of allowed)if(new URL(origin).origin!==origin)throw Error('Allowed origins must be exact origins.');let busy=false;
  const auth=req=>{const got=Buffer.from(req.headers.authorization??''),want=Buffer.from(`Bearer ${token}`);return got.length===want.length&&timingSafeEqual(got,want);};
  async function backendJSON(path,signal,body,max=128000){return readBoundedJSON(await fetchImpl(backend+path,{method:body?'POST':'GET',redirect:'error',signal,headers:{'Content-Type':'application/json',...(backendToken?{Authorization:`Bearer ${backendToken}`}:{})},...(body?{body:JSON.stringify(body)}:{})}),max);}
  const llama=engine==='llama.cpp'?llamaBackend({model,contextTokens,json:backendJSON,withLease}):null;
  async function installed(signal){if(llama)return llama.installed(signal);const got=await backendJSON('/api/tags',signal);const present=Array.isArray(got.models)&&got.models.some(row=>(row.name===model||row.model===model)&&!row.remote_host&&!row.remote_model&&typeof row.digest==='string'&&/^[a-f0-9]{64}$/.test(row.digest)&&row.details?.format==='gguf'&&row.size>0);if(!present)return false;const shown=await backendJSON('/api/show',signal,{model});const capacities=Object.entries(shown.model_info??{}).filter(([key,value])=>key.endsWith('.context_length')&&Number.isSafeInteger(value)&&value>0).map(([,value])=>value);return capacities.length>0&&contextTokens<=Math.max(...capacities);}
  const handle=async(req,res)=>{
    const origin=req.headers.origin,host=req.headers.host;
    const send=(status,body)=>{if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(body));};
    if(!allowed.has(origin)||!host||!(publicOrigin?host===new URL(publicOrigin).host:['127.0.0.1','localhost','[::1]'].some(h=>host===`${h}:${server.address()?.port}`)))return send(403,{error:'Origin or host refused.'});
    res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Private-Network','true');
    if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','authorization, content-type');res.setHeader('Access-Control-Allow-Methods','GET, POST');res.writeHead(204);return res.end();}
    if(!auth(req))return send(401,{error:'Session token required.'});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    try{
      const route={companion:publicOrigin??`http://${host}`,backend,model,...(engine==='llama.cpp'?{engine}:{})};
      if(req.method==='GET'&&req.url==='/status'){return send(200,{protocol:'effort-helper-v2',route,available:await installed(controller.signal),at:new Date().toISOString()});}
      if(req.method!=='POST'||req.url!=='/reply')return send(404,{error:'Unknown endpoint.'});
      if(busy)return send(409,{error:'One helper is already running.'});
      let bytes=0;const chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>64000)return send(413,{error:'Request too large.'});chunks.push(chunk);}const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
      if(!exactKeys(input,['protocol','review','role','attemptId'])||!['effort-helper-v1','effort-helper-v2'].includes(input.protocol)||!validId(input.attemptId))return send(400,{error:'Invalid request.'});
      await validateReview(input.review);if(!same(input.review.route,route)||!input.review.invited.includes(input.role))return send(409,{error:'Approved route or invitation differs.'});
      const prompt=helperPrompt(input.review,input.role);if(!llama&&new TextEncoder().encode(prompt).length+1200+256>contextTokens)return send(413,{error:'Approved context exceeds the configured model window. Nothing was truncated or generated.'});if(busy)return send(409,{error:'One helper is already running.'});busy=true;
      try{
        let rawResponse,provider;
        if(llama){provider=await llama.generate(prompt,controller.signal);rawResponse=provider.rawResponse;}
        else{
          let dispatched=false;const generate=async signal=>{
            if(dispatched)throw new IntegrityError('This approved helper attempt cannot be dispatched twice.');dispatched=true;
            if(!await installed(signal))return{rejected:{status:503,error:'The configured local model is unavailable.'}};
            const resident=await backendJSON('/api/ps',signal);if(!Array.isArray(resident.models)||resident.models.length>0)return{rejected:{status:409,error:'A model is already resident. Finish its work and unload it before this explicit run.'}};
            const got=await backendJSON('/api/chat',signal,{model,messages:[{role:'user',content:prompt}],stream:false,think:false,keep_alive:0,format:HELPER_RESULT_SCHEMA,options:{num_predict:1200,num_ctx:contextTokens,temperature:0}});
            if(got.model!==model||got.done!==true||got.done_reason!=='stop'||got.message?.role!=='assistant'||got.message?.tool_calls?.length||typeof got.message?.content!=='string'||!got.message.content.trim()||got.message.content.length>24000)return{rejected:{status:502,error:'The model returned an incomplete, tool-seeking or oversized reply.'}};
            return{rawResponse:got.message.content,model:got.model,promptTokens:got.prompt_eval_count??null,outputTokens:got.eval_count??null,providerAt:got.created_at??null,extra:{}};
          };
          provider=withLease?await withLease(generate,controller.signal):await generate(controller.signal);if(provider.rejected)return send(provider.rejected.status,{error:provider.rejected.error});rawResponse=provider.rawResponse;
        }
        const result=JSON.parse(rawResponse),receipt={protocol:'effort-helper-v2',promptVersion:'helper-json-v2',prompt,promptHash:await sha256(prompt),role:input.role,model:provider.model,stopReason:'stop',tools:[],contextTokens,promptTokens:provider.promptTokens,outputTokens:provider.outputTokens,providerAt:provider.providerAt,...provider.extra};
        await validateHelperEnvelope({result,rawResponse,receipt},input.review,input.role);
        if(input.protocol==='effort-helper-v1')return send(200,{protocol:'effort-helper-v1',attemptId:input.attemptId,route,text:result.text});
        return send(200,{protocol:'effort-helper-v2',attemptId:input.attemptId,route,text:result.text,result,rawResponse,receipt});
      }finally{busy=false;}
    }catch(error){const rejected=error instanceof IntegrityError||error instanceof SyntaxError;return send(controller.signal.aborted?504:rejected?422:502,{error:error instanceof IntegrityError?error.message:error instanceof SyntaxError?'The model response was not valid structured JSON. Your source writing is kept.':'The self-hosted helper could not complete. Source writing remains in E.F.F.O.R.T.'});}finally{clearTimeout(timer);}
  };
  const server=tls?https.createServer({key:tls.key,cert:tls.cert,minVersion:'TLSv1.2'},handle):http.createServer(handle);
  server.requestTimeout=timeoutMs+1000;server.headersTimeout=Math.min(5000,server.requestTimeout);server.maxConnections=8;
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const token=process.env.EFFORT_HELPER_TOKEN??randomBytes(24).toString('base64url');
  if(process.env.EFFORT_HELPER_SELF_HOSTED!=='1')throw Error('Confirm your self-hosted service has cloud disabled: EFFORT_HELPER_SELF_HOSTED=1. See docs/THREAD_REVIEW.md.');
  const port=Number(process.env.EFFORT_HELPER_PORT??4319);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('Choose a port from1024 through65535.');
  if(!process.env.EFFORT_HELPER_ORIGIN&&(process.env.EFFORT_HELPER_TLS_CERT||process.env.EFFORT_HELPER_TLS_KEY))throw Error('Set the exact HTTPS origin with TLS files.');
  const publicOrigin=process.env.EFFORT_HELPER_ORIGIN??null,tls=publicOrigin?{cert:readFileSync(process.env.EFFORT_HELPER_TLS_CERT),key:readFileSync(process.env.EFFORT_HELPER_TLS_KEY)}:null,listen=process.env.EFFORT_HELPER_LISTEN??'127.0.0.1';
  if(!isIP(listen)||!tls&&listen!=='127.0.0.1')throw Error('A non-loopback listener requires explicit HTTPS configuration.');
  const engine=process.env.EFFORT_HELPER_ENGINE??'ollama',withLease=process.env.EFFORT_HELPER_LOCK_FILE?fileGenerationLease(process.env.EFFORT_HELPER_LOCK_FILE):process.env.EFFORT_HELPER_DEDICATED==='1'?async(run,signal)=>{if(signal?.aborted)throw signal.reason;return run(signal);}:null;
  const server=createHelperCompanion({publicOrigin,tls,engine,withLease,backendToken:process.env.EFFORT_HELPER_BACKEND_TOKEN??null,model:process.env.EFFORT_HELPER_MODEL,backend:process.env.EFFORT_HELPER_BACKEND??'http://127.0.0.1:11434',token,contextTokens:Number(process.env.EFFORT_HELPER_CONTEXT??8192),origins:(process.env.EFFORT_HELPER_ORIGINS??'https://stevenammer.github.io').split(',')});
  server.listen(port,listen,()=>{console.log(`E.F.F.O.R.T. companion: ${publicOrigin??`http://127.0.0.1:${port}`} \nSession token (keep private): ${token}\nNo model runs until you explicitly approve and start a THREAD invitation.`);});
}
