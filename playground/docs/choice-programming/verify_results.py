#!/usr/bin/env python3
"""Verify the curated Choice Programming results without private traces or inference.

This checks recorded metrics and decision/action/edit consistency. It cannot
recount native model tokens, authenticate source hashes, recover omitted choice
sets, or rerun the application checker. It executes no recorded source code.
"""

import argparse
import json
import math
import sys
from decimal import Decimal
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def integer(value, minimum=0):
    return type(value) is int and value >= minimum


def verify_step(step, source, method, write_limit):
    tool = step["tool"]
    args = step["arguments"]
    decisions = step["decisions"]
    require(step["tool_execution_ok"] is True, "unsupported failed tool operation")
    require(decisions and decisions[0]["stage"] == "tool", "first decision is not tool selection")
    require(decisions[0]["choice"] == tool, "tool decision/action mismatch")
    stages = [d["stage"] for d in decisions]
    choices = [d["choice"] for d in decisions]
    if tool == "finish":
        require(stages == ["tool"] and step["choice"] == "finish", "invalid finish decisions")
        require(args == {} and "file_edit" not in step, "finish must not edit a file")
        return source

    require(args["path"] == "addition.py", "unsupported target file")
    edit = step["file_edit"]
    require(edit["before"] == source, "edit before does not match reconstructed source")
    if tool == "create_file":
        require(stages == ["tool", "arguments"], "invalid create decisions")
        require(choices[1] == step["choice"] == "file_0", "create target mismatch")
        require(source is None, "create would overwrite an existing file")
        start, end, content = 0, 0, ""
        after = ""
    else:
        require(tool in ("append_file", "replace_file_range"), "unsupported edit tool")
        require(isinstance(source, str), "edit target does not exist")
        mode = decisions[2]["choice"]
        require(mode in ("fragment", "character"), "invalid input mode")
        target_stage = "write_target" if tool == "append_file" else "write_range"
        expected_stages = ["tool", target_stage, "write_mode"]
        if mode == "character" and len(decisions) == 5:
            expected_stages.append("write_character_group")
        expected_stages.append("write_" + mode)
        require(stages == expected_stages, "invalid edit decision sequence")
        require(step["choice"] == "/".join((choices[1], mode, choices[-1])), "composite choice mismatch")
        content = args["content"]
        require(isinstance(content, str) and len(content) <= write_limit, "invalid edit content/limit")
        if mode == "fragment":
            fragments = dict(method["append_fragments"])
            if tool == "replace_file_range":
                fragments.update(method["replacement_extra_fragment"])
            require(choices[-1] in fragments and fragments[choices[-1]] == content, "fragment/action mismatch")
        else:
            require(len(content) == 1, "character choice must insert one code point")
            require(choices[-1].startswith("char_"), "invalid character choice identifier")
            # The curated schema omits the alphabet and group definitions. Do not
            # claim to validate char_N's original alphabet index or group membership.
        if tool == "append_file":
            require(choices[1] == "file_0", "append target mismatch")
            require(args["offset"] == len(source) and content != "", "invalid append position/content")
            start = end = args["offset"]
        else:
            start, end = args["start"], args["end"]
        require(integer(start) and integer(end) and start <= end <= len(source), "invalid edit range")
        after = source[:start] + content + source[end:]
    require(edit["start"] == start and edit["end"] == end, "action/audit range mismatch")
    require(edit["inserted_characters"] == len(content), "inserted-character count mismatch")
    require(edit["after"] == after, "splice result does not match recorded after")
    return after


