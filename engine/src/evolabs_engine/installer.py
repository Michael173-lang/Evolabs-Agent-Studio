from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import ssl
import stat
import tempfile
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable
from urllib.parse import urlparse


PACK_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_FILES = 32
MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024
MAX_EXPANDED_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 4096
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
INSTALL_DISK_HEADROOM_BYTES = 512 * 1024 * 1024
STALE_INSTALL_WORK_SECONDS = 24 * 60 * 60
STALE_PACK_WORK_PATTERN = re.compile(
    r"^\.[0-9A-Za-z][0-9A-Za-z._+-]{0,63}\.(?:staging|invalid)-[0-9a-f]{32}$"
)
WINDOWS_RESERVED_STEMS = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}


class InstallError(RuntimeError):
    def __init__(self, code: str, message: str, detail: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


class InstallCanceled(Exception):
    pass


class _HttpsOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Reject a downgrade (or credential injection) before following any hop."""

    def redirect_request(
        self,
        request: urllib.request.Request,
        file_pointer: Any,
        code: int,
        message: str,
        headers: Any,
        new_url: str,
    ) -> urllib.request.Request | None:
        parsed = urlparse(new_url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise InstallError(
                "DOWNLOAD_REDIRECT",
                "AI 模型下載被重新導向到不安全的來源。",
                new_url,
            )
        return super().redirect_request(request, file_pointer, code, message, headers, new_url)


@dataclass(frozen=True)
class PackFile:
    id: str
    url: str
    size: int
    sha256: str
    kind: str
    destination: PurePosixPath
    role: str | None
    max_expanded_bytes: int | None


@dataclass(frozen=True)
class PackManifest:
    id: str
    version: str
    name: str
    capabilities: tuple[str, ...]
    files: tuple[PackFile, ...]
    activation: dict[str, Any]
    source: dict[str, Any]


def _atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _read_json(path: Path, maximum_bytes: int = MAX_MANIFEST_BYTES) -> Any:
    try:
        size = path.stat().st_size
    except OSError as error:
        raise InstallError("MANIFEST_MISSING", "找不到模型安裝清單。", str(error)) from error
    if size <= 0 or size > maximum_bytes:
        raise InstallError("MANIFEST_SIZE", "模型安裝清單大小不正確。", f"{path}: {size} bytes")
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise InstallError("MANIFEST_INVALID", "模型安裝清單不是有效的 JSON。", str(error)) from error


def _safe_relative_path(raw: Any, label: str) -> PurePosixPath:
    if (
        not isinstance(raw, str)
        or not raw.strip()
        or "\\" in raw
        or ":" in raw
        or "\x00" in raw
    ):
        raise InstallError("MANIFEST_INVALID", f"{label} 不是安全的相對路徑。")
    value = PurePosixPath(raw)
    unsafe_component = any(
        part in {"", ".", ".."}
        or part.rstrip(" .") != part
        or part.split(".", 1)[0].upper() in WINDOWS_RESERVED_STEMS
        for part in value.parts
    )
    if value.is_absolute() or unsafe_component:
        raise InstallError("MANIFEST_INVALID", f"{label} 不是安全的相對路徑。", raw)
    return value


def _safe_destination(root: Path, relative: PurePosixPath, label: str) -> Path:
    root_resolved = root.resolve()
    candidate = root.joinpath(*relative.parts)
    try:
        candidate.resolve().relative_to(root_resolved)
    except (OSError, ValueError) as error:
        raise InstallError("PATH_UNSAFE", f"{label} 超出模型安裝目錄。", str(relative)) from error
    return candidate


def load_manifest(path: Path) -> PackManifest:
    raw = _read_json(path)
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
        raise InstallError("MANIFEST_VERSION", "模型安裝清單版本不受支援。")
    pack_id = str(raw.get("id") or "")
    version = str(raw.get("version") or "")
    name = str(raw.get("name") or raw.get("description") or pack_id).strip()
    if not PACK_ID_PATTERN.fullmatch(pack_id):
        raise InstallError("MANIFEST_INVALID", "模型包 ID 不合法。", pack_id)
    if not VERSION_PATTERN.fullmatch(version):
        raise InstallError("MANIFEST_INVALID", "模型包版本不合法。", version)
    if not name or len(name) > 128:
        raise InstallError("MANIFEST_INVALID", "模型包名稱不合法。")

    raw_capabilities = raw.get("capabilities", [])
    if not isinstance(raw_capabilities, list) or any(
        not isinstance(value, str) or not PACK_ID_PATTERN.fullmatch(value.replace("_", "-"))
        for value in raw_capabilities
    ):
        raise InstallError("MANIFEST_INVALID", "模型包能力清單不合法。")
    capabilities = tuple(dict.fromkeys(raw_capabilities))

    raw_files = raw.get("files")
    if not isinstance(raw_files, list) or not raw_files or len(raw_files) > MAX_FILES:
        raise InstallError("MANIFEST_INVALID", "模型包檔案清單為空或數量超過限制。")
    files: list[PackFile] = []
    file_ids: set[str] = set()
    destinations: set[PurePosixPath] = set()
    for index, item in enumerate(raw_files):
        if not isinstance(item, dict):
            raise InstallError("MANIFEST_INVALID", f"第 {index + 1} 個模型檔案設定不合法。")
        file_id = str(item.get("id") or "")
        if not PACK_ID_PATTERN.fullmatch(file_id) or file_id in file_ids:
            raise InstallError("MANIFEST_INVALID", "模型檔案 ID 缺失、重複或不合法。", file_id)
        file_ids.add(file_id)
        source = item.get("source") if isinstance(item.get("source"), dict) else {}
        url = str(item.get("url") or source.get("url") or "")
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise InstallError("MANIFEST_INVALID", "模型檔案只允許使用 HTTPS 來源。", url)
        try:
            size = int(item.get("size", item.get("sizeBytes")))
        except (TypeError, ValueError) as error:
            raise InstallError("MANIFEST_INVALID", "模型檔案大小缺失。", file_id) from error
        if size <= 0 or size > MAX_FILE_BYTES:
            raise InstallError("MANIFEST_INVALID", "模型檔案大小超過安全限制。", f"{file_id}: {size}")
        sha256 = str(item.get("sha256") or "").lower()
        if not SHA256_PATTERN.fullmatch(sha256):
            raise InstallError("MANIFEST_INVALID", "模型檔案 SHA-256 缺失或不合法。", file_id)
        install_settings = item.get("install") if isinstance(item.get("install"), dict) else {}
        raw_kind = item.get("kind") or install_settings.get("mode") or "file"
        kind = {"extract-zip": "zip"}.get(str(raw_kind), str(raw_kind))
        if kind not in {"file", "zip"}:
            raise InstallError("MANIFEST_INVALID", "模型檔案類型不受支援。", kind)
        max_expanded_bytes: int | None = None
        if kind == "zip":
            try:
                configured_limit = int(install_settings.get("maxExtractedBytes", MAX_EXPANDED_ARCHIVE_BYTES))
            except (TypeError, ValueError) as error:
                raise InstallError("MANIFEST_INVALID", "模型壓縮檔展開上限不合法。", file_id) from error
            if configured_limit <= 0 or configured_limit > MAX_EXPANDED_ARCHIVE_BYTES:
                raise InstallError("MANIFEST_INVALID", "模型壓縮檔展開上限超出安全範圍。", file_id)
            max_expanded_bytes = configured_limit
        destination = _safe_relative_path(
            item.get("destination", install_settings.get("destination")),
            f"{file_id}.destination",
        )
        if destination in destinations:
            raise InstallError("MANIFEST_INVALID", "模型檔案目的地重複。", str(destination))
        destinations.add(destination)
        role = item.get("role")
        if role is not None and (not isinstance(role, str) or not PACK_ID_PATTERN.fullmatch(role.replace("_", "-"))):
            raise InstallError("MANIFEST_INVALID", "模型檔案角色不合法。", str(role))
        files.append(PackFile(file_id, url, size, sha256, kind, destination, role, max_expanded_bytes))

    activation = raw.get("activation", {})
    if not isinstance(activation, dict):
        raise InstallError("MANIFEST_INVALID", "模型包啟用設定不合法。")
    return PackManifest(pack_id, version, name, capabilities, tuple(files), activation, raw)


def _sha256(path: Path, cancel: Callable[[], bool] | None = None) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            if cancel is not None and cancel():
                raise InstallCanceled()
            digest.update(chunk)
    if cancel is not None and cancel():
        raise InstallCanceled()
    return digest.hexdigest()


def _control_requested(control_path: Path) -> bool:
    try:
        raw = _read_json(control_path, 64 * 1024)
    except (InstallError, OSError):
        return False
    return isinstance(raw, dict) and raw.get("action") == "cancel"


def _download_file(
    item: PackFile,
    destination: Path,
    progress: Callable[[int], None],
    cancel: Callable[[], bool],
) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    existing = destination.stat().st_size if destination.is_file() else 0
    if existing > item.size:
        destination.unlink(missing_ok=True)
        existing = 0
    if existing == item.size:
        progress(existing)
        return
    headers = {
        "Accept-Encoding": "identity",
        "User-Agent": "Evolabs/0.3 model-installer",
    }
    if existing:
        headers["Range"] = f"bytes={existing}-"
    request = urllib.request.Request(item.url, headers=headers, method="GET")
    opener = urllib.request.build_opener(
        _HttpsOnlyRedirectHandler(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
    )
    try:
        response = opener.open(request, timeout=60)
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise InstallError("DOWNLOAD_FAILED", "無法下載 AI 模型檔案。", f"{item.id}: {error}") from error

    with response:
        final_url = urlparse(response.geturl())
        if final_url.scheme != "https" or not final_url.hostname or final_url.username or final_url.password:
            raise InstallError(
                "DOWNLOAD_REDIRECT",
                "AI 模型下載被重新導向到不安全的來源。",
                response.geturl(),
            )
        status = getattr(response, "status", response.getcode())
        if existing and status != 206:
            existing = 0
        mode = "ab" if existing and status == 206 else "wb"
        downloaded = existing
        progress(downloaded)
        try:
            with destination.open(mode) as handle:
                while True:
                    if cancel():
                        raise InstallCanceled()
                    chunk = response.read(DOWNLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    handle.write(chunk)
                    downloaded += len(chunk)
                    if downloaded > item.size:
                        raise InstallError("DOWNLOAD_SIZE", "下載的模型檔案大小不符。", item.id)
                    progress(downloaded)
                handle.flush()
                os.fsync(handle.fileno())
        except InstallCanceled:
            raise
        except InstallError:
            raise
        except OSError as error:
            raise InstallError("DOWNLOAD_WRITE", "無法寫入模型下載檔案。", str(error)) from error
    if destination.stat().st_size != item.size:
        raise InstallError(
            "DOWNLOAD_SIZE",
            "模型檔案尚未完整下載。",
            f"{item.id}: expected {item.size}, got {destination.stat().st_size}",
        )


def _safe_extract_zip(
    archive: Path,
    destination: Path,
    maximum_expanded_bytes: int,
    cancel: Callable[[], bool] | None = None,
) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive) as bundle:
            if len(bundle.infolist()) > MAX_ARCHIVE_MEMBERS:
                raise InstallError("ARCHIVE_TOO_LARGE", "模型壓縮檔項目數超過安全限制。")
            total = 0
            for member in bundle.infolist():
                if cancel is not None and cancel():
                    raise InstallCanceled()
                try:
                    _safe_relative_path(member.filename, "archive member")
                except InstallError as error:
                    raise InstallError("ARCHIVE_UNSAFE", "模型壓縮檔含有不安全路徑。", member.filename) from error
                unix_mode = (member.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(unix_mode):
                    raise InstallError("ARCHIVE_UNSAFE", "模型壓縮檔不允許符號連結。", member.filename)
                total += member.file_size
                if total > maximum_expanded_bytes:
                    raise InstallError("ARCHIVE_TOO_LARGE", "模型壓縮檔解壓後超過安全限制。")
            for member in bundle.infolist():
                if cancel is not None and cancel():
                    raise InstallCanceled()
                relative = _safe_relative_path(member.filename, "archive member")
                target = _safe_destination(destination, relative, "archive member")
                if member.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(member) as source, target.open("wb") as output:
                    while True:
                        if cancel is not None and cancel():
                            raise InstallCanceled()
                        chunk = source.read(DOWNLOAD_CHUNK_BYTES)
                        if not chunk:
                            break
                        output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
    except InstallCanceled:
        raise
    except InstallError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as error:
        raise InstallError("ARCHIVE_INVALID", "無法解壓 AI 執行元件。", str(error)) from error


def _resolve_activation(root: Path, activation: dict[str, Any]) -> dict[str, Any]:
    resolved: dict[str, Any] = {}
    for key, value in activation.items():
        if key.endswith("Glob"):
            if not isinstance(value, str) or value.startswith(('/', '\\')) or ".." in PurePosixPath(value).parts:
                raise InstallError("ACTIVATION_INVALID", "模型啟用搜尋路徑不合法。", key)
            matches = sorted(path for path in root.glob(value) if path.is_file())
            if len(matches) != 1:
                raise InstallError(
                    "ACTIVATION_MISSING",
                    "模型包缺少必要的執行元件。",
                    f"{key}: expected one match, got {len(matches)}",
                )
            resolved[key.removesuffix("Glob")] = matches[0].relative_to(root).as_posix()
        elif key.endswith("Path"):
            relative = _safe_relative_path(value, key)
            candidate = root.joinpath(*relative.parts)
            if not candidate.is_file():
                raise InstallError("ACTIVATION_MISSING", "模型包缺少必要檔案。", str(relative))
            resolved[key.removesuffix("Path")] = relative.as_posix()
        elif key in {"provider", "modelFamily", "backend"}:
            if not isinstance(value, str) or not value.strip() or len(value) > 128:
                raise InstallError("ACTIVATION_INVALID", "模型啟用設定不合法。", key)
            resolved[key] = value
    return resolved


def _installed_tree_records(
    pack_root: Path,
    tree_root: Path,
    cancel: Callable[[], bool],
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for path in sorted(tree_root.rglob("*"), key=lambda value: value.as_posix().lower()):
        if cancel():
            raise InstallCanceled()
        if path.is_symlink():
            raise InstallError("PACK_INVALID", "模型安裝內容不允許符號連結。", str(path))
        if not path.is_file():
            continue
        if len(records) >= MAX_ARCHIVE_MEMBERS:
            raise InstallError("PACK_INVALID", "模型安裝內容的檔案數超過安全限制。")
        relative = path.relative_to(pack_root).as_posix()
        records.append(
            {
                "path": relative,
                "size": path.stat().st_size,
                "sha256": _sha256(path, cancel),
            }
        )
    return records


def _verify_existing_pack(
    final_root: Path,
    manifest: PackManifest,
    manifest_sha256: str,
    cancel: Callable[[], bool],
) -> None:
    record = _read_json(final_root / "pack.json")
    if (
        not isinstance(record, dict)
        or record.get("schemaVersion") != 1
        or record.get("id") != manifest.id
        or record.get("version") != manifest.version
        or record.get("manifestSha256") != manifest_sha256
    ):
        raise InstallError("PACK_INVALID", "既有模型包紀錄不完整，將重新安裝。")
    raw_files = record.get("files")
    if not isinstance(raw_files, list) or len(raw_files) != len(manifest.files):
        raise InstallError("PACK_INVALID", "既有模型包檔案紀錄不完整，將重新安裝。")
    records_by_id = {
        item.get("id"): item
        for item in raw_files
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    if len(records_by_id) != len(raw_files):
        raise InstallError("PACK_INVALID", "既有模型包檔案紀錄重複，將重新安裝。")

    for item in manifest.files:
        if cancel():
            raise InstallCanceled()
        item_record = records_by_id.get(item.id)
        if not isinstance(item_record, dict) or any(
            (
                item_record.get("kind") != item.kind,
                item_record.get("destination") != item.destination.as_posix(),
                item_record.get("size") != item.size,
                item_record.get("sha256") != item.sha256,
            )
        ):
            raise InstallError("PACK_INVALID", "既有模型包與目前安裝清單不一致，將重新安裝。", item.id)
        destination = _safe_destination(final_root, item.destination, item.id)
        if item.kind == "file":
            if not destination.is_file() or destination.is_symlink():
                raise InstallError("PACK_INVALID", "既有模型檔案遺失，將重新安裝。", item.id)
            if destination.stat().st_size != item.size or _sha256(destination, cancel) != item.sha256:
                raise InstallError("PACK_INVALID", "既有模型檔案驗證失敗，將重新安裝。", item.id)
            continue

        entries = item_record.get("installedEntries")
        if not isinstance(entries, list) or not entries or len(entries) > MAX_ARCHIVE_MEMBERS:
            raise InstallError("PACK_INVALID", "既有執行元件缺少完整性紀錄，將重新安裝。", item.id)
        if not destination.is_dir() or destination.is_symlink():
            raise InstallError("PACK_INVALID", "既有執行元件目錄遺失，將重新安裝。", item.id)
        expected_paths: set[str] = set()
        expanded_bytes = 0
        for entry in entries:
            if not isinstance(entry, dict):
                raise InstallError("PACK_INVALID", "既有執行元件紀錄不合法，將重新安裝。", item.id)
            relative = _safe_relative_path(entry.get("path"), f"{item.id}.installedEntry")
            target = _safe_destination(final_root, relative, item.id)
            try:
                target.resolve().relative_to(destination.resolve())
            except (OSError, ValueError) as error:
                raise InstallError("PACK_INVALID", "既有執行元件路徑不合法，將重新安裝。", str(relative)) from error
            size = entry.get("size")
            sha256 = entry.get("sha256")
            if (
                not isinstance(size, int)
                or size < 0
                or not isinstance(sha256, str)
                or not SHA256_PATTERN.fullmatch(sha256)
                or relative.as_posix() in expected_paths
            ):
                raise InstallError("PACK_INVALID", "既有執行元件紀錄不合法，將重新安裝。", item.id)
            expanded_bytes += size
            if expanded_bytes > (item.max_expanded_bytes or MAX_EXPANDED_ARCHIVE_BYTES):
                raise InstallError("PACK_INVALID", "既有執行元件超過展開上限，將重新安裝。", item.id)
            if not target.is_file() or target.is_symlink() or target.stat().st_size != size:
                raise InstallError("PACK_INVALID", "既有執行元件遺失，將重新安裝。", str(relative))
            if _sha256(target, cancel) != sha256:
                raise InstallError("PACK_INVALID", "既有執行元件驗證失敗，將重新安裝。", str(relative))
            expected_paths.add(relative.as_posix())
        actual_paths: set[str] = set()
        for path in destination.rglob("*"):
            if path.is_symlink():
                raise InstallError("PACK_INVALID", "既有執行元件含有符號連結，將重新安裝。", item.id)
            if path.is_file():
                actual_paths.add(path.relative_to(final_root).as_posix())
        if actual_paths != expected_paths:
            raise InstallError("PACK_INVALID", "既有執行元件內容已改變，將重新安裝。", item.id)

    resolved_activation = _resolve_activation(final_root, manifest.activation)
    if record.get("resolvedActivation") != resolved_activation:
        raise InstallError("PACK_INVALID", "既有模型包啟用紀錄已改變，將重新安裝。")


def _cleanup_stale_pack_workdirs(pack_parent: Path) -> None:
    try:
        candidates = list(pack_parent.iterdir())
    except OSError:
        return
    cutoff = time.time() - STALE_INSTALL_WORK_SECONDS
    for candidate in candidates:
        if not STALE_PACK_WORK_PATTERN.fullmatch(candidate.name):
            continue
        try:
            if candidate.stat().st_mtime > cutoff:
                continue
            if candidate.is_symlink():
                candidate.unlink(missing_ok=True)
            elif candidate.is_dir():
                shutil.rmtree(candidate)
        except OSError:
            continue


def install_model_pack(data_root: Path, install_id: str, manifest_path: Path) -> dict[str, Any]:
    if not PACK_ID_PATTERN.fullmatch(install_id):
        raise InstallError("INSTALL_ID", "模型安裝工作 ID 不合法。")
    manifest = load_manifest(manifest_path)
    manifest_sha256 = _sha256(manifest_path)
    installs_root = data_root / "installs"
    install_root = installs_root / install_id
    status_path = install_root / "status.json"
    control_path = install_root / "control.json"
    downloads_root = data_root / "downloads"
    pack_parent = data_root / "models" / manifest.id
    final_root = pack_parent / manifest.version
    staging_root = pack_parent / f".{manifest.version}.staging-{uuid.uuid4().hex}"
    started = time.monotonic()
    total_bytes = sum(item.size for item in manifest.files)
    completed_bytes = 0

    def write_status(state: str, progress: float, message: str, **extra: Any) -> None:
        value: dict[str, Any] = {
            "schemaVersion": 1,
            "installId": install_id,
            "packId": manifest.id,
            "packName": manifest.name,
            "state": state,
            "progress": max(0.0, min(100.0, progress)),
            "downloadedBytes": min(total_bytes, max(0, completed_bytes)),
            "totalBytes": total_bytes,
            "elapsedSeconds": max(0.0, time.monotonic() - started),
            "message": message,
            "updatedAtUnixMs": int(time.time() * 1000),
            "enginePid": os.getpid(),
        }
        value.update(extra)
        _atomic_write_json(status_path, value)

    install_root.mkdir(parents=True, exist_ok=True)
    write_status("queued", 0, "正在準備 AI 模型安裝…")
    try:
        cancel_requested = lambda: _control_requested(control_path)
        if cancel_requested():
            raise InstallCanceled()
        _cleanup_stale_pack_workdirs(pack_parent)
        if final_root.exists():
            try:
                _verify_existing_pack(final_root, manifest, manifest_sha256, cancel_requested)
                if cancel_requested():
                    raise InstallCanceled()
                current = {"schemaVersion": 1, "id": manifest.id, "version": manifest.version}
                _atomic_write_json(pack_parent / "current.json", current)
                completed_bytes = total_bytes
                write_status("completed", 100, "AI 模型已安裝並通過檢查。")
                return _read_json(status_path)
            except InstallCanceled:
                raise
            except (InstallError, OSError):
                if cancel_requested():
                    raise InstallCanceled()
                write_status("running", 0, "發現既有模型損壞，正在安全重新安裝…")
                current_path = pack_parent / "current.json"
                try:
                    current = _read_json(current_path, 64 * 1024)
                except (InstallError, OSError):
                    current = None
                if isinstance(current, dict) and current.get("id") == manifest.id and current.get("version") == manifest.version:
                    current_path.unlink(missing_ok=True)
                quarantine = pack_parent / f".{manifest.version}.invalid-{uuid.uuid4().hex}"
                try:
                    os.replace(final_root, quarantine)
                    shutil.rmtree(quarantine)
                except OSError as error:
                    raise InstallError(
                        "PACK_REPAIR_FAILED",
                        "損壞的模型包正在被其他程序使用，無法安全修復。請關閉生成工作後重試。",
                        str(error),
                    ) from error

        required_disk_bytes = INSTALL_DISK_HEADROOM_BYTES
        for item in manifest.files:
            part_path = downloads_root / f"{item.sha256}.part"
            verified_path = downloads_root / f"{item.sha256}.verified"
            cached_bytes = 0
            try:
                if item.kind == "zip" and verified_path.is_file() and verified_path.stat().st_size == item.size:
                    cached_bytes = item.size
                elif part_path.is_file() and part_path.stat().st_size <= item.size:
                    cached_bytes = part_path.stat().st_size
            except OSError:
                cached_bytes = 0
            required_disk_bytes += item.size - cached_bytes
            if item.kind == "zip":
                required_disk_bytes += item.max_expanded_bytes or MAX_EXPANDED_ARCHIVE_BYTES
        try:
            available_disk_bytes = shutil.disk_usage(data_root).free
        except OSError as error:
            raise InstallError("DISK_PROBE_FAILED", "無法確認模型磁碟的可用空間。", str(error)) from error
        if available_disk_bytes < required_disk_bytes:
            required_gb = required_disk_bytes / (1024 ** 3)
            available_gb = available_disk_bytes / (1024 ** 3)
            raise InstallError(
                "DISK_SPACE",
                f"模型安裝需要至少 {required_gb:.1f} GB 可用空間；目前只有 {available_gb:.1f} GB。",
            )

        staging_root.mkdir(parents=True, exist_ok=False)
        installed_files: list[dict[str, Any]] = []
        for item in manifest.files:
            if cancel_requested():
                raise InstallCanceled()
            part_path = downloads_root / f"{item.sha256}.part"
            verified_archive = downloads_root / f"{item.sha256}.verified"
            base_completed = completed_bytes

            def on_progress(current: int, *, _base: int = base_completed, _item: PackFile = item) -> None:
                nonlocal completed_bytes
                completed_bytes = _base + current
                progress = (completed_bytes / total_bytes * 88.0) if total_bytes else 0.0
                write_status(
                    "running",
                    progress,
                    f"正在下載 {_item.id}…",
                    fileId=_item.id,
                    fileName=PurePosixPath(urlparse(_item.url).path).name,
                )

            source_path = part_path
            if item.kind == "zip" and verified_archive.is_file():
                if (
                    verified_archive.stat().st_size == item.size
                    and _sha256(verified_archive, cancel_requested) == item.sha256
                ):
                    source_path = verified_archive
                    on_progress(item.size)
                else:
                    verified_archive.unlink(missing_ok=True)
            if source_path == part_path:
                _download_file(item, part_path, on_progress, cancel_requested)
            write_status(
                "running",
                completed_bytes / total_bytes * 88.0,
                f"正在驗證 {item.id}…",
                fileId=item.id,
            )
            actual_hash = _sha256(source_path, cancel_requested)
            if actual_hash != item.sha256:
                source_path.unlink(missing_ok=True)
                raise InstallError(
                    "DOWNLOAD_HASH",
                    "AI 模型檔案驗證失敗，未啟用這個模型包。",
                    f"{item.id}: expected {item.sha256}, got {actual_hash}",
                )
            destination = _safe_destination(staging_root, item.destination, item.id)
            installed_entries: list[dict[str, Any]] | None = None
            if item.kind == "zip":
                if source_path == part_path:
                    verified_archive.parent.mkdir(parents=True, exist_ok=True)
                    os.replace(part_path, verified_archive)
                    source_path = verified_archive
                write_status(
                    "running",
                    completed_bytes / total_bytes * 88.0,
                    f"正在安裝 {item.id}…",
                    fileId=item.id,
                )
                _safe_extract_zip(
                    source_path,
                    destination,
                    item.max_expanded_bytes or MAX_EXPANDED_ARCHIVE_BYTES,
                    cancel_requested,
                )
                installed_entries = _installed_tree_records(staging_root, destination, cancel_requested)
            else:
                if cancel_requested():
                    raise InstallCanceled()
                destination.parent.mkdir(parents=True, exist_ok=True)
                os.replace(source_path, destination)
            completed_bytes = base_completed + item.size
            installed_record: dict[str, Any] = {
                "id": item.id,
                "role": item.role,
                "kind": item.kind,
                "destination": item.destination.as_posix(),
                "size": item.size,
                "sha256": item.sha256,
            }
            if installed_entries is not None:
                installed_record["installedEntries"] = installed_entries
            installed_files.append(installed_record)

        write_status("running", 96, "正在執行模型啟用檢查…")
        if cancel_requested():
            raise InstallCanceled()
        resolved_activation = _resolve_activation(staging_root, manifest.activation)
        pack_record = {
            "schemaVersion": 1,
            "id": manifest.id,
            "version": manifest.version,
            "name": manifest.name,
            "manifestSha256": manifest_sha256,
            "capabilities": list(manifest.capabilities),
            "files": installed_files,
            "resolvedActivation": resolved_activation,
            "installedAtUnixMs": int(time.time() * 1000),
        }
        _atomic_write_json(staging_root / "pack.json", pack_record)
        # This is the final cancellation boundary. The following directory
        # replacement and current.json write form the activation commit.
        if cancel_requested():
            raise InstallCanceled()
        pack_parent.mkdir(parents=True, exist_ok=True)
        os.replace(staging_root, final_root)
        _atomic_write_json(
            pack_parent / "current.json",
            {"schemaVersion": 1, "id": manifest.id, "version": manifest.version},
        )
        completed_bytes = total_bytes
        write_status("completed", 100, "AI 模型已安裝並通過 SHA-256 檢查。")
    except InstallCanceled:
        write_status("canceled", completed_bytes / total_bytes * 88.0 if total_bytes else 0, "AI 模型安裝已取消。")
    except InstallError as error:
        write_status(
            "failed",
            completed_bytes / total_bytes * 88.0 if total_bytes else 0,
            error.message,
            error={"code": error.code, "message": error.message, "detail": error.detail},
        )
    except Exception as error:
        wrapped = InstallError("INSTALL_FAILED", "AI 模型安裝發生未預期錯誤。", str(error))
        write_status(
            "failed",
            completed_bytes / total_bytes * 88.0 if total_bytes else 0,
            wrapped.message,
            error={"code": wrapped.code, "message": wrapped.message, "detail": wrapped.detail},
        )
    finally:
        if staging_root.exists():
            shutil.rmtree(staging_root, ignore_errors=True)
    return _read_json(status_path)


def active_pack(data_root: Path, pack_id: str) -> dict[str, Any] | None:
    if not PACK_ID_PATTERN.fullmatch(pack_id):
        return None
    pack_parent = data_root / "models" / pack_id
    try:
        current = _read_json(pack_parent / "current.json", 64 * 1024)
        if not isinstance(current, dict) or current.get("id") != pack_id:
            return None
        version = current.get("version")
        if not isinstance(version, str) or not VERSION_PATTERN.fullmatch(version):
            return None
        pack_root = pack_parent / version
        record = _read_json(pack_root / "pack.json")
        if not isinstance(record, dict) or record.get("id") != pack_id or record.get("version") != version:
            return None
        record = dict(record)
        record["root"] = str(pack_root)
        return record
    except (InstallError, OSError):
        return None
