"""Native Kev adapter contracts, with no checkpoint loading or model inference."""
from pathlib import Path
import importlib.util
import os
import re
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from kev import api, model as native_model, serve as native_serve

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
spec = importlib.util.spec_from_file_location("kev_server_under_test", SCRIPTS / "serve-kev.py")
SERVER = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = SERVER
spec.loader.exec_module(SERVER)


class CharacterTokenizer:
    """A transparent tokenizer makes independent delimiter accounting possible."""
    def __call__(self, text, add_special_tokens=False):
        assert add_special_tokens is False
        return SimpleNamespace(input_ids=[ord(character) + 100 for character in text])

    def convert_tokens_to_ids(self, token):
        return native_model.SPECIAL.index(token) + 1


class FakeModel:
    backend = "mlx"
    dtype = "bfloat16"
    device = "mlx"
    head = SimpleNamespace(temperature=1.0)

    def __init__(self):
        self.calls = []
        self.encodings = []
        self.failure = None

    def encode(self, tokenizer, record, **kwargs):
        self.calls.append((tokenizer, record, kwargs))
        if self.failure:
            raise self.failure
        encoded = native_model.encode(tokenizer, record, option_isolation=False, **kwargs)
        self.encodings.append(encoded)
        return encoded


class RecordingQueue:
    def __init__(self):
        self.items = []

    def put(self, item):
        self.items.append(item)
        encoded, future = item
        probabilities = [[0.75, 0.25] if len(options) == 2 else [1 / len(options)] * len(options)
                         for options in encoded["opt_idx"]]
        future.set_result((probabilities, {"tokens": len(encoded["ids"]), "latency_ms": 12.5}))

    def qsize(self):
        return len(self.items)


def fake_server():
    server = object.__new__(SERVER.BudgetServer)
    server.tok = CharacterTokenizer()
    server.model = FakeModel()
    server.device = "mps"
    server.tokenizer_lock = threading.Lock()
    server.stopping = threading.Event()
    server.queue = RecordingQueue()
    server.close = Mock()
    server.release_date = "2026-09-28"
    server.checkpoint = SimpleNamespace(
        requested=SERVER.MODEL_ID,
        path=f"/cache/snapshots/{SERVER.MODEL_REVISION}",
        meta=SimpleNamespace(base="Qwen/Qwen3.5-4B", lora=64, base_revision="base-revision"),
    )
    return server


def body():
    return {
        "model": SERVER.MODEL_ID,
        "state": {"goal_memory": {"text": "Create a file."}, "persistent_memory": {}},
        "questions": {"next_tool": {
            "type": "choice", "instructions": "Choose a tool.",
            "criteria": {"create_file": "Create", "finish": "Finish"},
        }},
    }


ENDPOINTS = ("/v1/input-tokens", "/v1/systemone", "/v1/systemone/separate", "/v1/systemone/permute")


def endpoint_body(endpoint, value):
    return {"request": value, "question": "next_tool", "n_perm": 3, "seed": 42} if endpoint.endswith("/permute") else value


def request_with_token_count(server, tokens):
    value = body()
    value["state"] = ""
    request = api.SystemOneRequest.model_validate(value)
    base = server.count_request(request)
    value["state"] = "x" * (tokens - base)
    server.model.calls.clear()
    server.model.encodings.clear()
    return api.SystemOneRequest.model_validate(value)


