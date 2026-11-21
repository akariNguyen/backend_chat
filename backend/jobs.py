"""Brand lookup job queue in SQLite.

The web page adds jobs; worker extensions (Chrome profiles logged in to ChatGPT) claim the oldest
pending job, ask ChatGPT and send the answer back. Jobs and results stay in brand_jobs.sqlite3.

status: pending -> running -> done | error | cancelled
"""
import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "brand_jobs.sqlite3"
JOB_TIMEOUT_S = 300          # a running job with no answer after this is failed (worker died, tab stuck)
WORKER_ONLINE_S = 60         # a worker that sent a heartbeat this recently counts as online
ACTIVE = ("pending", "running")


class JobStore:
    def __init__(self, path: Path = DB_PATH):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        with self.db:
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT, prompt TEXT NOT NULL,
                    status TEXT NOT NULL, worker_id TEXT, created_at REAL NOT NULL,
                    claimed_at REAL, finished_at REAL, answer TEXT, result TEXT, error TEXT);
                CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs(status, created_at);
                CREATE TABLE IF NOT EXISTS workers (
                    id TEXT PRIMARY KEY, last_seen REAL NOT NULL, status TEXT, job_id TEXT, version TEXT);
            """)
            # A job running when the backend stopped can no longer be answered.
            self.db.execute("UPDATE jobs SET status='error', error=?, finished_at=? WHERE status='running'",
                            ("Backend khởi động lại khi việc đang chạy", time.time()))

    # ------------------------------------------------------------ helpers
    @staticmethod
    def _row(row, with_details=True) -> dict | None:
        if row is None:
            return None
        job = dict(row)
        job["result"] = json.loads(job["result"]) if job.get("result") else None
        if not with_details:
            result = job.pop("result")
            job.pop("answer", None)
            job.pop("prompt", None)
            job["brand_name"] = (result or {}).get("brand_name")
            job["domain_in_official_list"] = (result or {}).get("domain_in_official_list")
        return job

    def _expire(self) -> None:
        cutoff = time.time() - JOB_TIMEOUT_S
        self.db.execute("UPDATE jobs SET status='error', error=?, finished_at=? WHERE status='running' AND claimed_at < ?",
                        (f"Worker không trả kết quả sau {JOB_TIMEOUT_S // 60} phút", time.time(), cutoff))

    # ------------------------------------------------------------ web page side
    def create(self, url: str, title: str | None, prompt: str) -> dict:
        with self.lock, self.db:
            self._expire()
            same = self.db.execute("SELECT * FROM jobs WHERE url=? AND status IN ('pending','running') "
                                   "ORDER BY created_at DESC LIMIT 1", (url,)).fetchone()
            if same:                                     # the same URL is already queued: reuse it
                return self._row(same)
            job_id = uuid.uuid4().hex[:12]
            self.db.execute("INSERT INTO jobs (id, url, title, prompt, status, created_at) VALUES (?,?,?,?,?,?)",
                            (job_id, url, title, prompt, "pending", time.time()))
            return self._row(self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())

    def get(self, job_id: str) -> dict | None:
        with self.lock, self.db:
            self._expire()
            job = self._row(self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())
            if job and job["status"] == "pending":
                job["queue_position"] = self.db.execute(
                    "SELECT COUNT(*) FROM jobs WHERE status='pending' AND created_at <= ?", (job["created_at"],)).fetchone()[0]
            return job

    def recent(self, limit: int = 20) -> list[dict]:
        with self.lock, self.db:
            self._expire()
            rows = self.db.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
            return [self._row(r, with_details=False) for r in rows]

    def cancel(self, job_id: str) -> dict | None:
        with self.lock, self.db:
            self.db.execute("UPDATE jobs SET status='cancelled', error='Đã hủy', finished_at=? "
                            "WHERE id=? AND status IN ('pending','running')", (time.time(), job_id))
            return self._row(self.db.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone())

    # ------------------------------------------------------------ worker side
    def claim(self, worker_id: str) -> dict | None:
        """Oldest pending job -> running for this worker (one claim at a time thanks to the lock)."""
        with self.lock, self.db:
            self._expire()
            row = self.db.execute("SELECT id FROM jobs WHERE status='pending' ORDER BY created_at LIMIT 1").fetchone()
            if not row:
                return None
            self.db.execute("UPDATE jobs SET status='running', worker_id=?, claimed_at=? WHERE id=?",
                            (worker_id, time.time(), row["id"]))
            return self._row(self.db.execute("SELECT * FROM jobs WHERE id=?", (row["id"],)).fetchone())

    def running_job(self, job_id: str, worker_id: str) -> dict | None:
        with self.lock:
            row = self.db.execute("SELECT * FROM jobs WHERE id=? AND worker_id=? AND status='running'",
                                  (job_id, worker_id)).fetchone()
            return self._row(row)

    def finish(self, job_id: str, worker_id: str, *, answer: str | None = None,
               result: dict | None = None, error: str | None = None) -> bool:
        with self.lock, self.db:
            cur = self.db.execute(
                "UPDATE jobs SET status=?, answer=COALESCE(?, answer), result=?, error=?, finished_at=? "
                "WHERE id=? AND worker_id=? AND status='running'",
                ("error" if error else "done", answer, json.dumps(result, ensure_ascii=False) if result else None,
                 error, time.time(), job_id, worker_id))
            return cur.rowcount == 1

    def heartbeat(self, worker_id: str, status: str, job_id: str | None, version: str | None) -> dict:
        with self.lock, self.db:
            self.db.execute("INSERT INTO workers (id, last_seen, status, job_id, version) VALUES (?,?,?,?,?) "
                            "ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen, status=excluded.status, "
                            "job_id=excluded.job_id, version=excluded.version",
                            (worker_id, time.time(), status, job_id, version))
            cancel = False
            if job_id:
                row = self.db.execute("SELECT status, worker_id FROM jobs WHERE id=?", (job_id,)).fetchone()
                cancel = row is None or row["status"] != "running" or row["worker_id"] != worker_id
            return {"cancel_job": cancel}

    def workers(self) -> list[dict]:
        with self.lock:
            now = time.time()
            rows = self.db.execute("SELECT * FROM workers ORDER BY last_seen DESC").fetchall()
            return [dict(r, online=now - r["last_seen"] < WORKER_ONLINE_S) for r in rows]
