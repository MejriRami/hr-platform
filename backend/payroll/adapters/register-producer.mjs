import {composePayrollProducer} from './compose-producer.mjs';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const STATES=new Set(['disabled','queued','archived','unconfirmed','reconciliation_required']);
const CODES=new Set(['archive_enqueue_unconfirmed','archive_attempts_exhausted']);

/** The ONLY helper to insert after either original successful SMTP helper call.
 * Lazy disabled-by-default registration cannot make missing archive dependencies
 * break RH startup. Initialization, input factory, callback and reporting failures
 * are isolated. Never calls SMTP, retries the hook, updates results or deletes files.
 * A timeout is UNKNOWN, not failure/delivery; late durable work may still complete. */
export function createSafeProducerRegistration(options={}){
 if(options.enabled!==true)return Object.freeze({afterSuccessfulSend:async()=>({archive:'disabled'})});
 const timeoutMs=options.timeoutMs??6000;
 const invalidLimits=!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>12000;
 const report=options.report;
 const notify=r=>{try{if(typeof report==='function')Promise.resolve(report(r)).catch(()=>{});}catch{}};
 const make=options.createRuntime??(()=>composePayrollProducer({...options.producerOptions,enabled:true}));
 let runtime;
 const unknown=()=>({archive:'unconfirmed',code:'archive_hook_unconfirmed'});
 return Object.freeze({async afterSuccessfulSend(inputOrFactory){
  let timer,expired=false;
  try{
   if(invalidLimits)throw Error('invalid_registration_timeout');
   const result=await Promise.race([
    Promise.resolve().then(async()=>{
     if(!runtime)runtime=Promise.resolve().then(()=>make());
     const producer=await runtime;
     if(expired)throw Error('archive_hook_timeout');
     if(producer?.enabled!==true||typeof producer.afterSuccessfulSend!=='function')throw Error('producer_unavailable');
     const input=typeof inputOrFactory==='function'?await inputOrFactory():inputOrFactory;
     if(expired)throw Error('archive_hook_timeout');
     const result=await producer.afterSuccessfulSend(input);
     if(!result||!STATES.has(result.archive))throw Error('archive_state_unknown');
     const safe={archive:result.archive};
     if(typeof result.eventId==='string'&&UUID.test(result.eventId))safe.eventId=result.eventId;
     if(CODES.has(result.code))safe.code=result.code;
     return safe;
    }),
    new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(Error('archive_hook_timeout'));},timeoutMs);})
   ]);
   notify(result);return result;
  }catch{const result=unknown();notify(result);return result;}
  finally{clearTimeout(timer);}
 }});
}
