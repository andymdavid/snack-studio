import { describe, expect, test } from 'bun:test';
import { publicationAuthorizesDeployment } from './git-deployment.ts';

describe('publicationAuthorizesDeployment', () => {
  test('requires the recorded main push and commit', () => {
    const publication = { status: 'published', mainPushed: true, commitSha: 'abc123' } as any;
    expect(publicationAuthorizesDeployment(publication)).toBe(true);
    expect(publicationAuthorizesDeployment({ ...publication, status: 'failed' })).toBe(false);
    expect(publicationAuthorizesDeployment({ ...publication, mainPushed: false })).toBe(false);
    expect(publicationAuthorizesDeployment({ ...publication, commitSha: null })).toBe(false);
  });
});
