import test from 'node:test';import assert from 'node:assert/strict';
import {isNight,frictionFor}from'../packages/core/night.js';import{shouldInterrupt,budgeted}from'../packages/core/interrupt.js';
const DAY=86400000;
test('all hour windows preserve capture and night remains advisory',()=>{
 for(const start of[0,6,12,23])for(const end of[0,6,12,23])for(let h=0;h<24;h++){
  const date=new Date(2026,0,1,h),quiet=isNight(date,start,end);
  if(start===end)assert.equal(quiet,false);
  if(start!==end){assert.equal(isNight(new Date(2026,0,1,start),start,end),true);assert.equal(isNight(new Date(2026,0,1,end),start,end),false);}
  for(const action of['capture','journal','tomorrow-first-step'])for(const dial of['TIGHT','NORMAL','WILD','UNHINGED'])assert.equal(frictionFor({date,start,end,action,dial}),null);
  const friction=frictionFor({date,start,end,action:'promote'});assert.equal(friction!==null,quiet);if(friction)assert.deepEqual(Object.keys(friction).sort(),['kind','message']);
 }
});
test('epoch zero and exact cooldown boundaries use supplied time',()=>{
 const candidate={key:'note',type:'task'},ctx={now:0,dial:'normal',quietStart:0,quietEnd:0};
 assert.equal(shouldInterrupt(candidate,ctx).allow,true);
 assert.equal(shouldInterrupt(candidate,{...ctx,lastShown:{note:0}}).allow,false);
 assert.equal(shouldInterrupt(candidate,{...ctx,recentDismissals:[{type:'task',at:0}]}).allow,false);
 assert.equal(shouldInterrupt(candidate,{...ctx,now:DAY-1,recentDismissals:[{type:'task',at:0}]}).allow,false);
 assert.equal(shouldInterrupt(candidate,{...ctx,now:DAY,recentDismissals:[{type:'task',at:0}]}).allow,true);
 assert.equal(shouldInterrupt(candidate,{...ctx,now:3*DAY-1,lastShown:{note:0}}).allow,false);
 assert.equal(shouldInterrupt(candidate,{...ctx,now:3*DAY,lastShown:{note:0}}).allow,true);
});
test('budgets are bounded, monotonic and cannot repeat a key',()=>{
 const candidates=Array.from({length:10},(_,i)=>({key:`item-${i%5}`,type:'task'}));
 for(const[dial,limit]of[['quiet',0],['normal',1],['loud',3]])for(let sent=0;sent<5;sent++){
  const ctx={now:0,dial,sentToday:sent,quietStart:0,quietEnd:0},out=budgeted(candidates,ctx);
  assert(out.length<=Math.max(0,limit-sent));assert.equal(new Set(out.map(x=>x.key)).size,out.length);
  assert(budgeted(candidates,{...ctx,sentToday:sent+1}).length<=out.length);
  assert.equal(budgeted(candidates,{...ctx,activeCommitment:true}).length,0);
 }
 assert.throws(()=>budgeted([],{now:0,dial:'invalid'}),/dial/);
});
