# Onboarding continuation

The server frontend can pass `{ invite, register, username, displayName, path }`
to `startPasskeySignIn`. The preload advertises `supportsBrowserRegistration` so
older desktop releases keep their password signup fallback. Main validates every
field before using it. The browser opens immediately; deprecated match-code UI
and its 1.5-second delay are removed.

Web `hasht://signin?server=<https-origin>&path=<destination>` links still confirm
the instance host and require explicit browser authorization. Only `/`, short
alphanumeric invite paths, server IDs, and message paths survive. Query strings,
fragments, and arbitrary URLs never cross this boundary. After PKCE exchange the
pending auth object also includes `continuation_path`; the updated chat frontend
adopts it as navigation before loading the destination. It contains no credential.

The existing verifier and callback code boundaries and duplicate-exchange guard
are unchanged. A request-matching `cancelled=1` callback lets browser recovery
return to the app without exchanging a code.

Validation: `npm run build`; `node --test tests/authContinuation.test.ts`.
Requires the companion chat onboarding-continuation frontend for the new UI.
