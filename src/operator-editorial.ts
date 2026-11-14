import {publishValidatedPackageToMain,getLatestGitPublication} from './git-publication';
import {deployPublishedCommit} from './git-deployment';
import {createHash} from 'node:crypto';
import {getLatestPublicTranscript,reviewPublicTranscript} from './public-transcripts.ts';
import {setNewsletterItems} from './curation.ts';
import {getPublicationPreparation,listThumbnailJobs,getThumbnailJobDetail} from './thumbnails.ts';
import {buildPublicationPackage} from './publication-package.ts';
/** Explicit operator-directed editorial actions; deliberately separate from preparation automation. */
import {db} from './db.ts';
import {getEpisode,recordAuditEvent,updateEpisodeMetadata} from './episodes.ts';
import {assertUnpublishedCopyEditable,normalizeLegacyPublicTranscriptHeaders,planInspectionMetadata} from './inspection-input.ts';
import {getLatestWebsiteValidation,stageAndValidateWebsitePackage} from './website-validation.ts';
import {listCandidates,createCandidateRevision,updateCandidateDecision,setApprovedCandidateOrder,approveCandidateBatch} from './candidates.ts';
import {validateCandidateRevision} from './candidate-input.ts';
import {finalSetFingerprint} from './agent-production-policy.ts';
import {reuseReviewedSnackArtwork,preparePublicationThumbnails,uploadEpisodeThumbnail,approveThumbnailCandidate} from './thumbnails.ts';
function authority(body:Record<string,unknown>){if(body.operatorApproved!==true||typeof body.approvalMessageId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(body.approvalMessageId))throw Error('Explicit operator approval and source message reference required');}
function guards(episodeId:string,body:Record<string,unknown>){authority(body);const ep=getEpisode(episodeId);if(!ep)throw Error('Episode not found');if(body.expectedTranscriptRevisionId!==ep.activeTranscriptRevisionId)throw Error('Transcript changed');const candidates=listCandidates(episodeId);if(body.expectedFinalSetFingerprint!==finalSetFingerprint(candidates))throw Error('Snack set changed');return {ep,candidates};}

