// Isolated optional SDK boundary. Module import never loads SDKs or contacts Azure.
export const APPROVED = Object.freeze({
  containerUrl:'https://yourstorage.blob.core.windows.net/payslips',
  keyId:'https://kv-org-payslips-fc.vault.azure.net/keys/payslip-envelope-key/5609c843f3514759b55cd8d8fd2c477f'
});
const MAX_ENVELOPE=7*1024*1024;
const objectName=/^v2\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bin$/i;
async function installedSdk(){const [identity,blob,keys]=await Promise.all([import('@azure/identity'),import('@azure/storage-blob'),import('@azure/keyvault-keys')]);return {ManagedIdentityCredential:identity.ManagedIdentityCredential,ContainerClient:blob.ContainerClient,CryptographyClient:keys.CryptographyClient};}
function signalOptions(options={}){options.abortSignal?.throwIfAborted();return {abortSignal:options.abortSignal};}
/** sdkLoader is a trusted composition/test seam, never an HTTP/user parameter.
 * scope is a process role: producer or reader. No credentials/endpoints accepted. */
export async function createPayrollAzureClients(options={}){
  if(options.enabled!==true)return Object.freeze({enabled:false});
  if(Object.keys(options).some(k=>!['enabled','scope','sdkLoader'].includes(k)))throw Error('unsupported_client_configuration');
  const {scope,sdkLoader=installedSdk}=options;
  if(!['producer','reader'].includes(scope)||typeof sdkLoader!=='function')throw Error('invalid_runtime_scope');
  const sdk=await sdkLoader();
  for(const key of ['ManagedIdentityCredential','ContainerClient','CryptographyClient'])if(typeof sdk?.[key]!=='function')throw Error('azure_sdk_required');
  // No client ID, resource ID, DefaultAzureCredential, CLI or developer fallback.
  const credential=new sdk.ManagedIdentityCredential();
  const rawContainer=new sdk.ContainerClient(APPROVED.containerUrl,credential,{retryOptions:{maxTries:1},keepAliveOptions:{enable:true}});
  const rawKey=new sdk.CryptographyClient(APPROVED.keyId,credential,{retryOptions:{maxRetries:0}});
  if(rawContainer.url!==APPROVED.containerUrl||rawKey.keyID!==APPROVED.keyId)throw Error('azure_client_target_mismatch');
  const check=()=>{if(rawContainer.url!==APPROVED.containerUrl||rawKey.keyID!==APPROVED.keyId)throw Error('azure_client_target_mismatch');};
  const cryptoOperation=scope==='producer'?'wrapKey':'unwrapKey';
  const keyClient=Object.freeze({keyID:APPROVED.keyId,async [cryptoOperation](algorithm,bytes,opts={}){
    check();if(algorithm!=='RSA-OAEP-256'||!(bytes instanceof Uint8Array)||(scope==='producer'?bytes.length!==32:bytes.length<1||bytes.length>6144))throw Error('invalid_key_operation');
    const response=await rawKey[cryptoOperation]('RSA-OAEP-256',bytes,signalOptions(opts));
    if(response?.keyID!==APPROVED.keyId||!(response.result instanceof Uint8Array)||(scope==='reader'?response.result.length!==32:response.result.length<1||response.result.length>6144))throw Error('azure_key_response_mismatch');
    return {keyID:APPROVED.keyId,result:response.result};
  }});
  const container=Object.freeze({
    getProperties(opts={}){check();return rawContainer.getProperties(signalOptions(opts));},
    getBlockBlobClient(name){
      check();if(typeof name!=='string'||!objectName.test(name))throw Error('invalid_archive_blob_name');
      const raw=rawContainer.getBlockBlobClient(name);
      const expected=APPROVED.containerUrl+'/'+name;
      if(raw.url!==expected)throw Error('azure_blob_target_mismatch');
      const guard=()=>{check();if(raw.url!==expected)throw Error('azure_blob_target_mismatch');};
      const methods={getProperties(opts={}){guard();return raw.getProperties(signalOptions(opts));},
        downloadToBuffer(offset,count,opts={}){guard();if(offset!==0||!Number.isInteger(count)||count<1||count>MAX_ENVELOPE||typeof opts.conditions?.ifMatch!=='string'||!opts.conditions.ifMatch)throw Error('bounded_conditional_download_required');return raw.downloadToBuffer(0,count,{...signalOptions(opts),conditions:{ifMatch:opts.conditions.ifMatch}});}};
      if(scope==='producer')methods.uploadData=(bytes,opts={})=>{guard();if(!(bytes instanceof Uint8Array)||bytes.length<1||bytes.length>MAX_ENVELOPE||opts.conditions?.ifNoneMatch!=='*')throw Error('immutable_bounded_upload_required');return raw.uploadData(bytes,{...signalOptions(opts),conditions:{ifNoneMatch:'*'},blobHTTPHeaders:{blobContentType:'application/octet-stream',blobCacheControl:'no-store'}});};
      return Object.freeze(methods);
    }
  });
  // No SDK object or credential escapes. Frozen entries satisfy new Map(keyClients).
  return Object.freeze({enabled:true,scope,currentKeyId:APPROVED.keyId,container,keyClients:Object.freeze([Object.freeze([APPROVED.keyId,keyClient])])});
}
export const createPayrollProducerAzureClients=options=>createPayrollAzureClients({...options,scope:'producer'});
export const createPayrollReaderAzureClients=options=>createPayrollAzureClients({...options,scope:'reader'});
