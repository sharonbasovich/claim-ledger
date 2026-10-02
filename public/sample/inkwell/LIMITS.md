# Inkwell Sync known limitations

Individual notes are capped at 2 MB; larger files are skipped and logged.
File metadata (names, sizes, timestamps) is not encrypted — only contents are.

Last-writer-wins merge means simultaneous edits to the same note silently
drop one version; the conflict copy preserves it but nothing alerts the user.
There is no iOS or Android client, and the relay protocol has no formal spec.

Sync over metered connections can be aggressive: the file watcher triggers a
sync per changed file with no batching.
