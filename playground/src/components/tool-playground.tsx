"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { completionChecks, EXAMPLE, EXAMPLES, parseProgram, validateName } from "@/lib/tool-loop";
import { MAX_INPUT_TOKENS, MODEL_ID } from "@/lib/model-config";
import type { Decision, FileView, MemoryValue, Reading, Snapshot, Step } from "@/lib/tool-loop";
import { FileDecisionTimeline } from "@/components/file-decision-timeline";

const pretty = (value: unknown) => JSON.stringify(value, null, 2);
const button = "inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";
const input = "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50";
const labels = { running: "Ready for next step", ended: "Finished", stopped: "Stopped", limit: "Step limit reached", error: "Run failed" };
const decisionLabels: Record<string, string> = {
  tool: "Tool selection",
  arguments: "Argument dictionary",
  memory_target: "Memory entry to edit",
  python_file: "Python target file",
  python_function: "Python function",
  python_string: "Python string value",
  write_target: "File to edit",
  write_range: "Visible range to replace",
  write_fragment: "Text fragment",
  write_mode: "Input mode",
  write_character: "Character",
  write_character_group: "Character group",
  write_range_group: "Range focus",
};
const presetFor = (program: { goal: string }) => Object.entries(EXAMPLES).find(([, example]) => example.program.goal === program.goal || program.goal.startsWith(`${example.program.goal} Build `))?.[0];
const decisionsFor = (step: Step): Decision[] => step.decisions ?? [{ stage: "arguments", choice: step.choice, probabilities: step.probabilities, confidence: step.confidence, latency_ms: step.latency_ms }];

function MemoryContent({ value }: { value: MemoryValue | null }) {
  if (value === null) return <p className="text-xs italic text-muted-foreground">No entry</p>;
  if (typeof value === "string") return <p className="whitespace-pre-wrap break-words text-xs leading-5">{value || "(empty)"}</p>;
  return <div className="space-y-1.5">
    <p className="break-all font-mono text-[11px] text-muted-foreground">{value.path} · chars {value.start + 1}–{value.end}</p>
    <blockquote className="whitespace-pre-wrap break-words border-l-2 pl-3 text-xs leading-5">{value.quote}</blockquote>
  </div>;
}

function ReadingContent({ reading }: { reading: Reading }) {
  return <div>
    <p className="flex flex-wrap justify-between gap-2 font-mono text-[11px] text-muted-foreground">
      <span className="break-all">{reading.path}</span>
      <span>{reading.totalChars ? `Chars ${reading.start + 1}–${reading.end}` : "Empty file"} / {reading.totalChars}</span>
    </p>
    <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-muted/30 p-3 font-mono text-xs leading-5">{reading.text || "(empty)"}</pre>
    <p className="mt-2 text-[11px] text-muted-foreground">{reading.hasMore ? "More text is available. The model can choose another page." : "End of file reached."}</p>
  </div>;
}

function GoalPage({ page }: { page: FileView }) {
  return <div>
    <p className="flex flex-wrap justify-between gap-2 font-mono text-[11px] text-muted-foreground">
      <span>Current goal page</span>
      <span>{page.totalChars ? `Chars ${page.start + 1}–${page.end} / ${page.totalChars}` : "Empty goal"}</span>
    </p>
    <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/30 p-3 font-mono text-xs leading-5">{page.text || "(empty)"}</pre>
    {(page.start > 0 || page.end < page.totalChars) && <p className="mt-2 text-[11px] text-muted-foreground">This is one part of the saved goal. The model can choose read_goal to view another page.</p>}
  </div>;
}

function DecisionTokenUsage({ decision }: { decision: Decision }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
    <span>{decision.input_tokens === undefined ? "Input tokens not recorded" : `Preflight ${decision.input_tokens.toLocaleString("en-US")} input tokens`}</span>
    {decision.reported_input_tokens !== undefined && <span>Model-reported {decision.reported_input_tokens.toLocaleString("en-US")}</span>}
    {decision.context_compacted && <span className="font-medium text-foreground">Context compacted before this decision</span>}
    <span className="w-full break-all">Recorded decision model · {decision.model ?? "Not recorded"}</span>
  </div>;
}

async function call(workspace: string, body?: Record<string, unknown>): Promise<Snapshot> {
  const response = await fetch(`/api/tool-loop?workspace=${encodeURIComponent(workspace)}`, body ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace, ...body }),
  } : { cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result;
}

