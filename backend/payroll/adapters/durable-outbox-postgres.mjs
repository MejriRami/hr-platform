import {createHash} from 'node:crypto';

/** LOCAL PREPARATION ONLY. Inject an already approved pool; never creates a connection,
 * credential, role, schema or SMTP request. Tests use fake pools, not PostgreSQL.
 * The worker must verify durable immutable Blob storage BEFORE calling complete(). */
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const MAX_BIGINT=9223372036854775807n;
const MAX_ENVELOPE=7*1024*1024;
const CODES=new Set(['archive_failed','storage_unavailable','storage_conflict','archive_conflict','timeout','invalid_envelope','lease_expired','attempts_exhausted']);
const fail=code=>{throw Object.assign(Error(code),{code});};
const bounded=(v,min,max)=>Number.isInteger(v)&&v>=min&&v<=max;
const validId=v=>typeof v==='string'&&UUID.test(v);
const numericId=v=>typeof v==='string'&&/^[1-9][0-9]{0,18}$/.test(v)&&BigInt(v)<=MAX_BIGINT;
const digest=b=>createHash('sha256').update(b).digest('hex');
const timestamp=v=>v instanceof Date?v.toISOString():new Date(v).toISOString();
const immutableColumns='id,event_id,employee_id,distribution_month,distributed_at,sha256,envelope_hash';
const claimColumns=immutableColumns+',envelope,status,attempts,lease_id,lease_until';
function record(input){
 if(!input||!validId(input.id)||input.id!==input.eventId||!numericId(input.employeeId)||typeof input.period!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(input.period)||typeof input.distributedAt!=='string'||!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(input.distributedAt)||typeof input.sha256!=='string'||!HASH.test(input.sha256)||typeof input.envelopeHash!=='string'||!HASH.test(input.envelopeHash)||!Buffer.isBuffer(input.envelope)||input.envelope.length<1||input.envelope.length>MAX_ENVELOPE)fail('invalid_outbox_record');
 let distributedAt;try{distributedAt=timestamp(input.distributedAt);}catch{fail('invalid_outbox_record');}
 if(distributedAt!==(input.distributedAt.includes('.')?input.distributedAt:input.distributedAt.replace(/Z$/,'.000Z')))fail('invalid_outbox_record');
 const envelope=Buffer.from(input.envelope);
 if(digest(envelope)!==input.envelopeHash)fail('invalid_envelope_hash');
 return {...input,distributedAt,envelope};
}
function map(row){return row?{id:row.id,eventId:row.event_id,employeeId:String(row.employee_id),period:row.distribution_month,distributedAt:timestamp(row.distributed_at),sha256:row.sha256,envelopeHash:row.envelope_hash,...(row.envelope===undefined?{}:{envelope:Buffer.from(row.envelope)}),...(row.status===undefined?{}:{status:row.status}),...(row.attempts===undefined?{}:{attempts:row.attempts}),...(row.lease_id===undefined?{}:{leaseId:row.lease_id,leaseUntil:row.lease_until?timestamp(row.lease_until):null})}:null;}
function sameDocument(a,b){return a.id===b.id&&a.eventId===b.eventId&&a.employeeId===b.employeeId&&a.period===b.period&&a.distributedAt===b.distributedAt&&a.sha256===b.sha256&&a.envelopeHash===b.envelopeHash;}
function leaseInput(v){if(!v||!validId(v.eventId)||!validId(v.leaseId))fail('invalid_lease');}

