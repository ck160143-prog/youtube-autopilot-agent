# Owner Bootstrap — independent verification report

Scope: the fix for **Owner Takeover** only (Option B). No merge, no deploy, no
production secret change, no migration was performed while writing this.

Everything below was measured on this working tree, on this machine, with the
real server process and real HTTP requests. Where something could not be
measured, it says so instead of claiming it.

---

## 1. The defect, restated

Before the change:

| Measured behaviour (before) | Consequence |
| --- | --- |
| first account to register became `role: "owner"` | whoever finds the URL first owns the instance |
| owner identity lived in `DATA_DIR`, which on the free plan is wiped by every deploy | after each deploy the instance was ownerless again, so the next visitor became the owner |
| startup adoption stamped all ownerless projects with the current owner | the new "owner" read the previous owner's story, topic and renders |
| `adoptLegacyRecords()` ran at startup with no verified owner | adoption was a side effect of booting, not a decision by an owner |
| session ids were stored in cleartext as the file key | copying an id out of `data/sessions.json` produced a 200 impersonation |
| `data/users.json` / `sessions.json` were mode `644` | any local reader got the credentials |
| the YouTube cookie was accepted without checking whose it was | a connection made by one account drove another account's uploads |
| the OAuth callback wrote a cookie even with `APP_SESSION_SECRET` missing | an empty key guarded the token |

## 2. What the fix does

* **Owner is created only by `OWNER_BOOTSTRAP_TOKEN`.** No code path creates an
  owner automatically, and there is no "first visitor" shortcut.
* **The door is closed by default.** With no token configured, or a token under
  16 characters, owner creation is refused (`403 OWNER_BOOTSTRAP_REQUIRED` /
  `503 WEAK_BOOTSTRAP_TOKEN`). The instance stays fail-closed (503) rather than
  letting anyone in.
* **The token is spent.** Once an owner exists, the same token is refused
  (`403 SIGNUP_CLOSED`), and the successful response returns a rotated
  `nextBootstrapToken` meant to replace the environment value.
* **Identity must be durable.** `storageState()` classifies `DATA_DIR`; when
  durability is *required* (`NODE_ENV=production` or
  `OWNER_REQUIRE_PERSISTENT_STORAGE=1`) and the path is ephemeral, every private
  route and owner creation return `503 PERSISTENT_STORAGE_REQUIRED`.
* **Legacy adoption only for the authenticated, verified owner**, and only in
  the request that proved the bootstrap token — never at startup, never for a
  later account. The helper re-checks `role === "owner"` itself.
* **Sessions are stored as `sha256(id)`**, and the credential files are `0600`
  in a `0700` directory. Legacy raw-id session entries are dropped on load.
* **YouTube tokens are bound to an owning account id**; a cookie that names no
  account, or a different one, is refused (`409 CHANNEL_NOT_CONNECTED`). The
  callback refuses to run without a ≥32-character `APP_SESSION_SECRET`.

## 3. Measurements

Standalone script, no test framework, only HTTP against a real listening
server. Reproduced for this report; output verbatim:

```
first visitor            | 403 | OWNER_BOOTSTRAP_REQUIRED | -
private route anon       | 503
wrong token              | 403 | OWNER_BOOTSTRAP_REQUIRED
correct token            | 201 | owner | rotated token 43 chars
token reuse              | 403 | SIGNUP_CLOSED
private route owner      | 200
status after owner       | bootstrap=false | privateAccess=true
session key is raw id    | false
users.json mode          | 600
prod + ephemeral DATA_DIR| durable=false | blocked=true | PERSISTENT_STORAGE_REQUIRED
prod register attempt    | 503 | PERSISTENT_STORAGE_REQUIRED
legacy ownerId after boot| null
after refused signup     | null
after bootstrapped owner | adopted (log: "Adopted 1 project(s) … into the bootstrapped owner account")
```

Note the third line from the bottom: booting the process does **not** adopt.
That is the exact behaviour that used to hand the instance over.

## 4. Regression tests and revert-verification

Two new suites: `test/owner-bootstrap.test.js` (13 tests) and
`test/session-binding.test.js` (5 tests). Each control below was verified by
removing the corresponding fix and re-running the suite: a test that does not
fail when its fix is gone is not evidence, so every row was run both ways.

