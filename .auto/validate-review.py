#!/usr/bin/env python3
"""Validate the last real review without judging its substantive conclusions."""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

HARNESS_ROOT = Path(__file__).resolve().parents[1]
ROOT = Path(os.environ.get("REVIEW_BENCH_ROOT", HARNESS_ROOT)).resolve()
PR_NUMBER = int(os.environ.get("REVIEW_BENCH_PR", "1"))
EVENTS = Path(os.environ.get("REVIEW_EVENTS", HARNESS_ROOT / ".auto" / "last-review-events.jsonl"))
REVIEW = Path(os.environ.get("REVIEW_RESULT", HARNESS_ROOT / ".auto" / "last-review.json"))
# Every base lens is a quality requirement. Sharded batches add suffixed
# instances, but must still retain each canonical pass id.
REQUIRED_PASSES = {
    "overview",
    "conventions-maintainability",
    "correctness",
    "correctness-contracts",
    "security-performance",
    "performance-resources",
}
SEVERITIES = {"P0", "P1", "P2", "P3", "nit"}
HEAVY_LENSES = {
    "correctness": "correctness_tail_ms",
    "correctness-contracts": "contracts_tail_ms",
    "security-performance": "security_tail_ms",
    "performance-resources": "resources_tail_ms",
}


def required_passes_for_mode(mode: str) -> set[str]:
    return REQUIRED_PASSES if mode == "full" else REQUIRED_PASSES - {"conventions-maintainability"}


def allowed_severities_for_mode(mode: str) -> set[str]:
    return {"P0", "P1", "P2"} if mode == "major" else SEVERITIES


def load_events() -> list[dict]:
    events = []
    for line in EVENTS.read_text(encoding="utf-8").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            events.append(value)
    return events


def final_review(events: list[dict]) -> dict:
    for event in reversed(events):
        if event.get("type") != "message_end":
            continue
        message = event.get("message", {})
        if message.get("role") != "assistant":
            continue
        text = "".join(
            part.get("text", "")
            for part in message.get("content", [])
            if part.get("type") == "text"
        ).strip()
        try:
            value = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and "findings" in value and "pr" in value:
            return value
    raise AssertionError("no structured final review found in Pi events")


def batch_details(events: list[dict]) -> dict:
    candidates: list[dict] = []

    def visit(value):
        if isinstance(value, dict):
            if value.get("passCount") and isinstance(value.get("results"), list):
                candidates.append(value)
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    for event in events:
        visit(event)
    if not candidates:
        raise AssertionError("no review_subagents batch details found")
    return candidates[-1]


def event_timestamp(event: dict) -> float | None:
    """Return the recorder timestamp attached to a message-end event."""
    message = event.get("message")
    timestamp = event.get("timestamp")
    if timestamp is None and isinstance(message, dict):
        timestamp = message.get("timestamp")
    return float(timestamp) if isinstance(timestamp, (int, float)) else None


def is_final_review_message(event: dict) -> bool:
    if event.get("type") != "message_end":
        return False
    message = event.get("message", {})
    if message.get("role") != "assistant":
        return False
    text = "".join(
        part.get("text", "")
        for part in message.get("content", [])
        if part.get("type") == "text"
    ).strip()
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return False
    return isinstance(value, dict) and "findings" in value and "pr" in value


def batch_timing_metrics(batch: dict) -> dict[str, float]:
    """Expose batch-tail diagnostics without affecting review eligibility."""
    results = batch.get("results", [])
    if not isinstance(results, list):
        results = []

    def elapsed(result: dict) -> float:
        value = result.get("elapsedMs", 0)
        return float(value) if isinstance(value, (int, float)) else 0.0

    metrics = {
        "batch_elapsed_ms": float(batch.get("elapsedMs", 0)),
        "heavy_tail_ms": max((elapsed(result) for result in results if result.get("tier") == "heavy"), default=0.0),
    }
    for lens, metric_name in HEAVY_LENSES.items():
        metrics[metric_name] = max(
            (elapsed(result) for result in results if result.get("id") == lens or str(result.get("id", "")).startswith(f"{lens}-shard-")),
            default=0.0,
        )
    return metrics


