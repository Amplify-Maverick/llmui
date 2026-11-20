#!/usr/bin/env python3
"""
sd-fetch: download Hugging Face model files into sd-server's --model-dir.

Runs on the sd-server host as the same user as sd-server (llama). Python 3
standard library only. LLMUI is the only client; it sends a shared bearer
token, and the port is reachable from that host only (an nft table,
sdfetch-guard.nft, or a socket unit's IPAddressAllow; see README.md).

It also reports the host's GPU stats (GET /v1/gpu) for LLMUI's System page.

Environment (systemd reads /etc/sd/fetch.env):
  SD_FETCH_TOKEN       required, >= 32 chars; clients send "Authorization: Bearer <token>"
  HF_TOKEN             optional; sent to huggingface.co only, for gated repos
  SD_MODEL_DIR         default /var/lib/sd/models (sd-server's --model-dir)
  SD_FETCH_BIND        default 100.118.190.15
  SD_FETCH_PORT        default 8083
  SD_FETCH_RESERVE_GB  default 10; a download must leave this much disk free
  SD_FETCH_GPU         auto (default) | nvidia | amd | none: where GPU stats come from
  SD_FETCH_GPU_NAME    optional; overrides the GPU name in /v1/gpu

Socket activation: if systemd passes a listening socket (LISTEN_FDS=1), it is
used instead of binding SD_FETCH_BIND:SD_FETCH_PORT.

  sd-fetch.py --init-env /etc/sd/fetch.env
      Puts a new random SD_FETCH_TOKEN into that file if its SD_FETCH_TOKEN= line
      is empty (never replaces an existing token) and exits. Prints nothing secret.

API (JSON; every request needs the bearer token):
  GET    /v1/health                    {ok, model_dir, categories, busy}
  GET    /v1/disk                      {free, total, reserve}
  GET    /v1/files                     {files: [{category, name, path, size, mtime, deletable}], disk}
  DELETE /v1/files/<category>/<name>   delete one top-level file in a category folder
  POST   /v1/downloads                 {repo, path, revision, category} -> 202 job
  GET    /v1/downloads/current         most recent job, or null
  GET    /v1/downloads/<id>            job: {id, state, bytes_done, bytes_total, filename, error, ...}
  POST   /v1/downloads/<id>/cancel     cancel; the partial file is deleted
  GET    /v1/gpu                       {source, error, gpus: [{index, name, vendor, temp_c, util_pct,
                                        vram_used_mib, vram_total_mib, power_w}]}; null = unknown

Only https://huggingface.co/<repo>/resolve/<revision>/<path> is fetched
(redirects may go to Hugging Face's CDN hosts, without the HF token). Only
.safetensors and .gguf. One download at a time. Files are written to a hidden
.part file in the category folder, checked against the size and SHA-256 that
Hugging Face reports, then linked into place (never overwriting).
"""

import hashlib
import hmac
import http.client
import json
import os
import re
import secrets
import shutil
import socket
import ssl
import stat
import subprocess
import sys
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "2"

# Category folders sd-server's --model-dir scans for model weights (see
# stable-diffusion.cpp examples/server/api.md, "Slot IDs | Search directories",
# plus loras/). tokenizers/ is left out: it only lists .json files.
CATEGORIES = (
    "checkpoints",
    "diffusion_models",
    "text_encoders",
    "vae",
    "clip_vision",
    "controlnet",
    "ipadapter",
    "motion_modules",
    "photomaker",
    "pulid",
    "loras",
)
EXTENSIONS = (".safetensors", ".gguf")

HF_HOST = "huggingface.co"
# Where huggingface.co/<repo>/resolve/... redirects for LFS/Xet files.
CDN_HOST_SUFFIXES = (".hf.co", ".huggingface.co")

REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,95}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$")
REVISION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")
SEGMENT_BAD_RE = re.compile(r"[\x00-\x1f\x7f\\]")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

GiB = 1024 ** 3
CHUNK = 1024 * 1024
MAX_BODY = 16 * 1024
JOB_HISTORY = 20


class Reject(Exception):
    """A request we refuse; status is the HTTP status to answer with."""

    def __init__(self, message, status=400):
        Exception.__init__(self, message)
        self.status = status


