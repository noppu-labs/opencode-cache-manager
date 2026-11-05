import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import { dbgUrl } from '../../src/utils/debug-log.ts';

const label = fc.stringMatching(/^[a-z]{1,8}$/u);

/** Uppercase, while the URL's host and path are lowercase, so a match can only be a leak. */
const secret = fc.stringMatching(/^[A-Z]{1,12}$/u);

describe('dbgUrl properties', () => {
  test('never throws, whatever string it is given', () => {
    const input = fc.oneof(
      fc.string(),
      fc.string({ unit: 'binary' }),
      fc.webUrl({ withFragments: true, withQueryParameters: true })
    );
    fc.assert(
      fc.property(input, (url) => {
        expect(typeof dbgUrl(url)).toBe('string');
      })
    );
  });

  test('a URL with a query and credentials keeps only its origin and path', () => {
    const url = fc.record({
      host: fc.array(label, { maxLength: 3, minLength: 2 }),
      password: secret,
      path: fc.array(label, { maxLength: 3 }),
      queryKey: secret,
      queryValue: secret,
      scheme: fc.constantFrom('http', 'https'),
      user: secret,
    });
    fc.assert(
      fc.property(url, ({ host, password, path, queryKey, queryValue, scheme, user }) => {
        const origin = `${scheme}://${host.join('.')}`;
        const pathname = `/${path.join('/')}`;
        const logged = dbgUrl(
          `${scheme}://${user}:${password}@${host.join('.')}${pathname}?${queryKey}=${queryValue}`
        );

        expect(logged).toBe(`${origin}${pathname}`);
        for (const value of [user, password, queryKey, queryValue]) {
          expect(logged).not.toContain(value);
        }
      })
    );
  });
});