def parent_phase_metrics(events: list[dict]) -> dict[str, float]:
    """Measure post-batch parent work from recorded event timestamps.

    These values are diagnostics only: they expose where wall time is spent
    without judging review quality by output size or finding count.
    """
    batch_calls = [
        event.get("toolCallId")
        for event in events
        if event.get("type") == "tool_execution_end" and event.get("toolName") == "review_subagents"
    ]
    final_events = [event for event in events if is_final_review_message(event)]
    if not batch_calls or not final_events:
        return {
            "parent_post_batch_ms": 0.0,
            "parent_validation_ms": 0.0,
            "parent_synthesis_ms": 0.0,
            "parent_post_batch_tool_turns": 0.0,
            "parent_post_batch_tool_calls": 0.0,
        }

    batch_call = batch_calls[-1]
    batch_end = next(
        (
            event_timestamp(event)
            for event in events
            if event.get("type") == "message_end"
            and (event.get("toolCallId") == batch_call or event.get("message", {}).get("toolCallId") == batch_call)
            and event.get("message", {}).get("role") == "toolResult"
            and event_timestamp(event) is not None
        ),
        None,
    )
    final_end = event_timestamp(final_events[-1])
    if batch_end is None or final_end is None or final_end < batch_end:
        return {
            "parent_post_batch_ms": 0.0,
            "parent_validation_ms": 0.0,
            "parent_synthesis_ms": 0.0,
            "parent_post_batch_tool_turns": 0.0,
            "parent_post_batch_tool_calls": 0.0,
        }

    post_batch_turns = 0
    post_batch_calls = 0
    tool_result_times: list[float] = []
    for event in events:
        timestamp = event_timestamp(event)
        if timestamp is None or not (batch_end <= timestamp < final_end):
            continue
        message = event.get("message", {})
        if event.get("type") == "message_end" and message.get("role") == "assistant":
            calls = [part for part in message.get("content", []) if part.get("type") == "toolCall"]
            if calls:
                post_batch_turns += 1
                post_batch_calls += len(calls)
        if event.get("type") == "message_end" and message.get("role") == "toolResult":
            tool_result_times.append(timestamp)

    last_tool_result = max(tool_result_times, default=batch_end)
    return {
        "parent_post_batch_ms": final_end - batch_end,
        "parent_validation_ms": last_tool_result - batch_end,
        "parent_synthesis_ms": final_end - last_tool_result,
        "parent_post_batch_tool_turns": float(post_batch_turns),
        "parent_post_batch_tool_calls": float(post_batch_calls),
    }


def self_test_reduced_scope_modes() -> None:
    assert required_passes_for_mode("default") == REQUIRED_PASSES - {"conventions-maintainability"}
    assert required_passes_for_mode("balanced") == REQUIRED_PASSES - {"conventions-maintainability"}
    assert required_passes_for_mode("major") == REQUIRED_PASSES - {"conventions-maintainability"}
    assert required_passes_for_mode("full") == REQUIRED_PASSES
    assert allowed_severities_for_mode("default") == SEVERITIES
    assert allowed_severities_for_mode("balanced") == SEVERITIES
    assert allowed_severities_for_mode("major") == {"P0", "P1", "P2"}
    assert allowed_severities_for_mode("full") == SEVERITIES


def self_test_batch_timing_metrics() -> None:
    metrics = batch_timing_metrics(
        {
            "elapsedMs": 900,
            "results": [
                {"id": "correctness", "tier": "heavy", "elapsedMs": 700},
                {"id": "correctness-contracts", "tier": "heavy", "elapsedMs": 800},
                {"id": "security-performance-shard-2", "tier": "heavy", "elapsedMs": 600},
                {"id": "performance-resources", "tier": "heavy", "elapsedMs": 500},
                {"id": "overview", "tier": "light", "elapsedMs": 100},
            ],
        }
    )
    assert metrics == {
        "batch_elapsed_ms": 900.0,
        "heavy_tail_ms": 800.0,
        "correctness_tail_ms": 700.0,
        "contracts_tail_ms": 800.0,
        "security_tail_ms": 600.0,
        "resources_tail_ms": 500.0,
    }


def self_test_parent_phase_metrics() -> None:
    events = [
        {"type": "tool_execution_end", "toolName": "review_subagents", "toolCallId": "batch"},
        {
            "type": "message_end",
            "message": {"role": "toolResult", "toolCallId": "batch", "timestamp": 1_000, "content": []},
        },
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "timestamp": 1_100,
                "content": [{"type": "toolCall", "name": "bash"}, {"type": "toolCall", "name": "read"}],
            },
        },
        {
            "type": "message_end",
            "toolCallId": "validation",
            "message": {"role": "toolResult", "timestamp": 1_500, "content": []},
        },
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "timestamp": 1_800,
                "content": [{"type": "text", "text": '{"pr": {}, "findings": []}'}],
            },
        },
    ]
    assert parent_phase_metrics(events) == {
        "parent_post_batch_ms": 800.0,
        "parent_validation_ms": 500.0,
        "parent_synthesis_ms": 300.0,
        "parent_post_batch_tool_turns": 1.0,
        "parent_post_batch_tool_calls": 2.0,
    }


