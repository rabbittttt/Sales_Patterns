"""Serve the sales report locally and rebuild after its read-only input settles."""
from __future__ import annotations

import argparse
import hashlib
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import time
from typing import NamedTuple
from urllib.error import URLError
from urllib.parse import quote, urlsplit
from urllib.request import ProxyHandler, build_opener
import webbrowser

ROOT = Path(__file__).resolve().parent
REPORT_NAME = "鸿蒙智行销量规律分析.html"
APP = "sales-patterns"


def log(message):
    print(time.strftime("[%Y-%m-%d %H:%M:%S] ") + message, flush=True)


def path_id(path):
    return hashlib.sha256(os.path.normcase(str(Path(path).resolve())).encode("utf-8")).hexdigest()


def default_input_path():
    spec = importlib.util.spec_from_file_location("sales_live_data_paths", ROOT / "core" / "data_paths.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.orders_input_directory(ROOT) / "鸿蒙智行销量数据汇总.xlsx"


class FileSignature(NamedTuple):
    stat: tuple
    digest: str


def stat_key(path):
    info = path.stat()
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def probe_file(path):
    """Check readability as well as metadata, without hashing a pending file."""
    before = stat_key(path)
    with path.open("rb") as stream:
        stream.read(1)
    if stat_key(path) != before:
        raise OSError("输入文件正在写入或替换")
    return before


def file_signature(path):
    before = stat_key(path)
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    if stat_key(path) != before:
        raise OSError("计算校验值期间输入文件发生变化")
    return FileSignature(before, digest.hexdigest())


class _ReportParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.parts = []
        self.active = False
        self.count = 0

    def handle_starttag(self, tag, attrs):
        if tag == "script" and dict(attrs).get("id") == "patterns-data":
            self.count += 1
            self.active = True

    def handle_endtag(self, tag):
        if tag == "script":
            self.active = False

    def handle_data(self, data):
        if self.active:
            self.parts.append(data)


def validate_report(content, expected_digest=None):
    """Accept a complete self-contained report only when its source agrees."""
    if not re.search(br"</html\s*>", content, re.IGNORECASE):
        raise ValueError("报告 HTML 不完整")
    parser = _ReportParser()
    parser.feed(content.decode("utf-8-sig"))
    parser.close()
    if parser.count != 1:
        raise ValueError("报告缺少唯一的 patterns-data 数据")
    data = json.loads("".join(parser.parts))
    digest = data.get("meta", {}).get("sha256")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("报告缺少有效的源文件 SHA256")
    if expected_digest is not None and digest != expected_digest:
        raise ValueError("报告与本次稳定输入不一致，保留上一版本")
    return content


class Monitor:
    """A pollable state machine; only the monitor loop starts generators."""

    def __init__(self, source, *, root=ROOT, calendar=None, scan_seconds=300,
                 stable_seconds=60, clock=time.monotonic, start_process=None,
                 logger=log):
        self.source = Path(source).resolve()
        self.root = Path(root).resolve()
        self.report_path = self.root / "output_file" / REPORT_NAME
        self.calendar = Path(calendar).resolve() if calendar else None
        self.scan_seconds = scan_seconds
        self.stable_seconds = stable_seconds
        self.clock = clock
        self.logger = logger
        self.start_process = start_process or self._start_process
        self.lock = threading.RLock()
        self.state = "waiting"
        self.content = None
        self.version = None
        self.source_id = path_id(self.source)
        self.project_id = path_id(self.root)
        self._observed_stat = None
        self._observed_digest = None
        self._stable_since = None
        self._pending = True
        self._next_check = clock()
        self._last_success = None
        self._process = None
        self._building_signature = None
        self._build_changed = False
        self._last_issue = None
        self._stopped = False
        try:
            content = validate_report(self.report_path.read_bytes())
        except FileNotFoundError:
            pass
        except (OSError, ValueError, UnicodeError, AttributeError, TypeError) as exc:
            self.logger(f"已有报告无法加载：{exc}")
        else:
            self._publish(content)
            self.logger("已载入上次完整报告；正在观察当前输入")

    @property
    def state(self):
        with self.lock:
            return self._state

    @state.setter
    def state(self, value):
        with self.lock:
            self._state = value

    def _publish(self, content, state=None):
        version = hashlib.sha256(content).hexdigest()
        with self.lock:
            self.content = content
            self.version = version
            if state is not None:
                self._state = state

    def status(self):
        with self.lock:
            return dict(app=APP, version=self.version, state=self.state,
                        source_id=self.source_id, project_id=self.project_id)

    def page(self, live_script):
        with self.lock:
            content, version = self.content, self.version
        if content is None:
            content = ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
                       '<title>鸿蒙智行销量规律</title></head><body>'
                       '<p role="status">正在更新…</p></body></html>').encode("utf-8")
        meta = f'<meta name="sales-patterns-live-version" content="{version or "pending"}">'.encode("utf-8")
        head = re.search(br"</head\s*>", content, re.IGNORECASE)
        position = head.start() if head else 0
        content = content[:position] + meta + content[position:]
        script = ("<script>" + live_script + "</script>").encode("utf-8")
        body = re.search(br"</body\s*>", content, re.IGNORECASE)
        if body is None:
            body = re.search(br"</html\s*>", content, re.IGNORECASE)
        position = body.start() if body else len(content)
        return content[:position] + script + content[position:]

    def _start_process(self):
        command = [sys.executable, str(self.root / "analyze_sales_patterns.py"),
                   "--input", str(self.source), "--no-open"]
        if self.calendar:
            command.extend(["--calendar", str(self.calendar)])
        return subprocess.Popen(command, cwd=str(self.root))

    def _issue(self, exc, now):
        self.state = "missing" if isinstance(exc, FileNotFoundError) else "error"
        message = f"输入暂不可用：{exc}；将自动重试"
        if self._last_issue != message:
            self.logger(message)
            self._last_issue = message
        self._pending = True
        self._observed_stat = None
        self._observed_digest = None
        self._stable_since = None
        self._next_check = now + 1

    def _observe(self, signature, now, state="waiting"):
        self._pending = True
        self._observed_stat = signature.stat
        self._observed_digest = signature.digest
        self._stable_since = now
        self._next_check = now + 1
        self._last_issue = None
        self.state = state

    def _retry_build(self, message, now):
        self.logger(message + "；保留上次完整报告，将自动重试")
        try:
            current = file_signature(self.source)
        except OSError as exc:
            self._issue(exc, now)
        else:
            self._observe(current, now, state="error")

    def _building_tick(self, now):
        try:
            current_stat = probe_file(self.source)
            if current_stat != self._building_signature.stat:
                self._build_changed = True
        except OSError:
            self._build_changed = True
        result = self._process.poll()
        self._next_check = now + 1
        if result is None:
            return
        self._process = None
        try:
            current = file_signature(self.source)
            if self._build_changed or current != self._building_signature:
                raise ValueError("生成期间输入发生变化，本次结果不发布")
            if result:
                raise ValueError(f"报告生成进程退出码 {result}")
            content = validate_report(self.report_path.read_bytes(), current.digest)
            # Reading or validating a report may overlap another input replacement.
            if file_signature(self.source) != current:
                raise ValueError("发布前输入发生变化，本次结果不发布")
        except (OSError, ValueError, UnicodeError, AttributeError, TypeError) as exc:
            self._retry_build(str(exc), now)
            return
        self._publish(content, state="idle")
        self._last_success = current
        self._pending = False
        self._next_check = now + self.scan_seconds
        self.logger("报告已更新，本地页面将自动刷新")

    def tick(self):
        # The monitor loop owns its control state; HTTP only takes short snapshot locks.
        now = self.clock()
        if self._stopped or now < self._next_check:
            return
        if self._process is not None:
            self._building_tick(now)
            return
        if not self._pending:
            try:
                signature = file_signature(self.source)
            except OSError as exc:
                self._issue(exc, now)
                return
            if signature == self._last_success:
                self._next_check = now + self.scan_seconds
            else:
                self._observe(signature, now)
                self.logger("检测到输入变化，等待文件稳定")
            return
        try:
            current_stat = probe_file(self.source)
            if self._observed_stat is None:
                self._observe(file_signature(self.source), now)
                return
        except OSError as exc:
            self._issue(exc, now)
            return
        self._next_check = now + 1
        if current_stat != self._observed_stat:
            self._observed_stat = current_stat
            self._observed_digest = None
            self._stable_since = now
            self.state = "waiting"
            return
        if now - self._stable_since < self.stable_seconds:
            return
        try:
            signature = file_signature(self.source)
        except OSError as exc:
            self._issue(exc, now)
            return
        if (signature.stat != current_stat or
                (self._observed_digest is not None and signature.digest != self._observed_digest)):
            self._observe(signature, now)
            return
        self._building_signature = signature
        self._build_changed = False
        try:
            self._process = self.start_process()
        except OSError as exc:
            self._retry_build(f"无法启动报告生成：{exc}", now)
            return
        self.state = "building"
        self.logger("输入已稳定，正在生成报告")

    def stop(self):
        with self.lock:
            self._stopped = True
            process, self._process = self._process, None
        if process is not None and process.poll() is None:
            try:
                process.terminate()
            except OSError:
                if process.poll() is None:
                    process.kill()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