| # | Fix removed | Tests that fail |
| --- | --- | --- |
| A | bootstrap condition `!hasOwnerYet && safeEqual(...)` → `!hasOwnerYet` (first visitor is owner again) | 1, 2, 3, 5, 9 |
| B | `blocksAccess: required && !durable` → `false` (fail-open storage gate) | 6, 7 |
| C | token no longer spent (`!hasOwnerYet` dropped) | 2, 10 |
| D | credential validation moved back before the door decision | 3 (oracle) |
| E | weak-token check `length >= 16` → `length > 0` | 4 |
| F1 | adoption for every created account instead of only the bootstrapped owner (role re-check also removed) | 9 |
| F2 | startup adoption `adoptLegacyRecords(authStore.ownerId())` reintroduced | 10 |
| G | session key back to the raw cookie id | 11, and 1/3/4 of the binding suite |
| H | credential files written without `0600` | 12 |
| I | session file keyed by the raw id | binding 1, 3, 4 |
| J | YouTube cookie accepted without the owner check | binding 3, 4 |

Rows F1 and F2 initially **passed against the reverted code**, i.e. the first
version of those two assertions proved nothing. The tests were rewritten (an
ownerless record created *after* boot for F2; a truthful 403 baseline plus a
member that must not adopt for F1) and both now fail with the fix removed. This
is recorded because it is the kind of thing that makes a green suite lie.

Two more test corrections are worth stating plainly, because in both cases the
*test* was wrong, not the code:

* `test/youtube-disconnect-api.test.js` expected `401` for an anonymous
  disconnect on an instance with **no owner**. The new, correct answer is `503
  OWNER_NOT_CONFIGURED` (fail closed). The assertion now accepts either refusal
  and asserts the 503 code specifically.
* `test/ui-auth.test.js`, `ui-mobile`, `dashboard-truth` and `session-security`
  registered their first account through the real UI/HTTP path, which now needs
  the token. They fill the field the dashboard shows, so the browser flow is
  still exercised end to end rather than bypassed.

## 5. Full suite, build, audit

```
npm test                370 tests, 369 pass, 0 fail, 1 skipped
node build.js           Build OK: dist/index.html + zip (63 files, 338.1 KB)
npm audit --omit=dev    found 0 vulnerabilities
node --check            clean on lib/auth.js and server.js
```

The skipped test is the pre-existing opt-in 30-minute render
(`RUN_LONG_RENDER=1`), unchanged by this work.

## 6. Dashboard change

`index.html` gained one password field (`authBootstrapToken`) shown only while
the server reports `bootstrap: true`, and the gate note now distinguishes three
real states: bootstrap open, operator-opened member signup, and access blocked
because storage is not durable. Without this field the only way to create the
owner would have been `curl`, which would have made the feature unusable.

## 7. What this does **not** establish

* No deployment was performed, so the Render environment itself is unverified.
  The live service is still on the old code. The bootstrap token has **not**
  been set anywhere.
* The durability check is a path heuristic (`/tmp`, `/var/tmp`, `/dev/shm`,
  paths inside the app dir). It cannot prove a mounted disk is actually
  persistent. `OWNER_REQUIRE_PERSISTENT_STORAGE=1` plus a real `DATA_DIR` is the
  intended configuration; that combination was tested only locally with a temp
  directory standing in for the disk.
* Sessions are still bearer tokens: hashing the file key stops *file readers*
  from replaying them, but it does not stop a stolen live cookie. Rotation on
  password change is not implemented.
* The YouTube binding stops cross-account use of a cookie; it does not shorten
  the token lifetime or revoke at Google.
* Pre-existing limits stand: in-memory rate limiter and job lock (single
  instance), S3 driver fake-transport only, real Gemini/YouTube/OAuth
  unverified, **3D/Blender BLOCKED**.

## 8. Deployment steps this work implies (not performed)

1. Attach a Render Disk and set `DATA_DIR` to it.
2. Set `OWNER_REQUIRE_PERSISTENT_STORAGE=1`.
3. Set `OWNER_BOOTSTRAP_TOKEN` to a random value of ≥16 characters.
4. Register the owner once in the dashboard, then replace the variable with the
   `nextBootstrapToken` returned by that response.
5. Confirm `/api/auth/status` reports `bootstrap: false`, `privateAccess: true`,
   `storage.durable: true`.

Step 4 is manual by design: nothing in the code rotates the environment for you.