# ----------------------------------------------------------------------
# Validation (pure functions; unit-tested in test_sd_fetch.py)
# ----------------------------------------------------------------------


def validate_repo(repo):
    if not isinstance(repo, str) or not REPO_RE.match(repo) or ".." in repo:
        raise Reject("invalid repo id (expected owner/name)")
    return repo


def validate_revision(revision):
    if revision is None or revision == "":
        return "main"
    if not isinstance(revision, str) or not REVISION_RE.match(revision) or ".." in revision:
        raise Reject("invalid revision (a branch name or commit hash)")
    return revision


def validate_repo_path(path):
    """A file path inside the repo: relative, no '.'/'..' segments, allowed extension."""
    if not isinstance(path, str) or not path or len(path) > 500:
        raise Reject("invalid file path")
    if path.startswith("/") or SEGMENT_BAD_RE.search(path):
        raise Reject("invalid file path")
    segments = path.split("/")
    if any(s in ("", ".", "..") for s in segments):
        raise Reject("invalid file path")
    if not path.lower().endswith(EXTENSIONS):
        raise Reject("only .safetensors and .gguf files can be downloaded")
    return path


def validate_category(category):
    if category not in CATEGORIES:
        raise Reject("category must be one of: " + ", ".join(CATEGORIES))
    return category


def sanitize_filename(name):
    """
    Local file name for a download or delete. Characters outside
    [A-Za-z0-9._+-] become "_"; then anything with "/", "..", a leading dot
    or the wrong extension is rejected.
    """
    if not isinstance(name, str):
        raise Reject("invalid file name")
    clean = re.sub(r"[^A-Za-z0-9._+-]", "_", name)
    if (
        not clean
        or len(clean) > 200
        or "/" in clean
        or ".." in clean
        or clean.startswith(".")
        or not clean.lower().endswith(EXTENSIONS)
    ):
        raise Reject("invalid file name: %r" % name)
    return clean


def resolve_url(repo, revision, path):
    """The only URL a download may start from."""
    quoted = "/".join(urllib.parse.quote(s, safe="") for s in path.split("/"))
    return "https://%s/%s/resolve/%s/%s" % (
        HF_HOST,
        repo,
        urllib.parse.quote(revision, safe=""),
        quoted,
    )


def redirect_allowed(url):
    u = urllib.parse.urlsplit(url)
    host = (u.hostname or "").lower()
    return u.scheme == "https" and (host == HF_HOST or host.endswith(CDN_HOST_SUFFIXES))


def fits(free, reserve, needed):
    return free - reserve >= needed


# ----------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------


class Config(object):
    def __init__(self, env):
        self.token = env.get("SD_FETCH_TOKEN", "")
        self.hf_token = env.get("HF_TOKEN", "").strip()
        self.model_dir = os.path.realpath(env.get("SD_MODEL_DIR", "/var/lib/sd/models"))
        self.bind = env.get("SD_FETCH_BIND", "100.118.190.15")
        self.port = int(env.get("SD_FETCH_PORT", "8083"))
        self.reserve = int(float(env.get("SD_FETCH_RESERVE_GB", "10")) * GiB)
        self.gpu = env.get("SD_FETCH_GPU", "auto").strip().lower() or "auto"
        self.gpu_name = env.get("SD_FETCH_GPU_NAME", "").strip()

    def check(self):
        if len(self.token) < 32:
            raise SystemExit("SD_FETCH_TOKEN must be set (at least 32 characters)")
        if not os.path.isdir(self.model_dir):
            raise SystemExit("SD_MODEL_DIR %s is not a directory" % self.model_dir)


# ----------------------------------------------------------------------
# Downloads
# ----------------------------------------------------------------------


class Cancelled(Exception):
    pass


