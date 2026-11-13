import {test,expect} from 'bun:test';
import type {Episode} from './episodes.ts';
import {planInspectionMetadata} from './inspection-input.ts';

const episode = {episodeNumber:59,workingTitle:'AI Hate',publicTitle:null,publicSummary:null,
  primaryTopic:null,recordedOn:'2025-01-01',audioUrl:'https://example.com/audio',videoUrl:null,
  editorialNotes:'Keep source',activeTranscriptRevisionId:'source',status:'approved'} as Episode;

test('inspection adds public video metadata while retaining episode identity and existing metadata',()=>{
  const result=planInspectionMetadata(episode,{videoUrl:'https://www.youtube.com/watch?v=4KJc8KjzjEc',publicSummary:'An episode summary.'});
  expect(result).toMatchObject({episodeNumber:59,workingTitle:'AI Hate',recordedOn:'2025-01-01',
    audioUrl:'https://example.com/audio',editorialNotes:'Keep source',videoUrl:'https://www.youtube.com/watch?v=4KJc8KjzjEc'});
  expect(episode.videoUrl).toBeNull();
});
test('inspection rejects identity, source and release controls',()=>{
  for(const patch of [{episodeNumber:60},{activeTranscriptRevisionId:'other'},{status:'published'},{publish:true},[]]) {
    expect(()=>planInspectionMetadata(episode,patch)).toThrow('Inspection metadata accepts only');
  }
});
test('inspection uses existing URL and text validation',()=>{
  expect(()=>planInspectionMetadata(episode,{videoUrl:'javascript:alert(1)'})).toThrow('http(s)');
  expect(()=>planInspectionMetadata(episode,{publicSummary:'x'.repeat(501)})).toThrow('allowed length');
});