def changed_paths() -> set[str]:
    import subprocess

    diff = subprocess.run(
        ["gh", "pr", "diff", str(PR_NUMBER)], cwd=ROOT, check=True, text=True, capture_output=True
    ).stdout
    matches = re.findall(r"^diff --git a/(.+?) b/(.+)$", diff, re.MULTILINE)
    return {new_path for _old_path, new_path in matches}


def validate(review: dict, batch: dict | None, mode: str = "default") -> dict[str, float]:
    assert review.get("pr", {}).get("number") == PR_NUMBER
    assert re.fullmatch(r"[0-9a-f]{40}", review.get("pr", {}).get("head_sha", ""))
    assert review.get("disposition") == "reviewed"
    assert isinstance(review.get("overview"), str) and review["overview"].strip()
    assert isinstance(review.get("strengths"), list)
    assert isinstance(review.get("verification"), str) and review["verification"].strip()
    assert review.get("verdict") in {"approve", "request_changes", "comment"}
    assert review.get("overall_correctness") in {"patch is correct", "patch is incorrect"}
    assert isinstance(review.get("overall_explanation"), str) and review["overall_explanation"].strip()
    assert 0 <= float(review.get("overall_confidence_score")) <= 1

    if batch is not None:
        reduced_scope = mode != "full"
        if reduced_scope:
            assert batch.get("majorOnly") is True, batch
        else:
            assert batch.get("majorOnly") is False, batch
        if mode in {"default", "balanced"}:
            assert batch.get("minorHygiene") is True, batch
        else:
            assert batch.get("minorHygiene") is False, batch
        results = batch.get("results", [])
        ids = {result.get("id") for result in results}
        # Additional sharded passes are allowed, but every canonical lens must remain represented.
        required_passes = required_passes_for_mode(mode)
        assert required_passes <= ids, (required_passes, ids)
        if reduced_scope:
            assert "conventions-maintainability" not in ids, ids
        assert all(result.get("status") == "completed" for result in results)
        pass_success = sum(result.get("status") == "completed" for result in results)
    else:
        # Raw inline fallback has no extension-owned pass results. Its structural
        # gate must never be interpreted as proof of independent lens completion.
        pass_success = 0

    paths = changed_paths()
    relevant = 0
    located = 0
    findings = review.get("findings")
    assert isinstance(findings, list)
    for finding in findings:
        severity = finding.get("severity")
        assert severity in allowed_severities_for_mode(mode)
        assert str(finding.get("title", "")).startswith(f"[{severity}]")
        assert bool(finding.get("blocking")) == (severity in {"P0", "P1"})
        assert isinstance(finding.get("body"), str) and finding["body"].strip()
        assert 0 <= float(finding.get("confidence_score")) <= 1
        location = finding.get("code_location")
        if location is None:
            continue
        located += 1
        path = location.get("absolute_file_path")
        assert path in paths, f"finding references unchanged path: {path}"
        assert location.get("side") in {"RIGHT", "LEFT"}
        line_range = location.get("line_range", {})
        assert int(line_range.get("start", 0)) > 0
        assert int(line_range.get("end", 0)) >= int(line_range.get("start", 0))
        relevant += 1

    if mode in {"default", "balanced"}:
        assert sum(finding.get("severity") in {"P3", "nit"} for finding in findings) <= 3

    relevance_rate = relevant / located if located else 1.0
    assert relevance_rate == 1.0
    return {
        "quality_gate": 1.0,
        "relevance_rate": relevance_rate,
        "pass_success": float(pass_success),
        "finding_count": float(len(findings)),
        "review_chars": float(len(json.dumps(review, separators=(",", ":")))),
    }


def main() -> None:
    events = load_events()
    review = final_review(events)
    REVIEW.write_text(json.dumps(review, indent=2) + "\n", encoding="utf-8")
    raw = "--raw" in sys.argv
    full = "--full" in sys.argv
    major_only = "--major-only" in sys.argv
    balanced = "--balanced" in sys.argv
    if sum((raw, full, major_only, balanced)) > 1:
        raise AssertionError("raw, full, major-only, and balanced validators are separate benchmark modes")
    mode = "full" if full else "major" if major_only else "balanced" if balanced else "default"
    batch = None if raw else batch_details(events)
    metrics = validate(review, batch, mode)
    if batch is not None:
        metrics = {**metrics, **batch_timing_metrics(batch), **parent_phase_metrics(events)}
    else:
        metrics["raw_inline_mode"] = 1.0
    if "--metrics" in sys.argv:
        for name, value in metrics.items():
            print(f"METRIC {name}={value:g}")
    else:
        print(json.dumps(metrics, sort_keys=True))


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        self_test_reduced_scope_modes()
        self_test_batch_timing_metrics()
        self_test_parent_phase_metrics()
    else:
        main()