class Job(object):
    def __init__(self, repo, path, revision, category, filename):
        self.id = secrets.token_hex(8)
        self.repo = repo
        self.path = path
        self.revision = revision
        self.category = category
        self.filename = filename
        self.state = "queued"  # queued | downloading | verifying | completed | failed | cancelled
        self.bytes_done = 0
        self.bytes_total = None
        self.resumed_from = 0
        self.sha256 = None
        self.commit = None
        self.error = None
        self.part_path = None
        self.created = time.time()
        self.finished = None
        self.cancel_event = threading.Event()

    @property
    def active(self):
        return self.state in ("queued", "downloading", "verifying")

    def to_dict(self):
        return {
            "id": self.id,
            "repo": self.repo,
            "path": self.path,
            "revision": self.revision,
            "commit": self.commit,
            "category": self.category,
            "filename": self.filename,
            "file_id": "%s/%s" % (self.category, self.filename),
            "state": self.state,
            "bytes_done": self.bytes_done,
            "bytes_total": self.bytes_total,
            "resumed_from": self.resumed_from,
            "sha256": self.sha256,
            "error": self.error,
            "created": self.created,
            "finished": self.finished,
        }


def disk_usage(cfg):
    du = shutil.disk_usage(cfg.model_dir)
    return {"free": du.free, "total": du.total, "reserve": cfg.reserve}


def open_url(url, headers, timeout=60):
    """GET without following redirects. Returns (conn, response)."""
    u = urllib.parse.urlsplit(url)
    conn = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=timeout,
                                       context=ssl.create_default_context())
    target = u.path + ("?" + u.query if u.query else "")
    conn.request("GET", target, headers=headers)
    return conn, conn.getresponse()


def hf_error(resp):
    body = resp.read(2000).decode("utf-8", "replace")
    msg = resp.getheader("X-Error-Message") or ""
    code = resp.getheader("X-Error-Code") or ""
    if not msg:
        try:
            msg = json.loads(body).get("error", "")
        except ValueError:
            msg = body.strip()[:300]
    if resp.status in (401, 403) or code in ("GatedRepo", "RepoNotFound"):
        hint = " (gated or private repo: accept its terms on huggingface.co and put HF_TOKEN in /etc/sd/fetch.env)"
        if code == "RepoNotFound" or resp.status == 404:
            hint = ""
        return "Hugging Face %d %s: %s%s" % (resp.status, code, msg or "access denied", hint)
    return "Hugging Face %d %s: %s" % (resp.status, code, msg or resp.reason)


