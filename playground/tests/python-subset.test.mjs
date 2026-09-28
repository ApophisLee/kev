import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePythonSubset, pythonOutputMatches, PYTHON_SUBSET_LIMITS } from "../src/lib/python-subset.ts";

function output(source, expected) {
  assert.deepEqual(evaluatePythonSubset(source), { output: expected });
  assert.equal(pythonOutputMatches(source, expected), true);
}
function failure(source, message) {
  const result = evaluatePythonSubset(source);
  assert.match(result.error ?? "", message);
  assert.equal(pythonOutputMatches(source, result.output), false);
}

test("prints 1+1 and evaluates variables, reassignment, precedence and parentheses", () => {
  output("print(1+1)", "2\n");
  output("a = 1\nb = 1\nprint(a + b)\n", "2\n");
  output("a = 2\na = a + 3\nprint(a)\nprint((a - 1) * 3)\n", "5\n12\n");
  output("print(2+3*4)\nprint((2+3)*4)\nprint(-(-2)+ +3)\n", "14\n20\n5\n");
  output("print(10 - 3 - 2)\nprint(12 / 3 / 2)\n", "5\n2.0\n");
});

test("handles numeric float literals, unary signs and division without losing their float type", () => {
  output("print(1 / 1)\nprint(5 / 2)\nprint(1.0 + 1)\nprint(.5 * 2)\nprint(-0.0)\n", "1.0\n2.5\n2.0\n1.0\n-0.0\n");
  output("print(1e2)\nprint(2E-1)\nprint(000)\n", "100.0\n0.2\n0\n");
  failure("print(01)", /Unsupported syntax/);
  failure("print(1e309)", /safe numeric range/);
  failure("print(9007199254740992)", /safe numeric range/);
  failure("print(9007199254740991 + 1)", /safe numeric range/);
  failure("print(1 / 0)", /Division by zero/);
});

test("strings support both quotes, escaped characters, Unicode and concatenation", () => {
  output('print("Hello, world!")\n', "Hello, world!\n");
  output("name = 'Kev'\nprint('Hello, ' + name + '!')\n", "Hello, Kev!\n");
  output(String.raw`print('it\'s "fine"\\path\nnext\tcolumn')`, 'it\'s "fine"\\path\nnext\tcolumn\n');
  output('print("你好 🌏")\nprint("\\u4f60\\u597d \\U0001f30f")\nprint("\\x41")\n', "你好 🌏\n你好 🌏\nA\n");
  output('print("# literal comment") # actual comment\n', "# literal comment\n");
  failure('print("a" + 1)', /requires numbers/);
  failure('print("a" * 3)', /requires numbers/);
  failure('print(-"a")', /Unary signs/);
});

test("blank lines, comments and ordinary CRLF files are supported", () => {
  output("# introduction\r\n\r\na = 1 # first\r\nb = 1\r\nprint(a + b) # result\r\n", "2\n");
  output("\n# empty program\n", "");
  output("", "");
});


test("rejects indented top-level statements while allowing indented comments and blank lines", () => {
  for (const source of [
    " print(1+1)\n", "\tprint(1+1)\n", "a=2\n  b=3\nprint(a+b)",
    "a=2\r\n\tb=3\r\nprint(a+b)", "\r print(1+1)",
  ]) failure(source, /Unsupported syntax: top-level statements cannot be indented/);
  output("  # comment\n\t# another\n \t \na=2\nprint(a)\n", "2\n");
  assert.equal(pythonOutputMatches(" print(1+1)\n", "2\n"), false);
  assert.equal(pythonOutputMatches("a=2\n  b=3\nprint(a+b)", "5\n"), false);
});

test("normalizes CRLF and bare CR as Python line boundaries", () => {
  output("a=2\rb=3\rprint(a+b)\r", "5\n");
  output("# comment\ra=2\r  # indented comment\rprint(a)\r", "2\n");
  failure("a=2\r+3\nprint(a)", /Unsupported syntax/);
  assert.equal(pythonOutputMatches("a=2\r+3\nprint(a)", "5\n"), false);
});

test("all Python hard keywords and reserved debug targets are rejected as assignment names", () => {
  // Soft keywords such as match/case remain legal variable names outside their syntax.
  const keywords = [
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del",
    "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
    "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "__debug__", "__peg_parser__",
  ];
  for (const name of keywords) failure(`${name}=2\nprint(${name})`, /Unsupported syntax/);
  assert.equal(pythonOutputMatches("as=2\nprint(as)", "2\n"), false);
  assert.equal(pythonOutputMatches("__debug__=5\nprint(__debug__)", "5\n"), false);
  output("match=2\ncase=3\nprint(match+case)", "5\n");
});

test("rejects imports, attributes, loops, arbitrary calls and unsupported expressions", () => {
  for (const source of [
    "import os", "from os import path", "while True:\n print(1)", "for x in range(3):\n print(x)",
    'print(__import__("os"))', "open('file')", "print(len('hi'))", "print(x.real)",
    "print(2 ** 3)", "print(7 // 2)", "print([1])", "print({'a': 1})", "print(1 == 1)",
    "a=1;b=1;print(a+b)", "print=1", "print()", "print(1, 2)", "print(\n1\n)",
    "def x():\n pass", "print(True)", "a = lambda: 1", "print(f'hello')", "print('a') trailing",
  ]) failure(source, /Unsupported syntax/);
  failure("print(missing)", /Unknown variable: missing/);
});

test("literal injection remains text and errors cannot satisfy exact-output completion", () => {
  const injection = '\"); __import__(\"os\").system(\"bad\") #';
  output(`print(${JSON.stringify(injection)})`, injection + "\n");
  assert.equal(pythonOutputMatches("print(1+1)", "2"), false);
  assert.equal(pythonOutputMatches("print(1+1)\nprint(3)", "2\n"), false);
  const source = "print(2)\nprint(missing)";
  assert.deepEqual(evaluatePythonSubset(source), { output: "2\n", error: "Unknown variable: missing." });
  assert.equal(pythonOutputMatches(source, "2\n"), false);
});

test("rejects malformed strings and NUL without throwing from the public evaluator", () => {
  for (const source of ['print("unterminated)', "print('line\nbreak')", String.raw`print('\q')`, String.raw`print('\uXYZW')`, String.raw`print('\U00110000')`]) {
    failure(source, /Unsupported syntax/);
  }
  failure('print("\\u0000")', /NUL/);
  failure("print(1)\0", /NUL/);
  failure(null, /Source must be a string/);
});

test("source, token, nesting, operation, value, output and variable limits are enforced", () => {
  assert.equal(PYTHON_SUBSET_LIMITS.sourceChars, 32000);
  failure("#" + "🌏".repeat(32000), /32000 Unicode/);
  failure("\n".repeat(8000), /8000-token/);
  failure("print(" + "(".repeat(65) + "1" + ")".repeat(65) + ")", /64-level/);
  output("print(" + "(".repeat(64) + "1" + ")".repeat(64) + ")", "1\n");
  failure("print(" + Array(3500).fill("1").join("+") + ")", /10000-operation/);
  failure(`a = "${"🌏".repeat(8001)}"`, /String value exceeds/);
  failure(`a = "${"x".repeat(5000)}"\na = a + a`, /String value exceeds/);
  failure(`print("${"🌏".repeat(8000)}")`, /Output exceeds/);
  output(`print("${"🌏".repeat(7999)}")`, "🌏".repeat(7999) + "\n");
  failure(Array.from({ length: 257 }, (_, index) => `v${index} = 1`).join("\n"), /256-variable/);
});
