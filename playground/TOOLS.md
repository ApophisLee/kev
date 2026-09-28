# Choice Programming

An experimental playground co-authored by **ApophisLee and GPT-6 Astra**.
The model making the recorded tool decisions is **jaredpalmer/kev-4b**.
See the [feasibility report and recorded results](docs/choice-programming/README.md).

Define a goal and a dictionary of tools and candidate arguments. Kev chooses a tool,
chooses its arguments, observes the result, and repeats until it chooses `finish` with all checks passed. The
available capabilities include editing sandbox files in small segments, reading bounded pages, and
creating, updating, or deleting persistent memory. The reader is one capability within
the Choice Programming loop.

The supplied adapter requires an Apple Silicon Mac, Python 3.13, and Node 22.18+
(native TypeScript stripping for the tests). From the repository root, install the
Python environment and frontend dependencies:

```sh
uv sync --extra serve --python 3.13
cd playground
npm ci
```

From `playground/`, start the pinned Kev 4B adapter, then the Next.js app in a second terminal:

```sh
../.venv/bin/python scripts/serve-kev.py --port 8009

# In another terminal, from playground/
npm run dev -- --hostname 127.0.0.1 -p 3001
```

Open http://127.0.0.1:3001/tools. The adapter also supports the existing decision
and chess views with the default unauthenticated local setup, including the
separate-question and option-permutation comparisons.
The 3,000-token limit applies to each inference request on this adapter.
It loads the cached `jaredpalmer/kev-4b` checkpoint at revision
`139fdd94f1b6a6ad80cc15e08fcb99cac885a101` on Apple Silicon using MLX/MPS with
bfloat16. All dictionary tools, memory, paged reading, and the 3,000-token input limit
remain available. The checkpoint and base weights are downloaded on first use if absent.
`KEV_API` overrides the playground's model endpoint (default `http://127.0.0.1:8009`).
For bearer authentication, set the same `KEV_API_KEY` on the adapter and Next.js.
The `/tools` server-side token counting and inference calls use this key; it is never
sent by the browser. The existing decision and chess views use direct browser proxy
calls and do not forward this key, so those views require the default unauthenticated
local adapter.

## Tools, observations, and memory

`create_file` creates an empty missing file. `append_file` asks the model to choose an
existing file, then text to append. `replace_file_range` asks for a visible range in the
current reading, then replacement text. A cursor range with equal start and end inserts
inside the visible source without deleting existing characters. Edits support two input modes: select a fragment
from a dictionary, or select one character from a configured alphabet. The model chooses
the mode and text in separate decisions. The next decision receives a bounded editor
view of the changed file.
Appending requires a current reading of that file's end. A new run preserves existing
files but starts without a file reading, so it must read the target before appending.
The read dictionary includes a bounded tail page as well as first, next, and previous pages.

Each text choice describes the literal insertion and a bounded before/after preview
computed by the same splice function used to apply the edit. Replacement choices also
show the text to delete; abbreviated excerpts are explicitly marked. These previews
combine only the current reading and the offered fragment, never a prewritten solution
or unread file contents. Append and replacement have separate instructions.
Unfinished statements can fail the output check while they are still being assembled;
that alone is not an instruction to replace them.

Small readings offer token ranges, character ranges, and insertion cursors. The mode
choice lists the available literal fragments before the model decides whether to use
fragments or individual characters. For longer readings, `focus_range`
lets the model narrow a visible region through groups of four before choosing an exact
small range. This search does not edit the file or change working memory. Large character
alphabets are grouped by category, with at most eight literal characters in the final
selection. Every stage remains subject to the exact 3,000-token input limit.
Reading pages, selecting excerpts, and choosing existing memory keys use dictionaries
generated from the current workspace. All these tools participate in the same choose,
execute, observe loop.

The model receives **all current memory on every decision**, including the tool choice,
argument choice, and any memory-target choice. Memory persists between runs in the same
workspace. The model decides what to add, replace, or delete.

The full goal is saved with the run. `goal_memory` sends only its current page, bounded
by `readLimit`, on every decision. Long goals automatically offer `read_goal` with
first, next, and previous page choices. This changes the goal page without replacing
the file reading or working notes. A new run starts at the first goal page.