class Downloader(object):
    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.jobs = []  # newest last

    # -- job table --

    def get(self, job_id):
        with self.lock:
            for j in self.jobs:
                if j.id == job_id:
                    return j
        return None

    def current(self):
        with self.lock:
            return self.jobs[-1] if self.jobs else None

    def busy(self):
        with self.lock:
            return any(j.active for j in self.jobs)

    def start(self, body):
        repo = validate_repo(body.get("repo"))
        revision = validate_revision(body.get("revision"))
        path = validate_repo_path(body.get("path"))
        category = validate_category(body.get("category"))
        filename = sanitize_filename(path.rsplit("/", 1)[-1])
        target = os.path.join(self.cfg.model_dir, category, filename)
        if os.path.lexists(target):
            raise Reject("%s/%s already exists; delete it first" % (category, filename), 409)
        with self.lock:
            if any(j.active for j in self.jobs):
                raise Reject("another download is running; one at a time", 409)
            job = Job(repo, path, revision, category, filename)
            self.jobs.append(job)
            del self.jobs[:-JOB_HISTORY]
        t = threading.Thread(target=self._run, args=(job,), name="download-" + job.id, daemon=True)
        t.start()
        return job

    def cancel(self, job_id):
        job = self.get(job_id)
        if job is None:
            raise Reject("no such download", 404)
        job.cancel_event.set()
        return job

    # -- worker --

    def _run(self, job):
        try:
            self._download(job)
            job.state = "completed"
            log("download %s: completed %s/%s (%d bytes)" % (job.id, job.category, job.filename, job.bytes_done))
        except Cancelled:
            job.state = "cancelled"
            if job.part_path:
                _unlink_quiet(job.part_path)
            log("download %s: cancelled" % job.id)
        except Reject as e:
            job.state = "failed"
            job.error = str(e)
            log("download %s: refused: %s" % (job.id, e))
        except Exception as e:  # network errors etc.; the .part is kept for a retry to resume
            job.state = "failed"
            job.error = "%s: %s" % (type(e).__name__, e)
            log("download %s: failed: %s" % (job.id, job.error))
        finally:
            job.finished = time.time()

    def _check_cancel(self, job):
        if job.cancel_event.is_set():
            raise Cancelled()

    def _download(self, job):
        cfg = self.cfg
        cat_dir = os.path.join(cfg.model_dir, job.category)
        os.makedirs(cat_dir, mode=0o755, exist_ok=True)
        if os.path.realpath(cat_dir) != os.path.join(cfg.model_dir, job.category):
            raise Reject("category folder %s resolves outside the model dir" % job.category)
        target = os.path.join(cat_dir, job.filename)

        # 1. Ask huggingface.co. LFS/Xet files answer 302 with the size and
        #    SHA-256 in X-Linked-Size / X-Linked-Etag; small files answer 200.
        url = resolve_url(job.repo, job.revision, job.path)
        headers = {"User-Agent": "sd-fetch/" + VERSION, "Accept-Encoding": "identity"}
        if cfg.hf_token:
            headers["Authorization"] = "Bearer " + cfg.hf_token
        conn, resp = open_url(url, headers)
        expected_sha = None
        resume_hasher = None  # SHA-256 of an existing .part, computed before reconnecting
        hops = 0
        while resp.status in (301, 302, 303, 307, 308):
            hops += 1
            if hops > 5:
                raise Reject("too many redirects")
            job.commit = job.commit or resp.getheader("X-Repo-Commit")
            size = resp.getheader("X-Linked-Size")
            if size and size.isdigit():
                job.bytes_total = int(size)
            etag = (resp.getheader("X-Linked-Etag") or "").strip('"').lower()
            if SHA256_RE.match(etag):
                expected_sha = etag
            location = resp.getheader("Location")
            resp.read()
            conn.close()
            if not location:
                raise Reject("redirect without Location")
            next_url = urllib.parse.urljoin(url, location)
            if not redirect_allowed(next_url):
                raise Reject("refusing redirect to %s" % urllib.parse.urlsplit(next_url).hostname)
            url = next_url
            if urllib.parse.urlsplit(url).hostname != HF_HOST:
                headers.pop("Authorization", None)  # the HF token never leaves huggingface.co
            # Resume a previous attempt at the same file, if its .part is still here.
            part = job.part_path = self._part_path(cat_dir, job, expected_sha)
            have = os.path.getsize(part) if os.path.exists(part) else 0
            if job.bytes_total and 0 < have < job.bytes_total:
                headers["Range"] = "bytes=%d-" % have
                if resume_hasher is None:
                    resume_hasher = self._hash_file(job, part)
            else:
                headers.pop("Range", None)
            self._check_space(job, have)
            self._check_cancel(job)
            conn, resp = open_url(url, headers)

        if resp.status not in (200, 206):
            msg = hf_error(resp)
            conn.close()
            raise Reject(msg)
        job.commit = job.commit or resp.getheader("X-Repo-Commit")
        if job.bytes_total is None:
            length = resp.getheader("Content-Length")
            job.bytes_total = int(length) if length and length.isdigit() else None
        part = job.part_path = self._part_path(cat_dir, job, expected_sha)
        if resp.status == 206 and resume_hasher is not None:
            have = os.path.getsize(part)
            mode = "ab"
            hasher = resume_hasher
        else:
            if resp.status == 206:  # a range we didn't ask for
                conn.close()
                raise Reject("unexpected partial response")
            have = 0
            mode = "wb"
            hasher = hashlib.sha256()
            self._check_space(job, 0)
        job.resumed_from = have
        job.sha256 = expected_sha

        # 2. Stream to the .part file, hashing as we go.
        job.bytes_done = have
        job.state = "downloading"
        log("download %s: %s/%s@%s -> %s/%s (%s bytes%s)" % (
            job.id, job.repo, job.path, job.revision, job.category, job.filename,
            job.bytes_total, ", resuming at %d" % have if have else ""))
        try:
            with open(part, mode) as f:
                while True:
                    self._check_cancel(job)
                    block = resp.read(CHUNK)
                    if not block:
                        break
                    f.write(block)
                    hasher.update(block)
                    job.bytes_done += len(block)
                f.flush()
                os.fsync(f.fileno())
        finally:
            conn.close()

        # 3. Verify and move into place without overwriting anything.
        job.state = "verifying"
        size = os.path.getsize(part)
        if job.bytes_total is not None and size != job.bytes_total:
            raise IOError("incomplete download: %d of %d bytes (retry to resume)" % (size, job.bytes_total))
        if expected_sha and hasher.hexdigest() != expected_sha:
            _unlink_quiet(part)
            raise Reject("SHA-256 mismatch (expected %s, got %s); partial file removed" % (expected_sha, hasher.hexdigest()))
        job.sha256 = hasher.hexdigest()
        try:
            os.link(part, target)
        except FileExistsError:
            raise Reject("%s/%s appeared while downloading; not overwriting" % (job.category, job.filename), 409)
        os.unlink(part)
        job.part_path = None
        os.chmod(target, 0o644)

    def _hash_file(self, job, path):
        hasher = hashlib.sha256()
        with open(path, "rb") as f:
            for block in iter(lambda: f.read(CHUNK), b""):
                hasher.update(block)
                self._check_cancel(job)
        return hasher

    def _part_path(self, cat_dir, job, sha):
        key = (sha or hashlib.sha256(("%s@%s:%s" % (job.repo, job.revision, job.path)).encode()).hexdigest())[:16]
        return os.path.join(cat_dir, ".%s.%s.part" % (job.filename, key))

    def _check_space(self, job, have):
        if job.bytes_total is None:
            return
        du = shutil.disk_usage(self.cfg.model_dir)
        needed = job.bytes_total - have
        if not fits(du.free, self.cfg.reserve, needed):
            raise Reject(
                "not enough disk space: need %.1f GiB, %.1f GiB free, %.0f GiB must stay free"
                % (needed / GiB, du.free / GiB, self.cfg.reserve / GiB),
                507,
            )


