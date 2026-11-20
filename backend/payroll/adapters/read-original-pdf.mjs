import {open,realpath} from 'node:fs/promises';import {constants} from 'node:fs';import path from 'node:path';
/** Read-only bounded capture of the original server-created file. No cleanup or writes.
 * allowedDirectory must be the approved existing uploads/paie directory, not request input. */
export async function readAtMost(handle,maxBytes,signal){
 if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>5*1024*1024)throw Error('invalid_read_limit');
 const buffer=Buffer.alloc(maxBytes+1);let offset=0;
 while(offset<buffer.length){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,offset,Math.min(65536,buffer.length-offset),offset);if(!Number.isInteger(bytesRead)||bytesRead<0||bytesRead>Math.min(65536,buffer.length-offset))throw Error('invalid_read');if(bytesRead===0)break;offset+=bytesRead;}
 if(offset>maxBytes)throw Error('original_too_large');return buffer.subarray(0,offset);
}
export function createOriginalPdfReader({allowedDirectory}){
 if(typeof allowedDirectory!=='string'||!path.isAbsolute(allowedDirectory))throw Error('approved_directory_required');
 return async function readOriginalPdf(filename,{signal,maxBytes=5*1024*1024}={}){
  if(typeof filename!=='string'||!Number.isInteger(maxBytes)||maxBytes<8||maxBytes>5*1024*1024)throw Error('invalid_capture');signal?.throwIfAborted();
  const root=await realpath(allowedDirectory),candidate=path.resolve(filename),parent=await realpath(path.dirname(candidate));if(parent!==root)throw Error('outside_original_directory');
  const handle=await open(path.join(parent,path.basename(candidate)),constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=await handle.stat();if(!before.isFile()||before.size<8||before.size>maxBytes)throw Error('invalid_original_pdf');signal?.throwIfAborted();const result=await readAtMost(handle,maxBytes,signal);const after=await handle.stat();if(result.length!==before.size||result.length>maxBytes||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||result.subarray(0,5).toString()!=='%PDF-')throw Error('original_changed');return result;}finally{await handle.close();}
 };
}
