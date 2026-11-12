import {db} from './db.ts';
import {getEpisode} from './episodes.ts';
import {createCandidateRevision,listCandidates,type SnackCandidate} from './candidates.ts';
import {validateCandidateRevision} from './candidate-input.ts';
export const HUMANIZER_COMMIT='a58df065367550b6ce40ff3f648335018d8e0589';
export function planHumanizerRevisions(current:SnackCandidate[],body:Record<string,unknown>){
  if(body.skillCommit!==HUMANIZER_COMMIT)throw Error('Pinned Humanizer commit required');
  if(!Array.isArray(body.articles)||body.articles.length!==current.length||!current.length)throw Error('Complete existing Snack set required');
  const seen=new Set<string>();
  return body.articles.map((raw:any)=>{
    if(typeof raw.candidateId!=='string'||seen.has(raw.candidateId))throw Error('Duplicate or invalid candidate ID');seen.add(raw.candidateId);
    const c=current.find(c=>c.id===raw.candidateId);
    if(!c||c.selectionId!==raw.selectionId)throw Error('Unknown candidate or selection');
    if(c.currentRevisionId!==raw.expectedCurrentRevisionId)throw Error('Snack revision changed; reconcile before editing');
    if(c.reviewDecision==='accepted'||c.revision.publicState==='published')throw Error('Approved or published copy cannot be replaced here');
    if(!Array.isArray(raw.paragraphs)||raw.paragraphs.length!==3||raw.paragraphs.some((p:any)=>typeof p!=='string'||!p.trim())||raw.paragraphs.join(' ').trim().split(/\s+/).length>275)throw Error('Three complete paragraphs, at most 275 words required');
    if(!Array.isArray(raw.reviewNotes)||raw.reviewNotes.length>20||raw.reviewNotes.some((x:any)=>typeof x!=='string'||x.length>1500))throw Error('Invalid review notes');
    const r=c.revision;
    const parsed=validateCandidateRevision({...r,publicTitle:raw.publicTitle,editorialTitle:raw.publicTitle,standfirst:raw.standfirst,bodyMarkdown:raw.paragraphs.join('\n\n'),changeNote:'Applied reviewed Humanizer comparison, pinned commit '+HUMANIZER_COMMIT+'. Original v13 copy retained in revision history. Not publication approval.'});
    if(!parsed.ok)throw Error(parsed.error);
    return {candidate:c,input:parsed.value,reviewNotes:raw.reviewNotes};
  });
}
export function applyHumanizerRevisions(episodeId:string,body:Record<string,unknown>,actorPubkey:string){
 return db.transaction(()=>{
  const episode=getEpisode(episodeId);if(!episode)throw Error('Episode not found');
  if(episode.status==='approved')throw Error('Approved episode cannot be edited here');
  if(body.expectedTranscriptRevisionId!==episode.activeTranscriptRevisionId)throw Error('Transcript changed; reconcile before editing');
  const plan=planHumanizerRevisions(listCandidates(episodeId),body);
  for(const p of plan){
    const updated=createCandidateRevision(p.candidate.id,p.input,actorPubkey);if(!updated)throw Error('Candidate disappeared');
    const r=p.candidate.revision;
    // This is an editorial revision of the v13 generation, not a newly executed pipeline.
    db.query(`UPDATE snack_revisions SET pipeline_request_id=?1,pipeline_run_id=?2,source_transcript_revision_id=?3,prompt_suite_version=?4,pipeline_version=?5,result_schema_version=?6,claim_evidence_json=?7,validation_warnings_json=?8 WHERE id=?9`).run(r.pipelineRequestId,r.pipelineRunId,r.sourceTranscriptRevisionId,r.promptSuiteVersion,r.pipelineVersion,r.resultSchemaVersion,JSON.stringify(r.claimEvidenceMap),JSON.stringify([...r.validationWarnings,...p.reviewNotes.map((n:string)=>'Humanizer review: '+n)]),updated.currentRevisionId);
  }
  return listCandidates(episodeId);
 })();
}
