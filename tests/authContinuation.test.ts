import test from 'node:test';
import assert from 'node:assert/strict';
import { browserSignInOptions, continuationPath } from '../src/main/authContinuation.ts';

test('handoff only forwards validated form intent and same-instance navigation', () => {
  assert.deepEqual(browserSignInOptions({ invite: 'ABC123', register: true, username: ' alice ', displayName: 'Alice' }), {
    invite: 'ABC123', register: true, username: 'alice', displayName: 'Alice', path: '/invite/ABC123',
  });
  assert.deepEqual(browserSignInOptions({ invite: 'bad-code', register: 'true', username: 'a\nb', displayName: 'x'.repeat(256), path: 'https://evil.test' }), { path: '/' });
  for (const path of ['//evil.test', '/?token=secret', '/invite/ABC#secret', '/servers/123?native_auth=x']) assert.equal(continuationPath(path), null);
  assert.equal(continuationPath('/invite/ABC/'), '/invite/ABC');
  assert.equal(continuationPath('/servers/123-abc'), '/servers/123-abc');
});