class EncodingTests(unittest.TestCase):
    def setUp(self):
        self.server = fake_server()

    def test_count_uses_native_preparation_rendering_and_strict_model_encoder(self):
        value = body()
        value["state"] = {"dates": "2026-09-01 and 2026-09-28", "text": "你好🌏 <|fim_prefix|>", "nested": [True, None, {"n": 2}]}
        value["questions"]["next_tool"]["criteria"]["create_file"] = {"description": "<|box_end|>literal", "path": "hello.py"}
        value["questions"]["yes"] = {"type": "noul", "instructions": "Continue?"}
        value["questions"]["score"] = {"type": "score", "instructions": ["Rate", "the result"], "criteria": ["low", {"level": "high"}]}
        request = api.SystemOneRequest.model_validate(value)
        with patch.object(native_serve, "DATE_FACTS", True):
            record, _ = api.to_record(native_serve.prepare(request))
            count = self.server.count_request(request)
        def text_length(text):
            return len(re.sub(r"<\|([A-Za-z0-9_]+)\|>", r"<¦\1¦>", text))
        expected = 1 + text_length(record["state"]) + sum(
            2 + text_length(question["instr"]) + sum(2 + text_length(option) for option in question["options"])
            for question in record["questions"]
        )
        self.assertEqual(count, expected)
        self.assertIn("date_facts", record["state"])
        self.assertEqual(len(self.server.model.calls), 1)
        tokenizer, actual_record, kwargs = self.server.model.calls[0]
        self.assertIs(tokenizer, self.server.tok)
        self.assertEqual(actual_record, record)
        self.assertEqual(kwargs, {"max_state": native_model.SERVE_MAX_STATE, "max_branch": native_model.SERVE_MAX_BRANCH, "strict": True})
        self.assertFalse(self.server.model.encodings[0]["state_truncated"])
        self.assertEqual(self.server.queue.items, [])

    def test_exactly_3000_tokens_queue_the_same_strict_encoding_once(self):
        request = request_with_token_count(self.server, 3000)
        record, _ = api.to_record(native_serve.prepare(request))
        future = self.server.submit(record)
        self.assertEqual(len(self.server.model.calls), 1)
        self.assertEqual(len(self.server.queue.items), 1)
        encoded, queued_future = self.server.queue.items[0]
        self.assertIs(encoded, self.server.model.encodings[0])
        self.assertIs(future, queued_future)
        self.assertEqual(len(encoded["ids"]), 3000)
        self.assertTrue(self.server.model.calls[0][2]["strict"])
        self.assertEqual(future.result()[1]["tokens"], 3000)

    def test_3001_tokens_are_counted_without_queueing_and_rejected_before_inference(self):
        request = request_with_token_count(self.server, 3001)
        self.assertEqual(self.server.count_request(request), 3001)
        self.assertEqual(self.server.queue.items, [])
        record, _ = api.to_record(native_serve.prepare(request))
        with self.assertRaises(HTTPException) as error:
            self.server.submit(record)
        self.assertEqual(error.exception.status_code, 422)
        self.assertIn("3001", str(error.exception.detail).replace(",", ""))
        self.assertIn("3000", str(error.exception.detail).replace(",", ""))
        self.assertEqual(self.server.queue.items, [])

    def test_state_above_native_encoder_limit_is_not_silently_truncated(self):
        record = {"state": "x" * native_model.SERVE_MAX_STATE,
                  "questions": [{"instr": "Choose", "options": ["a", "b"], "label": 0}]}
        with self.assertRaises((HTTPException, ValueError)):
            self.server.encode_record(record)
        self.assertEqual(self.server.queue.items, [])
        self.assertEqual(self.server.model.encodings, [])

    def test_stopped_server_cannot_enqueue_another_request(self):
        self.server.stopping.set()
        record, _ = api.to_record(api.SystemOneRequest.model_validate(body()))
        with self.assertRaises(HTTPException) as error:
            self.server.submit(record)
        self.assertEqual(error.exception.status_code, 503)
        self.assertEqual(self.server.queue.items, [])


class HTTPTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {"KEV_API_KEY": "", "KEV_DATE_FACTS": "0"})
        environment.start()
        self.addCleanup(environment.stop)
        self.server = fake_server()
        self.loader = Mock(return_value=self.server)
        self.client = TestClient(SERVER.create_app(loader=self.loader))
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def test_metadata_reports_the_pinned_kev_model_and_actual_backend(self):
        models = self.client.get("/v1/models")
        health = self.client.get("/health")
        self.assertEqual(models.status_code, 200)
        self.assertEqual(health.status_code, 200)
        model = models.json()["models"][0]
        for key, value in {"name": SERVER.MODEL_ID, "run": SERVER.MODEL_ID, "revision": SERVER.MODEL_REVISION,
                           "backend": "mlx/mps", "dtype": "bfloat16", "max_input_tokens": 3000}.items():
            self.assertEqual(model[key], value)
        self.assertIn(model.get("device"), ("mps", "mlx"))
        self.assertEqual(health.json()["model"], model)
        self.loader.assert_called_once_with()
        self.assertEqual(self.server.model.calls, [])
        self.assertEqual(self.server.queue.items, [])

    def test_preflight_and_inference_use_identical_tokens_and_native_answer_conversion(self):
        payload = body()
        counted = self.client.post("/v1/input-tokens", json=payload)
        self.assertEqual(counted.status_code, 200)
        self.assertEqual(self.server.queue.items, [])
        response = self.client.post("/v1/systemone", json=payload)
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual(result["model"], SERVER.MODEL_ID)
        self.assertEqual(result["usage"]["input_tokens"], counted.json()["input_tokens"])
        self.assertEqual(result["latency_ms"], 12.5)
        self.assertEqual(result["answers"]["next_tool"], {
            "type": "choice", "choice": "create_file", "confidence": 0.5,
            "probabilities": {"create_file": 0.75, "finish": 0.25},
        })
        self.assertEqual(len(self.server.queue.items), 1)
        self.assertEqual(self.server.model.encodings[0]["ids"], self.server.queue.items[0][0]["ids"])

    def test_exact_budget_boundary_is_enforced_by_http(self):
        for tokens in (3000, 3001):
            with self.subTest(tokens=tokens):
                request = request_with_token_count(self.server, tokens)
                before = len(self.server.queue.items)
                counted = self.client.post("/v1/input-tokens", json=request.model_dump())
                self.assertEqual(counted.status_code, 200)
                self.assertEqual(counted.json()["input_tokens"], tokens)
                self.assertEqual(len(self.server.queue.items), before)
                response = self.client.post("/v1/systemone", json=request.model_dump())
                self.assertEqual(response.status_code, 200 if tokens == 3000 else 422)
                self.assertEqual(len(self.server.queue.items), before + (tokens == 3000))

    def test_separate_matches_native_answers_usage_and_latency(self):
        value = body()
        value["questions"].update({
            "yes": {"type": "noul", "instructions": "Continue?"},
            "score": {"type": "score", "criteria": ["low", "medium", "high"]},
        })
        reference = fake_server()
        with patch.object(native_serve, "server", return_value=reference):
            expected = native_serve.systemone_separate(api.SystemOneRequest.model_validate(value))
        response = self.client.post("/v1/systemone/separate", json=value)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), expected)
        self.assertEqual(len(self.server.queue.items), 3)
        self.assertTrue(all(len(encoded["opt_idx"]) == 1 for encoded, _ in self.server.queue.items))
        self.assertEqual([encoded["ids"] for encoded, _ in self.server.queue.items],
                         [encoded["ids"] for encoded, _ in reference.queue.items])

    def test_permute_matches_native_order_probabilities_and_spread(self):
        value = endpoint_body("/permute", body())
        value["n_perm"] = 6
        value["request"]["questions"]["ignored"] = {"type": "noul", "instructions": "Not selected."}
        reference = fake_server()
        with patch.object(native_serve, "server", return_value=reference):
            expected = native_serve.systemone_permute(native_serve.PermuteSystemOne.model_validate(value))
        response = self.client.post("/v1/systemone/permute", json=value)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), expected)
        self.assertEqual(expected["runs"][0]["order"], ["create_file", "finish"])
        self.assertFalse(expected["argmax_stable"])
        self.assertEqual(expected["spread"], {"create_file": 0.5, "finish": 0.5})
        self.assertEqual(len(self.server.queue.items), 6)
        self.assertTrue(all(len(encoded["opt_idx"]) == 1 for encoded, _ in self.server.queue.items))
        self.assertEqual([encoded["ids"] for encoded, _ in self.server.queue.items],
                         [encoded["ids"] for encoded, _ in reference.queue.items])

    def test_comparison_routes_enforce_budget_before_each_model_request(self):
        for endpoint in ("/v1/systemone/separate", "/v1/systemone/permute"):
            for tokens in (3000, 3001):
                with self.subTest(endpoint=endpoint, tokens=tokens):
                    request = request_with_token_count(self.server, tokens)
                    before = len(self.server.queue.items)
                    response = self.client.post(endpoint, json=endpoint_body(endpoint, request.model_dump()))
                    self.assertEqual(response.status_code, 200 if tokens == 3000 else 422)
                    expected_calls = (3 if endpoint.endswith("/permute") else 1) if tokens == 3000 else 0
                    self.assertEqual(len(self.server.queue.items) - before, expected_calls)
                    self.assertTrue(all(len(encoded["ids"]) <= 3000 for encoded, _ in self.server.queue.items))

    def test_separate_usage_counts_repeated_state_across_budgeted_requests(self):
        value = request_with_token_count(self.server, 3000).model_dump()
        value["questions"]["another"] = value["questions"]["next_tool"]
        response = self.client.post("/v1/systemone/separate", json=value)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["usage"]["input_tokens"], 6000)
        self.assertEqual([len(encoded["ids"]) for encoded, _ in self.server.queue.items], [3000, 3000])

    def test_permute_rejects_invalid_selection_and_pass_counts_before_encoding(self):
        value = endpoint_body("/permute", body())
        non_choice = body()
        non_choice["questions"]["next_tool"] = {"type": "noul"}
        invalid = [
            {**value, "question": "missing"}, {**value, "n_perm": 0}, {**value, "n_perm": 65},
            {**value, "request": non_choice}, {**value, "request": {**body(), "model": "other-model"}},
        ]
        for candidate in invalid:
            with self.subTest(candidate=candidate):
                self.assertEqual(self.client.post("/v1/systemone/permute", json=candidate).status_code, 422)
        self.assertEqual(self.server.model.calls, [])
        self.assertEqual(self.server.queue.items, [])

    def test_legacy_aliases_return_canonical_identity(self):
        for alias in ("kev-latest", "jev-latest"):
            for endpoint in ("/v1/input-tokens", "/v1/systemone", "/v1/systemone/separate"):
                with self.subTest(alias=alias, endpoint=endpoint):
                    response = self.client.post(endpoint, json={**body(), "model": alias})
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.json()["model"], SERVER.MODEL_ID)

    def test_wrong_models_and_invalid_request_shapes_never_reach_the_encoder(self):
        invalid = [
            {**body(), "model": "convaiinnovations/laya"}, [], "text", {},
            {"state": {}}, {"questions": body()["questions"]},
            {**body(), "questions": {}}, {**body(), "questions": []},
            {**body(), "questions": {"bad": {"type": "choice", "criteria": {}}}},
        ]
        for endpoint in ENDPOINTS:
            for payload in invalid:
                with self.subTest(endpoint=endpoint, payload=payload):
                    self.assertEqual(self.client.post(endpoint, json=endpoint_body(endpoint, payload)).status_code, 422)
            self.assertEqual(self.client.post(endpoint, content=b"{not-json", headers={"content-type": "application/json"}).status_code, 422)
        self.assertEqual(self.server.model.calls, [])
        self.assertEqual(self.server.queue.items, [])

    def test_oversized_body_is_rejected_before_encoding(self):
        for endpoint in ENDPOINTS:
            response = self.client.post(endpoint, json=endpoint_body(endpoint, {**body(), "state": "x" * (256 * 1024)}))
            self.assertEqual(response.status_code, 413)
        self.assertEqual(self.server.model.calls, [])
        self.assertEqual(self.server.queue.items, [])

    def test_encoder_failures_return_validation_errors_without_queueing(self):
        self.server.model.failure = ValueError("Native encoder rejected this input.")
        for endpoint in ENDPOINTS:
            response = self.client.post(endpoint, json=endpoint_body(endpoint, body()))
            self.assertEqual(response.status_code, 422)
        self.assertEqual(self.server.queue.items, [])

    def test_authentication_and_lifespan_cleanup(self):
        server = fake_server()
        with patch.dict(os.environ, {"KEV_API_KEY": "local-test-key"}):
            with TestClient(SERVER.create_app(loader=lambda: server)) as client:
                for endpoint in ENDPOINTS:
                    payload = endpoint_body(endpoint, body())
                    self.assertEqual(client.post(endpoint, json=payload).status_code, 401)
                    self.assertEqual(client.post(endpoint, json=payload, headers={"authorization": "Bearer wrong"}).status_code, 401)
                self.assertEqual(server.model.calls, [])
                for endpoint in ENDPOINTS:
                    self.assertEqual(client.post(endpoint, json=endpoint_body(endpoint, body()), headers={"authorization": "Bearer local-test-key"}).status_code, 200)
                server.close.assert_not_called()
            server.close.assert_called_once_with()


if __name__ == "__main__":
    unittest.main(verbosity=2)
