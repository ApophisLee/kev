/**
 * Educational Python subset for browser-side checks. This is not a Python VM.
 * Supports one assignment or print(expression) per line, comments, literals,
 * names, parentheses, unary signs and numeric + - * / (also string + string).
 * It never executes Python, JavaScript, imported modules or arbitrary calls.
 */
export const PYTHON_SUBSET_LIMITS = Object.freeze({
  sourceChars: 32000,
  tokens: 8000,
  expressionDepth: 64,
  operations: 10000,
  valueChars: 8000,
  outputChars: 8000,
  variables: 256,
});

type Value = { kind: "number"; value: number; integer: boolean } | { kind: "string"; value: string };
type Token = { kind: "name" | "literal" | "symbol" | "newline" | "eof"; text: string; value?: Value };
const RESERVED = new Set([
  "print", "import", "from", "for", "while", "if", "else", "elif", "def", "class", "return", "lambda",
  "with", "try", "except", "finally", "raise", "pass", "break", "continue", "True", "False", "None",
  "and", "or", "not", "in", "is", "as", "del", "global", "nonlocal", "yield", "await", "async", "assert",
  "__debug__", "__peg_parser__",
]);

function unsupported(detail: string): never { throw new Error(`Unsupported syntax: ${detail}`); }
function numeric(value: number, integer: boolean): Value {
  if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
    throw new Error("Number exceeds the supported finite, safe numeric range.");
  }
  return { kind: "number", value, integer };
}
function stringValue(value: string): Value {
  if (value.includes("\0")) throw new Error("String values cannot contain NUL.");
  if (Array.from(value).length > PYTHON_SUBSET_LIMITS.valueChars) throw new Error("String value exceeds 8000 characters.");
  return { kind: "string", value };
}

function tokenize(source: string): Token[] {
  if (typeof source !== "string" || Array.from(source).length > PYTHON_SUBSET_LIMITS.sourceChars) {
    throw new Error("Source must be a string of at most 32000 Unicode characters.");
  }
  if (source.includes("\0")) unsupported("NUL is not allowed.");
  // Python treats CRLF and bare CR as line boundaries, never as token spacing.
  source = source.replace(/\r\n?/g, "\n");
  for (const line of source.split("\n")) {
    const indentation = /^[ \t]+/.exec(line);
    if (!indentation) continue;
    const rest = line.slice(indentation[0].length);
    if (rest !== "" && !rest.startsWith("#")) unsupported("top-level statements cannot be indented.");
  }
  const tokens: Token[] = [];
  const push = (token: Token) => {
    if (tokens.length >= PYTHON_SUBSET_LIMITS.tokens) throw new Error("Program exceeds the 8000-token limit.");
    tokens.push(token);
  };
  const numberPattern = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
  const namePattern = /[A-Za-z_][A-Za-z0-9_]*/y;
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === " " || character === "\t" || character === "\r") { index++; continue; }
    if (character === "\n") { push({ kind: "newline", text: "\n" }); index++; continue; }
    if (character === "#") {
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      let value = "";
      let closed = false;
      index++;
      while (index < source.length) {
        const next = source[index++];
        if (next === quote) { closed = true; break; }
        if (next === "\n" || next === "\r") unsupported("string literals must close on the same line.");
        if (next !== "\\") { value += next; continue; }
        if (index >= source.length) unsupported("unfinished string escape.");
        const escape = source[index++];
        const simple: Record<string, string> = { "\\": "\\", '"': '"', "'": "'", n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
        if (Object.hasOwn(simple, escape)) { value += simple[escape]; continue; }
        const digits = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
        if (!digits) unsupported(`string escape \\${escape} is not supported.`);
        const hex = source.slice(index, index + digits);
        if (hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) unsupported("invalid hexadecimal string escape.");
        const point = Number.parseInt(hex, 16);
        if (point > 0x10ffff) unsupported("Unicode escape is out of range.");
        value += String.fromCodePoint(point);
        index += digits;
      }
      if (!closed) unsupported("unterminated string literal.");
      push({ kind: "literal", text: "string", value: stringValue(value) });
      continue;
    }
    numberPattern.lastIndex = index;
    const number = numberPattern.exec(source);
    if (number) {
      const text = number[0];
      const integer = !/[.eE]/.test(text);
      if (integer && /^0\d*[1-9]/.test(text)) unsupported("decimal integers cannot have leading zeros.");
      push({ kind: "literal", text, value: numeric(Number(text), integer) });
      index += text.length;
      continue;
    }
    namePattern.lastIndex = index;
    const name = namePattern.exec(source);
    if (name) {
      const afterName = source[index + name[0].length];
      if (afterName === '"' || afterName === "'") unsupported("prefixed string literals are not supported.");
      push({ kind: "name", text: name[0] });
      index += name[0].length;
      continue;
    }
    if ("+-*/=()".includes(character)) {
      push({ kind: "symbol", text: character });
      index++;
      continue;
    }
    unsupported(`character ${JSON.stringify(character)} is not supported.`);
  }
  push({ kind: "eof", text: "end of program" });
  return tokens;
}

