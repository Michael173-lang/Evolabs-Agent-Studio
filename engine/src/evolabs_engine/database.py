from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  progress REAL NOT NULL DEFAULT 0,
  pause_requested INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL,
  started_at REAL,
  finished_at REAL,
  error_json TEXT
);

CREATE TABLE IF NOT EXISTS job_nodes (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  shot_id TEXT,
  node_type TEXT NOT NULL,
  node_key TEXT NOT NULL,
  resource_class TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  parameters_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  checkpoint_json TEXT,
  output_artifact_id TEXT,
  created_at REAL NOT NULL,
  started_at REAL,
  finished_at REAL
);

CREATE INDEX IF NOT EXISTS idx_job_nodes_job_state
ON job_nodes(job_id, state, resource_class);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS node_cache (
  node_key TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  last_used_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at REAL NOT NULL
);
"""


class EngineDatabase:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA synchronous=NORMAL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._connection.execute("PRAGMA busy_timeout=5000")
        self._connection.executescript(SCHEMA)
        self._connection.commit()
        self.recover_interrupted_jobs()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            try:
                yield self._connection
                self._connection.commit()
            except Exception:
                self._connection.rollback()
                raise

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def recover_interrupted_jobs(self) -> None:
        """A process crash only requeues the node that had not committed output."""
        with self.transaction() as connection:
            connection.execute(
                "UPDATE job_nodes SET state='QUEUED', started_at=NULL "
                "WHERE state IN ('RUNNING', 'PAUSING')"
            )
            connection.execute(
                "UPDATE jobs SET state='QUEUED' WHERE state IN ('RUNNING', 'PAUSING')"
            )

    def create_job(self, project_id: str, nodes: list[dict[str, Any]], priority: int = 100) -> str:
        job_id = f"job_{uuid.uuid4()}"
        now = time.time()
        with self.transaction() as connection:
            connection.execute(
                "INSERT INTO jobs(id, project_id, state, priority, created_at) VALUES(?,?,?,?,?)",
                (job_id, project_id, "QUEUED", priority, now),
            )
            for node in nodes:
                connection.execute(
                    """
                    INSERT INTO job_nodes(
                      id, job_id, shot_id, node_type, node_key, resource_class,
                      state, parameters_json, dependencies_json, created_at
                    ) VALUES(?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        node["id"], job_id, node.get("shot_id"), node["node_type"],
                        node["node_key"], node["resource_class"], "QUEUED",
                        json.dumps(node.get("parameters", {}), ensure_ascii=False),
                        json.dumps(node.get("dependencies", [])), now,
                    ),
                )
            self._append_event(connection, job_id, "job.created", {"node_count": len(nodes)})
        return job_id

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if job is None:
                return None
            nodes = self._connection.execute(
                "SELECT * FROM job_nodes WHERE job_id=? ORDER BY created_at, id", (job_id,)
            ).fetchall()
        return {"job": dict(job), "nodes": [dict(node) for node in nodes]}

    def request_action(self, job_id: str, action: str) -> bool:
        fields = {
            "pause": ("pause_requested", 1, "job.pause_requested"),
            "resume": ("pause_requested", 0, "job.resume_requested"),
            "cancel": ("cancel_requested", 1, "job.cancel_requested"),
        }
        if action not in fields:
            raise ValueError(f"unknown job action: {action}")
        field, value, event = fields[action]
        with self.transaction() as connection:
            cursor = connection.execute(f"UPDATE jobs SET {field}=? WHERE id=?", (value, job_id))
            if cursor.rowcount:
                self._append_event(connection, job_id, event, {})
        return bool(cursor.rowcount)

    @staticmethod
    def _append_event(
        connection: sqlite3.Connection, job_id: str | None, event_type: str, payload: dict[str, Any]
    ) -> None:
        connection.execute(
            "INSERT INTO event_log(job_id, event_type, payload_json, created_at) VALUES(?,?,?,?)",
            (job_id, event_type, json.dumps(payload, ensure_ascii=False), time.time()),
        )
