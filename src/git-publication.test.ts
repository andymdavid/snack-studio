import { describe, expect, test } from 'bun:test';
import { publicationCanResume, validationAuthorizesPublication } from './git-publication.ts';

const passedValidation = {
  id: 'validation-1',
  episodeId: 'episode-1',
  packageFingerprint: 'fingerprint-1',
  status: 'passed',
  websiteRepo: '/workspace/intelligence-snacks',
  baseCommit: 'abc123',
  worktreePath: '/tmp/validated-package',
  changedFiles: [],
  diffStat: '',
  textDiff: '',
  buildOutput: '',
  failureSummary: null,
  actorPubkey: 'pubkey',
  createdAt: 1,
  updatedAt: 1,
} as const;

describe('validationAuthorizesPublication', () => {
  test('accepts only the exact passed package with a resolved base and worktree', () => {
    expect(validationAuthorizesPublication('fingerprint-1', passedValidation)).toBe(true);
  });

  test('rejects stale or failed validation', () => {
    expect(validationAuthorizesPublication('fingerprint-2', passedValidation)).toBe(false);
    expect(validationAuthorizesPublication('fingerprint-1', { ...passedValidation, status: 'failed' })).toBe(false);
    expect(validationAuthorizesPublication('fingerprint-1', { ...passedValidation, baseCommit: '' })).toBe(false);
  });
});

describe('publicationCanResume', () => {
  const failedPublication = {
    status: 'failed', validationAttemptId: 'validation-1', packageFingerprint: 'fingerprint-1',
    commitSha: 'commit-1', cleanBuildOutput: 'build passed',
  } as any;

  test('reuses only a built commit from the exact failed validation', () => {
    expect(publicationCanResume(failedPublication, passedValidation, 'fingerprint-1')).toBe(true);
    expect(publicationCanResume({ ...failedPublication, cleanBuildOutput: null }, passedValidation, 'fingerprint-1')).toBe(false);
    expect(publicationCanResume({ ...failedPublication, validationAttemptId: 'other' }, passedValidation, 'fingerprint-1')).toBe(false);
    expect(publicationCanResume(failedPublication, passedValidation, 'other')).toBe(false);
  });
});
