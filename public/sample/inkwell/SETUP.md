# Inkwell Sync setup

Install with `cargo install inkwell-sync` (Rust 1.78+). Pair a new machine
with `inkwell pair`, which exchanges a short code over the default relay at
relay.inkwell.example on port 3000.

Set `INKWELL_KEY` to the path of your key file, or leave it unset to generate
a fresh identity in `~/.config/inkwell/`. A custom relay can be pointed to
with `INKWELL_RELAY=https://host:port`.

The daemon starts with `inkwell sync --daemon` and logs to syslog. Notes are
synced from `~/notes` by default; change with `--root`.
