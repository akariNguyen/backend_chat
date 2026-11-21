"""Brand Search: web page + job queue + API.

The web page (web/, served at /) adds a lookup job for a URL. A worker extension running in a Chrome
profile logged in to ChatGPT claims the job, opens ChatGPT with the prompt (web search on), sends the
answer back and closes the tab. The backend turns the answer into checked data (logos, official domains).
No OpenAI API key is used.

Run (from this backend/ folder):  py -3.13 app.py   -> http://127.0.0.1:8765, API docs at /docs
"""
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import jobs
import lookup

WEB_DIR = Path(__file__).resolve().parent.parent / "frontend"     # the web page lives next to backend/
WORKER_ID = r"^[A-Za-z0-9_.-]{1,64}$"


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.jobs = jobs.JobStore(Path(os.environ.get("BRAND_JOBS_DB", jobs.DB_PATH)))
    async with httpx.AsyncClient(limits=httpx.Limits(max_connections=20)) as client:
        app.state.http = client
        yield


app = FastAPI(title="Brand Search API", version="4.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
# The page is same-origin; from other origins only browser extensions (the worker) may call the API.
app.add_middleware(CORSMiddleware,
                   allow_origin_regex=r"^(chrome-extension://[a-p]{32}|moz-extension://[0-9a-f-]{36})$",
                   allow_methods=["GET", "POST"], allow_headers=["Content-Type"])


# ---------------------------------------------------------------- models
class Logo(BaseModel):
    url: str
    final_url: str
    source: str = Field(description="chatgpt = link given by ChatGPT, page = taken from the page itself")
    content_type: str
    bytes: int
    data_uri: str | None = Field(None, description="the image itself, for logos up to 400 KB")
    verified: bool = Field(description="true = downloaded and checked to be an image; false = the site refused "
                                       "the server (e.g. upload.wikimedia.org), the browser must load the URL")


class LogoError(BaseModel):
    url: str
    source: str
    error: str


class PageInfo(BaseModel):
    fetched: bool
    final_url: str | None = None
    title: str | None = None
    site_name: str | None = None
    error: str | None = None


class BrandResult(BaseModel):
    input_url: str
    registered_domain: str
    brand_name: str | None
    organization: str | None
    aliases: list[str]
    official_domains: list[str]
    is_official_site: bool | None = Field(description="ChatGPT's judgement")
    domain_in_official_list: bool = Field(description="registered_domain is in official_domains")
    description: str | None
    confidence: str
    reasoning: str
    logos: list[Logo]
    logo_errors: list[LogoError]
    sources: list[str]
    page: PageInfo
    elapsed_ms: int


class JobRequest(BaseModel):
    url: str = Field(min_length=3, max_length=2048, examples=["https://www.vietcombank.com.vn/"])
    title: str | None = Field(None, max_length=1000, description="page title if known (sent by the extension popup)")


class Job(BaseModel):
    id: str
    url: str
    title: str | None = None
    status: str = Field(description="pending | running | done | error | cancelled")
    worker_id: str | None = None
    created_at: float
    claimed_at: float | None = None
    finished_at: float | None = None
    queue_position: int | None = Field(None, description="1 = next to be claimed (pending jobs only)")
    error: str | None = None
    answer: str | None = Field(None, description="ChatGPT's raw answer as the worker read it")
    result: BrandResult | None = None


class JobSummary(BaseModel):
    id: str
    url: str
    status: str
    worker_id: str | None = None
    created_at: float
    finished_at: float | None = None
    error: str | None = None
    brand_name: str | None = None
    domain_in_official_list: bool | None = None


class WorkerJob(BaseModel):
    id: str
    url: str
    prompt: str


class WorkerAnswer(BaseModel):
    worker_id: str = Field(pattern=WORKER_ID)
    answer: str = Field(min_length=1, max_length=200_000)


class WorkerFailure(BaseModel):
    worker_id: str = Field(pattern=WORKER_ID)
    error: str = Field(min_length=1, max_length=2000)


class Heartbeat(BaseModel):
    worker_id: str = Field(pattern=WORKER_ID)
    status: str = Field(max_length=20, description="idle | busy | off")
    job_id: str | None = Field(None, max_length=64)
    version: str | None = Field(None, max_length=20)


class WorkerInfo(BaseModel):
    id: str
    last_seen: float
    status: str | None = None
    job_id: str | None = None
    version: str | None = None
    online: bool


class PromptRequest(BaseModel):
    url: str = Field(min_length=3, max_length=2048)
    title: str | None = Field(None, max_length=1000)


class PromptResult(BaseModel):
    url: str
    registered_domain: str
    prompt: str
    chatgpt_url: str = Field(description="chatgpt.com link with the prompt prefilled and web search on")


class ParseRequest(BaseModel):
    url: str = Field(min_length=3, max_length=2048)
    answer: str = Field(min_length=2, max_length=200_000, description="ChatGPT's answer")


def _fail(exc: lookup.LookupFailed):
    raise HTTPException(status_code=exc.status, detail=exc.message)


# ---------------------------------------------------------------- web page
@app.get("/", include_in_schema=False)
async def front_end():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "brand-search", "version": app.version}


