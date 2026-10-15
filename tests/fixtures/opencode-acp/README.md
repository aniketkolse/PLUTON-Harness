# OpenCode ACP recorded frames (test fixtures)

`recorded-frames.json` contains payload shapes captured from a live
`opencode acp` session (opencode v2.0.29, 2026-10-16) during Phase 4 protocol
probing. The raw transcripts live outside the repo in `.pluton-tmp/acp-probe*.log`
(working notes), so the essential frames are committed here as test fixtures.

Edits applied when extracting (documented in the file itself):

- session ids replaced with stable placeholders (`ses_recorded_*`)
- the `available_commands_update` frame trimmed to 3 of its 90+ entries
- whitespace normalized; field order and values otherwise untouched

These are protocol samples from a live tool session, used to replay the real
wire format in offline tests (`tests/unit/opencode-adapter.test.ts`). They are
not code vendored from another project; no license implications (see
`docs/reverse-engineering/reuse-and-license-audit.md`).