def verify_run(run, method):
    label = run["label"]
    steps = run["steps"]
    require(steps and integer(run["step_budget"], 1), "invalid steps/budget")
    require(len(steps) <= run["step_budget"], "step budget exceeded")
    require(run["model"] == method["model"], "model mismatch")
    source = run["initial_target_source"]
    decisions = []
    for number, step in enumerate(steps, 1):
        require(step["number"] == number, "nonconsecutive step number")
        require(step["tool"] != "finish" or number == len(steps), "operation after finish")
        source = verify_step(step, source, method, run["write_limit_characters"])
        decisions.extend(step["decisions"])
    require(source == run["final_target_source"], "final source mismatch")
    for decision in decisions:
        for key in ("input_tokens", "server_reported_input_tokens", "option_count"):
            require(integer(decision[key], 1), "invalid decision " + key)
        require(isinstance(decision["choice"], str) and decision["choice"], "empty decision choice")
        probability, latency = decision["selected_probability"], decision["latency_ms"]
        require(math.isfinite(probability) and 0 <= probability <= 1, "invalid probability")
        require(math.isfinite(latency) and latency >= 0, "invalid latency")
        if decision["option_count"] == 1:
            require(probability == 1, "single-option decision probability is not 1")
    tokens = [d["input_tokens"] for d in decisions]
    matches = all(d["input_tokens"] == d["server_reported_input_tokens"] for d in decisions)
    within_cap = all(t <= method["max_input_tokens_per_decision"] for t in tokens)
    require(matches and within_cap, "token count mismatch or input cap exceeded")
    expected_metrics = {
        "executed_tool_steps": len(steps),
        "model_decisions": len(decisions),
        "input_tokens_min": min(tokens),
        "input_tokens_max": max(tokens),
        "input_tokens_cumulative": sum(tokens),
        "decision_latency_ms_sum": sum(Decimal(str(d["latency_ms"])) for d in decisions).quantize(Decimal("0.1")),
        "all_token_counts_match_server": matches,
        "all_inputs_within_3000_tokens": within_cap,
    }
    require(run["metrics"] == expected_metrics, "reported aggregate metrics differ")
    status = run["recorded_status"]
    stop_reasons = {"limit": "step_budget_reached", "stopped": "stopped_externally_before_step_budget", "ended": "model_selected_finish_after_checks_passed"}
    require(status in stop_reasons and run["stop_reason"] == stop_reasons[status], "stop metadata mismatch")
    ended = steps[-1]["tool"] == "finish"
    require(ended == (status == "ended") and run["goal_satisfied"] is ended, "completion metadata mismatch")
    if status == "limit":
        require(len(steps) == run["step_budget"], "limit status before budget")
    if status == "stopped":
        require(len(steps) < run["step_budget"], "stopped status contradicts reason")
    return f"{label}: {len(steps)} steps, {len(decisions)} decisions, {sum(tokens):,} cumulative input tokens; edits reconstructed"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", nargs="?", type=Path, default=Path(__file__).with_name("results.json"))
    args = parser.parse_args()
    raw = args.results.read_bytes()
    require(b"\r" not in raw, "results must use LF line endings")
    data = json.loads(raw.decode("utf-8"), parse_float=Decimal)
    require(data["schema_version"] == 1, "unsupported results schema")
    require(data["method"]["max_input_tokens_per_decision"] == 3000, "unexpected input cap")
    runs = data["runs"]
    require(runs and len({r["label"] for r in runs}) == len(runs), "missing or duplicate runs")
    messages = []
    for run in runs:
        try:
            messages.append(verify_run(run, data["method"]))
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"{run.get('label', 'unnamed run')}: {error}") from error
    successful = [r for r in runs if r["goal_satisfied"]]
    verification = data["independent_success_verification"]
    require(len(successful) == 1, "expected one curated successful trace")
    require(successful[0]["final_target_source"] == verification["source"], "verification source mismatch")
    require(successful[0]["expected_stdout"] == verification["stdout"], "verification stdout mismatch")
    require(verification["exit_code"] == 0 and verification["stderr"] == "", "unsuccessful verification metadata")
    print("\n".join(messages))
    print("PASS: curated record consistency verified; no model or recorded source code executed.")
    print("Limits: native token recounting, omitted candidate/alphabet mappings, original record hashes, and Python output are not independently reverified here.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, KeyError, TypeError, ValueError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        sys.exit(1)
