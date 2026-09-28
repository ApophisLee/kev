import { isPythonPrintProgram, PYTHON_FUNCTIONS } from "./python-dictionary.ts";
import { evaluatePythonSubset } from "./python-subset.ts";
import type { PythonFunction } from "./python-dictionary.ts";

// The model selects dictionary entries; reading and memory are separate decisions.
export const DEFAULT_READ_LIMIT = 400;
export const MAX_READ_LIMIT = 1200;
export const EXCERPT_LIMIT = 120;
export const DEFAULT_WRITE_LIMIT = 120;
export const MAX_WRITE_LIMIT = 400;
export const MAX_MEMORY_ENTRIES = 32;
export const MAX_MEMORY_CHARS = 8000;
export const LEGACY_COMPLETION_NOTE = {
  key: "task_status",
  value: "The requested Python program passes its output check.",
} as const;
export type MemoryIndex = { kind: "index"; path: string; start: number; end: number; quote: string };
export type MemoryValue = string | MemoryIndex;
export type Reading = { path: string; start: number; end: number; totalChars: number; hasMore: boolean; text: string; version: string };
export type FileView = Pick<Reading, "start" | "end" | "totalChars" | "text">;
type Description = { description: string };
export type StaticAction = Description & (
  | { tool: "write_file"; path: string; content: string }
  | { tool: "write_memory"; key: string; value: string; requiresChecks?: boolean }
  | { tool: "END" }
  | { tool: "finish" }
);
export type DynamicTool = "read_file" | "read_goal" | "remember_excerpt" | "edit_memory" | "delete_memory";
export type PythonAction = Description & { tool: "write_python"; paths: string[]; functions: PythonFunction[]; strings: Record<string, string> };
export type FileSegmentAction = Description & ({ tool: "create_file"; paths: string[] } | { tool: "append_file" | "replace_file_range"; paths: string[]; fragments?: Record<string, string>; characters?: string });
export type Action = StaticAction | PythonAction | FileSegmentAction | (Description & { tool: DynamicTool });
export type ExecutedAction = StaticAction | (Description & (
  | { tool: "create_file"; path: string }
  | { tool: "append_file"; path: string; content: string; offset: number; version: string }
  | { tool: "replace_file_range"; path: string; content: string; start: number; end: number; version: string }
  | { tool: "write_python"; path: string; function: PythonFunction; value: string; content: string }
  | { tool: "read_file"; path: string; offset: number; limit: number }
  | { tool: "read_goal"; offset: number; limit: number }
  | { tool: "remember_excerpt" | "edit_memory"; key: string; value: MemoryIndex }
  | { tool: "delete_memory"; key: string }
));
export function isLegacyCompletionNote(action: Action | ExecutedAction): boolean {
  return action.tool === "write_memory" && action.key === LEGACY_COMPLETION_NOTE.key && action.value === LEGACY_COMPLETION_NOTE.value;
}
export type CompletionCheck = ({ equals: string } & ({ file: string } | { memory: string })) | { file: string; pythonPrints: string } | { file: string; pythonOutput: string };
export type Program = {
  goal: string; maxSteps: number; actions: Record<string, Action>;
  readLimit?: number; writeLimit?: number; initialFiles?: Record<string, string>; checks?: Record<string, CompletionCheck>;
};
export type Decision = {
  stage: "tool" | "arguments" | "memory_target" | "python_file" | "python_function" | "python_string" | "write_target" | "write_range" | "write_range_group" | "write_fragment" | "write_mode" | "write_character_group" | "write_character"; choice: string; probabilities: Record<string, number>;
  confidence: number; latency_ms: number;
  input_tokens?: number; reported_input_tokens?: number; context_compacted?: boolean;
  model?: string;
};
export type Observation = {
  ok: boolean; message: string; reading?: Reading;
  changed?: boolean;
  goalReading?: FileView;
  fileChange?: { path: string; start: number; end: number; insertedChars: number; totalChars: number };
  // UI audit windows only. These are never included in model decision history.
  fileEdit?: { before: FileView | null; after: FileView; start: number; end: number; insertedChars: number };
  memoryChange?: { key: string; before: MemoryValue | null; after: MemoryValue | null };
};
export type Step = {
  number: number; choice: string;
  action: ExecutedAction | (Description & { tool: "read_file_to_memory"; path: string; key: string }); // Old traces only.
  probabilities: Record<string, number>; confidence: number; latency_ms: number; result: Observation;
  decisions?: Decision[];
};
export type Run = {
  id: string; program: Program; model?: string; status: "running" | "ended" | "stopped" | "limit" | "error";
  steps: Step[]; reading?: Reading | null; goalReading?: FileView; error?: string;
};
export type Snapshot = {
  workspace: string; storagePath: string; memory: Record<string, MemoryValue>;
  files: { path: string; content: string }[]; run: Run | null; resetAvailable: boolean;
};

