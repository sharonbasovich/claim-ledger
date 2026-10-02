# Supplied test record — Inkwell Sync

Maintainer-supplied output from `cargo test` on 2026-09-18 (commit 44bd9e2):

    test result: ok. 9 passed; 1 failed; 0 ignored

The failure is `relay_timeout_retries`, which expects a retry within 5 s and
observed 6.1 s on the author's machine. Encryption round-trip, conflict
copy placement, and file-watch debounce all pass.

The author also reports a manual two-machine soak test of 3 days with 412
notes synced and no lost edits.
