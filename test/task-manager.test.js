const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TaskManager } = require('../build/core/task-manager');

test('TaskManager starts a task once and stops tasks in reverse order', async () => {
  const manager = new TaskManager();
  const events = [];
  let starts = 0;
  await manager.start('first', () => {
    starts++;
    events.push('start:first');
    return () => events.push('stop:first');
  });
  await manager.start('first', () => { starts++; });
  await manager.start('second', () => {
    events.push('start:second');
    return () => events.push('stop:second');
  });

  assert.equal(starts, 1);
  assert.deepEqual(manager.snapshot().map(task => task.status), ['running', 'running']);
  await manager.stopAll();
  assert.deepEqual(events, ['start:first', 'start:second', 'stop:second', 'stop:first']);
  assert.deepEqual(manager.snapshot().map(task => task.status), ['stopped', 'stopped']);
});

test('TaskManager records startup and shutdown failures without blocking other tasks', async () => {
  const manager = new TaskManager();
  let stopped = false;
  await manager.start('bad-start', () => { throw new Error('start failed'); });
  await manager.start('good', () => () => { stopped = true; });
  await manager.start('bad-stop', () => () => { throw new Error('stop failed'); });

  await manager.stopAll();
  const tasks = Object.fromEntries(manager.snapshot().map(task => [task.name, task]));
  assert.equal(tasks['bad-start'].status, 'failed');
  assert.match(tasks['bad-start'].lastError, /start failed/);
  assert.equal(tasks['bad-stop'].status, 'failed');
  assert.match(tasks['bad-stop'].lastError, /stop failed/);
  assert.equal(stopped, true);
});
