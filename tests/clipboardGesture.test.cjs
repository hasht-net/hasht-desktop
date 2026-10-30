const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

function preload() {
  const handlers = {};
  const signals = [];
  let now = 100_000;
  class Element {
    constructor(kind) { this.kind = kind; this.disabled = kind === 'disabled'; }
    closest(selector) {
      if (selector === '.md-composer') return this.kind === 'composer' ? this : null;
      if (selector === '.composer-clipboard-menu') return ['Paste', 'Copy', 'disabled'].includes(this.kind) ? this : null;
      if (selector === '.composer-clipboard-menu button[role=menuitem]') return ['Paste', 'Copy', 'disabled'].includes(this.kind) ? this : null;
      return null;
    }
    querySelector() { return { textContent: this.kind === 'disabled' ? 'Paste' : this.kind }; }
  }
  vm.runInNewContext(readFileSync(path.join(__dirname, '../dist/preload/serverPreload.js'), 'utf8'), {
    exports: {}, Element, Date: { now: () => now },
    process: { platform: 'win32', argv: [] },
    window: { addEventListener(name, handler) { (handlers[name] ??= []).push(handler); } },
    require() { return {
      contextBridge: { exposeInMainWorld() {}, executeInMainWorld() {} },
      ipcRenderer: { on() {}, sendSync(channel) { signals.push(channel); } },
    }; },
  });
  return {
    signals,
    advance(ms) { now += ms; },
    fire(type, kind = 'composer', extra = {}) {
      for (const handler of handlers[type] ?? []) handler({ isTrusted: true, target: new Element(kind), ...extra });
    },
  };
}

test('trusted context-menu followed by a Paste click signals main, including Control-click', () => {
  const p = preload();
  p.fire('contextmenu', 'composer', { ctrlKey: true, button: 2 });
  p.fire('pointerdown', 'Paste');
  p.fire('click', 'Paste');
  assert.deepEqual(p.signals, ['clipboard-paste-gesture']);
  p.fire('click', 'Paste');
  assert.equal(p.signals.length, 1);
});

test('keyboard activation of Paste works after a trusted context menu', () => {
  const p = preload();
  p.fire('contextmenu');
  p.fire('keydown', 'Paste', { key: 'ArrowDown' });
  p.fire('keydown', 'Paste', { key: 'Enter' });
  p.fire('click', 'Paste', { detail: 0 });
  assert.equal(p.signals.length, 1);
});

test('opening a context menu alone does not signal main', () => {
  const p = preload();
  p.fire('contextmenu');
  assert.deepEqual(p.signals, []);
});

for (const kind of ['Copy', 'disabled', 'outside']) {
  test(`${kind} click cannot unlock the prompt`, () => {
    const p = preload();
    p.fire('contextmenu');
    p.fire('click', kind);
    assert.deepEqual(p.signals, []);
  });
}

test('synthetic context menus and clicks cannot unlock the prompt', () => {
  const p = preload();
  p.fire('contextmenu', 'composer', { isTrusted: false });
  p.fire('click', 'Paste');
  p.fire('contextmenu');
  p.fire('click', 'Paste', { isTrusted: false });
  assert.deepEqual(p.signals, []);
});

for (const key of ['a', 'Escape', 'Tab']) {
  test(`${key} dismisses the gesture before later Paste`, () => {
    const p = preload();
    p.fire('contextmenu');
    p.fire('keydown', 'composer', { key });
    p.fire('click', 'Paste');
    assert.deepEqual(p.signals, []);
  });
}

test('an outside press or expired menu cannot unlock the prompt', () => {
  const p = preload();
  p.fire('contextmenu');
  p.fire('pointerdown', 'outside');
  p.fire('click', 'Paste');
  p.fire('contextmenu');
  p.advance(30_001);
  p.fire('click', 'Paste');
  assert.deepEqual(p.signals, []);
});
