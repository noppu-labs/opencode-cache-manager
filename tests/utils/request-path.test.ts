import { describe, expect, test } from 'bun:test';

import { isPostToPathSuffix } from '../../src/utils/request-path.ts';

describe('isPostToPathSuffix', () => {
  test('matches a POST whose path ends in the suffix, on any host', () => {
    expect(
      isPostToPathSuffix(
        new Request('https://a.example/v1/messages', { method: 'POST' }),
        '/messages'
      )
    ).toBe(true);
    expect(
      isPostToPathSuffix(
        new Request('http://localhost:1/x/chat/completions?q=1', { method: 'POST' }),
        '/chat/completions'
      )
    ).toBe(true);
  });

  test('rejects other methods, other paths and a suffix only in the query', () => {
    expect(isPostToPathSuffix(new Request('https://a.example/v1/messages'), '/messages')).toBe(
      false
    );
    expect(
      isPostToPathSuffix(
        new Request('https://a.example/v1/embeddings', { method: 'POST' }),
        '/messages'
      )
    ).toBe(false);
    expect(
      isPostToPathSuffix(
        new Request('https://a.example/v1?p=/messages', { method: 'POST' }),
        '/messages'
      )
    ).toBe(false);
  });

  test('a malformed URL is false', () => {
    expect(isPostToPathSuffix({ method: 'POST', url: 'not a url' } as Request, '/messages')).toBe(
      false
    );
  });
});
