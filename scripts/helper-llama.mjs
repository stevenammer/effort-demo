import { HELPER_RESULT_SCHEMA, encodedBytes } from '../public/helper-contract.js';
import { sha256, IntegrityError } from '../public/primitives.js';
const fail=message=>{throw new IntegrityError(message);};
export function llamaBackend({model,contextTokens,json,withLease}) {
  if(typeof withLease!=='function')throw Error('llama.cpp requires an explicit shared generation lease or dedicated-worker confirmation.');
  async function installed(signal){const health=await json('/health',signal),models=await json('/v1/models',signal),props=await json('/props',signal);return health.status==='ok'&&Array.isArray(models.data)&&models.data.length===1&&models.data[0]?.id===model&&props.total_slots===1&&props.default_generation_settings?.n_ctx===contextTokens&&typeof props.model_path==='string'&&props.model_path.endsWith('.gguf');}
  async function idle(signal){const slots=await json('/slots',signal);if(!Array.isArray(slots)||slots.length!==1||slots[0].is_processing!==false||slots[0].n_ctx!==contextTokens||!Number.isSafeInteger(slots[0].id)||slots[0].id<0)fail('The configured single llama.cpp worker is busy or cannot be verified. No call was started.');return slots[0].id;}
  async function generate(prompt,signal){let dispatched=false;return withLease(async heldSignal=>{
    if(dispatched)fail('This approved llama.cpp attempt cannot be dispatched twice.');dispatched=true;
    signal=heldSignal??signal;
    if(!await installed(signal))fail('The configured llama.cpp model and exact context window are unavailable.');
    const id=await idle(signal),rendered=await json('/apply-template',signal,{messages:[{role:'user',content:prompt}],chat_template_kwargs:{enable_thinking:false},reasoning_effort:'none'});
    if(typeof rendered.prompt!=='string'||!rendered.prompt.trim()||rendered.prompt.length>40000||rendered.prompt.split(prompt).length!==2)fail('The llama.cpp input template cannot be preserved within its portable limit.');
    const tokenized=await json('/tokenize',signal,{content:rendered.prompt,add_special:true,parse_special:true},512000),tokens=tokenized.tokens;
    if(!Array.isArray(tokens)||!tokens.length||tokens.length+1200>contextTokens||tokens.some(n=>!Number.isSafeInteger(n)||n<0||n>2147483647))fail('The complete llama.cpp input and output allowance exceed the configured window. Nothing was truncated or generated.');
    if(encodedBytes({prompt,renderedPrompt:rendered.prompt,tokenIds:tokens})>100000)fail('The exact llama.cpp input exceeds its portable receipt budget. Nothing was generated.');
    if(await idle(signal)!==id||!await installed(signal))fail('The llama.cpp worker changed before dispatch. No call was started.');
    const got=await json('/completion',signal,{model,prompt:tokens,id_slot:id,stream:false,n_predict:1200,temperature:0,cache_prompt:false,json_schema:HELPER_RESULT_SCHEMA},256000);
    if(got.model!==model||got.stop!==true||!['eos','word'].includes(got.stop_type)||got.truncated!==false||got.generation_settings?.n_ctx!==contextTokens||typeof got.content!=='string'||!got.content.trim()||got.content.length>24000||got.tool_calls?.length||got.timings?.predicted_n>1200)fail('The llama.cpp reply is incomplete, truncated, tool-seeking or from a different worker.');
    const extra={engine:'llama.cpp',inputFormat:'llama-token-v1',renderedPrompt:rendered.prompt,renderedHash:await sha256(rendered.prompt),tokenIds:tokens,tokenHash:await sha256(JSON.stringify(tokens)),providerStopReason:got.stop_type};
    return{rawResponse:got.content,model,promptTokens:tokens.length,outputTokens:got.timings?.predicted_n??null,providerAt:null,extra};
  },signal);}
  return{installed,generate};
}
