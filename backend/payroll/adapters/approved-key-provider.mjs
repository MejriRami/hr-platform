/** Explicit approved version map, supplied existing SDK clients only. No dynamic client URL,
 * credential provisioning, key listing or implicit latest-version selection. */
export function createApprovedKeyProvider({currentKeyId,clients}){
 const allowed=new Map(clients);const valid=id=>typeof id==='string'&&/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/keys\/[a-zA-Z0-9-]+\/[a-f0-9]+$/.test(id);
 if(!valid(currentKeyId)||!allowed.has(currentKeyId)||[...allowed.entries()].some(([id,client])=>!valid(id)||client?.keyID!==id))throw Error('approved_keys_required');
 return Object.freeze({async wrap(key,{signal}={}){if(allowed.get(currentKeyId).keyID!==currentKeyId)throw Error('key_client_mismatch');const r=await allowed.get(currentKeyId).wrapKey('RSA-OAEP-256',key,{abortSignal:signal});if(r.keyID!==currentKeyId||!r.result)throw Error('key_mismatch');return {keyId:currentKeyId,value:Buffer.from(r.result).toString('base64')};},async unwrap({keyId,value},{signal}={}){if(!allowed.has(keyId)||typeof value!=='string'||value.length>8192)throw Error('unapproved_key_version');if(allowed.get(keyId).keyID!==keyId)throw Error('key_client_mismatch');const r=await allowed.get(keyId).unwrapKey('RSA-OAEP-256',Buffer.from(value,'base64'),{abortSignal:signal});if(r.keyID!==keyId||!r.result)throw Error('key_mismatch');return Buffer.from(r.result);}});
}
