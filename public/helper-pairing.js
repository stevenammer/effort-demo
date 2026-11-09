import { companionURL } from './thread-review.js';
import { exactKeys, same } from './primitives.js';
export const HELPER_PAIRING_KEY='effort-helper-pairing-v1';
export function validPairing(row){return exactKeys(row,['version','url','token'])&&row.version===1&&typeof row.url==='string'&&companionURL(row.url)===row.url&&typeof row.token==='string'&&/^[A-Za-z0-9_-]{24,128}$/.test(row.token);}
// Credentials are deliberately outside workspace data, drafts and backups.
export function createHelperPairing(options={}) {
  let storage,unavailable=false;try{storage=Object.hasOwn(options,'storage')?options.storage:globalThis.localStorage;}catch{unavailable=true;}
  function read(){try{if(unavailable)throw Error();const raw=storage?.getItem(HELPER_PAIRING_KEY);if(!raw)return{pair:null,warning:''};if(raw.length>1024)throw Error();const pair=JSON.parse(raw);if(!validPairing(pair))throw Error();return{pair,warning:''};}catch{return{pair:null,warning:'Remembered connection could not be read. Enter and check it again.'};}}
  function save(url,token){const pair={version:1,url:companionURL(url),token};if(!validPairing(pair))throw Error('Check a valid connection before remembering it.');try{if(!storage)throw Error();storage.setItem(HELPER_PAIRING_KEY,JSON.stringify(pair));if(!same(read().pair,pair))throw Error();}catch{throw Error('This browser could not verify remembering the connection. It remains usable in this tab.');}return pair;}
  function clear(){try{if(!storage)return false;storage.removeItem(HELPER_PAIRING_KEY);if(storage.getItem(HELPER_PAIRING_KEY)!==null)throw Error();return true;}catch{return false;}}
  return{read,save,clear};
}