const EDIT_CHARACTERS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("") + "\n";
const PYTHON_INTRO = [
  "PYTHON INTRODUCTION",
  "Python programs are plain text files with a .py extension. Python executes statements from top to bottom. A simple program does not need a class or a main function.",
  "FUNCTIONS AND STRINGS",
  "A function call uses a function name, an opening parenthesis, an argument, and a closing parenthesis. A string is text enclosed in quotes. End the statement with a newline. print displays its argument. Returning a value alone does not display it in a Python script.",
  "ARITHMETIC AND VARIABLES",
  "Use + to add numbers, - to subtract, * to multiply, and / to divide. Parentheses group expressions. An assignment uses a variable name, an equals sign, and a value. Later expressions can refer to that variable by name. Quoted digits are text; unquoted digits are numbers.",
  "EDITING IN SMALL STEPS",
  "Use create_file to start an empty file. Read the end of an existing file before appending. Use append_file to add a fragment or character without deleting earlier text. Each edit returns a bounded view. Use replace_file_range to edit inside visible source: select characters to replace, or a cursor with equal start/end to insert without deleting anything. focus_range locates smaller ranges in long readings. Check the before/after preview. An empty replacement removes the range. Unfinished statements may fail checks while being written. Memory remains separate from the editing view.",
  "OUTPUT CHECKS",
  "The playground checks a restricted Python subset: print, simple assignments, string and number literals, and basic arithmetic. Imports, loops, and arbitrary function calls are not supported by this checker. No submitted code is executed by the operating system.",
].join("\n\n");
function programmingExample(file: string, task: string, output: string, fragments: Record<string, string>): Program {
  const paths = [file, "scratch.py"];
  return {
    goal: task,
    maxSteps: 64, readLimit: 300, writeLimit: 40,
    initialFiles: { "docs/python-intro.md": PYTHON_INTRO },
    checks: { output_matches: { file, pythonOutput: output } },
    actions: {
      create: { tool: "create_file", description: "Create an empty target file without overwriting an existing file.", paths },
      append: { tool: "append_file", description: "Choose a target, then fragment or character input, and append one small piece.", paths, fragments, characters: EDIT_CHARACTERS },
      revise: { tool: "replace_file_range", description: "Replace visible characters or insert at a visible cursor using a short fragment or one character. Read the intended location first.", paths, fragments: { ...fragments, remove: "" }, characters: EDIT_CHARACTERS },
      python_intro: { tool: "read_file", description: "Read a limited page of the Python introduction or another sandbox file; continue or revisit pages when useful." },
      index_point: { tool: "remember_excerpt", description: "Choose a useful excerpt from the current reading and store its source index in memory." },
      revise_index: { tool: "edit_memory", description: "Replace an existing memory entry with a better excerpt from the current reading." },
      forget: { tool: "delete_memory", description: "Remove a memory entry that is irrelevant or outdated." },
      finish: { tool: "finish", description: "Finish when the requested Python program passes its output check." },
    },
  };
}
export const EXAMPLES: Record<string, { name: string; program: Program }> = {
  hello_world: { name: "Hello World", program: programmingExample("hello.py", 'Create hello.py that prints exactly "Hello, world!".', "Hello, world!\n", {
    open_print: "print(", open_len: "len(", open_repr: "repr(", greeting: '\"Hello, world!\"', name: '\"Kev\"', close_call: ")\n",
  }) },
  addition: { name: "Addition: 1 + 1", program: programmingExample("addition.py", "Create addition.py that computes 1 + 1 and prints the result.", "2\n", {
    open_print: "print(", one: "1", plus: " + ", minus: " - ", close_call: ")\n",
  }) },
  variables: { name: "Variables: a + b", program: programmingExample("variables.py", "Create variables.py. Assign 2 to a and 3 to b, then print a + b.", "5\n", {
    assign_a: "a = ", assign_b: "b = ", two: "2", three: "3", variable_a: "a", variable_b: "b", plus: " + ", open_print: "print(", close_call: ")\n", newline: "\n",
  }) },
};
export const EXAMPLE = EXAMPLES.hello_world.program;

