# PR #165873 real persistence evidence

Tested feature head: `079f019294fb87175e6f7371f0d5facb0e0df6a8`.
Upgrade baseline: retained prerequisite build `5cfbf3932db1c714e1196cba404aedb186927ba2` (not a claim covering every published release).

## Real existing Gateway: two paired clients

Two separate Chromium contexts each consumed a fresh one-use Dashboard bootstrap URL. Assertions verify different device IDs, issued device authentication tokens, and the same canonical user profile. The real Systems controller invoked rename, dismissal, and interval writes against the real Gateway/store with real terminal-worker inventory. No preferences or inventory RPC response was mocked.

`live-sync-results.json`: live cross-client synchronization, reload persistence, unchanged unrelated settings, restored original settings.

`live-concurrent-results.json`: held the first outgoing preference-set request on each client until both had read the old value, then released both unchanged requests. The real Gateway returned a CAS conflict, the shipped writer retried, and both distinct worker-name edits reached both clients and survived reload. No server response was fabricated. Original presentation settings were restored with CAS. An unrelated existing preference was present and preserved.

## Actual binary upgrade and Gateway restart

`upgrade-binaries-results.json`: created a separate temporary state directory, unused loopback port, generated authentication credential, and disabled optional providers/plugins in that test-only config. Booted the retained baseline binary, paired two browser device identities to one user, and stored a synthetic unrelated preference through real authenticated RPC. Stopped only that owned process. Started the candidate binary against exactly the same directory/port, reloaded the clients, and verified the profile, devices, and all preference values were preserved. Verified default retention did not rewrite existing preferences. Changed retention through the actual candidate Systems controller, observed it on the second client, stopped/restarted only the candidate Gateway, and verified new retention plus unrelated data remained intact. Stopped the owned Gateway and removed its disposable state.

The real deployment was neither restarted nor reconfigured for these tests. No workers were allocated/reclaimed. These are authenticated web-client proofs, not native platform acceptance. The binary-upgrade test also supplies one synthetic UI inventory row to the unchanged controller and exercises its name/dismissal writer against real authenticated RPC/storage. Names, dismissal timestamps, retention, and unrelated data all survive the owned Gateway restart. Only the disposable UI inventory row is synthetic; no preference response or stored value is mocked. The live tests separately exercise actual terminal inventory.

## Fresh candidate profile

`fresh-profile-results.json`: a separately created candidate state/profile has neither feature key, receives the 15-minute default without preexisting values, and persists a changed interval through the real writer and browser reload. The isolated Gateway and state were cleaned up.

## Replay scripts

Portable wrappers are included with the same assertion logic as the executed local scripts; absolute installation/artifact paths were replaced with explicit environment inputs. Use Node24.19 and an installed Playwright. `PLAYWRIGHT_MODULE` may point to its index.mjs; `PROOF_DIR` selects output. For binary tests set `OPENCLAW_PROOF_BASE` and `OPENCLAW_PROOF_HEAD` to installed package roots at the exact recorded commits, and optionally `PROOF_NODE`. Live scripts intentionally require `ALLOW_LIVE_PREFS_PROOF=1` and use `OPENCLAW_CLI` (default openclaw). They temporarily modify an uncustomized terminal-worker presentation and retention, then restore touched settings using CAS. Do not run against an unrelated user profile. Never publish authentication material.
