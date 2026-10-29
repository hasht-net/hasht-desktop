import test from 'node:test';
import assert from 'node:assert/strict';
import { browserSignInOptions, continuationPath, signupFragment } from '../src/main/authContinuation.ts';

test('handoff only forwards validated form intent and same-instance navigation', () => {
  assert.deepEqual(browserSignInOptions({ invite: 'ABC123', register: true, username: ' alice ', displayName: 'Alice' }), {
    invite: 'ABC123', register: true, username: 'alice', displayName: 'Alice', path: '/invite/ABC123',
  });
  assert.deepEqual(browserSignInOptions({ invite: 'bad-code', register: 'true', username: 'a\nb', displayName: 'x'.repeat(256), path: 'https://evil.test' }), { path: '/' });
  for (const path of ['//evil.test', '/?token=secret', '/invite/ABC#secret', '/servers/123?native_auth=x']) assert.equal(continuationPath(path), null);
  assert.equal(continuationPath('/invite/ABC/'), '/invite/ABC');
  assert.equal(continuationPath('/servers/123-abc'), '/servers/123-abc');
});

test('signup details are validated and carried in a URLSearchParams fragment', () => {
  const options = browserSignInOptions({
    register: true, email: ' a+b@example.com ', birthday: '1990-05-04', birthdayVisibility: 'month_day',
  });
  assert.equal(options.email, 'a+b@example.com');
  assert.equal(options.birthday, '1990-05-04');
  assert.equal(options.birthdayVisibility, 'month_day');
  const fragment = signupFragment(options);
  const parsed = new URLSearchParams(fragment);
  assert.equal(parsed.get('email'), 'a+b@example.com');
  assert.equal(parsed.get('birthday'), '1990-05-04');
  assert.equal(parsed.get('birthday_visibility'), 'month_day');

  assert.deepEqual(browserSignInOptions({
    email: 'a b@example.com', birthday: '1990-02-30', birthdayVisibility: 'everyone',
  }), { path: '/' });
  assert.deepEqual(browserSignInOptions({ email: 'no-at-sign', birthday: 'May 4' }), { path: '/' });
  assert.deepEqual(browserSignInOptions({ email: `${'x'.repeat(250)}@e.co` }), { path: '/' });
  assert.equal(signupFragment({}), '');
});