/** Finish the inspection package through the same guarded editor API; never push or deploy. */
export function prepareEpisodeInspection(episodeId:string,body:Record<string,unknown>,actor:string){
 const {ep}=guards(episodeId,body);
 if(ep.status!=='approved')throw Error('Approved copy required');
 if(body.validateWebsite!==undefined&&typeof body.validateWebsite!=='boolean')throw Error('validateWebsite must be boolean');
 if(body.normalizeTranscriptHeaders!==undefined&&typeof body.normalizeTranscriptHeaders!=='boolean')throw Error('normalizeTranscriptHeaders must be boolean');
 const metadata=planInspectionMetadata(ep,body.metadata??{});
 const transcript=body.normalizeTranscriptHeaders===true?getLatestPublicTranscript(episodeId):null;
 if(body.normalizeTranscriptHeaders===true&&(!transcript||transcript.status!=='approved'||transcript.id!==body.expectedPublicTranscriptId
   ||createHash('sha256').update(transcript.transcriptText).digest('hex')!==body.expectedPublicTranscriptSha256))throw Error('Reviewed public transcript changed');
 const changed=['publicTitle','publicSummary','videoUrl'].some(key=>metadata[key as keyof typeof metadata]!==ep[key as keyof typeof ep]);
 if(changed)updateEpisodeMetadata(episodeId,{...metadata,actorPubkey:actor});
 if(transcript){
   const normalized=normalizeLegacyPublicTranscriptHeaders(transcript.transcriptText);
   if(normalized!==transcript.transcriptText)reviewPublicTranscript({id:transcript.id,status:'approved',transcriptText:normalized,actorPubkey:actor});
 }
 const packageValue=buildPublicationPackage(episodeId);
 if(!packageValue.ready)throw Error('Finish the inspection package before validation: '+packageValue.blockers.map(b=>b.message).join(' '));
 let validation=getLatestWebsiteValidation(episodeId);
 if(body.validateWebsite===true)validation=stageAndValidateWebsitePackage(episodeId,actor);
 recordAuditEvent({actorPubkey:actor,action:'editorial.operator-inspection.prepared',entityType:'episode',entityId:episodeId,
   detail:{approvalMessageId:body.approvalMessageId,metadataKeys:Object.keys((body.metadata??{}) as object),normalizedPublicTranscriptId:transcript?.id??null,validationId:validation?.id??null,validationStatus:validation?.status??null}});
 return {episode:getEpisode(episodeId),package:packageValue,validation};
}
export function approveEditedCopy(episodeId:string,body:Record<string,unknown>,actor:string){return db.transaction(()=>{
 const {ep,candidates}=guards(episodeId,body);
 // Preparation approval must remain editable when the operator requests revisions.
 // Published content requires the separate publication reconciliation workflow.
 assertUnpublishedCopyEditable(candidates.map(c=>c.revision.publicState),Boolean(db.query("SELECT 1 FROM git_publication_attempts WHERE episode_id=?1 AND (main_pushed=1 OR status='published') LIMIT 1").get(episodeId)));
 if(!Array.isArray(body.articles)||body.articles.length!==candidates.length||![6,7].includes(candidates.length))throw Error('Complete set of six or seven Snacks required');
 const seen=new Set<string>();const plan=body.articles.map((raw:any)=>{
  if(typeof raw.candidateId!=='string'||seen.has(raw.candidateId))throw Error('Duplicate or invalid candidate ID');seen.add(raw.candidateId);
  const c=candidates.find(c=>c.id===raw.candidateId);if(!c||c.currentRevisionId!==raw.expectedCurrentRevisionId)throw Error('Snack revision changed');
  if(c.revision.publicState==='published')throw Error('Published copy cannot be edited here');
  const parsed=validateCandidateRevision({...c.revision,publicTitle:raw.publicTitle,editorialTitle:raw.editorialTitle??c.revision.editorialTitle,standfirst:raw.standfirst,bodyMarkdown:raw.bodyMarkdown,changeNote:'Operator-authorised surgical edit and approval; source message '+body.approvalMessageId});if(!parsed.ok)throw Error(parsed.error);
  if(/\b(?:Andy David|Pete Winn)\b|:/.test([parsed.value.publicTitle,parsed.value.standfirst,parsed.value.bodyMarkdown].join('\n')))throw Error('Copy still contains a full host name or colon');
  if(parsed.value.bodyMarkdown.split(/\n\s*\n/).length!==3)throw Error('Retain three body paragraphs');
  return {c,input:parsed.value};
 });
 for(const {c,input} of plan){
  const changed=input.publicTitle!==c.revision.publicTitle||input.editorialTitle!==c.revision.editorialTitle||input.standfirst!==c.revision.standfirst||input.bodyMarkdown!==c.revision.bodyMarkdown;
  if(changed){const updated=createCandidateRevision(c.id,input,actor)!;const r=c.revision;db.query(`UPDATE snack_revisions SET pipeline_request_id=?1,pipeline_run_id=?2,source_transcript_revision_id=?3,prompt_suite_version=?4,pipeline_version=?5,result_schema_version=?6,claim_evidence_json=?7,validation_warnings_json=?8 WHERE id=?9`).run(r.pipelineRequestId,r.pipelineRunId,r.sourceTranscriptRevisionId,r.promptSuiteVersion,r.pipelineVersion,r.resultSchemaVersion,JSON.stringify(r.claimEvidenceMap),JSON.stringify(r.validationWarnings),updated.currentRevisionId);}
  updateCandidateDecision(c.id,'accepted',actor);
 }
 setApprovedCandidateOrder(episodeId,plan.map(p=>p.c.id),actor);const approvedBatch=approveCandidateBatch(episodeId,actor);
 recordAuditEvent({actorPubkey:actor,action:'editorial.operator-approval.applied',entityType:'episode',entityId:episodeId,detail:{approvalMessageId:body.approvalMessageId,candidateIds:approvedBatch.candidateIds}});
 return {episode:getEpisode(episodeId),candidates:listCandidates(episodeId),approvedBatch};
})();}
export async function useSuppliedEpisodeThumbnail(episodeId:string,body:Record<string,unknown>,actor:string){
 const {ep}=guards(episodeId,body);if(ep.status!=='approved')throw Error('Approve copy before preparing artwork');
 if(typeof body.imageBase64!=='string'||body.imageBase64.length>21_000_000||body.contentType!=='image/png')throw Error('Supply a PNG up to 15 MB');
 const bytes=Buffer.from(body.imageBase64,'base64');if(!bytes.length||bytes.length>15*1024*1024)throw Error('Invalid image size');
 if(body.confirmedEpisodeNumber!==ep.episodeNumber)throw Error('Confirm the episode number for the supplied image');
 const prep=preparePublicationThumbnails(episodeId,actor);const job=prep.jobs.find(j=>j.assetKind==='episode');if(!job)throw Error('Episode thumbnail job missing');
 if(job.status==='approved'){
  assertUnpublishedCopyEditable([],Boolean(db.query("SELECT 1 FROM git_publication_attempts WHERE episode_id=?1 AND (main_pushed=1 OR status='published') LIMIT 1").get(episodeId)));
  if(!job.selectedCandidateId||body.expectedSelectedCandidateId!==job.selectedCandidateId)throw Error('Confirm the current selected thumbnail before replacing approved artwork');
 }
 const uploaded=await uploadEpisodeThumbnail(job.id,new File([bytes],String(body.fileName||'episode-thumbnail.png'),{type:'image/png'}),actor);
 const candidate=uploaded.candidates[0];if(!candidate||candidate.modelName!=='upload')throw Error('Uploaded thumbnail candidate missing');
 const approved=approveThumbnailCandidate(candidate.id,actor);
 recordAuditEvent({actorPubkey:actor,action:'editorial.operator-thumbnail.applied',entityType:'episode',entityId:episodeId,detail:{approvalMessageId:body.approvalMessageId,storageObjectId:body.storageObjectId,jobId:job.id}});
 return {job:approved};
}