class LocalServer(ThreadingHTTPServer):
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def make_server(monitor, live_script, port):
    class Handler(BaseHTTPRequestHandler):
        def _respond(self, head=False):
            path = urlsplit(self.path).path
            if path == "/api/status":
                content = json.dumps(monitor.status(), ensure_ascii=False).encode("utf-8")
                kind, code = "application/json; charset=utf-8", 200
            elif path in ("/", "/index.html", "/" + REPORT_NAME,
                          "/" + quote(REPORT_NAME)):
                content = monitor.page(live_script)
                kind, code = "text/html; charset=utf-8", 200
            else:
                content, kind, code = b"Not found", "text/plain; charset=utf-8", 404
            self.send_response(code)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if not head:
                self.wfile.write(content)

        def do_GET(self):
            self._respond()

        def do_HEAD(self):
            self._respond(head=True)

        def log_message(self, format, *args):
            pass

    return LocalServer(("127.0.0.1", port), Handler)


def existing_instance(url, project_id, source_id):
    """Only reuse a server that identifies this exact project and input."""
    try:
        # A corporate proxy must never intercept a loopback identity check.
        with build_opener(ProxyHandler({})).open(url + "api/status", timeout=2) as response:
            status = json.loads(response.read(65536).decode("utf-8"))
        return (isinstance(status, dict) and status.get("app") == APP
                and status.get("project_id") == project_id
                and status.get("source_id") == source_id)
    except (OSError, URLError, ValueError, UnicodeError):
        return False


