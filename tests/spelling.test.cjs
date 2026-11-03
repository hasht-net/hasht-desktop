const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

function load() {
  let now = 1_000;
  let learnHandler;
  const exports = {};
  vm.runInNewContext(readFileSync(path.join(__dirname, "../dist/main/spelling.js"), "utf8"), {
    exports, Date: { now: () => now },
    require(name) {
      if (name === "electron") return { ipcMain: { handle(channel, handler) { if (channel === "spelling:learn") learnHandler = handler; } } };
      return require(name);
    },
  });
  const learned = [];
  const sent = [];
  const listeners = {};
  const contents = {
    id: 7, mainFrame: { name: "main" },
    session: { addWordToSpellCheckerDictionary: (word) => { learned.push(word); return true; } },
    on(event, handler) { listeners[event] = handler; },
    once() {},
    send: (channel, payload) => sent.push([channel, payload]),
  };
  exports.enableSpelling(contents);
  const rightClick = (params) => listeners["context-menu"]({}, {
    isEditable: true, misspelledWord: "", dictionarySuggestions: [], ...params,
  });
  const learn = (senderFrame = contents.mainFrame) => learnHandler({ sender: contents, senderFrame });
  return { rightClick, learn, learned, sent, advance: (ms) => { now += ms; } };
}

test("an editable right-click reports the word and at most five suggestions", () => {
  const { rightClick, sent } = load();
  rightClick({ misspelledWord: "teh", dictionarySuggestions: ["the", "ten", "tea", "tech", "eh", "tee"] });
  rightClick({ isEditable: false, misspelledWord: "teh" });
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [["spelling-context", { word: "teh", suggestions: ["the", "ten", "tea", "tech", "eh"] }]]);
});

test("only the right-clicked word is learned, once, from the main frame", () => {
  const { rightClick, learn, learned, advance } = load();
  assert.equal(learn(), false);
  rightClick({ misspelledWord: "hasht" });
  assert.equal(learn({ name: "subframe" }), false);
  assert.equal(learn(), true);
  assert.equal(learn(), false);
  rightClick({ misspelledWord: "zzqx" });
  advance(30_001);
  assert.equal(learn(), false);
  rightClick({ misspelledWord: "zzqx" });
  rightClick({ misspelledWord: "" });
  assert.equal(learn(), false);
  assert.deepEqual(learned, ["hasht"]);
});