/** Apply individually reviewed choices; no generation, publication or deployment. */
export function approvePreparation(episodeId:string,body:Record<string,unknown>,actor:string){return db.transaction(()=>{
 const {ep,candidates}=guards(episodeId,body);if(ep.status!=='approved')throw Error('Approved copy required');
 const transcript=getLatestPublicTranscript(episodeId);
 if(!transcript||transcript.id!==body.publicTranscriptId||transcript.sourceTranscriptRevisionId!==ep.activeTranscriptRevisionId||createHash('sha256').update(transcript.transcriptText).digest('hex')!==body.publicTranscriptSha256)throw Error('Reviewed public transcript changed');
 if(!Array.isArray(body.newsletterCandidateIds)||![3,4].includes(body.newsletterCandidateIds.length)||new Set(body.newsletterCandidateIds).size!==body.newsletterCandidateIds.length||body.newsletterCandidateIds.some((id:any)=>!candidates.some(c=>c.id===id&&c.reviewDecision==='accepted')))throw Error('Select three or four approved Snacks');
 if(!Array.isArray(body.thumbnailCandidateIds))throw Error('Reviewed artwork required');
 const jobs=listThumbnailJobs(episodeId);const seen=new Set<string>();
 for(const id of body.thumbnailCandidateIds){const job=jobs.find(j=>getThumbnailJobDetail(j.id)?.candidates.some(c=>c.id===id));if(!job||seen.has(job.id)||!['in-review','approved'].includes(job.status))throw Error('Artwork changed or duplicated');seen.add(job.id);}
 for(const id of body.thumbnailCandidateIds)approveThumbnailCandidate(String(id),actor);
 reviewPublicTranscript({id:transcript.id,status:'approved',actorPubkey:actor});
 setNewsletterItems(episodeId,body.newsletterCandidateIds.map(String),actor);
 recordAuditEvent({actorPubkey:actor,action:'editorial.operator-preparation.applied',entityType:'episode',entityId:episodeId,detail:{approvalMessageId:body.approvalMessageId,thumbnailCandidateIds:body.thumbnailCandidateIds,publicTranscriptId:transcript.id,newsletterCandidateIds:body.newsletterCandidateIds}});
 return {package:buildPublicationPackage(episodeId)};
})();}

export function reuseEpisodeArtwork(episodeId:string,body:Record<string,unknown>,actor:string){return db.transaction(()=>{
 const {candidates}=guards(episodeId,body);
 assertUnpublishedCopyEditable(candidates.map(c=>c.revision.publicState),Boolean(db.query("SELECT 1 FROM git_publication_attempts WHERE episode_id=?1 AND (main_pushed=1 OR status='published') LIMIT 1").get(episodeId)));
 if(!Array.isArray(body.reuses)||!body.reuses.length||body.reuses.length>7)throw Error('Explicit artwork reuse list required');
 const current=getPublicationPreparation(episodeId).jobs;const results=[];
 for(const item of body.reuses){const target=current.find(j=>j.id===item.targetJobId);if(!target||target.assetKind!=='snack')throw Error('Target is not a current Snack revision');results.push(reuseReviewedSnackArtwork(item.sourceJobId,item.targetJobId,item.expectedSelectedCandidateId,actor));}
 return {jobs:results};
})();}

/** Explicit operator release; preparation-only access never reaches this operation. */
export async function releaseEpisode(episodeId:string,body:Record<string,unknown>,actor:string,operation:'publish'|'deploy'){
 guards(episodeId,body);
 const validation=getLatestWebsiteValidation(episodeId);
 const packageValue=buildPublicationPackage(episodeId);
 if(!packageValue.ready||!validation||validation.status!=='passed'||body.expectedValidationId!==validation.id||validation.packageFingerprint!==packageValue.fingerprint)throw Error('Current passing validation required');
 if(operation==='publish')return {publication:publishValidatedPackageToMain(episodeId,actor)};
 const publication=getLatestGitPublication(episodeId);
 if(!publication||body.expectedPublicationId!==publication.id||publication.packageFingerprint!==packageValue.fingerprint)throw Error('Current publication required');
 return {deployment:await deployPublishedCommit(episodeId,actor)};
}