def _unlink_quiet(path):
    try:
        os.unlink(path)
    except OSError:
        pass


# ----------------------------------------------------------------------
# Installed files
# ----------------------------------------------------------------------


def list_files(cfg):
    files = []
    for category in CATEGORIES:
        root = os.path.join(cfg.model_dir, category)
        if not os.path.isdir(root):
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
            for name in sorted(filenames):
                if name.startswith(".") or not name.lower().endswith(EXTENSIONS):
                    continue
                full = os.path.join(dirpath, name)
                try:
                    st = os.lstat(full)
                except OSError:
                    continue
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                top_level = "/" not in rel
                files.append({
                    "category": category,
                    "name": name,
                    "path": "%s/%s" % (category, rel),
                    "size": st.st_size,
                    "mtime": st.st_mtime,
                    "symlink": os.path.islink(full),
                    # Only plain top-level files can be deleted through the API.
                    "deletable": top_level and not os.path.islink(full),
                })
    return files


def delete_file(cfg, category, name, downloader):
    validate_category(category)
    clean = sanitize_filename(name)
    if clean != name:
        raise Reject("invalid file name: %r" % name)
    cat_dir = os.path.join(cfg.model_dir, category)
    if os.path.realpath(cat_dir) != cat_dir:
        raise Reject("category folder %s resolves outside the model dir" % category)
    path = os.path.join(cat_dir, name)
    cur = downloader.current()
    if cur and cur.active and cur.category == category and cur.filename == name:
        raise Reject("that file is downloading; cancel it first", 409)
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        raise Reject("%s/%s not found" % (category, name), 404)
    if not stat.S_ISREG(st.st_mode):
        raise Reject("%s/%s is not a regular file" % (category, name), 409)
    os.unlink(path)
    log("deleted %s/%s (%d bytes)" % (category, name, st.st_size))
    return {"deleted": "%s/%s" % (category, name), "size": st.st_size}


# ----------------------------------------------------------------------
# GPU stats (GET /v1/gpu)
# ----------------------------------------------------------------------

