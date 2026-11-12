import {createHash} from 'node:crypto';
import {getLatestPublicTranscript,reviewPublicTranscript} from './public-transcripts.ts';
import {setNewsletterItems} from './curation.ts';
import {listThumbnailJobs,getThumbnailJobDetail} from './thumbnails.ts';
import {buildPublicationPackage} from './publication-package.ts';
/** Explicit operator-directed editorial actions; deliberately separate from preparation automation. */
import {db} from './db.ts';
import {getEpisode,recordAuditEvent} from './episodes.ts';
import {listCandidates,createCandidateRevision,updateCandidateDecision,setApprovedCandidateOrder,approveCandidateBatch} from './candidates.ts';
import {validateCandidateRevision} from './candidate-input.ts';
import {finalSetFingerprint} from './agent-production-policy.ts';
import {preparePublicationThumbnails,uploadEpisodeThumbnail,approveThumbnailCandidate} from './thumbnails.ts';
function authority(body:Record<string,unknown>){if(body.operatorApproved!==true||typeof body.approvalMessageId!=='string'||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(body.approvalMessageId))throw Error('Explicit operator approval and source message reference required');}
function guards(episodeId:string,body:Record<string,unknown>){authority(body);const ep=getEpisode(episodeId);if(!ep)throw Error('Episode not found');if(body.expectedTranscriptRevisionId!==ep.activeTranscriptRevisionId)throw Error('Transcript changed');const candidates=listCandidates(episodeId);if(body.expectedFinalSetFingerprint!==finalSetFingerprint(candidates))throw Error('Snack set changed');return {ep,candidates};}
export function approveEditedCopy(episodeId:string,body:Record<string,unknown>,actor:string){return db.transaction(()=>{
 const {ep,candidates}=guards(episodeId,body);if(ep.status==='approved')throw Error('Episode already approved; reconcile before editing');
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
 if(job.status==='approved')throw Error('Episode thumbnail already approved; reconcile before replacing');
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
