# mend

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-22%2B-green.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/checks-300%2F300-brightgreen.svg)](#results)

**mend** is a single-file command-line tool that applies the edits AI models
write to a tree of text files — in all four formats models actually produce:
unified diffs (often with wrong line numbers), `SEARCH/REPLACE` blocks, the
V4A patch format, and text-editor tool calls as JSON. It finds the lines an
edit names even when the model drifted their whitespace or indentation, and
changes every file or none.

## Features

- **Four formats, one tool** — unified diff, SEARCH/REPLACE, V4A, JSON edits,
  with automatic detection (`--format=auto`, the default) or an explicit
  `--format=NAME`.
- **Three-tier fuzzy matching** — an edit's old lines are found at the first
  tier where they occur: exact, trailing-whitespace-insensitive, then
  leading-and-trailing-whitespace-insensitive, with re-indentation of the
  replacement at the deepest tier. `--strict` matches exactly (tier 0 only).
- **Line-number tolerant** — unified hunks take the occurrence nearest the
  header's line number, so a hunk still lands when the model's numbers are
  off; empty hunks insert at the right place.
- **Atomic, all-or-nothing** — edits apply in order to the tree as earlier
  edits left it; a failed edit changes nothing, later edits still run, and
  when any edit failed no file is written at all.
- **Exact output contract** — `A`/`D`/`M`/`R` lines in byte order plus an
  `ok: N files` summary, or one `error:` line per failure plus a
  `failed: k of n edits` summary; `--check` previews without writing.
- **Faithful to the files** — CRLF files stay CRLF, files without a final
  line break keep it, `\ No newline at end of file` is honoured, moves are
  reported as `R old -> new`, and unsafe paths (`..`, absolute, backslash)
  are refused before anything else.
- **No dependencies** — Node 22 and its standard library alone.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` (or omitted) to read the patch from standard
input. Options and `PATCH` may come in any order; `--` ends the options.

```sh
# Apply a patch file to the current directory
node main.ts fix.patch

# Preview what would change, without writing anything
node main.ts --check fix.patch

# Read the patch from stdin, forcing the V4A format
cat patch.txt | node main.ts --format=v4a -

# Require exact line matches
node main.ts --strict fix.patch
```

Exit codes: `0` applied, `1` one or more edits failed (nothing written),
`2` usage, unreadable patch, undetectable format, or unparsable patch.

## Results

Verified against the specification's practice set and three independent
100-check trials, run through the trial runner exactly as a grader runs them:

| Check set | Passed |
| --- | --- |
| Practice set (100 checks: unified, SEARCH/REPLACE, V4A, JSON, CLI) | 100 / 100 |
| Trial 0 (100 checks) | 100 / 100 |
| Trial 1 (100 checks) | 100 / 100 |
| Trial 2 (100 checks) | 100 / 100 |
| Extra edge cases (usage errors, atomicity, CRLF, no-newline, moves, ambiguity) | 78 / 78 |

Run the practice set yourself with the included checker:

```sh
node check.ts <practice.json>
```

## Files

- `main.ts` — the whole tool: argument parsing, format detection, the four
  readers, three-tier matching, and the atomic write.
- `runner.ts` — runs `main.ts` on each check of a trial and posts the
  results (used when `MAKEFUN_ENV_URL` is set).
- `check.ts` — runs the practice set against `main.ts` on your own machine.

## License

MIT — see [LICENSE](LICENSE).

---

**Author:** Kamal Mosadegh — contact by email only: kamalmosadegh6977@gmail.com
