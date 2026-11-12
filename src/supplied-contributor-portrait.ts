import {join} from 'node:path';
import {createPortraitJob,applyPortraitResult,approvePortraitCandidate,getPortraitJob} from './contributor-portraits.ts';
import {getContributor} from './contributors.ts';
import {recordAuditEvent} from './episodes.ts';
import {contributorForm} from './agent-contributors.ts';
export async function useSuppliedContributorPortrait(id:string,body:Record<string,unknown>,actor:string,origin:string){
 if(body.operatorApproved!==true||typeof body.approvalMessageId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(body.approvalMessageId))throw Error('Explicit operator approval and source message reference required');
 const contributor=getContributor(id);if(!contributor)throw Error('Contributor not found');
 if(contributor.portraitStatus==='approved')throw Error('Portrait already approved; reconcile before replacement');
 const form=await contributorForm(new Request('http://studio/contributors',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
 const photo=form.get('photo');if(!(photo instanceof File))throw Error('Supplied portrait required');
 // Validate before creating any job or changing contributor state.
 const probe=await import('node:os').then(m=>join(m.tmpdir(),'studio-portrait-'+crypto.randomUUID()+'.png'));
 await Bun.write(probe,photo);try{const result=Bun.spawnSync(['identify','-format','%w %h',probe]);const [w,h]=result.stdout.toString().trim().split(/\s+/).map(Number);if(result.exitCode!==0||!w||w!==h||w<768)throw Error('Supplied portrait must be square and at least 768 pixels');}finally{await Bun.file(probe).delete();}
 const prepared=createPortraitJob(id,actor,origin),input=prepared.triggerRequest.body.input;
 const path=join(input.outputDirectory,'supplied.png');await Bun.write(path,photo);
 applyPortraitResult(prepared.job!.id,input.webhook.token,{status:'ok',response:{prompt:'Operator-supplied finished contributor portrait. Source message '+body.approvalMessageId,model:'operator-supplied',candidates:[{path,mimeType:photo.type}]}});
 const candidate=getPortraitJob(prepared.job!.id)!.candidates[0]!;
 const approved=approvePortraitCandidate(candidate.id,actor);
 recordAuditEvent({actorPubkey:actor,action:'editorial.operator-contributor-portrait.applied',entityType:'contributor',entityId:id,detail:{approvalMessageId:body.approvalMessageId,storageObjectId:body.storageObjectId}});
 return approved;
}
