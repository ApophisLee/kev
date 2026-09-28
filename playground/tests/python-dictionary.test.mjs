import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { PYTHON_FUNCTIONS, buildPythonStatement, isPythonPrintProgram } from "../src/lib/python-dictionary.ts";

// Use Python's parser, without executing the generated program, to verify that
// every input remains a single constant argument to the selected function.
function parsedStatement(program) {
  return JSON.parse(execFileSync("python3", ["-c", [
    "import ast, json, sys",
    "tree = ast.parse(sys.stdin.read())",
    "assert len(tree.body) == 1 and isinstance(tree.body[0], ast.Expr)",
    "call = tree.body[0].value",
    "assert isinstance(call, ast.Call) and isinstance(call.func, ast.Name)",
    "assert len(call.args) == 1 and not call.keywords",
    "assert isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str)",
    "print(json.dumps({'function': call.func.id, 'value': call.args[0].value}))",
  ].join("\n")], { input: program, encoding: "utf8" }));
}

test("function dictionary offers independent print, len and repr choices", () => {
  assert.deepEqual(Object.keys(PYTHON_FUNCTIONS), ["print", "len", "repr"]);
  for (const [name, description] of Object.entries(PYTHON_FUNCTIONS)) {
    assert.equal(typeof description, "string");
    assert.ok(description.length > 0);
    assert.equal(buildPythonStatement(name, "Hello, world!"), `${name}("Hello, world!")\n`);
  }
});

test("builds a Hello world statement and recognizes only the exact supported print", () => {
  const content = buildPythonStatement("print", "Hello, world!");
  assert.equal(content, 'print("Hello, world!")\n');
  assert.deepEqual(parsedStatement(content), { function: "print", value: "Hello, world!" });
  assert.equal(isPythonPrintProgram(content, "Hello, world!"), true);
  assert.equal(isPythonPrintProgram(content, "Hello, Kev!"), false);
  assert.equal(isPythonPrintProgram(buildPythonStatement("len", "Hello, world!"), "Hello, world!"), false);
  assert.equal(isPythonPrintProgram(buildPythonStatement("repr", "Hello, world!"), "Hello, world!"), false);
  assert.equal(isPythonPrintProgram(content + 'print("extra")\n', "Hello, world!"), false);
  assert.equal(isPythonPrintProgram(content.trimEnd(), "Hello, world!"), false);
});

test("quotes, backslashes, newlines and Unicode remain literal Python string data", () => {
  for (const value of [
    'He said "hello"; it\'s fine.',
    "first line\nsecond line\r\nthird\tcolumn",
    "C:\\notes\\hello.py",
    "你好，世界！ 🌏 café",
    "line\u2028separator\u2029paragraph\b\f\u0001",
    "",
  ]) {
    const content = buildPythonStatement("print", value);
    assert.equal(content.endsWith("\n"), true);
    assert.equal(content.split("\n").length, 2, "file contains exactly one physical statement line");
    assert.deepEqual(parsedStatement(content), { function: "print", value });
    assert.equal(isPythonPrintProgram(content, value), true);
  }
});

test("attempted code injection stays inside the one constant argument", () => {
  const value = '"); __import__("os").system("touch SHOULD_NOT_EXIST")\n#';
  for (const selectedFunction of Object.keys(PYTHON_FUNCTIONS)) {
    assert.deepEqual(parsedStatement(buildPythonStatement(selectedFunction, value)), { function: selectedFunction, value });
  }
  assert.equal(isPythonPrintProgram('print("Hello, world!"); __import__("os")\n', "Hello, world!"), false);
});

test("rejects unlisted functions, NUL and oversized values; Unicode limit counts code points", () => {
  for (const name of ["eval", "exec", "constructor", "__proto__", 'print);exec("bad")', null, {}]) {
    assert.throws(() => buildPythonStatement(name, "hello"), /allowed Python function/);
  }
  for (const value of ["hello\0world", "a".repeat(1001), "🌏".repeat(1001), null, 123]) {
    assert.throws(() => buildPythonStatement("print", value), /1000 Unicode characters/);
    assert.equal(isPythonPrintProgram('print("hello")\n', value), false);
  }
  const boundary = "🌏".repeat(1000);
  assert.deepEqual(parsedStatement(buildPythonStatement("print", boundary)), { function: "print", value: boundary });
});