Reads and writes return a limited file observation to the model. They leave memory
unchanged until the model chooses a memory tool. The latest observation remains in the
current run's reading buffer and is sent with every decision until another read or write
replaces it, or its source changes. Earlier page text is excluded from model history.
To retain a useful fact across pages or runs, the model must choose an excerpt or a
supplied memory note.

`readLimit` is a per-read **Unicode character** budget, not a linguistic word count.
The default is 400 characters and the maximum is 1,200. The model chooses a file/page
from a generated dictionary. The returned reading contains its path, text, character
range, total length, and whether more text follows. The interface shows full files for
human inspection; that preview is not sent to the model. Each write also returns an
editor window of at most `readLimit` characters.

`writeLimit` sets the maximum insertion size, from 1–400 Unicode characters, with a default
of 120. Fragments may contain syntax, string literals, or newlines. Character mode inserts
one Unicode character per operation. The model builds larger files over several operations.
Range replacements are limited to text visible in the current reading; the model can read
another page to edit elsewhere.

`remember_excerpt` offers short excerpts from the current page, each at most 120 Unicode
characters. A selected excerpt becomes an indexed memory value:

```json
{
  "kind": "index",
  "path": "docs/python-intro.md",
  "start": 0,
  "end": 28,
  "quote": "Use print() to display text."
}
```

Stored character offsets are zero-based with an exclusive end; the interface displays
one-based inclusive ranges. The quote is retained alongside its source location.
`edit_memory` first asks which existing key to change, then asks which current excerpt
should replace that entry. `delete_memory` lets the model choose an existing key to remove.
`write_memory` creates or replaces a note using a key/value supplied in the program.

The programming presets use `remember_excerpt`, `edit_memory`, and `delete_memory`
to maintain notes selected from file readings. They do not include prewritten progress
or completion status notes. Custom dictionaries can still declare `write_memory` actions.
Set `requiresChecks: true` on such an action when its note depends on all configured
completion checks passing. At least one check must be configured for this prerequisite
to pass. This field is optional, must be a boolean, and is supported only by
`write_memory`. For example:

```json
{
  "tool": "write_memory",
  "description": "Keep a verification note after all configured checks pass.",
  "key": "verified_program",
  "value": "The configured output checks passed.",
  "requiresChecks": true
}
```

For compatibility, the older preset note with key `task_status` and exact value
`The requested Python program passes its output check.` has the same prerequisite,
even in saved programs without `requiresChecks`. Existing saved programs and memory
are not rewritten. A remembered claim does not replace the current completion checks.

Candidates that would write the value already stored under their memory key are
excluded. This also applies to saving the same source index again or replacing an
entry with its current value. If an unchanged write reaches execution, the observation
reports `changed: false`, separately from whether the tool call succeeded. The trace
shows **No state change** rather than implying that a successful call advanced the task.

Kev is a decision model: it selects supplied building blocks and does not generate
freeform code, text, or summaries. The file tools apply its selected text fragments.
Excerpt selection creates a source index, while custom summaries or notes must be
supplied as `write_memory` candidates.

## The program is a dictionary

Each operation starts with a tool decision, then sends that tool's argument dictionaries
in separate model calls. The tool decision includes the available choice count and up
to three compact candidate previews with relevant file targets, memory keys, source
ranges, or effects. Longer notes are previewed with an explicit character count and
truncation flag; the later argument decision receives the actual selected-tool choices.
Only actions whose current prerequisites pass are offered.

With both input modes offered, appending has four decisions:
tool, target file, input mode, and fragment or character. Replacing chooses tool, visible
range, input mode, and fragment or character. The file changes only after all required
choices are valid. `finish` needs no argument call and becomes available only when all
checks pass. Editing an existing
memory entry has three decisions: tool, memory key, replacement excerpt.

The editor provides three programming presets:

| Preset | Goal | Expected output |
| --- | --- | --- |
| Hello World | Write `hello.py` to print the greeting. | `Hello, world!` followed by a newline |
| Addition: 1 + 1 | Write `addition.py` to compute 1 + 1. | `2` followed by a newline |
| Variables: a + b | Write `variables.py` to set `a = 2` and `b = 3`, then print their sum. | `5` followed by a newline |

