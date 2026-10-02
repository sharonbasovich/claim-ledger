# Inkwell Sync

Inkwell Sync is a command-line tool that keeps a folder of Markdown notes in
sync between machines. All note contents are end-to-end encrypted with
X25519 keys; the relay server stores only ciphertext.

Conflicts are resolved with a last-writer-wins merge on file level, and
conflicted copies are kept under `.inkwell/conflicts/` for manual review.
Sync runs on a 30-second interval or on file-watch events.

Inkwell supports an unlimited number of paired devices and works on Linux,
macOS, and Windows. The current release is v2.1.0, published under the
Apache-2.0 license.
