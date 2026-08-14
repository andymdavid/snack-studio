import { describe, expect, test } from 'bun:test';
import { gitEnvironment } from './git-auth.ts';

describe('gitEnvironment', () => {
  test('leaves the environment alone when no GitHub token is configured', () => {
    const source = { PATH: '/usr/bin' };
    expect(gitEnvironment(source)).toBe(source);
  });

  test('adds an explicit GitHub credential helper while preserving existing git config', () => {
    const result = gitEnvironment({
      WINGMAN_GITHUB_USERNAME: 'studio-user',
      WINGMAN_GITHUB_TOKEN: 'secret-token',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '*',
    });

    expect(result.GIT_CONFIG_COUNT).toBe('2');
    expect(result.GIT_CONFIG_KEY_0).toBe('safe.directory');
    expect(result.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(result.GIT_CONFIG_VALUE_1).toContain('WINGMAN_GITHUB_TOKEN');
    expect(result.GIT_CONFIG_VALUE_1).not.toContain('secret-token');
  });
});