Choose a preset while idle to load its dictionary into the editor. **Load example**
restores the selected preset after edits. This changes the editor for the next run;
existing files and memory remain available. An active run must be stopped before
switching presets. Use reset or another workspace when you want a fresh sandbox.

The included dictionary asks the model to create `hello.py` so it prints `Hello, world!`.
The model creates an empty file, then builds code by appending fragments across several
operations. It can inspect each intermediate result, replace a visible range, read a
generic Python introduction, and keep useful excerpts or notes in memory. The goal and
completion check specify the desired output. A smaller dictionary looks like this:

```json
{
  "goal": "Create hello.py so the Python program prints exactly Hello, world! when run. Build the file a short fragment at a time. Read docs/python-intro.md if needed, inspect and revise visible ranges, and finish when the file is correct.",
  "maxSteps": 64,
  "readLimit": 300,
  "writeLimit": 40,
  "initialFiles": {
    "docs/python-intro.md": "Use print() to display text.\nA function call has a function name, parentheses, and an argument. A string is text enclosed in quotes. End the statement with a newline.\nprint displays its argument. len returns a string's length. repr returns a printable representation.\nCreate an empty file, append fragments, inspect each editor observation, and replace a visible range if needed.\n"
  },
  "checks": {
    "hello_file_created": {
      "file": "hello.py",
      "pythonOutput": "Hello, world!\n"
    }
  },
  "actions": {
    "create": {
      "description": "Create an empty target file without overwriting an existing file.",
      "tool": "create_file",
      "paths": ["hello.py", "scratch.py"]
    },
    "append": {
      "description": "Choose an existing target and append one short dictionary fragment.",
      "tool": "append_file",
      "paths": ["hello.py", "scratch.py"],
      "fragments": {
        "open_print": "print(",
        "open_len": "len(",
        "open_repr": "repr(",
        "greeting": "\"Hello, world!\"",
        "name": "\"Kev\"",
        "close_call": ")\n"
      },
      "characters": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_()=+-,.!\"' \n"
    },
    "revise": {
      "description": "Replace a visible range of the current reading with a selected fragment.",
      "tool": "replace_file_range",
      "paths": ["hello.py", "scratch.py"],
      "fragments": {
        "open_print": "print(",
        "open_len": "len(",
        "open_repr": "repr(",
        "greeting": "\"Hello, world!\"",
        "name": "\"Kev\"",
        "close_call": ")\n",
        "remove": ""
      },
      "characters": "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_()=+-,.!\"' \n"
    },
    "read": {
      "description": "Read a tutorial page if guidance is needed, or inspect the written file.",
      "tool": "read_file"
    },
    "remember": {
      "description": "Choose an important excerpt from the current page and keep its source index.",
      "tool": "remember_excerpt"
    },
    "revise_index": {
      "description": "Replace a less useful memory entry with an important current excerpt.",
      "tool": "edit_memory"
    },
    "forget": {
      "description": "Delete irrelevant or duplicate memory.",
      "tool": "delete_memory"
    },
    "finish": {
      "description": "Finish when hello.py contains a program that prints the requested greeting.",
      "tool": "finish"
    }
  }
}
```

| Tool | Argument dictionary | Effect |
| --- | --- | --- |
| `create_file` | Candidate paths | Create an empty file only when the path is missing. |
| `append_file` | Existing files, input mode, then fragments or characters | Append bounded text and return an editor observation. |
| `replace_file_range` | Visible ranges, input mode, then fragments or characters | Replace a range in the current reading and return an editor observation. |
| `write_python` | Custom target-file, Python-function, and string-value dictionaries | Assemble one function-call statement and write the selected Python file. |
| `write_file` | Custom static program entries with `path`, `content` | Create or replace a UTF-8 sandbox file. |
| `write_memory` | Custom entries with `key`, `value`, optional `requiresChecks` | Create or replace a persistent string note when its preconditions pass and the value differs. |
| `read_file` | Generated file/page choices | Return a bounded reading observation, without saving memory. |
| `remember_excerpt` | Generated excerpts from the current reading | Store a selected quote and its source range as an indexed entry. |
| `edit_memory` | Existing keys, then current excerpts | Replace the chosen memory entry with a selected source index. |
| `delete_memory` | Existing memory keys | Remove the selected entry. |
| `read_goal` | Generated goal-page choices | Read a bounded page of the saved goal; automatically available for long goals. |
| `finish` | None | Available only after all checks pass; end the run when selected. |

