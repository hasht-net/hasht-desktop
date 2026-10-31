// Browser passkey step-ups for the app page: main opens the browser and waits
// for its `hasht://step-up` callback. One at a time; a newer one replaces the
// old. The code is useless without the page's own session, so a stray or
// forged callback can at most end the wait early.
const STEP_UP_TIMEOUT_MS = 3 * 60_000;

interface PendingStepUp {
  owner: number;
  resolve: (code: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

let pending: PendingStepUp | null = null;

function settle(code: string | null): void {
  const current = pending;
  if (!current) return;
  pending = null;
  clearTimeout(current.timer);
  current.resolve(code);
}

/** Resolves with the callback's code, or null on cancel, timeout or replacement. */
export function waitForStepUp(owner: number): Promise<string | null> {
  settle(null);
  return new Promise((resolve) => {
    pending = { owner, resolve, timer: setTimeout(() => settle(null), STEP_UP_TIMEOUT_MS) };
  });
}

export function cancelStepUp(owner: number): void {
  if (pending?.owner === owner) settle(null);
}

/**
 * Handles a `hasht://step-up?code=…` or `?cancelled=1` link. Null when the
 * link isn't a step-up callback; otherwise the waiting page's webContents id
 * (null if nothing was waiting), so main can bring its window forward.
 */
export function completeStepUp(link: string): { owner: number | null } | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== "hasht:" || url.hostname !== "step-up") return null;
  const owner = pending?.owner ?? null;
  const code = url.searchParams.get("code");
  if (code && /^[0-9a-f]{64}$/i.test(code)) settle(code);
  else if (url.searchParams.get("cancelled") === "1") settle(null);
  else return { owner: null };
  return { owner };
}
