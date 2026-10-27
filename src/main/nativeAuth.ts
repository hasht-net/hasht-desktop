import { net, shell } from "electron";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import type { ServerEntry } from "./serverStore";

import { browserSignInOptions, type BrowserSignInOptions } from "./authContinuation";

export const PROTOCOL = "hasht";

// Passkey sign-in handed off to the system browser, for platforms where an
// in-shell WebAuthn ceremony can't run (macOS Electron — electron#24573). The
// browser runs the ceremony and sends a one-time code back over `hasht://`.
//
// Any app can claim that scheme, so the code alone is deliberately useless:
// redeeming it also requires the verifier, which never leaves this process.
interface PendingHandoff {
  serverId: string;
  serverUrl: string;
  verifier: string;
  path: string;
  register: boolean;
}

const pending = new Map<string, PendingHandoff>();
// Requests with an exchange in flight. The same callback can arrive twice
// (the browser's "Open Hasht?" prompt plus the approve page's "Return to the
// app" button), and the server redeems a code once — the second exchange would
// fail and show an error after the first had already signed the user in.
const redeeming = new Set<string>();

export interface AuthResult {
  serverId: string;
  /** The server's own auth response, passed through to the page untouched. */
  auth: unknown;
}

/** Opens the browser leg immediately. External sign-in links first confirm the
 * destination host; approval and any step-up happen on the browser page.
 * The deprecated match code remains in the return shape for older frontends. */
export async function beginBrowserSignIn(
  entry: ServerEntry,
  confirm?: () => Promise<boolean>,
  options: BrowserSignInOptions = {},
): Promise<{ match_code: string }> {
  options = browserSignInOptions(options);
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("hex");

  const res = await net.fetch(
    new URL("/api/auth/native/start", entry.url).toString(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge, device_label: `Hasht on ${os.hostname()} (${os.platform()})` }),
    },
  );
  if (res.status === 404) {
    throw new Error(
      "This server hasn't enabled desktop sign-in. Ask the admin to turn it on, or sign in with a password.",
    );
  }
  if (!res.ok) {
    throw new Error(`Couldn't start sign-in (${res.status}).`);
  }

  const { request_id, match_code } = (await res.json()) as {
    request_id: string;
    match_code: string;
  };
  pending.set(request_id, { serverId: entry.id, serverUrl: entry.url, verifier, path: options.path ?? "/", register: options.register === true });

  const target = new URL(entry.url);
  target.pathname = "/";
  target.search = "";
  target.hash = "";
  target.searchParams.set("native_auth", request_id);
  if (options.invite) target.searchParams.set("invite", options.invite);
  if (options.register) target.searchParams.set("register", "1");
  if (options.username) target.searchParams.set("username", options.username);
  if (options.displayName) target.searchParams.set("display_name", options.displayName);
  if (confirm && !(await confirm())) {
    pending.delete(request_id);
    return { match_code };
  }
  await shell.openExternal(target.toString());

  return { match_code };
}

/**
 * Redeems a `hasht://auth?request_id=…&code=…` callback. Returns null
 * for anything we weren't waiting for, so a stray or forged deep link is a
 * no-op rather than an error the user has to interpret.
 */
export async function completeBrowserSignIn(
  deepLink: string,
): Promise<AuthResult | null> {
  let url: URL;
  try {
    url = new URL(deepLink);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL}:` || url.hostname !== "auth") return null;

  const requestId = url.searchParams.get("request_id");
  const code = url.searchParams.get("code");
  if (!requestId) return null;
  if (url.searchParams.get("cancelled") === "1") {
    pending.delete(requestId);
    return null;
  }
  if (!code) return null;

  const handoff = pending.get(requestId);
  if (!handoff || redeeming.has(requestId)) return null;

  redeeming.add(requestId);
  try {
    return await redeem(requestId, code, handoff);
  } finally {
    redeeming.delete(requestId);
  }
}

export function cancelBrowserSignIn(serverId: string): void {
  for (const [id, handoff] of pending) if (handoff.serverId === serverId) pending.delete(id);
}

async function redeem(
  requestId: string,
  code: string,
  handoff: PendingHandoff,
): Promise<AuthResult | null> {
  const res = await net.fetch(
    new URL("/api/auth/native/exchange", handoff.serverUrl).toString(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: requestId,
        code,
        verifier: handoff.verifier,
      }),
    },
  );
  // A wrong verifier now leaves the request redeemable server-side, so only
  // drop our copy once the exchange has actually succeeded — a lost response
  // on a flaky connection can then be retried.
  if (!res.ok) {
    throw new Error("That sign-in link didn't work — try again from the app.");
  }
  const auth = await res.json() as { token?: string };
  if (pending.get(requestId) !== handoff) {
    if (auth.token) await net.fetch(new URL("/api/auth/logout", handoff.serverUrl).toString(), {
      method: "POST", headers: { Authorization: `Bearer ${auth.token}` }, redirect: "error",
    }).catch(() => {});
    return null;
  }
  pending.delete(requestId);

  return { serverId: handoff.serverId, auth: { ...auth, continuation_path: handoff.path, registration_intent: handoff.register } };
}

/**
 * The server named by a `hasht://signin?server=<origin>` link — the web app's
 * "Sign in to the App" setting. Any page can send that link naming any host,
 * so only an https origin is accepted, and the caller must confirm with the
 * user before anything happens.
 */
export function signInLinkOrigin(deepLink: string): string | null {
  try {
    const url = new URL(deepLink);
    if (url.protocol !== `${PROTOCOL}:` || url.hostname !== "signin") return null;
    const server = new URL(url.searchParams.get("server") ?? "");
    return server.protocol === "https:" && server.hostname ? server.origin : null;
  } catch {
    return null;
  }
}

/** Pulls a deep link out of argv, which is how Windows and Linux deliver it. */
export function deepLinkFromArgv(argv: string[]): string | undefined {
  return argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
}
