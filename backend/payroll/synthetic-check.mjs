import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
// One predeclared object forever for this approval. No ID generation or deletion.
export const SYNTHETIC = Object.freeze({eventId:'00000000-0000-0000-0000-000000000000',blobPath:'v2/00000000-0000-0000-0000-000000000000.bin',employeeId:'9000000000000000001',period:'2026-10',distributedAt:'2026-10-23T11:45:00.000Z',producerHost:'backend-rh',readerHost:'pointeuse-back',maxObjects:1});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Entirely synthetic valid one-page PDF; no employee/database/filesystem input.
export function syntheticPdf(){const stream='BT /F1 16 Tf 50 780 Td (SYNTHETIC PAYROLL CHECK - NOT A PAYSLIP) Tj 0 -30 Td (NO EMPLOYEE DATA - NO SALARY - NO SMTP) Tj ET';const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];let pdf='%PDF-1.4\n';const offsets=[];objects.forEach((s,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${s}\nendobj\n`;});const xref=pdf.length;pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return Buffer.from(pdf,'ascii');}
export const SYNTHETIC_PDF_SHA256=hash(syntheticPdf());
async function deployedRuntime(){const [azure,envelope,contracts]=await Promise.all([import('./azure-clients.mjs'),import('./service/durable-envelope.mjs'),import('./adapters/scoped-runtime-contracts.mjs')]);return {...azure,...envelope,...contracts};}
/** Explicit action runner; no call on import. loadRuntime is a trusted test seam.
 * No pool, SMTP, actor lookup, endpoints, credentials or arbitrary object inputs. */
export async function runSyntheticCheck({execute=false,role,hostName=process.env.WEBSITE_SITE_NAME,loadRuntime=deployedRuntime,timeoutMs=20000}={}){
 const counts={wrap:0,upload:0,download:0,unwrap:0};
 const report=(status,extra={})=>Object.freeze({status,role:['producer','reader'].includes(role)?role:'invalid',blobPath:SYNTHETIC.blobPath,counts:{...counts},...extra});
 if(execute!==true)return report('NOT_EXECUTED');
 if(!['producer','reader'].includes(role)||hostName!==(role==='producer'?SYNTHETIC.producerHost:SYNTHETIC.readerHost))return report('HOST_OR_ROLE_REJECTED');
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>20000)return report('INVALID_TIME_BOUND');
 const controller=new AbortController();let timer;
 const work=async()=>{
  const runtime=await loadRuntime();controller.signal.throwIfAborted();
  const clients=await runtime.createPayrollAzureClients({enabled:true,scope:role});controller.signal.throwIfAborted();
  const scoped=runtime.scopedKeys({scope:role,currentKeyId:clients.currentKeyId,keyClients:clients.keyClients});
  const keys=role==='producer'?{wrap:async(...args)=>{controller.signal.throwIfAborted();counts.wrap++;return scoped.wrap(...args);}}:{unwrap:async(...args)=>{controller.signal.throwIfAborted();counts.unwrap++;return scoped.unwrap(...args);}};
  const envelope=runtime.createDurableEnvelope({keys});
  const meta={eventId:SYNTHETIC.eventId,id:SYNTHETIC.eventId,employeeId:SYNTHETIC.employeeId,period:SYNTHETIC.period,distributedAt:SYNTHETIC.distributedAt,sha256:SYNTHETIC_PDF_SHA256};
  const opts={abortSignal:controller.signal};const props=await clients.container.getProperties(opts);controller.signal.throwIfAborted();if(props.blobPublicAccess||props.publicAccess)throw Error('private_required');
  const blob=clients.container.getBlockBlobClient(SYNTHETIC.blobPath);let existing;
  try{existing=await blob.getProperties(opts);}catch(e){if(e?.statusCode!==404)throw e;}
  controller.signal.throwIfAborted();
  if(role==='producer'){
   if(existing)return report('OBJECT_EXISTS_READER_CHECK_REQUIRED');
   const pdf=syntheticPdf();let encrypted;
   try{encrypted=await envelope.seal(meta,pdf,{signal:controller.signal});}finally{pdf.fill(0);}
   controller.signal.throwIfAborted();counts.upload++;
   await blob.uploadData(encrypted,{...opts,conditions:{ifNoneMatch:'*'},blobHTTPHeaders:{blobContentType:'application/octet-stream',blobCacheControl:'no-store'}});
   controller.signal.throwIfAborted();return report('UPLOAD_CONFIRMED',{envelopeSha256:hash(encrypted),syntheticPdfSha256:SYNTHETIC_PDF_SHA256});
  }
  if(!existing)return report('OBJECT_NOT_OBSERVED');
  if(!Number.isInteger(existing.contentLength)||existing.contentLength<1||existing.contentLength>runtime.MAX_ENVELOPE||typeof existing.etag!=='string'||!existing.etag)throw Error('invalid_size');
  counts.download++;const encrypted=await blob.downloadToBuffer(0,existing.contentLength,{...opts,conditions:{ifMatch:existing.etag}});controller.signal.throwIfAborted();if(encrypted.length!==existing.contentLength)throw Error('invalid_size');
  // Fixed AAD, key version and known PDF hash must match before any unwrap request.
  const parsed=JSON.parse(encrypted.toString('utf8'));if(parsed.aad!==runtime.boundMetadata(meta)||parsed.keyId!==clients.currentKeyId)throw Error('synthetic_binding_mismatch');
  const envelopeSha256=hash(encrypted);const pdf=await envelope.open({...meta,envelopeHash:envelopeSha256},encrypted,{signal:controller.signal});
  try{controller.signal.throwIfAborted();if(hash(pdf)!==SYNTHETIC_PDF_SHA256)throw Error('synthetic_hash_mismatch');return report('SYNTHETIC_ROUNDTRIP_VERIFIED',{envelopeSha256,syntheticPdfSha256:SYNTHETIC_PDF_SHA256});}finally{pdf.fill(0);}
 };
 try{return await Promise.race([work(),new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(report(counts.upload?'UPLOAD_OUTCOME_UNKNOWN':'CHECK_TIMEOUT'));},timeoutMs);})]);}
 catch{return report(counts.upload?'UPLOAD_OUTCOME_UNKNOWN':'CHECK_UNCONFIRMED');}
 finally{clearTimeout(timer);controller.abort();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);const role=args[1];
 const exact=args.length===2&&args[0]==='--execute-approved-synthetic'&&['producer','reader'].includes(role);
 const result=await runSyntheticCheck({execute:exact,role});
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=['UPLOAD_CONFIRMED','SYNTHETIC_ROUNDTRIP_VERIFIED','NOT_EXECUTED','OBJECT_EXISTS_READER_CHECK_REQUIRED'].includes(result.status)?0:2;
}
