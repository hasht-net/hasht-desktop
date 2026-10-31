import test from 'node:test';
import assert from 'node:assert/strict';
import { cancelStepUp, completeStepUp, waitForStepUp } from '../src/main/securityStepUp.ts';

const code = 'a'.repeat(64);

test('a step-up callback resolves the waiting page with its code', async () => {
  const waiting = waitForStepUp(7);
  assert.deepEqual(completeStepUp(`hasht://step-up?code=${code}`), { owner: 7 });
  assert.equal(await waiting, code);
  assert.deepEqual(completeStepUp(`hasht://step-up?code=${code}`), { owner: null }, 'nothing waits after it settled');
});

test('cancel, a newer step-up, or a cancelled callback resolve null', async () => {
  const first = waitForStepUp(1);
  const second = waitForStepUp(2);
  assert.equal(await first, null);
  cancelStepUp(1);
  assert.deepEqual(completeStepUp('hasht://step-up?cancelled=1'), { owner: 2 });
  assert.equal(await second, null);
  const third = waitForStepUp(3);
  cancelStepUp(3);
  assert.equal(await third, null);
});

test('other links and malformed codes are left alone', async () => {
  assert.equal(completeStepUp(`hasht://auth?request_id=x&code=${code}`), null);
  assert.equal(completeStepUp('not a url'), null);
  const waiting = waitForStepUp(4);
  assert.deepEqual(completeStepUp('hasht://step-up?code=123456'), { owner: null });
  assert.deepEqual(completeStepUp(`hasht://step-up?code=${code}`), { owner: 4 });
  assert.equal(await waiting, code);
});