# ---------------------------------------------------------------- jobs (web page side)
@app.post("/api/jobs", response_model=Job)
async def create_job(request: JobRequest):
    try:
        url = lookup.checked_url(request.url)
    except lookup.LookupFailed as exc:
        _fail(exc)
    prompt = lookup.build_prompt(url, request.title)["prompt"]
    return app.state.jobs.create(url, request.title, prompt)


@app.get("/api/jobs", response_model=list[JobSummary])
async def recent_jobs(limit: int = Query(20, ge=1, le=200)):
    return app.state.jobs.recent(limit)


@app.get("/api/jobs/{job_id}", response_model=Job)
async def get_job(job_id: str):
    job = app.state.jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Không có việc này")
    return job


@app.post("/api/jobs/{job_id}/cancel", response_model=Job)
async def cancel_job(job_id: str):
    job = app.state.jobs.cancel(job_id)
    if not job:
        raise HTTPException(404, "Không có việc này")
    return job


@app.get("/api/workers", response_model=list[WorkerInfo])
async def list_workers():
    return app.state.jobs.workers()


# ---------------------------------------------------------------- worker extension side
@app.get("/api/worker/next", response_model=WorkerJob, responses={204: {"description": "no job waiting"}})
async def next_job(worker_id: str = Query(pattern=WORKER_ID)):
    job = app.state.jobs.claim(worker_id)
    if not job:
        return Response(status_code=204)
    return WorkerJob(id=job["id"], url=job["url"], prompt=job["prompt"])


@app.post("/api/worker/jobs/{job_id}/answer")
async def submit_answer(job_id: str, body: WorkerAnswer):
    store = app.state.jobs
    job = store.running_job(job_id, body.worker_id)
    if not job:
        raise HTTPException(409, "Việc này không còn chạy (đã hủy, hết giờ hoặc của worker khác)")
    try:
        result = await lookup.analyze_answer(app.state.http, job["url"], body.answer)
    except lookup.LookupFailed as exc:
        store.finish(job_id, body.worker_id, answer=body.answer, error=exc.message)
        return {"status": "error", "error": exc.message}
    if not store.finish(job_id, body.worker_id, answer=body.answer, result=result):
        raise HTTPException(409, "Việc này đã bị hủy trong lúc phân tích")
    return {"status": "done", "brand_name": result["brand_name"]}


@app.post("/api/worker/jobs/{job_id}/fail")
async def report_failure(job_id: str, body: WorkerFailure):
    return {"ok": app.state.jobs.finish(job_id, body.worker_id, error=body.error)}


@app.post("/api/worker/heartbeat")
async def heartbeat(body: Heartbeat):
    return app.state.jobs.heartbeat(body.worker_id, body.status, body.job_id, body.version)


# ---------------------------------------------------------------- manual helpers
@app.post("/api/prompt", response_model=PromptResult)
async def make_prompt(request: PromptRequest):
    try:
        return lookup.build_prompt(lookup.checked_url(request.url), request.title)
    except lookup.LookupFailed as exc:
        _fail(exc)


@app.post("/api/brand/parse", response_model=BrandResult)
async def parse_chatgpt_answer(request: ParseRequest):
    try:
        return await lookup.analyze_answer(app.state.http, request.url, request.answer)
    except lookup.LookupFailed as exc:
        _fail(exc)


if __name__ == "__main__":
    import uvicorn
    # Keep the port in sync with BACKEND_URL in the extension (background.js, popup.js, manifest.json).
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("BRAND_API_PORT", "8765")))
