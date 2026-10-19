# File helper

`qb-files` runs inside the tools sandbox. With no arguments it accepts one `FilesRequest` JSON value on stdin,
writes one `FilesResult` JSON value followed by a newline, and exits zero. Operation errors are JSON results.
Invalid input and unexpected failures write a diagnostic to stderr and exit nonzero.

`qb-files export` accepts a `FilesExportRequest` instead and streams the exact file bytes to stdout. Export
failures use stderr and a nonzero exit code. An interrupted export may already have emitted bytes; callers must
check its exit status before accepting the file.

The package build emits `dist/main.js` with a Node shebang. The image can invoke it with `node`, or install it
as the executable `/opt/quokkabot/bin/qb-files`. As with other workspace packages, the production build must also
build the runtime dependency `@quokkabot/shared`.

Environment:

| Variable | Default | Purpose |
| --- | --- | --- |
| `QB_WORKSPACE` | `/workspace` | Writable root |
| `QB_DOWNLOADS` | `/downloads` | Read-only root |
| `QB_PDFTOTEXT` | `/usr/bin/pdftotext` | PDF converter executable, launched directly without a shell |

Roots must already exist and be absolute paths. Empty values fail explicitly. Requests are validated using the
frozen shared schemas, including for direct calls to `handle(request, env)`. Invalid requests reject that call;
ordinary operation failures resolve to an error result. `exportFile(request, writable, env)` is also exported.

Path walks check the root and every requested component using `lstat`. Symlinks, hard-linked regular files and
special files are refused, including when discovered during a directory listing. Regular files are opened with
`O_NOFOLLOW` and `O_NONBLOCK` and checked again with `fstat`. Writes create checked parent directories, use a
private temporary file beside the target, fsync it, recheck the destination, rename, and fsync the directory.
Failed edits leave the original untouched and remove the temporary file. New files have mode `0600`; replacing
an existing file also uses that mode.

Listings include hidden entries, sort directories first with deterministic name ordering, and use an opaque
offset cursor. Both the entry count and serialized tool-result character limit bound a page. Concurrent
directory changes can shift pages. Text reads validate UTF-8 across the whole file,
check for NUL in the first 8 KB, and retain only a bounded page while counting all lines. Line numbers use six
columns and a tab; original line endings and a final unterminated line are preserved. The character cap includes
line numbers. An oversized line returns `too_large` when it cannot fit on an otherwise empty page. An empty file
has zero lines, and a trailing newline does not create an extra line.

PDF extraction uses the same pagination and a 30-second converter timeout. Images are identified by magic bytes,
with the size limit enforced both before and during reading. Copies, edits, hashes and exports stream bytes;
edits use literal, nonoverlapping substring matches, including matches across stream chunks.

This helper runs as the shell's user and is not an isolation boundary. Node's portable filesystem API does not
provide an `openat` directory-descriptor walk. A concurrent process with the same write permissions can race an
intermediate-directory check or mutate a file during a read, hash, copy or PDF conversion. The sandbox remains
the security boundary.

Tests use temporary roots and build the real shared sources into a runtime fixture under this package's ignored
`dist/` directory. They do not write into `packages/shared` or need listening sockets or network access.