function display(value: Value): string {
  if (value.kind === "string") return value.value;
  if (value.integer) return String(value.value);
  if (Object.is(value.value, -0)) return "-0.0";
  const text = String(value.value);
  if (Number.isInteger(value.value) && !/[eE]/.test(text)) return `${text}.0`;
  return text;
}

class SubsetInterpreter {
  output = "";
  private outputChars = 0;
  private position = 0;
  private operations = 0;
  private readonly variables = new Map<string, Value>();
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  private tick(): void {
    if (++this.operations > PYTHON_SUBSET_LIMITS.operations) throw new Error("Program exceeds the 10000-operation limit.");
  }
  private peek(): Token { return this.tokens[this.position]; }
  private take(): Token { this.tick(); return this.tokens[this.position++]; }
  private expect(text: string): void {
    if (this.peek().text !== text) unsupported(`expected ${text}, received ${this.peek().text}.`);
    this.take();
  }
  private depth(depth: number): void {
    if (depth > PYTHON_SUBSET_LIMITS.expressionDepth) throw new Error("Expression exceeds the 64-level nesting limit.");
  }
  private expression(depth = 0): Value {
    this.depth(depth);
    let left = this.product(depth);
    while (this.peek().text === "+" || this.peek().text === "-") {
      const operator = this.take().text;
      left = this.binary(left, operator, this.product(depth));
    }
    return left;
  }
  private product(depth: number): Value {
    let left = this.unary(depth);
    while (this.peek().text === "*" || this.peek().text === "/") {
      const operator = this.take().text;
      left = this.binary(left, operator, this.unary(depth));
    }
    return left;
  }
  private unary(depth: number): Value {
    this.depth(depth);
    if (this.peek().text === "+" || this.peek().text === "-") {
      const operator = this.take().text;
      const value = this.unary(depth + 1);
      if (value.kind !== "number") throw new Error("Unary signs require a number.");
      this.tick();
      return numeric(operator === "-" ? -value.value : value.value, value.integer);
    }
    return this.primary(depth);
  }
  private primary(depth: number): Value {
    const token = this.take();
    if (token.kind === "literal") return token.value!;
    if (token.kind === "name") {
      if (this.peek().text === "(") unsupported(`function call ${token.text}() is not supported inside expressions.`);
      if (RESERVED.has(token.text)) unsupported(`${token.text} is not a supported expression.`);
      const value = this.variables.get(token.text);
      if (value === undefined) throw new Error(`Unknown variable: ${token.text}.`);
      return value;
    }
    if (token.text === "(") {
      const value = this.expression(depth + 1);
      this.expect(")");
      return value;
    }
    unsupported(`expected a literal, variable, or parenthesized expression; received ${token.text}.`);
  }
  private binary(left: Value, operator: string, right: Value): Value {
    this.tick();
    if (operator === "+" && left.kind === "string" && right.kind === "string") return stringValue(left.value + right.value);
    if (left.kind !== "number" || right.kind !== "number") throw new Error(`Operator ${operator} requires numbers (or two strings for +).`);
    if (operator === "/" && right.value === 0) throw new Error("Division by zero.");
    const value = operator === "+" ? left.value + right.value : operator === "-" ? left.value - right.value :
      operator === "*" ? left.value * right.value : left.value / right.value;
    return numeric(value, operator !== "/" && left.integer && right.integer);
  }
  run(): void {
    while (this.peek().kind !== "eof") {
      if (this.peek().kind === "newline") { this.take(); continue; }
      const name = this.take();
      if (name.kind !== "name") unsupported("only assignments and print(expression) statements are supported.");
      if (name.text === "print" && this.peek().text === "(") {
        this.take();
        const value = this.expression();
        this.expect(")");
        this.statementEnd();
        const addition = display(value) + "\n";
        const addedChars = Array.from(addition).length;
        if (this.outputChars + addedChars > PYTHON_SUBSET_LIMITS.outputChars) throw new Error("Output exceeds 8000 characters.");
        this.output += addition;
        this.outputChars += addedChars;
      } else {
        if (RESERVED.has(name.text)) unsupported(`${name.text} is not a supported assignment target.`);
        if (this.peek().text !== "=") unsupported("only assignments and print(expression) statements are supported.");
        this.take();
        const value = this.expression();
        this.statementEnd();
        if (!this.variables.has(name.text) && this.variables.size >= PYTHON_SUBSET_LIMITS.variables) throw new Error("Program exceeds the 256-variable limit.");
        this.variables.set(name.text, value);
      }
    }
  }
  private statementEnd(): void {
    if (this.peek().kind !== "newline" && this.peek().kind !== "eof") unsupported("put one complete statement on each line.");
  }
}

export function evaluatePythonSubset(source: string): { output: string; error?: string } {
  let interpreter: SubsetInterpreter | undefined;
  try {
    interpreter = new SubsetInterpreter(tokenize(source));
    interpreter.run();
    return { output: interpreter.output };
  } catch (error) {
    return { output: interpreter?.output ?? "", error: error instanceof Error ? error.message : "Could not evaluate this Python subset." };
  }
}

export function pythonOutputMatches(content: string, expectedOutput: string): boolean {
  if (typeof expectedOutput !== "string") return false;
  const result = evaluatePythonSubset(content);
  return result.error === undefined && result.output === expectedOutput;
}
