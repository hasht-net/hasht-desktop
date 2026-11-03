import { ipcMain, type WebContents } from "electron";

const MAX_SUGGESTIONS = 5;

// The page draws its own context menu, so main hands it the spelling that only
// Chromium knows. A page may only add the word the user just right-clicked: on
// macOS this is the system-wide dictionary.
const LEARN_WINDOW_MS = 30_000;

const learnHandlers = new Map<number, (event: Electron.IpcMainInvokeEvent) => boolean>();
let learnListenerInstalled = false;

export function enableSpelling(contents: WebContents): void {
  let clicked: { word: string; at: number } | null = null;
  contents.on("context-menu", (_event, params) => {
    if (!params.isEditable) return;
    clicked = params.misspelledWord ? { word: params.misspelledWord, at: Date.now() } : null;
    contents.send("spelling-context", {
      word: params.misspelledWord,
      suggestions: params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS),
    });
  });

  if (!learnListenerInstalled) {
    ipcMain.handle("spelling:learn", (event) => learnHandlers.get(event.sender.id)?.(event) ?? false);
    learnListenerInstalled = true;
  }
  const id = contents.id;
  learnHandlers.set(id, (event) => {
    if (event.senderFrame !== contents.mainFrame) return false;
    const word = clicked && Date.now() - clicked.at <= LEARN_WINDOW_MS ? clicked.word : null;
    clicked = null;
    return word ? contents.session.addWordToSpellCheckerDictionary(word) : false;
  });
  contents.once("destroyed", () => learnHandlers.delete(id));
}
