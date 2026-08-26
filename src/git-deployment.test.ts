import { describe, expect, test } from 'bun:test';
import { deploymentWorkflowRequest, publicationAuthorizesDeployment } from './git-deployment.ts';

describe('publicationAuthorizesDeployment', () => {
  test('requires the recorded main push and commit', () => {
    const publication = { status: 'published', mainPushed: true, commitSha: 'abc123' } as any;
    expect(publicationAuthorizesDeployment(publication)).toBe(true);
    expect(publicationAuthorizesDeployment({ ...publication, status: 'failed' })).toBe(false);
    expect(publicationAuthorizesDeployment({ ...publication, mainPushed: false })).toBe(false);
    expect(publicationAuthorizesDeployment({ ...publication, commitSha: null })).toBe(false);
  });
});

describe('deploymentWorkflowRequest', () => {
  test('explicitly dispatches the deployed branch without exposing the token in the URL or body', () => {
    const request = deploymentWorkflowRequest('secret-token');
    expect(request.url).toBe('https://api.github.com/repos/andymdavid/Intelligence-Snacks/actions/workflows/deploy-captain-b.yml/dispatches');
    expect(request.init.method).toBe('POST');
    expect(request.init.headers.Authorization).toBe('Bearer secret-token');
    expect(request.init.body).toBe(JSON.stringify({ ref: 'deployed' }));
    expect(`${request.url}${request.init.body}`).not.toContain('secret-token');
  });
});