export const characters = (value: string) => Array.from(value);
export function completionChecks(program: Program, state: Pick<Snapshot, "files" | "memory">) {
  return Object.entries(program.checks ?? {}).map(([name, check]) => {
    const current = "file" in check ? state.files.find(f => f.path === check.file)?.content : state.memory[check.memory];
    if ("pythonOutput" in check) {
      const result = typeof current === "string" ? evaluatePythonSubset(current) : { output: "", error: "File not created yet." };
      return { name, met: !result.error && result.output === check.pythonOutput,
        requirement: `Python file ${check.file} must output ${JSON.stringify(check.pythonOutput)}.`,
        detail: result.error ?? (result.output !== check.pythonOutput ? `Observed output: ${JSON.stringify(result.output)}.` : undefined) };
    }
    if ("pythonPrints" in check) return {
      name,
      met: typeof current === "string" && isPythonPrintProgram(current, check.pythonPrints),
      requirement: `Python file ${check.file} must print ${JSON.stringify(check.pythonPrints)}.`,
    };
    return { name, met: current === check.equals,
      requirement: `${"file" in check ? `File ${check.file}` : `Memory ${check.memory}`} must equal ${JSON.stringify(check.equals)}` };
  });
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown, label: string, max: number, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.trim()) || characters(value).length > max || value.includes("\0")) {
    throw new Error(`${label} must be ${empty ? "0" : "1"}–${max} characters, without NUL.`);
  }
}
export function validateName(value: unknown, label = "Workspace"): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`${label} must use 1–64 letters, numbers, underscores or hyphens.`);
  }
  if (["__proto__", "constructor", "prototype"].includes(value)) throw new Error(`Reserved ${label}.`);
}
export function validatePath(value: unknown): asserts value is string {
  string(value, "Sandbox path", 200);
  if (value.split("/").some(p => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(p))) {
    throw new Error("Use a relative sandbox path, e.g. notes/hello.txt; no traversal or hidden paths.");
  }
}
export function validateFilePaths(paths: string[]) {
  const files = new Set(paths);
  for (const file of files) {
    const segments = file.split("/");
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i).join("/");
      if (files.has(parent)) throw new Error(`Sandbox file paths conflict: ${parent} is also a parent of ${file}.`);
    }
  }
}
export function validateMemory(value: unknown): asserts value is Record<string, MemoryValue> {
  if (!object(value)) throw new Error("Memory must be an object.");
  if (Object.keys(value).length > MAX_MEMORY_ENTRIES || characters(JSON.stringify(value)).length > MAX_MEMORY_CHARS) {
    throw new Error(`Memory is limited to ${MAX_MEMORY_ENTRIES} entries and ${MAX_MEMORY_CHARS} characters. Edit or delete an entry first.`);
  }
  for (const [key, entry] of Object.entries(value)) {
    validateName(key, "Memory key");
    if (typeof entry === "string") { string(entry, "Memory value", MAX_MEMORY_CHARS, true); continue; }
    if (!object(entry) || entry.kind !== "index") throw new Error("Memory entries must be strings or source indexes.");
    validatePath(entry.path);
    string(entry.quote, "Index quote", EXCERPT_LIMIT);
    if (!Number.isSafeInteger(entry.start) || !Number.isSafeInteger(entry.end) || Number(entry.start) < 0 ||
        Number(entry.end) - Number(entry.start) !== characters(entry.quote).length) throw new Error("Invalid source index range.");
  }
}
export function parseProgram(value: unknown): Program {
  if (!object(value)) throw new Error("Program must be a JSON object.");
  string(value.goal, "Goal", 4000);
  if (!Number.isInteger(value.maxSteps) || Number(value.maxSteps) < 1 || Number(value.maxSteps) > 100) throw new Error("maxSteps must be an integer between 1 and 100.");
  if (value.readLimit !== undefined && (!Number.isInteger(value.readLimit) || Number(value.readLimit) < 80 || Number(value.readLimit) > MAX_READ_LIMIT)) {
    throw new Error(`readLimit must be an integer between 80 and ${MAX_READ_LIMIT} characters.`);
  }
  if (value.writeLimit !== undefined && (!Number.isInteger(value.writeLimit) || Number(value.writeLimit) < 1 || Number(value.writeLimit) > MAX_WRITE_LIMIT)) {
    throw new Error(`writeLimit must be an integer between 1 and ${MAX_WRITE_LIMIT} characters.`);
  }
  if (value.initialFiles !== undefined) {
    if (!object(value.initialFiles) || Object.keys(value.initialFiles).length > 32) throw new Error("initialFiles must contain at most 32 files.");
    for (const [file, content] of Object.entries(value.initialFiles)) { validatePath(file); string(content, file, 16000, true); }
    validateFilePaths(Object.keys(value.initialFiles));
  }
  if (!object(value.actions) || Object.keys(value.actions).length < 2 || Object.keys(value.actions).length > 32) throw new Error("Define 2–32 actions, including finish (or legacy END).");
  if (value.checks !== undefined) {
    if (!object(value.checks) || Object.keys(value.checks).length > 16) throw new Error("checks must be an object with at most 16 entries.");
    for (const [name, check] of Object.entries(value.checks)) {
      validateName(name, "Check name");
      if (!object(check) || ("file" in check) === ("memory" in check)) throw new Error(`${name}: specify either file or memory.`);
      if ("file" in check) validatePath(check.file); else validateName(check.memory, "Memory key");
      if ("pythonPrints" in check || "pythonOutput" in check) {
        if (!("file" in check) || "equals" in check || ("pythonPrints" in check && "pythonOutput" in check)) throw new Error(`${name}: Python checks require a file and exactly one output condition.`);
        string("pythonPrints" in check ? check.pythonPrints : check.pythonOutput, `${name}.Python output`, 1000, true);
      } else string(check.equals, `${name}.equals`, 8000, true);
    }
  }
  const dynamic = new Set();
  for (const [name, action] of Object.entries(value.actions)) {
    validateName(name, "Action name");
    if (!object(action)) throw new Error(`${name} must be an object.`);
    string(action.description, `${name}.description`, 1000);
    if (Object.hasOwn(action, "requiresChecks")) {
      if (action.tool !== "write_memory") throw new Error(`${name}: requiresChecks is supported only for write_memory.`);
      if (typeof action.requiresChecks !== "boolean") throw new Error(`${name}.requiresChecks must be a boolean.`);
    }
    switch (action.tool) {
      case "write_file": validatePath(action.path); string(action.content, `${name}.content`, 8000, true); break;
      case "write_memory": validateName(action.key, "Memory key"); string(action.value, `${name}.value`, 1000, true); break;
      case "create_file": case "append_file": case "replace_file_range":
        if (dynamic.has(action.tool)) throw new Error(`Declare ${action.tool} only once.`);
        if (Object.keys(action).some(key => !["tool", "description", "paths", ...(action.tool === "create_file" ? [] : ["fragments", "characters"])].includes(key))) throw new Error(`${name}: declare paths and short fragment choices, not complete file content.`);
        if (!Array.isArray(action.paths) || action.paths.length < 1 || action.paths.length > 8 || new Set(action.paths).size !== action.paths.length) throw new Error(`${name}.paths must contain 1–8 unique target paths.`);
        for (const file of action.paths) validatePath(file);
        validateFilePaths(action.paths as string[]);
        if (action.tool !== "create_file") {
          if (action.fragments === undefined && action.characters === undefined) throw new Error(`${name}: provide fragments, characters, or both input modes.`);
          if (action.fragments !== undefined) {
            if (!object(action.fragments) || Object.keys(action.fragments).length < 1 || Object.keys(action.fragments).length > 32) throw new Error(`${name}.fragments must contain 1–32 fragment choices.`);
            for (const [key, fragment] of Object.entries(action.fragments)) {
              validateName(key, "Fragment choice"); string(fragment, `${name}.fragments.${key}`, Number(value.writeLimit ?? DEFAULT_WRITE_LIMIT), true);
              if (action.tool === "append_file" && fragment === "") throw new Error("Append fragments must not be empty.");
            }
          }
          if (action.characters !== undefined) {
            string(action.characters, `${name}.characters`, 128, true);
            if (!characters(action.characters).length || new Set(characters(action.characters)).size !== characters(action.characters).length) throw new Error("Character input needs 1–128 distinct Unicode characters.");
          }
        }
        dynamic.add(action.tool); break;
      case "write_python":
        if (dynamic.has(action.tool)) throw new Error("Declare write_python only once.");
        if (Object.keys(action).some(key => !["tool", "description", "paths", "functions", "strings"].includes(key))) throw new Error(`${name}: use paths, functions and strings dictionaries instead of complete code.`);
        if (!Array.isArray(action.paths) || action.paths.length < 1 || action.paths.length > 8 || new Set(action.paths).size !== action.paths.length) throw new Error(`${name}.paths must contain 1–8 unique Python paths.`);
        for (const file of action.paths) { validatePath(file); if (!file.endsWith(".py")) throw new Error("Python target paths must end in .py."); }
        if (!Array.isArray(action.functions) || action.functions.length < 1 || action.functions.length > 3 || new Set(action.functions).size !== action.functions.length || action.functions.some(fn => typeof fn !== "string" || !Object.hasOwn(PYTHON_FUNCTIONS, fn))) throw new Error(`${name}.functions must choose from print, len and repr.`);
        if (!object(action.strings) || Object.keys(action.strings).length < 1 || Object.keys(action.strings).length > 16) throw new Error(`${name}.strings must contain 1–16 string values.`);
        for (const [key, value] of Object.entries(action.strings)) { validateName(key, "String choice"); string(value, `${name}.strings.${key}`, 1000, true); }
        dynamic.add(action.tool); break;
      case "read_file": case "read_goal": case "remember_excerpt": case "edit_memory": case "delete_memory":
        if (dynamic.has(action.tool)) throw new Error(`Declare ${action.tool} only once; its argument dictionary is built at runtime.`);
        if (Object.keys(action).some(key => !["tool", "description"].includes(key))) throw new Error(`${name} takes only tool and description; its arguments are selected at runtime.`);
        dynamic.add(action.tool); break;
      case "read_file_to_memory": throw new Error("Use read_file and remember_excerpt separately. Reading no longer copies files into memory.");
      case "finish": if (name !== "finish") throw new Error("The finish tool must use the finish action key."); break;
      case "END": if (name !== "END") throw new Error("The END tool must use the END action key."); break;
      default: throw new Error(`${name}: unknown tool ${action.tool}.`);
    }
  }
  if ((!object(value.actions.finish) || value.actions.finish.tool !== "finish") && (!object(value.actions.END) || value.actions.END.tool !== "END")) throw new Error("A finish (or legacy END) action is required.");
  if (JSON.stringify(value).length > 100000) throw new Error("Program exceeds 100,000 characters.");
  return value as Program;
}
