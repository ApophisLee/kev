"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowRight, Check, ChevronLeft, ChevronRight, Clock, Code, FilePlus, Pause, Pencil, Play, SkipForward } from "lucide-react";
import { buildFileTimeline } from "@/lib/file-timeline";
import type { Run } from "@/lib/tool-loop";

type Frame = ReturnType<typeof buildFileTimeline>[number];
type FileWindow = NonNullable<Frame["after"]>;
const control = "inline-flex items-center justify-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35 motion-reduce:transition-none";
const toolNames: Record<string, string> = {
  create_file: "Create file", append_file: "Append text", replace_file_range: "Replace range",
  write_file: "Write file", write_python: "Compose Python",
};
const time = (ms: number) => ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)} s`;
const actionName = (tool: string) => toolNames[tool] ?? tool.replaceAll("_", " ");

function CodeText({ text, changed }: { text: string; changed: boolean }) {
  const lines = text.split("\n");
  return <>{lines.map((line, index) => <span key={index}>{line}{index < lines.length - 1 && <>{changed && <span aria-label="newline" className="select-none opacity-55">↵</span>}{"\n"}</>}</span>)}</>;
}

function FilePane({ title, view, change, after }: { title: string; view: FileWindow | null | undefined; change: Frame["change"]; after: boolean }) {
  const chars = view ? Array.from(view.text) : [];
  const rangeStart = change?.start ?? 0;
  const rangeEnd = change ? (after ? change.start + change.insertedChars : change.end) : 0;
  const highlightStart = view ? Math.max(0, Math.min(chars.length, rangeStart - view.start)) : 0;
  const highlightEnd = view ? Math.max(highlightStart, Math.min(chars.length, rangeEnd - view.start)) : 0;
  const highlighted = highlightEnd > highlightStart;
  const color = after ? "bg-emerald-500/15 text-emerald-950 dark:text-emerald-200" : "bg-amber-500/20 text-amber-950 dark:text-amber-200";
  return <section className="min-w-0 overflow-hidden rounded-lg border bg-background" aria-label={`${title} file contents`}>
    <div className="flex items-center justify-between gap-2 border-b bg-muted/25 px-3.5 py-2.5">
      <h4 className="flex items-center gap-2 text-xs font-medium"><span className={`h-1.5 w-1.5 rounded-full ${after ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden />{title}</h4>
      {view && <span className="font-mono text-[10px] text-muted-foreground">{view.totalChars} chars total</span>}
    </div>
    {view === undefined ? <div className="flex min-h-36 items-center gap-3 px-4 py-6 text-muted-foreground">
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
      <div><p className="text-xs font-medium">{title} view unavailable</p><p className="mt-1 text-[11px] leading-5">This recorded step has no {title.toLowerCase()} window. Earlier content is not inferred.</p></div>
    </div> : view === null ? <div className="flex min-h-36 items-center gap-3 px-4 py-6 text-muted-foreground">
      <FilePlus className="h-5 w-5 shrink-0" aria-hidden /><div><p className="text-xs font-medium">File did not exist</p><p className="mt-1 text-[11px]">This step creates a new file.</p></div>
    </div> : <>
      <pre className="min-h-36 max-h-72 overflow-auto whitespace-pre-wrap break-words px-4 py-4 font-mono text-xs leading-6 [tab-size:2]" aria-label={`${title} recorded code window`}>
        {chars.length ? <code><CodeText text={chars.slice(0, highlightStart).join("")} changed={false} />{highlighted && <mark className={`rounded-sm px-0.5 ${color}`}><CodeText text={chars.slice(highlightStart, highlightEnd).join("")} changed /></mark>}<CodeText text={chars.slice(highlightEnd).join("")} changed={false} /></code> : <span className="italic text-muted-foreground">Empty file</span>}
      </pre>
      <p className="border-t px-3.5 py-2 text-[10px] leading-4 text-muted-foreground">
        {view.totalChars === 0 ? "0 characters" : view.start === view.end ? `Position ${view.start + 1} of ${view.totalChars}` : `Characters ${view.start + 1}–${view.end} of ${view.totalChars}`}
        {view.start > 0 || view.end < view.totalChars ? " · Partial recorded window" : " · Full file recorded"}
        {highlighted && <span> · {after ? "Inserted text highlighted" : "Replaced text highlighted"}</span>}
      </p>
    </>}
  </section>;
}

