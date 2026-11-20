import {createDurableOutboxRepository} from './durable-outbox-postgres.mjs';
import {createDurableEnvelope} from '../service/durable-envelope.mjs';
import {createDurablePrivateBlob} from './durable-private-blob.mjs';
import {createDistributionArchiveHook} from './distribution-hook.mjs';
import {createDurableCoordinator} from '../service/durable-coordinator.mjs';
import {requireBoundedPool,requireCallbacks,scopedKeys} from './scoped-runtime-contracts.mjs';

/** RH producer/worker process only. No employee reader, JWT verification or SMTP.
 * Clients are injected and separately authorized, never provisioned here. */
export function composePayrollProducer(options={}){
 if(options.enabled!==true)return Object.freeze({enabled:false});
 const {pool,container,currentKeyId,keyClients,resolveOriginalEmployee,readOriginalPdf,report,timeoutMs=5000}=options;
 requireBoundedPool(pool,{transactions:true});
 requireCallbacks(options,['resolveOriginalEmployee','readOriginalPdf']);
 requireCallbacks(container,['getProperties','getBlockBlobClient']);
 const keys=scopedKeys({scope:'producer',currentKeyId,keyClients});
 const envelope=createDurableEnvelope({keys});
 const outbox=createDurableOutboxRepository({pool});
 const privateStore=createDurablePrivateBlob({container,envelope});
 const blobStore=Object.freeze({putOrVerify:privateStore.putOrVerify});
 const worker=createDurableCoordinator({enabled:true,envelope,outbox,blobStore,resolveAcceptedEvent:()=>{throw Error('worker_cannot_accept_mail');},report,timeoutMs,leaseMs:Math.max(30000,timeoutMs*3)});
 const hook=createDistributionArchiveHook({enabled:true,readOriginalPdf,resolveOriginalEmployee,envelope,outbox,blobStore,report,timeoutMs});
 return Object.freeze({enabled:true,afterSuccessfulSend:hook.afterSuccessfulSend,runOne:worker.runOne,reconcilePublished:worker.reconcilePublished,summary:outbox.summary});
}