export function ToolPlayground() {
  const [workspace, setWorkspace] = useState("demo");
  const [state, setState] = useState<Snapshot | null>(null);
  const [source, setSource] = useState(pretty(EXAMPLE));
  const [selectedPreset, setSelectedPreset] = useState<keyof typeof EXAMPLES>("hello_world");
  const [model, setModel] = useState(`Connecting to ${MODEL_ID}…`);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetScope, setResetScope] = useState<"files" | "all">("files");
  const stopRequested = useRef(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let alive = true;
    const initialWorkspace = new URLSearchParams(window.location.search).get("workspace") ?? "demo";
    call(initialWorkspace).then(s => {
      if (alive) {
        setWorkspace(s.workspace); setState(s);
        if (s.run) {
          setSource(pretty(s.run.program));
          const preset = presetFor(s.run.program);
          if (preset) setSelectedPreset(preset);
        }
      }
    }).catch(e => { if (alive) setError(e.message); });
    fetch("/kev/v1/models").then(async r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const m = data.models[0];
      if (alive) setModel(`${m.run} · ${m.backend} · ${m.dtype}`);
    }).catch(() => { if (alive) setModel("Model offline · Check :8009"); });
    return () => { alive = false; stopRequested.current = true; };
  }, []);

  let invalid: string | null = null;
  let draftReadLimit = 400;
  let draftWriteLimit = 120;
  try {
    const draft = parseProgram(JSON.parse(source));
    draftReadLimit = draft.readLimit ?? 400;
    draftWriteLimit = draft.writeLimit ?? 120;
  } catch (e) { invalid = (e as Error).message; }
  const active = state?.run?.status === "running";
  const loaded = state?.workspace === workspace;

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      validateName(workspace);
      const next = await call(workspace);
      setState(next); setSource(pretty(next.run?.program ?? EXAMPLE));
      const preset = presetFor(next.run?.program ?? EXAMPLE);
      if (preset) setSelectedPreset(preset);
      const url = new URL(window.location.href);
      url.searchParams.set("workspace", workspace);
      window.history.replaceState(null, "", url);
    } catch (e) { setError((e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function run(automatic: boolean) {
    if (inFlight.current || !state || !loaded) return;
    inFlight.current = true; stopRequested.current = false;
    setBusy(true); setStopping(false); setError(null);
    let current = state;
    try {
      if (current.run?.status !== "running") {
        current = await call(workspace, { operation: "start", program: parseProgram(JSON.parse(source)) });
        setState(current);
      }
      do {
        if (stopRequested.current || current.run?.status !== "running") break;
        current = await call(workspace, { operation: "step", runId: current.run.id, expectedStep: current.run.steps.length });
        setState(current);
      } while (automatic && current.run?.status === "running");
      if (stopRequested.current && current.run?.status === "running") {
        current = await call(workspace, { operation: "stop", runId: current.run.id });
        setState(current);
      }
    } catch (e) {
      setError((e as Error).message);
      // A lost HTTP reply may follow a committed step. Reload before the next request.
      try { setState(await call(workspace)); } catch { /* Keep the original error visible. */ }
    } finally { inFlight.current = false; setBusy(false); setStopping(false); }
  }

  async function stop() {
    stopRequested.current = true;
    if (inFlight.current) { setStopping(true); return; }
    if (!state?.run || state.run.status !== "running") return;
    inFlight.current = true; setBusy(true); setError(null);
    try { setState(await call(state.workspace, { operation: "stop", runId: state.run.id })); }
    catch (e) { setError((e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }

  async function resetOrRestore(operation: "reset" | "restore") {
    if (inFlight.current || !state || !loaded || active) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const next = await call(state.workspace, {
        operation,
        ...(operation === "reset" ? { scope: resetScope } : {}),
        runId: state.run?.id ?? null,
      });
      setState(next);
      setSource(pretty(operation === "reset" ? EXAMPLE : next.run?.program ?? EXAMPLE));
      const preset = presetFor(operation === "reset" ? EXAMPLE : next.run?.program ?? EXAMPLE);
      if (preset) setSelectedPreset(preset);
      stopRequested.current = false;
      setStopping(false);
    } catch (e) { setError((e as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }

  const latest = state?.run?.steps.at(-1);
  const checks = state?.run ? completionChecks(state.run.program, state) : [];
  const unmetChecks = checks.some(check => !check.met);
  return (
    <main lang="en" className="mx-auto w-full max-w-7xl px-5 py-8 md:px-10">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b pb-5">
        <nav className="flex items-center gap-5 text-sm" aria-label="Playgrounds">
          <Link href="/" className="font-semibold">kev</Link>
          <Link href="/" className="text-muted-foreground hover:text-foreground">decisions</Link>
          <Link href="/chess" className="text-muted-foreground hover:text-foreground">chess</Link>
          <span aria-current="page" className="font-medium">tools</span>
        </nav>
        <p className="font-mono text-xs text-muted-foreground">{model}</p>
      </header>

      <div className="my-8 max-w-3xl">
        <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted-foreground">Choice Programming</p>
        <h1 className="text-3xl font-medium tracking-tight">Let the model choose the next action.</h1>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">Give the model a dictionary of tools and arguments. It can build code in small edits, read bounded pages, and maintain memory until it chooses <code className="text-foreground">finish</code>. Every decision receives all current memory and the latest file observation.</p>
        <p className="mt-3 font-mono text-xs text-muted-foreground">Choose tool → Choose arguments → Observe result → Repeat</p>
      </div>

      <div className="mb-7 flex flex-wrap items-end justify-between gap-4 rounded-lg border bg-muted/20 p-4">
        <div className="flex items-end gap-2">
          <div className="w-44">
            <label htmlFor="workspace" className="mb-1.5 block text-xs text-muted-foreground">Workspace · Files and memory persist</label>
            <input id="workspace" value={workspace} onChange={e => setWorkspace(e.target.value)} disabled={busy || active} className={`${input} font-mono`} />
          </div>
          <button onClick={load} disabled={busy || active} className={button}>Load</button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => run(true)} disabled={busy || !loaded || !!invalid} className={`${button} border-foreground bg-foreground text-background hover:bg-foreground/85`}>
            {busy ? (stopping ? "Stopping after this step…" : "Working…") : active ? "Continue loop" : "Run loop"}
          </button>
          <button onClick={() => run(false)} disabled={busy || !loaded || !!invalid} className={button}>Single step</button>
          <button onClick={stop} disabled={(!active && !busy) || stopping} className={button}>Stop</button>
        </div>
      </div>

      <div className="mb-7 flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4">
        <div className="max-w-xl text-xs leading-5 text-muted-foreground">
          <p className="font-medium text-foreground">Reset sandbox</p>
          <p>Files only keeps memory. Files and memory starts fresh. Both clear the current run and save an archive for Restore last reset. The example files are seeded when a new run starts.</p>
          {active && <p className="mt-1">Stop the active run before resetting or restoring.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="reset-scope" className="sr-only">Reset scope</label>
          <select id="reset-scope" className={`${input} w-auto`} value={resetScope} disabled={busy || active || !loaded} onChange={e => setResetScope(e.target.value as "files" | "all")}>
            <option value="files">Files only</option>
            <option value="all">Files and memory</option>
          </select>
          <button onClick={() => resetOrRestore("reset")} disabled={busy || active || !loaded} className={button}>Reset sandbox</button>
          <button onClick={() => resetOrRestore("restore")} disabled={busy || active || !loaded || !state?.resetAvailable} className={button}>Restore last reset</button>
        </div>
      </div>

      {(error || state?.run?.error) && <p role="alert" className="mb-5 rounded-md border border-destructive/40 p-3 text-sm text-destructive">{error ?? state?.run?.error}</p>}
      {!loaded && state && <p className="mb-4 text-sm text-muted-foreground">Load this workspace before running.</p>}

      <FileDecisionTimeline key={state?.run?.id ?? "empty"} run={state?.run ?? null} busy={busy && state?.run?.status === "running"} />

      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-medium">01 / Program</h2>
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="example-preset" className="sr-only">Example preset</label>
              <select id="example-preset" value={selectedPreset} disabled={busy || active} className={`${input} w-auto`} onChange={e => {
                const preset = e.target.value as keyof typeof EXAMPLES;
                setSelectedPreset(preset);
                setSource(pretty(EXAMPLES[preset].program));
              }}>
                {Object.entries(EXAMPLES).map(([key, example]) => <option key={key} value={key}>{example.name}</option>)}
              </select>
              <button className="text-xs text-muted-foreground underline underline-offset-4 disabled:opacity-40" disabled={busy || active} onClick={() => setSource(pretty(EXAMPLES[selectedPreset].program))}>Load example</button>
            </div>
          </div>
          <label htmlFor="program" className="sr-only">Program JSON</label>
          <textarea id="program" spellCheck={false} value={source} disabled={busy || active} onChange={e => setSource(e.target.value)} aria-invalid={!!invalid}
            className={`${input} min-h-[560px] resize-y font-mono text-xs leading-5`} />
          {invalid && <p className="mt-2 text-xs text-destructive">{invalid}</p>}
          <p className="mt-3 text-xs leading-5 text-muted-foreground">Tools: <code>create_file</code> · <code>append_file</code> · <code>replace_file_range</code> · <code>read_file</code> · <code>remember_excerpt</code> · <code>write_memory</code> · <code>edit_memory</code> · <code>delete_memory</code> · <code>finish</code>. File targets, visible ranges, input modes, and text are separate choices. Built-in <code>read_goal</code> is added automatically only when the saved goal spans multiple pages.</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">Try Hello world, 1 + 1, or variables and addition. Choosing a preset updates the editor for the next run. The model can read the tutorial, create a file, and build code across several edits. Each write returns a bounded editor view for the next decision.</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">Edits can use a fragment dictionary or character input. The mode choice lists available fragments; character input uses small groups from the configured <code>characters</code> alphabet. Every text choice previews its result. Select a visible range to replace text, or an insertion cursor to add text without deleting existing characters.</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground"><code>readLimit</code> limits each page to Unicode characters (default 400, maximum 1,200), rather than a linguistic word count. Only the newest page remains in the reading buffer. Remembered excerpts are at most 120 characters and include their file and character range.</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground"><code>writeLimit</code> limits each insertion to Unicode characters (default 120, maximum 400). <code>create_file</code> only creates missing files. <code>append_file</code> requires a current reading of the file’s end. <code>replace_file_range</code> edits visible text; equal start and end offsets insert at a cursor. Long readings can be narrowed with <code>focus_range</code>.</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">The presets keep useful file excerpts in memory. Custom dictionaries can add <code>write_memory</code> notes; set <code>requiresChecks: true</code> to make a note available only after all checks pass. Memory choices that would preserve the same value are omitted.</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">This playground uses choices to build code and maintain memory. Custom dictionaries can also use <code>write_python</code> for one composed statement or <code>write_file</code> for a static file write. Reads and writes leave memory unchanged until the model chooses a memory tool. <code>initialFiles</code> seeds missing files when a run starts.</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">Optional <code>checks</code> report which file and memory requirements are met. The programming presets use a restricted Python subset checker for expected output. It supports these basic exercises without running arbitrary Python. The <code>finish</code> tool becomes available only after all checks pass.</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">New runs reuse existing files and memory. The model must read an existing file before editing it. Keep this page open for automatic execution; you can resume after a reload. Stop waits for the current step to finish.</p>
        </section>

        <section className="min-w-0" aria-labelledby="trace-title">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="trace-title" className="text-sm font-medium">02 / Execution trace</h2>
            <span role="status" className="font-mono text-xs text-muted-foreground">
              {state?.run ? `${state.run.steps.length}/${state.run.program.maxSteps} · ${busy ? "Running" : state.run.status === "ended" && unmetChecks ? "Finished · Checks failed" : labels[state.run.status]}` : "Not started"}
            </span>
          </div>
          <div className="mb-3 rounded-md border bg-muted/15 px-3 py-2 text-xs leading-5">
            <p className="font-medium">Model input budget · {MAX_INPUT_TOKENS.toLocaleString("en-US")} tokens per decision</p>
            <p className="break-all text-[11px] text-muted-foreground">Current model · <code>{MODEL_ID}</code></p>
            {state?.run && <p className="break-all text-[11px] text-muted-foreground">Recorded run model · {state.run.model ?? "Not recorded for this run"}</p>}
            <p className="text-[11px] text-muted-foreground">Each request is token-counted before the model call and must fit this hard limit. The trace records preflight counts and context compaction.</p>
          </div>
          {checks.length > 0 && <ul className="mb-3 space-y-1 text-xs" aria-label="Completion checks">{checks.map(check => <li key={check.name} className={check.met ? "text-foreground" : "text-muted-foreground"} title={check.requirement}>
            {check.met ? "✓" : "○"} {check.name.replaceAll("_", " ")}
            {"detail" in check && typeof check.detail === "string" && <span className="ml-2">· {check.detail}</span>}
          </li>)}</ul>}
          <div className="max-h-[560px] space-y-3 overflow-y-auto rounded-lg border bg-muted/10 p-4" aria-live="polite">
            {!state?.run?.steps.length && <div className="py-16 text-center text-sm leading-7 text-muted-foreground">Start with the example program.<br />Choose tool → Choose arguments → Observe result → Repeat<br /><span className="text-xs">The model chooses the order and when to finish.</span></div>}
            {state?.run?.steps.map(step => (
              <details key={step.number} className="rounded-md border bg-background p-3" open={step.number === latest?.number}>
                <summary className="cursor-pointer text-sm">
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{String(step.number).padStart(2, "0")}</span>
                  <span className="font-mono font-medium">{step.decisions && !["END", "finish"].includes(step.action.tool) ? `${step.action.tool} → ${step.choice}` : step.choice}</span>
                  <span className="float-right font-mono text-xs text-muted-foreground">{step.latency_ms.toFixed(0)} ms</span>
                </summary>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <p className={`text-xs leading-5 ${step.result.ok ? "text-muted-foreground" : "text-destructive"}`}>{step.result.ok ? "✓" : "!"} {step.result.message}</p>
                  {step.result.changed === false && <span className="rounded border bg-muted/30 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">No state change</span>}
                </div>
                {step.result.fileChange && <div className="mt-3 rounded-md border p-3 text-xs leading-5">
                  <p className="break-all font-medium">File change · <code>{step.result.fileChange.path}</code></p>
                  <p className="mt-1 text-muted-foreground">{step.result.fileChange.start === step.result.fileChange.end ? `Insertion point ${step.result.fileChange.start + 1}` : `Replaced chars ${step.result.fileChange.start + 1}–${step.result.fileChange.end}`} · {step.result.fileChange.insertedChars} chars inserted · {step.result.fileChange.totalChars} chars total</p>
                </div>}
                {step.result.reading && <div className="mt-3 rounded-md border p-3"><p className="mb-2 text-xs font-medium">File observation returned to the model</p><ReadingContent reading={step.result.reading} /></div>}
                {step.result.goalReading && <div className="mt-3 rounded-md border p-3"><p className="mb-2 text-xs font-medium">Goal memory returned to the model</p><GoalPage page={step.result.goalReading} /></div>}
                {step.result.memoryChange && <div className="mt-3 rounded-md border p-3">
                  <p className="mb-3 break-all text-xs font-medium">Memory change · <code>{step.result.memoryChange.key}</code></p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div><p className="mb-1 text-[11px] text-muted-foreground">Before</p><MemoryContent value={step.result.memoryChange.before} /></div>
                    <div><p className="mb-1 text-[11px] text-muted-foreground">After</p><MemoryContent value={step.result.memoryChange.after} /></div>
                  </div>
                </div>}
                {decisionsFor(step).map((decision, index) => (
                  <div key={decision.stage} className="mt-4 space-y-2 border-t pt-3">
                    <p className="flex flex-wrap justify-between gap-1 text-[11px] text-muted-foreground">
                      <span>{step.decisions ? `${index + 1}. ${decisionLabels[decision.stage] ?? "Argument dictionary"}` : "Action selection"} · <span className="font-mono text-foreground">{decision.choice}</span></span>
                      <span>{decision.latency_ms.toFixed(0)} ms</span>
                    </p>
                  {Object.entries(decision.probabilities).sort((a, b) => b[1] - a[1]).map(([key, p]) => (
                    <div key={key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_3.2rem] items-center gap-3 text-[11px]">
                      <span className={`truncate font-mono ${key === decision.choice ? "font-semibold" : "text-muted-foreground"}`} title={key}>{key}</span>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden><div className={`h-full ${key === decision.choice ? "bg-foreground" : "bg-muted-foreground/40"}`} style={{ width: `${p * 100}%` }} /></div>
                      <span className="text-right font-mono">{(p * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                    <p className="text-[11px] text-muted-foreground">Confidence {decision.confidence.toFixed(3)}</p>
                    <DecisionTokenUsage decision={decision} />
                  </div>
                ))}
                <pre className="mt-2 overflow-auto rounded bg-muted/40 p-2 text-[11px] leading-5">{pretty(step.action)}</pre>
              </details>
            ))}
          </div>
          {state?.run?.status === "limit" && <p className="mt-2 text-xs text-muted-foreground">The run reached maxSteps before completion. Inspect the decisions, adjust the goal or dictionary, and start a new run.</p>}
          {state?.run?.status === "ended" && <p className="mt-2 text-xs text-muted-foreground">{unmetChecks ? "The model chose to finish before all checks passed. Inspect the failed checks and file contents, then start another run to continue the task." : "The model chose to finish. Inspect the results below, or run again to verify that memory carries over."}</p>}
        </section>
      </div>

      <section className="mt-9 min-w-0 rounded-lg border p-4" aria-labelledby="goal-memory-title">
        <h2 id="goal-memory-title" className="mb-2 text-sm font-medium">Goal memory</h2>
        <p className="mb-3 text-xs leading-5 text-muted-foreground">The full goal is saved with the run. Each decision receives only the current goal page, together with all persistent notes and the current file observation. For multi-page goals, the model can choose <code>read_goal</code> to select another page.</p>
        {state?.run?.goalReading ? <GoalPage page={state.run.goalReading} /> : <p className="rounded bg-muted/30 p-3 text-xs text-muted-foreground">{state?.run ? "This run did not record a goal memory page." : "Start a run to record its current goal page."}</p>}
      </section>

      <section className="mt-7 min-w-0 border-t pt-6" aria-labelledby="reading-title">
        <h2 id="reading-title" className="mb-2 text-sm font-medium">03 / Current reading <span className="ml-2 font-mono text-xs text-muted-foreground">{state?.run ? state.run.program.readLimit ?? 400 : draftReadLimit} chars per page</span></h2>
        <p className="mb-3 text-xs leading-5 text-muted-foreground">Reads and writes refresh this bounded buffer. It is sent with every decision while its source remains current. Older page text is excluded from model history. Save an excerpt in memory to carry it into later pages and runs.</p>
        <div className="rounded-lg border p-4">
          {state?.run?.reading ? <ReadingContent reading={state.run.reading} /> : <p className="text-xs text-muted-foreground">No current file observation. The model must read an existing file before editing it, or create a new empty file.</p>}
        </div>
      </section>

      <div className="mt-7 grid gap-8 md:grid-cols-2">
        <section className="min-w-0">
          <h2 className="mb-2 text-sm font-medium">04 / Persistent memory <span className="ml-2 font-mono text-xs text-muted-foreground">{Object.keys(state?.memory ?? {}).length} entries</span></h2>
          <p className="mb-3 text-xs leading-5 text-muted-foreground">All entries are sent to the model on every decision, including later runs. The model can add, replace, or delete entries.</p>
          <div className="max-h-96 min-h-28 space-y-3 overflow-auto rounded-lg border bg-muted/20 p-4">
            {!Object.keys(state?.memory ?? {}).length && <p className="text-xs text-muted-foreground">No memory yet. Reading a file does not automatically add an entry.</p>}
            {Object.entries(state?.memory ?? {}).map(([key, value]) => <div key={key} className="rounded-md border bg-background p-3"><p className="mb-2 break-all font-mono text-xs font-medium">{key}</p><MemoryContent value={value} /></div>)}
          </div>
        </section>
        <section className="min-w-0">
          <h2 className="mb-2 text-sm font-medium">05 / Sandbox files <span className="ml-2 font-mono text-xs text-muted-foreground">{state?.files.length ?? 0} files · {state?.run ? state.run.program.writeLimit ?? 120 : draftWriteLimit} chars per edit</span></h2>
          <p className="mb-3 text-xs leading-5 text-muted-foreground">Full previews are for you. The model receives bounded file observations from reads and writes.</p>
          <div className="max-h-96 min-h-28 space-y-2 overflow-auto rounded-lg border p-3">
            {!state?.files.length && <p className="p-1 text-xs text-muted-foreground">Seeded files and files written by the model will appear here.</p>}
            {state?.files.map(file => <details key={file.path} open><summary className="cursor-pointer font-mono text-xs">{file.path}</summary><pre className="mt-2 overflow-auto rounded bg-muted/30 p-2 font-mono text-xs leading-5">{file.content}</pre></details>)}
          </div>
        </section>
      </div>
      <p className="mt-5 break-all font-mono text-[11px] text-muted-foreground">{state?.storagePath ?? "Loading storage location…"}</p>
    </main>
  );
}