MiB = 1024 ** 2
GPU_CACHE_SECONDS = 1.0
NVIDIA_QUERY = "index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw"
# PCI device ids -> marketing names, for amdgpu cards without product_name.
AMD_NAMES = {
    "1002:67DF": "Radeon RX 470/480/570/580",
    "1002:6FDF": "Radeon RX 580 2048SP",
    "1002:67EF": "Radeon RX 460/560",
    "1002:731F": "Radeon RX 5600/5700",
    "1002:73BF": "Radeon RX 6800/6900",
    "1002:73DF": "Radeon RX 6700",
    "1002:73FF": "Radeon RX 6600",
    "1002:744C": "Radeon RX 7900",
}


def _gpu(index, name, vendor, temp_c=None, util_pct=None, used=None, total=None, power_w=None):
    return {
        "index": index,
        "name": name,
        "vendor": vendor,
        "temp_c": temp_c,
        "util_pct": util_pct,
        "vram_used_mib": used,
        "vram_total_mib": total,
        "power_w": power_w,
    }


def _number(text, scale=1.0, digits=1):
    """float(text) / scale rounded, or None for '', '[N/A]', '[Not Supported]', junk."""
    try:
        v = float(str(text).strip())
    except (TypeError, ValueError):
        return None
    if v != v:  # NaN
        return None
    v = v / scale
    return int(v) if digits == 0 else round(v, digits)


def parse_nvidia_csv(text):
    """Rows of `nvidia-smi --query-gpu=NVIDIA_QUERY --format=csv,noheader,nounits`."""
    gpus = []
    for line in text.splitlines():
        if not line.strip():
            continue
        cols = [c.strip() for c in line.split(",")]
        if len(cols) < 7:
            continue
        index = _number(cols[0], digits=0)
        gpus.append(_gpu(
            index if index is not None else len(gpus),
            cols[1] or None,
            "nvidia",
            temp_c=_number(cols[2], digits=0),
            util_pct=_number(cols[3], digits=0),
            used=_number(cols[4], digits=0),
            total=_number(cols[5], digits=0),
            power_w=_number(cols[6]),
        ))
    return gpus


def nvidia_smi_path():
    return shutil.which("nvidia-smi") or next(
        (p for p in ("/usr/bin/nvidia-smi", "/opt/bin/nvidia-smi") if os.access(p, os.X_OK)), None)


