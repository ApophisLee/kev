#!/usr/bin/env python3
"""Serve the pinned Kev 4B checkpoint with exact, untruncated input budgeting."""
import argparse
from concurrent.futures import Future
from contextlib import asynccontextmanager
import hmac
import os
from pathlib import Path
import random
import sys
import threading

os.environ.setdefault("USE_TF", "0")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
# Running from playground/ still imports the repository's native Kev package.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fastapi import FastAPI, HTTPException, Request
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool
from kev.api import SystemOneRequest, output_tokens, to_record
from kev.serve import PermuteSystemOne, Server, prepare
from kev.model import SERVE_MAX_BRANCH, SERVE_MAX_STATE

MODEL_ID = "jaredpalmer/kev-4b"
MODEL_REVISION = "139fdd94f1b6a6ad80cc15e08fcb99cac885a101"
MAX_INPUT_TOKENS = 3000
MAX_BODY_BYTES = 256_000
MODEL_ALIASES = {MODEL_ID, "kev-latest", "jev-latest"}


class BudgetServer(Server):
    """Keep native decoding, model queue and prefix caching; bound its exact input."""

    def __post_init__(self):
        self.tokenizer_lock = threading.RLock()
        super().__post_init__()

    def encode_record(self, rec):
        with self.tokenizer_lock:
            return self.model.encode(self.tok, rec, max_state=SERVE_MAX_STATE,
                                     max_branch=SERVE_MAX_BRANCH, strict=True)

    def count_request(self, req):
        rec, _ = to_record(prepare(req))
        return len(self.encode_record(rec)["ids"])

    def submit(self, rec):
        # As in native Server.submit, queue the encoding itself: no second pass
        # through a formatter that might disagree with the checked token count.
        if self.stopping.is_set():
            raise HTTPException(503, "The model server is stopping.")
        try:
            enc = self.encode_record(rec)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        count = len(enc["ids"])
        if count > MAX_INPUT_TOKENS:
            raise HTTPException(422, f"Model request blocked before inference: {count:,} input tokens exceeds the {MAX_INPUT_TOKENS:,}-token limit. No content was truncated.")
        done = Future()
        self.queue.put((enc, done))
        return done


def load_server():
    import torch
    from huggingface_hub import snapshot_download
    from kev.checkpoint import Checkpoint, LoadOptions
    # Prefer the user's already downloaded checkpoint; download only if missing.
    try:
        checkpoint_path = snapshot_download(MODEL_ID, revision=MODEL_REVISION, local_files_only=True)
    except FileNotFoundError:
        checkpoint_path = snapshot_download(MODEL_ID, revision=MODEL_REVISION,
                                           allow_patterns=["*.json", "*.safetensors", "*.pt", "*.txt", "*.jinja"])
    ck = Checkpoint(checkpoint_path)
    tok, model = ck.load("mps", LoadOptions(backend="mlx", dtype=torch.bfloat16, attn="sdpa"))
    if model.backend != "mlx" or model.dtype != "bfloat16":
        raise RuntimeError(f"Expected MLX/bfloat16, loaded {model.backend}/{model.dtype}.")
    server = BudgetServer(ck, tok, model, "mps")
    print(f"serving {MODEL_ID} ({ck.path}) on mps via mlx (bfloat16); input limit {MAX_INPUT_TOKENS}", flush=True)
    return server


def create_app(loader=load_server):
    @asynccontextmanager
    async def lifespan(app):
        app.state.server = loader()
        try:
            yield
        finally:
            app.state.server.close()

    app = FastAPI(title="Choice Programming · Kev", lifespan=lifespan)

    def metadata():
        server = app.state.server
        return {"name": MODEL_ID, "run": MODEL_ID, "base": server.checkpoint.meta.base,
                "backend": f"{server.model.backend}/{server.device}", "device": server.device,
                "dtype": server.model.dtype, "revision": MODEL_REVISION,
                "max_input_tokens": MAX_INPUT_TOKENS, "input_truncated": False}

    async def payload(request, schema=SystemOneRequest):
        key = os.environ.get("KEV_API_KEY")
        if key and not hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {key}"):
            raise HTTPException(401, "Invalid API key.")
        body = await request.body()
        if len(body) > MAX_BODY_BYTES:
            raise HTTPException(413, "Request exceeds 256 KB.")
        try:
            value = schema.model_validate_json(body)
        except ValidationError as error:
            raise HTTPException(422, "Invalid System One request.") from error
        req = value.request if isinstance(value, PermuteSystemOne) else value
        if req.model not in MODEL_ALIASES:
            raise HTTPException(422, f"This endpoint serves only {MODEL_ID}.")
        return value

    @app.get("/health")
    def health():
        return {"status": "ready", "model": metadata()}

    @app.get("/v1/models")
    def models():
        return {"models": [metadata()]}

    @app.post("/v1/input-tokens")
    async def input_tokens(request: Request):
        req = await payload(request)
        try:
            count = await run_in_threadpool(app.state.server.count_request, req)
        except (ValueError, TypeError) as error:
            raise HTTPException(422, str(error)) from error
        return {"model": MODEL_ID, "input_tokens": count, "max_input_tokens": MAX_INPUT_TOKENS}

    @app.post("/v1/systemone")
    async def system_one(request: Request):
        req = await payload(request)
        result = await app.state.server.answer_async(req)
        return {**result, "model": MODEL_ID}

    @app.post("/v1/systemone/separate")
    async def system_one_separate(request: Request):
        req = await payload(request)
        server = app.state.server
        # Match the native comparison: each question is its own budgeted model
        # request, and usage/latency sum those requests (including repeated state).
        parts = [await server.answer_async(req.model_copy(update={"questions": {qid: q}}))
                 for qid, q in req.questions.items()]
        answers = {qid: answer for part in parts for qid, answer in part["answers"].items()}
        return {"model": MODEL_ID, "answers": answers,
                "usage": {"input_tokens": sum(part["usage"]["input_tokens"] for part in parts),
                          "output_tokens": output_tokens(server.tok, answers)},
                "latency_ms": round(sum(part["latency_ms"] for part in parts), 1)}

    @app.post("/v1/systemone/permute")
    async def system_one_permute(request: Request):
        value = await payload(request, PermuteSystemOne)
        question = value.request.questions.get(value.question)
        if question is None or question.type != "choice":
            raise HTTPException(422, "question must be an existing choice question")
        rng = random.Random(value.seed)
        keys = list(question.criteria)
        runs = []
        for index in range(value.n_perm):
            order = list(keys)
            if index > 0:
                rng.shuffle(order)
            one = value.request.model_copy(update={"questions": {
                value.question: question.model_copy(update={"criteria": {key: question.criteria[key] for key in order}}),
            }})
            result = await app.state.server.answer_async(one)
            answer = result["answers"][value.question]
            runs.append({"order": order, "probabilities": answer["probabilities"],
                         "choice": answer["choice"], "latency_ms": result["latency_ms"]})
        spread = {key: max(run["probabilities"][key] for run in runs)
                       - min(run["probabilities"][key] for run in runs) for key in keys}
        return {"runs": runs, "argmax_stable": len({run["choice"] for run in runs}) == 1, "spread": spread}

    return app


if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8009)
    args = parser.parse_args()
    uvicorn.run(create_app(), host="127.0.0.1", port=args.port)
