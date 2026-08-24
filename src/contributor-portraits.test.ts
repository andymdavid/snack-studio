import { describe, expect, test } from 'bun:test';
import { verifyPortraitCallbackToken } from './contributor-portraits.ts';

describe('contributor portrait callback verification', () => {
  test('rejects an unknown job and callback credential', () => {
    expect(verifyPortraitCallbackToken('missing-portrait-job', 'not-a-callback-token')).toBe(false);
  });
});