def nvidia_gpus(exe):
    out = subprocess.run(
        [exe, "--query-gpu=" + NVIDIA_QUERY, "--format=csv,noheader,nounits"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False,
    )
    if out.returncode != 0:
        msg = out.stderr.decode("utf-8", "replace").strip() or out.stdout.decode("utf-8", "replace").strip()
        raise RuntimeError("nvidia-smi exited %d: %s" % (out.returncode, msg[:200]))
    return parse_nvidia_csv(out.stdout.decode("utf-8", "replace"))


def _read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except (OSError, ValueError):
        return None


def amd_gpus(drm_root="/sys/class/drm"):
    """amdgpu cards from sysfs: cardN/device/{mem_info_vram_*, gpu_busy_percent, hwmon/*}."""
    gpus = []
    try:
        cards = sorted((c for c in os.listdir(drm_root) if re.match(r"^card\d+$", c)), key=lambda c: int(c[4:]))
    except OSError:
        return gpus
    for card in cards:
        dev = os.path.join(drm_root, card, "device")
        total = _read(os.path.join(dev, "mem_info_vram_total"))
        if total is None:
            continue  # not an amdgpu device (or no VRAM info)
        hwmon = None
        try:
            hw = sorted(os.listdir(os.path.join(dev, "hwmon")))
            hwmon = os.path.join(dev, "hwmon", hw[0]) if hw else None
        except OSError:
            pass
        power = None
        if hwmon:
            for name in ("power1_average", "power1_input"):
                power = _number(_read(os.path.join(hwmon, name)), scale=1e6)
                if power is not None:
                    break
        name = _read(os.path.join(dev, "product_name"))
        if not name:
            pci = None
            for line in (_read(os.path.join(dev, "uevent")) or "").splitlines():
                if line.startswith("PCI_ID="):
                    pci = line[7:].upper()
            name = AMD_NAMES.get(pci, "AMD GPU %s" % pci if pci else "AMD GPU")
        gpus.append(_gpu(
            int(card[4:]),
            name,
            "amd",
            temp_c=_number(_read(os.path.join(hwmon, "temp1_input")) if hwmon else None, scale=1000, digits=0),
            util_pct=_number(_read(os.path.join(dev, "gpu_busy_percent")), digits=0),
            used=_number(_read(os.path.join(dev, "mem_info_vram_used")), scale=MiB, digits=0),
            total=_number(total, scale=MiB, digits=0),
            power_w=power,
        ))
    return gpus


class GpuStats(object):
    """GET /v1/gpu, cached for GPU_CACHE_SECONDS so pollers can't fork-storm nvidia-smi."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.lock = threading.Lock()
        self.at = 0.0
        self.data = None

    def _collect(self):
        mode = self.cfg.gpu
        if mode == "none":
            return {"source": None, "error": "GPU stats disabled (SD_FETCH_GPU=none)", "gpus": []}
        errors = []
        if mode in ("auto", "nvidia"):
            exe = nvidia_smi_path()
            if exe:
                try:
                    gpus = nvidia_gpus(exe)
                    if gpus:
                        return {"source": "nvidia-smi", "error": None, "gpus": gpus}
                    errors.append("nvidia-smi reported no GPUs")
                except (OSError, RuntimeError, subprocess.SubprocessError) as e:
                    errors.append(str(e))
            elif mode == "nvidia":
                errors.append("nvidia-smi not found")
        if mode in ("auto", "amd"):
            gpus = amd_gpus()
            if gpus:
                return {"source": "amdgpu-sysfs", "error": None, "gpus": gpus}
            if mode == "amd":
                errors.append("no amdgpu device in /sys/class/drm")
        return {"source": None, "error": "; ".join(errors) or "no supported GPU found", "gpus": []}

    def get(self):
        with self.lock:
            if self.data is None or time.time() - self.at >= GPU_CACHE_SECONDS:
                try:
                    data = self._collect()
                except Exception as e:  # never let stats break the helper
                    data = {"source": None, "error": "%s: %s" % (type(e).__name__, e), "gpus": []}
                if self.cfg.gpu_name:
                    for g in data["gpus"]:
                        g["name"] = self.cfg.gpu_name
                self.data, self.at = data, time.time()
            return self.data


# ----------------------------------------------------------------------
# --init-env
# ----------------------------------------------------------------------

TOKEN_LINE_RE = re.compile(r"^SD_FETCH_TOKEN=[ \t]*$", re.M)


def init_env_token(path):
    """Fill an empty SD_FETCH_TOKEN= line with a new token. Returns True if written."""
    with open(path) as f:
        text = f.read()
    if not TOKEN_LINE_RE.search(text):
        return False
    text = TOKEN_LINE_RE.sub("SD_FETCH_TOKEN=" + secrets.token_hex(32), text, count=1)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    st = os.stat(path)
    os.chown(tmp, st.st_uid, st.st_gid)
    os.chmod(tmp, stat.S_IMODE(st.st_mode))
    os.replace(tmp, path)
    return True


# ----------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def make_handler(cfg, downloader, gpu_stats=None):
    gpu_stats = gpu_stats or GpuStats(cfg)
    expected = ("Bearer " + cfg.token).encode()

    class Handler(BaseHTTPRequestHandler):
        server_version = "sd-fetch/" + VERSION
        sys_version = ""
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            log("%s %s" % (self.client_address[0], fmt % args))

        def _send(self, status, obj):
            body = json.dumps(obj).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self):
            got = (self.headers.get("Authorization") or "").encode()
            return hmac.compare_digest(got, expected)

        def _read_raw(self):
            # Read (or refuse) the whole body before answering, so an early
            # error never leaves unread bytes on a kept-alive connection.
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY:
                self.close_connection = True
                return None
            return self.rfile.read(length) if length else b""

        def _body(self):
            raw = self._raw or b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except ValueError:
                raise Reject("body must be JSON")
            if not isinstance(body, dict):
                raise Reject("body must be a JSON object")
            return body

        def _dispatch(self, method):
            self._raw = self._read_raw()
            if self._raw is None:
                self._send(413, {"error": "request body too large"})
                return
            if not self._authorized():
                self._send(401, {"error": "unauthorized"})
                return
            parts = [urllib.parse.unquote(p) for p in urllib.parse.urlsplit(self.path).path.split("/") if p]
            try:
                status, obj = self._route(method, parts)
            except Reject as e:
                status, obj = e.status, {"error": str(e)}
            except Exception as e:
                log("error handling %s %s: %r" % (method, self.path, e))
                status, obj = 500, {"error": "internal error: %s" % e}
            self._send(status, obj)

        def _route(self, method, p):
            if not p or p[0] != "v1":
                raise Reject("not found", 404)
            p = p[1:]
            if method == "GET" and p == ["health"]:
                return 200, {"ok": True, "version": VERSION, "model_dir": cfg.model_dir,
                             "categories": list(CATEGORIES), "extensions": list(EXTENSIONS),
                             "busy": downloader.busy(), "hf_token": bool(cfg.hf_token)}
            if method == "GET" and p == ["disk"]:
                return 200, disk_usage(cfg)
            if method == "GET" and p == ["files"]:
                return 200, {"files": list_files(cfg), "disk": disk_usage(cfg)}
            if method == "DELETE" and len(p) == 3 and p[0] == "files":
                return 200, delete_file(cfg, p[1], p[2], downloader)
            if method == "GET" and p == ["gpu"]:
                return 200, gpu_stats.get()
            if method == "POST" and p == ["downloads"]:
                return 202, downloader.start(self._body()).to_dict()
            if method == "GET" and p == ["downloads", "current"]:
                cur = downloader.current()
                return 200, {"job": cur.to_dict() if cur else None}
            if method == "GET" and len(p) == 2 and p[0] == "downloads":
                job = downloader.get(p[1])
                if job is None:
                    raise Reject("no such download", 404)
                return 200, job.to_dict()
            if method == "POST" and len(p) == 3 and p[0] == "downloads" and p[2] == "cancel":
                return 200, downloader.cancel(p[1]).to_dict()
            raise Reject("not found", 404)

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_DELETE(self):
            self._dispatch("DELETE")

    return Handler


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self):
        # IP_FREEBIND: start even if the Tailscale address isn't up yet.
        try:
            self.socket.setsockopt(socket.SOL_IP, getattr(socket, "IP_FREEBIND", 15), 1)
        except OSError:
            pass
        ThreadingHTTPServer.server_bind(self)


SD_LISTEN_FDS_START = 3


def systemd_socket():
    """The listening socket systemd passed us (socket activation), or None."""
    if os.environ.get("LISTEN_PID") != str(os.getpid()):
        return None
    if os.environ.get("LISTEN_FDS") != "1":
        raise SystemExit("socket activation: expected exactly one socket, got LISTEN_FDS=%r"
                         % os.environ.get("LISTEN_FDS"))
    for k in ("LISTEN_PID", "LISTEN_FDS", "LISTEN_FDNAMES"):
        os.environ.pop(k, None)
    return socket.socket(fileno=SD_LISTEN_FDS_START)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ["--init-env"] and len(argv) == 2:
        wrote = init_env_token(argv[1])
        print("SD_FETCH_TOKEN generated in %s" % argv[1] if wrote else
              "SD_FETCH_TOKEN already set in %s; left unchanged" % argv[1])
        return
    if argv:
        raise SystemExit("usage: sd-fetch.py [--init-env /etc/sd/fetch.env]")
    cfg = Config(os.environ)
    cfg.check()
    os.umask(0o022)
    downloader = Downloader(cfg)
    handler = make_handler(cfg, downloader)
    sock = systemd_socket()
    if sock is not None:
        httpd = Server(sock.getsockname()[:2], handler, bind_and_activate=False)
        httpd.socket.close()
        httpd.socket = sock
        httpd.server_name, httpd.server_port = sock.getsockname()[:2]
        where = "%s:%d (socket-activated)" % sock.getsockname()[:2]
    else:
        httpd = Server((cfg.bind, cfg.port), handler)
        where = "%s:%d" % (cfg.bind, cfg.port)
    log("sd-fetch %s listening on %s, model dir %s, reserve %.0f GiB, HF token %s, GPU stats %s"
        % (VERSION, where, cfg.model_dir, cfg.reserve / GiB, "set" if cfg.hf_token else "not set", cfg.gpu))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