export function FileDecisionTimeline({ run, busy }: { run: Run | null; busy: boolean }) {
  const frames = useMemo(() => buildFileTimeline(run), [run]);
  const files = useMemo(() => [...new Set(frames.map(frame => frame.path))], [frames]);
  const [fileFilter, setFileFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [playing, setPlaying] = useState(false);
  const filtered = useMemo(() => fileFilter ? frames.filter(frame => frame.path === fileFilter) : frames, [frames, fileFilter]);
  const selected = followLatest ? filtered.at(-1) : filtered.find(frame => frame.id === selectedId) ?? filtered[0];
  const selectedIndex = selected ? filtered.findIndex(frame => frame.id === selected.id) : -1;
  const rail = useRef<HTMLDivElement>(null);
  const activeNode = useRef<HTMLButtonElement>(null);
  const modelTime = run?.steps.reduce((sum, step) => sum + (Number.isFinite(step.latency_ms) ? Math.max(0, step.latency_ms) : 0), 0) ?? 0;

  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      const next = filtered[selectedIndex + 1];
      if (next) setSelectedId(next.id);
      else setPlaying(false);
    }, 1600);
    return () => window.clearTimeout(timer);
  }, [playing, filtered, selectedIndex]);

  useEffect(() => {
    const container = rail.current;
    const node = activeNode.current;
    if (!container || !node) return;
    const area = container.getBoundingClientRect();
    const item = node.getBoundingClientRect();
    if (item.left < area.left + 8) container.scrollLeft += item.left - area.left - 8;
    else if (item.right > area.right - 8) container.scrollLeft += item.right - area.right + 8;
  }, [selected?.id]);

  function select(frame: Frame) {
    setSelectedId(frame.id); setFollowLatest(false); setPlaying(false);
  }
  function replay() {
    if (playing) { setPlaying(false); return; }
    if (!filtered.length) return;
    setFollowLatest(false);
    setSelectedId(selectedIndex >= filtered.length - 1 ? filtered[0].id : selected?.id ?? filtered[0].id);
    setPlaying(true);
  }

  return <section className="mb-8 overflow-hidden rounded-xl border bg-muted/10" aria-labelledby="file-timeline-title">
    <div className="flex flex-wrap items-start justify-between gap-4 border-b bg-background px-5 py-5">
      <div>
        <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground"><Code className="h-3.5 w-3.5" aria-hidden />Recorded decisions</div>
        <h2 id="file-timeline-title" className="text-lg font-medium tracking-tight">File-writing timeline</h2>
        <p className="mt-1.5 max-w-2xl text-xs leading-5 text-muted-foreground">Trace each write from the model’s choices to the file change. Select a step to inspect its recorded editor windows.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <label htmlFor="timeline-file" className="text-xs text-muted-foreground">File</label>
        <select id="timeline-file" value={fileFilter} disabled={!files.length} onChange={event => { setFileFilter(event.target.value); setSelectedId(null); setFollowLatest(true); setPlaying(false); }} className="max-w-64 rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40">
          <option value="">All files</option>
          {files.map(path => <option key={path} value={path}>{path || "Unknown file"}</option>)}
        </select>
      </div>
    </div>

    <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span><span className="font-mono font-medium text-foreground">{frames.length}</span> write {frames.length === 1 ? "step" : "steps"}</span>
        <span><span className="font-mono font-medium text-foreground">{files.length}</span> {files.length === 1 ? "file" : "files"}</span>
        <span className="inline-flex items-center gap-1.5" title="Sum of model decision latency across all completed run steps, including non-file tools."><Clock className="h-3 w-3" aria-hidden />Model time <span className="font-mono text-foreground">{time(modelTime)}</span></span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={followLatest} onChange={event => { setSelectedId(selected?.id ?? null); setFollowLatest(event.target.checked); setPlaying(false); }} className="h-3.5 w-3.5 accent-foreground" />Follow latest</label>
        <button className={control} disabled={!filtered.length || followLatest} onClick={() => { setFollowLatest(true); setPlaying(false); }}><SkipForward className="h-3 w-3" aria-hidden />Latest</button>
      </div>
    </div>

    {busy && run?.status === "running" && <p role="status" className="flex items-center gap-2 border-b bg-background px-5 py-2.5 text-[11px] text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />Waiting for a completed step. Decisions appear here after the operation finishes.</p>}

    {!frames.length ? <div className="flex min-h-52 flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-4 flex items-center gap-3 text-muted-foreground"><span className="rounded-lg border bg-background p-2.5"><Code className="h-5 w-5" aria-hidden /></span><ArrowRight className="h-4 w-4" aria-hidden /><span className="rounded-lg border bg-background p-2.5"><Pencil className="h-5 w-5" aria-hidden /></span></div>
      <p className="text-sm font-medium">The first file write starts the timeline.</p>
      <p className="mt-2 max-w-md text-xs leading-6 text-muted-foreground">Run the program or take a single step. File targets, input modes, selected text, and the resulting edit will appear as recorded steps.</p>
    </div> : <>
      <div ref={rail} className="overflow-x-auto px-5 py-5" aria-label="File-writing step navigation">
        <ol className="flex w-max min-w-full items-stretch" aria-label="Recorded file-writing steps">
          {filtered.map((frame, index) => <li key={frame.id} className="flex items-center">
            <button ref={frame.id === selected?.id ? activeNode : undefined} type="button" aria-pressed={frame.id === selected?.id} aria-label={`Step ${frame.step}: ${actionName(frame.tool)}, ${frame.path}, ${frame.ok ? "succeeded" : "failed"}`} onClick={() => select(frame)} className={`relative min-h-28 w-44 overflow-hidden rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${frame.id === selected?.id ? "border-foreground bg-background shadow-sm" : "border-border bg-background/60 hover:border-muted-foreground/60 hover:bg-background"}`}>
              <div className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] text-muted-foreground">STEP {String(frame.step).padStart(2, "0")}</span>{frame.ok ? <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <AlertCircle className="h-3.5 w-3.5 text-destructive" aria-hidden />}</div>
              <p className="mt-2 text-xs font-medium">{actionName(frame.tool)}</p>
              <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={frame.path}>{frame.path || "Unknown file"}</p>
              <div className="mt-3 flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground"><span>{time(frame.durationMs)}</span><span className={frame.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}>{frame.ok && frame.change ? `+${frame.change.insertedChars}${frame.change.end > frame.change.start ? ` / −${frame.change.end - frame.change.start}` : ""}` : frame.ok ? "Recorded" : "Failed"}</span></div>
              {frame.id === selected?.id && <span className={`absolute inset-x-0 bottom-0 h-0.5 ${frame.ok ? "bg-emerald-500" : "bg-destructive"}`} aria-hidden />}
            </button>
            {index < filtered.length - 1 && <div className="flex w-8 shrink-0 items-center justify-center text-muted-foreground/50"><ArrowRight className="h-3.5 w-3.5" aria-hidden /></div>}
          </li>)}
        </ol>
      </div>

      {selected && <div className="border-t bg-background px-4 py-5 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Step {String(selected.step).padStart(2, "0")} · {actionName(selected.tool)}</p>
            <h3 className="mt-1.5 break-all font-mono text-base font-medium">{selected.path || "Unknown file"}</h3>
            <p className={`mt-2 flex items-start gap-1.5 text-xs leading-5 ${selected.ok ? "text-muted-foreground" : "text-destructive"}`}>{selected.ok ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}{selected.message}</p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <div className="flex items-center gap-1.5">
              <button className={control} disabled={selectedIndex <= 0} onClick={() => select(filtered[selectedIndex - 1])} aria-label="Previous recorded write"><ChevronLeft className="h-3.5 w-3.5" aria-hidden />Previous</button>
              <span className="px-1 font-mono text-[10px] text-muted-foreground">{selectedIndex + 1} / {filtered.length}</span>
              <button className={control} disabled={selectedIndex >= filtered.length - 1} onClick={() => select(filtered[selectedIndex + 1])} aria-label="Next recorded write">Next<ChevronRight className="h-3.5 w-3.5" aria-hidden /></button>
              <button className={control} disabled={filtered.length < 2} onClick={replay} aria-pressed={playing}>{playing ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}{playing ? "Pause replay" : "Replay"}</button>
            </div>
            <p className="text-[10px] text-muted-foreground">Replay recorded steps · No model calls</p>
          </div>
        </div>

        <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Decision path</h4>
          <p className="font-mono text-[10px] text-muted-foreground">Model time {time(selected.startMs)} → {time(selected.startMs + selected.durationMs)}</p>
        </div>
        {selected.stages.length ? <ol className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-stretch" aria-label="Model decisions for this write">
          {selected.stages.map((stage, index) => <li key={`${stage.stage}-${index}`} className="flex min-w-0 flex-1 items-stretch sm:min-w-36">
            <div className="flex min-w-0 flex-1 flex-col rounded-lg border bg-muted/15 p-3">
              <p className="flex items-center gap-2 text-[10px] text-muted-foreground"><span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border bg-background font-mono text-[9px]">{index + 1}</span>{stage.title}</p>
              <code className="mt-3 block max-h-28 min-h-10 overflow-auto whitespace-pre-wrap break-words text-xs font-medium leading-5">{stage.value || "(empty value)"}</code>
              {stage.choice !== stage.value && <p className="mt-1 truncate font-mono text-[9px] text-muted-foreground" title={stage.choice}>{stage.choice}</p>}
              <div className="mt-auto pt-3">
                <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-muted-foreground"><span title="Probability assigned to the selected choice">{stage.probability === null ? "Probability unavailable" : `${(stage.probability * 100).toFixed(1)}% selected`}</span><span>{time(stage.latencyMs)}</span></div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden><div className="h-full rounded-full bg-foreground/65" style={{ width: `${Math.max(0, Math.min(100, (stage.probability ?? 0) * 100))}%` }} /></div>
              </div>
            </div>
            {index < selected.stages.length - 1 && <span className="hidden w-5 shrink-0 items-center justify-center text-muted-foreground/50 sm:flex"><ArrowRight className="h-3 w-3" aria-hidden /></span>}
          </li>)}
        </ol> : <p className="rounded-lg border border-dashed p-4 text-xs leading-5 text-muted-foreground">Individual model decisions were not recorded for this step.</p>}

        <div className="mb-3 mt-6 flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Recorded file change</h4>
          {selected.change && <p className="font-mono text-[10px] text-muted-foreground">{selected.change.start === selected.change.end ? `Position ${selected.change.start + 1}` : `Replaced chars ${selected.change.start + 1}–${selected.change.end}`} · {selected.change.insertedChars} inserted</p>}
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <FilePane title="Before" view={selected.before} change={selected.change} after={false} />
          <FilePane title="After" view={selected.after} change={selected.change} after />
        </div>
        <p className="mt-3 text-[10px] leading-5 text-muted-foreground">Character ranges use Unicode characters. Windows show what was recorded for this edit; unrecorded file contents remain unavailable.</p>
      </div>}
    </>}
  </section>;
}
