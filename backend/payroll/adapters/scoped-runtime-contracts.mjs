import {createApprovedKeyProvider} from './approved-key-provider.mjs';

// Shared local validation only. Never constructs SDK/DB clients or grants access.
export function requireBoundedPool(pool,{transactions=false}={}){
 const p=pool?.options,bounded=(v,max)=>Number.isInteger(v)&&v>0&&v<=max;
 if(typeof pool?.query!=='function'||(transactions&&typeof pool?.connect!=='function')||!p||!bounded(p.connectionTimeoutMillis,5000)||!bounded(p.statement_timeout,10000)||!bounded(p.query_timeout,12000)||p.query_timeout<p.statement_timeout)throw Error('bounded_database_pool_required');
}
export function requireCallbacks(record,names){for(const name of names)if(typeof record?.[name]!=='function')throw Error('required_callback_missing');}
export function scopedKeys({scope,currentKeyId,keyClients}){
 if(!['reader','producer'].includes(scope))throw Error('invalid_runtime_scope');
 const clients=new Map(keyClients),method=scope==='reader'?'unwrapKey':'wrapKey';
 if([...clients.values()].some(client=>typeof client?.[method]!=='function'))throw Error('scoped_key_operation_required');
 const provider=createApprovedKeyProvider({currentKeyId,clients});
 return scope==='reader'?Object.freeze({unwrap:provider.unwrap}):Object.freeze({wrap:provider.wrap});
}
export function ownPortalVerifier(verifyPortalToken){
 if(typeof verifyPortalToken!=='function')throw Error('existing_portal_verifier_required');
 return async token=>{
  // Existing signed employee domain is the purpose boundary. Do not mint or require
  // a new payroll-purpose claim; do not decode a JWT in place of verification.
  const p=await verifyPortalToken(token);
  if(!p||p.role!=='employee'||p.aud!=='northwind-employee-portal'||p.iss!=='pointeuse-back'||p.portal?.method!=='microsoft')throw Object.assign(Error('employee_session_required'),{code:'employee_session_required',status:401});
  return p;
 };
}
