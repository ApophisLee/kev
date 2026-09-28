import path from "node:path";
import { exclusive, localRequest, LoopError, ToolLoop } from "@/lib/tool-loop-server";
import { object, validateName } from "@/lib/tool-loop";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const loop = new ToolLoop(path.join(process.cwd(), ".tool-playground"), process.env.KEV_API, fetch, process.env.KEV_API_KEY);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const failure = (error: unknown) => json({ error: (error as Error).message }, error instanceof LoopError ? error.status : 400);

export async function GET(request: Request) {
  try {
    localRequest(request);
    const workspace = new URL(request.url).searchParams.get("workspace") ?? "demo";
    validateName(workspace);
    return json(await exclusive(workspace, () => loop.snapshot(workspace)));
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    localRequest(request);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new LoopError("Expected application/json.", 415);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 128000) throw new LoopError("Request exceeds 128 KB.", 413);
    const body: unknown = JSON.parse(raw);
    if (!object(body)) throw new LoopError("Expected a JSON object.");
    validateName(body.workspace);
    const workspace = body.workspace;
    return json(await exclusive(workspace, async () => {
      switch (body.operation) {
        case "start": return loop.start(workspace, body.program);
        case "step": return loop.step(workspace, body.runId, body.expectedStep);
        case "stop": return loop.stop(workspace, body.runId);
        case "reset":
          if (body.scope !== "files" && body.scope !== "all") throw new LoopError("Reset scope must be files or all.");
          return loop.reset(workspace, body.scope, body.runId);
        case "restore": return loop.restore(workspace, body.runId);
        default: throw new LoopError("Unknown operation.");
      }
    }));
  } catch (error) { return failure(error); }
}
