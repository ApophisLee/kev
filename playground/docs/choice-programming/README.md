# Choice Programming: an experimental Kev playground

**Co-authored by ApophisLee and GPT-6 Astra.** The playground implementation, tests, and this report were developed collaboratively. The model making the recorded decisions is **`jaredpalmer/kev-4b`**. This is an experimental fork contribution, with no claim of official upstream endorsement.

Choice Programming explores whether a decision model can construct small programs by repeatedly choosing tools and literal text from dictionaries. One preserved arithmetic run created `addition.py`, assembled `print(1 + 1)\n`, and selected `finish` after its output check passed. Two preceding development traces failed. This demonstrates feasibility for a narrowly scaffolded example; it is not a benchmark, a reliability estimate, or evidence of general coding ability.

## Method

The recorded model was `jaredpalmer/kev-4b`, using checkpoint `139fdd94f1b6a6ad80cc15e08fcb99cac885a101` with MLX on MPS in bfloat16. Every decision has a 3,000-input-token cap. The adapter counts the complete request using Kev's native encoder and checks the count against server-reported usage. All recorded counts in these three traces matched and stayed below the cap.

Each run used the goal “Create addition.py that computes 1 + 1 and prints the result.” The task dictionary offered `print(`, `1`, ` + `, ` - `, and `)\n`, plus an empty replacement for deletion. Individual character entry was also available. No dictionary entry contained the complete program. These are task-specific building blocks, and the expected stdout `2\n` is visible in the checks; this is a scaffolded task, not unconstrained program synthesis.

An edit may require several model calls: select the tool, its target or range, the input mode, and the literal fragment or character. The host applies the selected operation only after all required choices resolve. Each decision receives the current goal page, persistent working memory, a bounded reading, the previous executed step, and decisions already made in the current operation. These traces use 300-character readings and a 40-character write limit.

The application checks a restricted Python subset without executing submitted Python through the operating system. Its filesystem is scoped to a workspace; the name “sandbox” does not imply an operating-system process sandbox. `finish` is offered only after application checks pass. Separately, the exact archived successful source was reviewed and executed with CPython 3.9.6 using `python3 -I -c`: stdout was `2\n`, stderr was empty, and the exit code was 0.

## Recorded results

[Sanitized results and decision records](results.json) include the source-run identifiers, record hashes, file edits, per-decision token counts, and measured latencies. The successful arithmetic run comes from a preserved reset archive: its interactive workspace was later reused, so a live workspace URL is not a stable evidence record.

To verify the published records using only the Python standard library, run from this report's directory:

```sh
python3 verify_results.py results.json
```

The verifier recomputes aggregates, checks the input cap and recorded decision/action mappings, and reconstructs every file edit. It does not call a model or execute the recorded Python source. It cannot independently recount native tokens, verify omitted alphabet/candidate mappings or private source hashes, or reproduce the historical output check.

| Development trace | End condition | Tool steps / model calls | Input tokens per call | Cumulative input tokens | Sum of decision latency |
| --- | --- | ---: | ---: | ---: | ---: |
| Original edit interface | 8-step limit; incorrect source | 8 / 32 | 357–2,233 | 29,533 | 228.783 s |
| Intermediate edit interface | Externally stopped at step 11 of 18; incorrect output | 11 / 46 | 371–1,318 | 45,095 | 408.322 s |
| Aligned edit interface | Model selected `finish` at step 7 of 18; correct output | 7 / 23 | 371–1,267 | 20,775 | 157.235 s |

Counts sum each recorded decision once; step-level totals are not counted again. Cumulative input tokens include repeated context across requests and are not simultaneous context size. Latency is the sum of recorded decision latencies, not elapsed run wall time, GPU-only inference time, or a throughput benchmark. Cold-start effects and local scheduling were not controlled.

The original trace began with an existing `print(`. It appended another `print(` and later replaced the entire visible source with `)\n`. At step 8 the file was `print(1`; the model selected `replace_file_range`, then `current_view`, then the `close_call` fragment. The executor replaced `[0, 7)` with `)\n` exactly as selected. The range decision had only one option, so its probability of 1 did not indicate informed confidence in that range. The recorded behavior exposed a mismatch between continuation-like fragment wording and replacement effects; it does not establish that a model selection was mapped to the wrong action.

The intermediate trace started with an absent target file. It reached `print(1)\n`, removed the argument, and continued editing without achieving the requested output. It ended at `print()`, which prints a newline rather than `2\n`. Adding clearer previews and smaller replacement ranges alone did not establish reliable completion.

The successful trace also started with an absent target file and made these choices:

```text
create addition.py
append "print("
append "1"
append " + "
append "1"
append ")\n"
finish
```

This is six file operations and a model-selected termination, requiring 23 decisions. It used fragments throughout. It did not exercise document reading, memory updates, character entry, or error recovery.

## Interface changes and interpretation

The current interface requires an appropriate current reading before editing an existing file, distinguishes append, replacement, and insertion at a cursor, and offers smaller token or character ranges. Long ranges can be narrowed in stages. Character selection is grouped rather than presenting the full alphabet as one flat decision. Input-mode choices show the available fragment literals.

Each text option includes the literal insertion and a bounded result preview derived from the current reading. Preview and execution use the same splice operation; replacement options identify the removed text. Instructions distinguish an unfinished statement from task completion and state that closing syntax alone does not fulfill the goal. These are interface-contract changes, not prewritten solutions.

Several prompts, choices, starting states, and budgets changed between the traces. These observations therefore do **not** isolate a causal effect or constitute a controlled A/B comparison. The three records are selected development examples, not all attempts; computing a success percentage from them would be misleading. Conditional option probabilities are also not calibrated probabilities of code correctness.

Deterministic tests with mocked model decisions validate application behavior—such as preview/execution agreement, bounded input, stale-file handling, and completion gating. Passing those tests does not measure Kev's coding accuracy. The restricted output checker also cannot establish general Python correctness.

## Questions for upstream discussion

- Is hierarchical tool → target/range → input-mode → literal selection an appropriate use of Kev's decision interface? What option structure would upstream recommend for small stateful editing tasks?
- How should single-option stages be handled, and how should probabilities be interpreted when candidate sets change between stages?
- Would a bounded evaluation of arithmetic, greetings, variables, and repairs be useful? A next experiment could fix task dictionaries, reset state for every trial, preserve every attempt, and vary one interface feature at a time across repeated runs.
- Which metrics matter most beyond completion: total decisions, token cost, latency, destructive edits, recovery rate, or sensitivity to option order? Memory, long-file reading, and character-only composition need separate evaluations.

The immediate result is an inspectable proof of feasibility for one small arithmetic program, together with concrete failure traces and a more faithful editing interface. Reliability and broader task coverage remain open questions.