export function createDurableOutboxRepository({pool}={}){
 if(typeof pool?.query!=='function'||typeof pool?.connect!=='function')fail('outbox_pool_required');
 return Object.freeze({
  async enqueue(input){
   const r=record(input);
   // A reseal of the same event can have a different randomized ciphertext. Keep the
   // first envelope/hash atomically; compare every immutable PLAINTEXT binding only.
   const result=await pool.query(`INSERT INTO payroll_archive.outbox AS existing
    (id,event_id,employee_id,distribution_month,distributed_at,sha256,envelope_hash,envelope)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT(event_id) DO UPDATE SET event_id=EXCLUDED.event_id
    WHERE existing.id=EXCLUDED.id AND existing.employee_id=EXCLUDED.employee_id
      AND existing.distribution_month=EXCLUDED.distribution_month AND existing.distributed_at=EXCLUDED.distributed_at
      AND existing.sha256=EXCLUDED.sha256
    RETURNING id,event_id,status`,[r.id,r.eventId,r.employeeId,r.period,r.distributedAt,r.sha256,r.envelopeHash,r.envelope]);
   if(result.rows.length!==1)fail('outbox_event_conflict');
   return {id:result.rows[0].id,eventId:result.rows[0].event_id,status:result.rows[0].status};
  },
  async claim({leaseId,leaseMs,maxAttempts}={}){
   if(!validId(leaseId)||!bounded(leaseMs,1000,300000)||!bounded(maxAttempts,1,25))fail('invalid_claim');
   // Terminalize a bounded batch of exhausted, currently eligible jobs. Locks are
   // skipped rather than waiting on another worker. All lease time uses DB clocks.
   const result=await pool.query(`WITH exhausted AS (
    SELECT event_id FROM payroll_archive.outbox WHERE attempts >= $3 AND
     ((status IN ('pending','retry') AND available_at<=clock_timestamp()) OR (status='leased' AND lease_until<=clock_timestamp()))
    ORDER BY available_at,event_id FOR UPDATE SKIP LOCKED LIMIT 100
   ), terminal AS (
    UPDATE payroll_archive.outbox AS o SET status='failed',lease_id=NULL,lease_until=NULL,last_code='attempts_exhausted',updated_at=clock_timestamp()
    FROM exhausted e WHERE o.event_id=e.event_id RETURNING o.event_id
   ), candidate AS (
    SELECT event_id FROM payroll_archive.outbox WHERE attempts < $3 AND
     ((status IN ('pending','retry') AND available_at<=clock_timestamp()) OR (status='leased' AND lease_until<=clock_timestamp()))
    ORDER BY available_at,created_at,event_id FOR UPDATE SKIP LOCKED LIMIT 1
   ) UPDATE payroll_archive.outbox AS o SET status='leased',lease_id=$1::uuid,
    lease_until=clock_timestamp()+($2::bigint * interval '1 millisecond'),attempts=o.attempts+1,last_code=NULL,updated_at=clock_timestamp()
    FROM candidate c WHERE o.event_id=c.event_id RETURNING ${claimColumns.split(',').map(c=>'o.'+c).join(',')}`,[leaseId,leaseMs,maxAttempts]);
   if(result.rows.length>1)fail('outbox_claim_contract');
   return map(result.rows[0]);
  },
  async complete(input){
   leaseInput(input);const params=[input.eventId,input.leaseId];const client=await pool.connect();
   try{
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");await client.query("SET LOCAL statement_timeout='10s'");
    const owned=await client.query(`SELECT ${immutableColumns} FROM payroll_archive.outbox WHERE event_id=$1 AND status='leased' AND lease_id=$2 AND lease_until>clock_timestamp() FOR UPDATE`,params);
    if(owned.rows.length!==1){await client.query('ROLLBACK');return false;}
    const expected=map(owned.rows[0]);
    await client.query(`INSERT INTO payroll_archive.documents(id,event_id,employee_id,sha256,distributed_at,distribution_month,envelope_hash)
     SELECT id,event_id,employee_id,sha256,distributed_at,distribution_month,envelope_hash FROM payroll_archive.outbox
     WHERE event_id=$1 AND status='leased' AND lease_id=$2 AND lease_until>clock_timestamp()
     ON CONFLICT(event_id) DO NOTHING`,params);
    const found=await client.query(`SELECT ${immutableColumns} FROM payroll_archive.documents WHERE event_id=$1`,[input.eventId]);
    if(found.rows.length!==1){await client.query('ROLLBACK');return false;}
    if(!sameDocument(expected,map(found.rows[0])))fail('outbox_document_conflict');
    // The lease may expire while this transaction waits. Roll back metadata too.
    const done=await client.query(`UPDATE payroll_archive.outbox SET status='published',lease_id=NULL,lease_until=NULL,last_code=NULL,published_at=clock_timestamp(),updated_at=clock_timestamp()
     WHERE event_id=$1 AND status='leased' AND lease_id=$2 AND lease_until>clock_timestamp() RETURNING event_id`,params);
    if(done.rows.length!==1){await client.query('ROLLBACK');return false;}
    await client.query('COMMIT');return true;
   }catch(e){try{await client.query('ROLLBACK');}catch{}throw e;}finally{client.release();}
  },
  async retry(input){
   leaseInput(input);
   if(!bounded(input.delayMs,0,86400000)||!bounded(input.maxAttempts,1,25)||!CODES.has(input.code))fail('invalid_retry');
   const result=await pool.query(`UPDATE payroll_archive.outbox SET status=CASE WHEN attempts >= $4 THEN 'failed' ELSE 'retry' END,
    available_at=clock_timestamp()+($3::bigint * interval '1 millisecond'),lease_id=NULL,lease_until=NULL,last_code=$5,updated_at=clock_timestamp()
    WHERE event_id=$1 AND status='leased' AND lease_id=$2 AND lease_until>clock_timestamp() RETURNING event_id`,[input.eventId,input.leaseId,input.delayMs,input.maxAttempts,input.code]);
   return result.rows.length===1;
  },
  async publishedCopy(eventId){
   if(!validId(eventId))fail('invalid_event_id');
   const r=await pool.query(`SELECT ${claimColumns} FROM payroll_archive.outbox WHERE event_id=$1 AND status='published'`,[eventId]);
   if(r.rows.length>1)fail('outbox_read_contract');return map(r.rows[0]);
  },
  async summary(){
   const counts={pending:0,retry:0,leased:0,published:0,failed:0};
   const result=await pool.query('SELECT status,COUNT(*)::text AS count FROM payroll_archive.outbox GROUP BY status');
   for(const row of result.rows){const n=Number(row.count);if(!Object.hasOwn(counts,row.status)||!Number.isSafeInteger(n)||n<0)fail('invalid_outbox_summary');counts[row.status]=n;}
   return counts;
  }
 });
}