Segmented file tools declare eligible `paths`. `append_file` and `replace_file_range`
can offer `fragments`, a dictionary of short text choices bounded by `writeLimit`, and
`characters`, a string containing 1–128 distinct Unicode characters. Configure either
input mode or both. Character options are generated from the alphabet, including spaces
or newlines when configured. An empty replacement fragment deletes the chosen range.
Append fragments must be nonempty.
Each successful write returns `fileChange` with the changed path, the replaced range in
the old file, the inserted character count, and the new total character count. For creates
and appends, the old range has zero width. The returned editor observation is bounded by
`readLimit`; memory remains unchanged.

The optional `write_python` capability declares `paths` (1–8 distinct `.py` files), `functions` (a selection of
`print`, `len`, and `repr`), and `strings` (1–16 named string values). It produces one
function call with a string argument, handling quoting, escaping, and the final newline.
It writes the selected file without executing Python.

The dynamic reading and memory actions need only `tool` and `description`; the server
builds their argument dictionaries from the current sandbox, reading buffer, and memory.
Custom static entries with the same tool can offer file contents or memory notes.
`initialFiles` seeds files only if they are missing when a run starts, so later runs
preserve edits.

Model requests use `POST /v1/systemone`. The first request asks `next_tool`; subsequent
requests ask for that tool's argument choices. Every request includes current persistent
memory, the current file reading and goal-memory page, file metadata, completion checks,
and protected context for the previous and current tool operation:

- `last_step` identifies the latest completed tool attempt, including failed attempts.
  It records the chosen tool and choice, resolved arguments, and the execution outcome.
  Segmented edits preserve the exact selected text, including empty replacements,
  whitespace, newlines, and Unicode characters. The outcome retains the actual success
  or failure message, the recorded `changed` flag, file-change coordinates and counts,
  and memory changes with before/after values when present.
- `current_step` identifies the operation being decided and marks it `not_executed`.
  Each argument decision receives the earlier choices in that same operation, with
  their stages, choice keys, and selected dictionary values. Selecting a target, mode,
  or fragment does not imply that a write has already happened.
- `recent_steps` contains optional short summaries of earlier operations. The latest
  attempt is carried by `last_step`, so its outcome remains available even when these
  older summaries are removed to fit the token budget.

Reading outcomes in `last_step` include file or goal-page coordinates, not page text.
The only live pages are `reading` and `goal_memory`. UI audit windows, old reading pages,
complete decision distributions, and full sandbox files are not replayed as history.
The custom compatibility tool `write_file` records the path and content length instead
of copying its whole-file payload into `last_step`; use a bounded `read_file` operation
to inspect that file. `write_python` preserves its selected function and string value.
Last-step arguments omit action descriptions and internal file-version hashes.
No write occurs when a decision request fails or returns an invalid choice.

Optional `checks` declare desired file contents or memory values. The programming presets
use `pythonOutput` to compare output, including newlines, through a restricted Python
subset evaluator. It supports print, simple assignments, string and number literals,
and basic arithmetic. Imports, loops, and arbitrary function calls are outside this
subset. The checker does not run submitted code in an operating-system Python process;
parse and unsupported-syntax errors appear beside the completion check.
The earlier `pythonPrints` check remains available for supported single-call print
programs. Checks specify the requested output and do not supply an answer program to
the model. Current results are sent to the model and shown above the trace. Checks never choose
the next tool or insert code. While checks are incomplete, `finish` is absent from the
available-tool dictionary. It becomes available after they pass. `maxSteps` bounds retries.
Saved traces from older versions remain readable, and the legacy `END` tool is still
accepted. New programs must use `read_file`
and `remember_excerpt` instead of the old `read_file_to_memory` action.