def open_browser(url):
    try:
        if sys.platform == "win32":
            os.startfile(url)
        elif not webbrowser.open(url):
            log("未能自动打开浏览器，请手动打开：" + url)
    except (OSError, webbrowser.Error) as exc:
        log(f"自动打开浏览器失败（{exc}），请手动打开：{url}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=default_input_path())
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--scan-seconds", type=float, default=300)
    parser.add_argument("--stable-seconds", type=float, default=60)
    parser.add_argument("--no-open", action="store_true")
    parser.add_argument("--calendar", type=Path)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("--port 必须在 1 到 65535 之间")
    if any(not math.isfinite(value) or value <= 0
           for value in (args.scan_seconds, args.stable_seconds)):
        parser.error("扫描间隔和稳定时间必须大于 0")
    source = args.input.resolve()
    url = f"http://127.0.0.1:{args.port}/"
    monitor = Monitor(source, calendar=args.calendar, scan_seconds=args.scan_seconds,
                      stable_seconds=args.stable_seconds)
    script = (ROOT / "templates" / "live_reload.js").read_text(encoding="utf-8")
    try:
        server = make_server(monitor, script, args.port)
    except OSError as exc:
        if existing_instance(url, monitor.project_id, monitor.source_id):
            log("当前项目与输入已在运行，复用服务：" + url)
            if not args.no_open:
                open_browser(url)
            return 0
        print(f"无法监听 {url}：端口已被其他服务占用或不可用（{exc}）。"
              "请使用 --port 指定其他端口。", file=sys.stderr, flush=True)
        return 1
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
    thread.start()
    log(f"动态服务已启动：{url}（每 {args.scan_seconds:g} 秒扫描，稳定 {args.stable_seconds:g} 秒后更新）")
    if not args.no_open:
        open_browser(url)
    try:
        while True:
            monitor.tick()
            time.sleep(0.2)
    except KeyboardInterrupt:
        log("正在停止动态服务")
    finally:
        try:
            monitor.stop()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