## Input token budget

Every model request is counted before inference and must contain at most **3,000 input
tokens**, including state, instructions, option text, and Kev's special tokens. Counting uses
the loaded Kev tokenizer and the exact native input sent to inference, not a character estimate. If a
request is too large, the oldest recent-operation summaries are removed and it is
counted again. Working memory, the current goal page, file reading, available choices,
`last_step`, and the current operation's choice chain are never silently dropped.
If this protected context still exceeds the limit, the run stops
before sending that request; reduce the notes, page size, or dictionary and start again.

`POST /v1/input-tokens` counts without running the model. `POST /v1/systemone`
independently enforces the same cap before inference. Both assemble and count the
complete native Kev input without truncating state, instructions, or option
descriptions. No option is silently removed.
Missing counters, a different model identity, and token-count mismatches fail closed.
Decision traces show exact preflight tokens and the server-reported usage; old traces
without counts or model identity are labeled unavailable. A token limit does not
guarantee correct decisions.

## File-writing timeline

The file-writing timeline shows completed writes in run order. Filter by file or select
a write to inspect its tool and argument decisions, selected-option probabilities, and
latency. Model time is the sum of reported model latency, including intervening non-write
operations; it is not a wall-clock timestamp.

The Before and After panes highlight the affected character range within recorded,
bounded file windows. New writes save these audit windows for the interface only; they
are excluded from model decision history. Older traces use only recorded or provable
content and mark unavailable history explicitly. Failed writes remain visible without
pretending they changed the file.

Replay moves through recorded steps locally. It does not call the model or write files.
During a run, completed writes appear after each tool operation returns.

## Running and inspecting

Keep the page open for automatic execution. Single step completes one tool operation,
including all its model decisions. Stop waits for the current operation to finish.
The trace shows each decision's probabilities and latency, bounded file observations,
edited character ranges, inserted character counts, and memory changes with before/after
values. The current-reading panel shows what will be
available on the next decision, while the memory panel shows all persistent entries.

API failures stop with `error`; tool errors become observations so the model can choose again.
`maxSteps` (1–100) stops a repeating model with `limit`, distinct from model-selected
`finish`. The limit counts tool operations, not individual model requests.

## Persistence and reset

Each workspace uses `playground/.tool-playground/<workspace>/`:

```text
sandbox/       Actual files available to the tools
memory.json    All persistent notes and selected source indexes
run.json       Latest program, step trace, reading buffer, and run status
```

A later run reuses files and memory but starts a new reading buffer and trace. Data
survives browser and Next server restarts and is gitignored.

The **Reset sandbox** controls are available when the workspace is idle:

- **Files only** clears sandbox files and the current run, keeping memory.
- **Files and memory** clears sandbox files, memory, and the current run.
- Both save the previous workspace state in a reset archive. **Restore last reset**
  restores that saved state, including its files, memory, and run.

Stop an active run before resetting or restoring. Reset also loads the example into
the editor; its `initialFiles` are seeded on the next start. Restore reloads the saved
run's program when one exists. Only the latest reset archive is available for restore.
Keeping memory while clearing files intentionally leaves the remembered quotes and
source locations intact, even while their source files are absent.

The local API accepts `POST /api/tool-loop?workspace=<name>` with JSON bodies:

```json
{ "workspace": "demo", "operation": "reset", "scope": "files", "runId": null }
```

Use `"scope": "all"` to reset files and memory. Restore uses
`{ "workspace": "demo", "operation": "restore", "runId": null }`.
Pass the current run ID instead of `null` when a run exists, so stale requests can be
rejected. Both operations return the updated workspace snapshot.

This is a single-process local development playground. Requests are restricted to a
local, same-origin host. Tool paths cannot escape the sandbox; symlinks and hard-linked
reads are rejected. There is no shell/eval tool. Files and memory have size limits to
bound model context. Do not run multiple Next processes against the same data directory.
Concurrent tabs are serialized and stale steps are rejected.

## Verification

```sh
# Node 22.18+ (native TypeScript stripping)
npm test
../.venv/bin/python -B tests/kev-server.test.py
npm run lint
npx next typegen
npx tsc --noEmit -p .
```
