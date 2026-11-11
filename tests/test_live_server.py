"""Live-serving regressions using synthetic bytes and a fake monotonic clock."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import ProxyHandler, build_opener
from unittest.mock import Mock, patch

PROJECT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("sales_live_test", PROJECT / "serve_sales_patterns.py")
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


def report(digest, label="synthetic"):
    data = json.dumps({"meta": {"sha256": digest}, "label": label})
    return ('<!doctype html><html><head><title>Test</title></head><body>'
            '<script id="patterns-data" type="application/json">' + data +
            '</script></body></html>').encode("utf-8")


class Clock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value


class Process:
    def __init__(self):
        self.returncode = None
        self.terminated = False
        self.killed = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = -1

    def kill(self):
        self.killed = True
        self.returncode = -9

    def wait(self, timeout=None):
        return self.returncode


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name).resolve()
        self.source = self.root / "synthetic-input.bin"
        self.source.write_bytes(b"initial synthetic input")
        self.output = self.root / "output_file" / live.REPORT_NAME
        self.output.parent.mkdir()
        self.clock = Clock()
        self.processes = []
        self.logs = []

    def start(self):
        process = Process()
        self.processes.append(process)
        return process

    def monitor(self, **kwargs):
        return live.Monitor(self.source, root=self.root, clock=self.clock,
                            start_process=self.start, logger=self.logs.append, **kwargs)

    def tick(self, monitor, when):
        self.clock.value = when
        monitor.tick()

    def finish(self, monitor, when=61, label="first", digest=None):
        digest = digest or live.file_signature(self.source).digest
        content = report(digest, label)
        self.output.write_bytes(content)
        self.processes[-1].returncode = 0
        self.tick(monitor, when)
        return content

    def ready(self):
        monitor = self.monitor()
        self.tick(monitor, 0)
        self.tick(monitor, 60)
        self.finish(monitor)
        return monitor

    def test_initial_generation_waits_60_seconds_even_with_existing_report(self):
        old = report("a" * 64, "previous input")
        self.output.write_bytes(old)
        monitor = self.monitor()
        self.assertEqual(monitor.content, old)
        self.tick(monitor, 0)
        self.tick(monitor, 59)
        self.assertEqual(self.processes, [])
        self.tick(monitor, 60)
        self.assertEqual(len(self.processes), 1)
        self.assertEqual(monitor.status()["state"], "building")
        self.assertEqual(monitor.content, old)

    def test_idle_300_seconds_then_stable_60_without_another_scan_delay(self):
        monitor = self.ready()
        self.source.write_bytes(b"changed synthetic bytes")
        self.tick(monitor, 360)
        self.assertEqual(len(self.processes), 1)
        self.tick(monitor, 361)
        self.assertEqual(monitor.state, "waiting")
        self.tick(monitor, 420)
        self.assertEqual(len(self.processes), 1)
        self.tick(monitor, 421)
        self.assertEqual(len(self.processes), 2)
        self.finish(monitor, 422, "updated")
        self.assertEqual(monitor.state, "idle")

    def test_pending_write_restarts_full_quiet_window(self):
        monitor = self.monitor()
        self.tick(monitor, 0)
        self.source.write_bytes(b"rewritten data longer than initial input")
        self.tick(monitor, 30)
        self.tick(monitor, 60)
        self.tick(monitor, 89)
        self.assertFalse(self.processes)
        self.tick(monitor, 90)
        self.assertEqual(len(self.processes), 1)

    def test_atomic_replacement_restarts_window(self):
        monitor = self.monitor()
        self.tick(monitor, 0)
        replacement = self.root / "replacement.bin"
        replacement.write_bytes(self.source.read_bytes())
        os.replace(replacement, self.source)
        self.tick(monitor, 20)
        self.tick(monitor, 79)
        self.assertFalse(self.processes)
        self.tick(monitor, 80)
        self.assertEqual(len(self.processes), 1)

    def test_missing_file_recovers_then_waits_60_seconds(self):
        monitor = self.monitor()
        self.tick(monitor, 0)
        self.source.unlink()
        self.tick(monitor, 30)
        self.assertEqual(monitor.state, "missing")
        self.tick(monitor, 80)
        self.source.write_bytes(b"restored synthetic input")
        self.tick(monitor, 81)
        self.tick(monitor, 140)
        self.assertFalse(self.processes)
        self.tick(monitor, 141)
        self.assertEqual(len(self.processes), 1)

    def test_lock_resets_stability_even_when_stat_is_unchanged(self):
        monitor = self.monitor()
        self.tick(monitor, 0)
        with patch.object(live, "probe_file", side_effect=PermissionError("locked")):
            self.tick(monitor, 40)
        self.assertEqual(monitor.state, "error")
        self.tick(monitor, 41)
        self.tick(monitor, 100)
        self.assertFalse(self.processes)
        self.tick(monitor, 101)
        self.assertEqual(len(self.processes), 1)

    def test_idle_sha_detects_change_with_identical_metadata(self):
        with patch.object(live, "stat_key", return_value=(1, 2, 3, 4, 5)):
            monitor = self.ready()
            self.source.write_bytes(b"new content whose stat appears unchanged")
            self.tick(monitor, 361)
            self.assertEqual(monitor.state, "waiting")
            self.tick(monitor, 421)
            self.assertEqual(len(self.processes), 2)

    def test_final_sha_recheck_restarts_quiet_window_on_hidden_write(self):
        with patch.object(live, "stat_key", return_value=(1, 2, 3, 4, 5)):
            monitor = self.monitor()
            self.tick(monitor, 0)
            self.source.write_bytes(b"hidden write")
            self.tick(monitor, 60)
            self.assertFalse(self.processes)
            self.tick(monitor, 119)
            self.assertFalse(self.processes)
            self.tick(monitor, 120)
            self.assertEqual(len(self.processes), 1)

    def test_failure_preserves_last_good_version_and_retries(self):
        monitor = self.ready()
        old_content, old_version = monitor.content, monitor.version
        self.source.write_bytes(b"new input")
        self.tick(monitor, 361)
        self.tick(monitor, 421)
        self.processes[-1].returncode = 2
        self.tick(monitor, 422)
        self.assertEqual(monitor.state, "error")
        self.assertEqual((monitor.content, monitor.version), (old_content, old_version))
        self.tick(monitor, 481)
        self.assertEqual(len(self.processes), 2)
        self.tick(monitor, 482)
        self.assertEqual(len(self.processes), 3)
        self.finish(monitor, 483, "recovered")
        self.assertNotEqual(monitor.version, old_version)

    def test_input_change_during_build_discards_result(self):
        monitor = self.ready()
        old_content, old_version = monitor.content, monitor.version
        self.source.write_bytes(b"second input")
        self.tick(monitor, 361)
        self.tick(monitor, 421)
        stable_digest = live.file_signature(self.source).digest
        self.source.write_bytes(b"third input changed while generating")
        self.tick(monitor, 422)
        self.finish(monitor, 423, "stale generated report", stable_digest)
        self.assertEqual((monitor.content, monitor.version), (old_content, old_version))
        self.assertEqual(monitor.state, "error")
        self.tick(monitor, 483)
        self.assertEqual(len(self.processes), 3)

    def test_wrong_digest_from_parallel_static_run_is_never_published(self):
        monitor = self.ready()
        old_content, old_version = monitor.content, monitor.version
        self.source.write_bytes(b"second synthetic input")
        self.tick(monitor, 361)
        self.tick(monitor, 421)
        self.finish(monitor, 422, "other input report", "f" * 64)
        self.assertEqual((monitor.content, monitor.version), (old_content, old_version))
        self.assertEqual(monitor.state, "error")

    def test_unusable_existing_report_becomes_pending_page(self):
        self.output.write_bytes(b"<html>partial")
        monitor = self.monitor()
        self.assertIsNone(monitor.version)
        page = monitor.page("window.testLive = true;")
        self.assertIn('正在更新'.encode(), page)
        self.assertIn(b'content="pending"', page)
        self.assertIn(b"window.testLive = true;", page)
        self.assertEqual(monitor.status()["version"], None)

    def test_only_one_process_runs_and_stop_terminates_it(self):
        monitor = self.monitor()
        self.tick(monitor, 0)
        self.tick(monitor, 60)
        self.tick(monitor, 120)
        self.tick(monitor, 500)
        self.assertEqual(len(self.processes), 1)
        monitor.stop()
        self.assertTrue(self.processes[0].terminated)
        self.tick(monitor, 600)
        self.assertEqual(len(self.processes), 1)

    def test_stop_kills_generator_if_termination_times_out(self):
        monitor = self.monitor()
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("synthetic generator", 5), 0]
        monitor._process = process
        monitor.stop()
        process.terminate.assert_called_once_with()
        process.kill.assert_called_once_with()
        self.assertEqual(process.wait.call_count, 2)

    def test_process_start_failure_preserves_last_page(self):
        old = report("b" * 64)
        self.output.write_bytes(old)
        monitor = self.monitor()
        monitor.start_process = Mock(side_effect=OSError("cannot start"))
        self.tick(monitor, 0)
        self.tick(monitor, 60)
        self.assertEqual(monitor.content, old)
        self.assertEqual(monitor.state, "error")
        self.tick(monitor, 120)
        self.assertEqual(monitor.start_process.call_count, 2)

    def test_generator_uses_current_interpreter_and_no_open(self):
        monitor = self.monitor(calendar=self.root / "calendar.json")
        with patch.object(live.subprocess, "Popen") as popen:
            monitor._start_process()
        args, kwargs = popen.call_args
        self.assertEqual(args[0], [sys.executable, str(self.root / "analyze_sales_patterns.py"),
                                  "--input", str(self.source), "--no-open", "--calendar",
                                  str(self.root / "calendar.json")])
        self.assertEqual(kwargs["cwd"], str(self.root))

    def test_generated_html_sha_is_version_and_page_does_not_modify_disk(self):
        monitor = self.ready()
        original = self.output.read_bytes()
        self.assertEqual(monitor.version, hashlib.sha256(original).hexdigest())
        page = monitor.page("window.syntheticLive = true;")
        self.assertIn(monitor.version.encode(), page)
        self.assertIn(b"window.syntheticLive = true;", page)
        self.assertLess(page.index(b"sales-patterns-live-version"), page.index(b"</head>"))
        self.assertGreater(page.index(b"window.syntheticLive = true;"), page.index(b'id="patterns-data"'))
        self.assertLess(page.index(b"window.syntheticLive = true;"), page.index(b"</body>"))
        self.assertEqual(self.output.read_bytes(), original)
        monitor.state = "error"
        self.assertEqual(monitor.version, hashlib.sha256(original).hexdigest())

    def test_incomplete_report_and_invalid_metadata_rejected(self):
        for content in (b"<html>", b"<html></html>", report("invalid"),
                        b'<html><script id="patterns-data">[]</script></html>'):
            with self.subTest(content=content):
                with self.assertRaises((ValueError, AttributeError)):
                    live.validate_report(content)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name).resolve()
        self.source = self.root / "private-source.bin"
        self.source.write_bytes(b"private synthetic data")
        self.monitor = live.Monitor(self.source, root=self.root, logger=lambda message: None)
        self.server = live.make_server(self.monitor, "window.liveInjected = true;", 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/"
        self.opener = build_opener(ProxyHandler({}))

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def fetch(self, path):
        return self.opener.open(self.url + path, timeout=2)

    def test_status_contract_is_identity_only_without_input_path_or_data(self):
        with self.fetch("api/status") as response:
            data = json.load(response)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(set(data), {"app", "version", "state", "source_id", "project_id"})
        self.assertEqual(data["app"], "sales-patterns")
        self.assertEqual(data["source_id"], live.path_id(self.source))
        self.assertEqual(data["project_id"], live.path_id(self.root))
        self.assertEqual(data["version"], None)
        self.assertNotIn(str(self.source), json.dumps(data))

    def test_html_and_index_are_injected_no_store(self):
        for path in ("", "index.html", "?x=1"):
            with self.subTest(path=path), self.fetch(path) as response:
                content = response.read()
                self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertIn(b"sales-patterns-live-version", content)
                self.assertIn(b"window.liveInjected = true;", content)
                self.assertNotIn(str(self.source).encode(), content)

    def test_routes_do_not_expose_directory_source_or_script(self):
        for path in ("private-source.bin", "templates/live_reload.js", "output_file/",
                     "../private-source.bin", "%2e%2e/private-source.bin", "api/status/", "favicon.ico"):
            with self.subTest(path=path), self.assertRaises(HTTPError) as caught:
                self.fetch(path)
            self.assertEqual(caught.exception.code, 404)
            self.assertEqual(caught.exception.headers["Cache-Control"], "no-store")
            caught.exception.close()

    def test_same_instance_identity_and_mismatches(self):
        self.assertTrue(live.existing_instance(self.url, self.monitor.project_id, self.monitor.source_id))
        self.assertFalse(live.existing_instance(self.url, "other-project", self.monitor.source_id))
        self.assertFalse(live.existing_instance(self.url, self.monitor.project_id, "other-source"))
        with patch.object(self.monitor, "status", return_value={"app": "other-program"}):
            self.assertFalse(live.existing_instance(self.url, self.monitor.project_id, self.monitor.source_id))

    def test_exclusive_port_binding(self):
        with self.assertRaises(OSError):
            other = live.make_server(self.monitor, "", self.server.server_address[1])
            other.server_close()

    def test_slow_input_hash_does_not_block_serving_existing_page_or_status(self):
        started = threading.Event()
        release = threading.Event()
        original = live.file_signature

        def blocked_hash(path):
            started.set()
            release.wait(timeout=5)
            return original(path)

        with patch.object(live, "file_signature", side_effect=blocked_hash):
            worker = threading.Thread(target=self.monitor.tick)
            worker.start()
            try:
                self.assertTrue(started.wait(timeout=2))
                with self.fetch("api/status") as response:
                    self.assertEqual(response.status, 200)
                with self.fetch("") as response:
                    self.assertEqual(response.status, 200)
            finally:
                release.set()
                worker.join(timeout=2)
        self.assertFalse(worker.is_alive())

    def test_existing_loaded_report_is_only_changed_by_successful_publication(self):
        old = report("a" * 64)
        with self.monitor.lock:
            self.monitor._publish(old)
        expected_version = self.monitor.version
        self.monitor.report_path.parent.mkdir()
        self.monitor.report_path.write_bytes(report("b" * 64))
        with self.fetch("") as response:
            content = response.read()
        self.assertIn(expected_version.encode(), content)
        self.assertIn(old.split(b"<body>")[1].split(b"</body>")[0], content)
        with self.fetch("api/status") as response:
            self.assertEqual(json.load(response)["version"], expected_version)


class MainTests(unittest.TestCase):
    def test_non_finite_or_non_positive_intervals_are_rejected(self):
        for option in ("--scan-seconds", "--stable-seconds"):
            for value in ("nan", "inf", "-inf", "0", "-1"):
                with self.subTest(option=option, value=value), \
                        patch.object(live, "default_input_path", return_value=Path("synthetic.bin")), \
                        patch.object(live.sys, "stderr"), \
                        patch.object(live, "Monitor") as monitor, \
                        self.assertRaises(SystemExit) as caught:
                    live.main([option + "=" + value])
                self.assertEqual(caught.exception.code, 2)
                monitor.assert_not_called()

    def test_cli_defaults_and_duplicate_reuse_do_not_spawn_worker(self):
        monitor = Mock(project_id="project", source_id="source")
        with patch.object(live, "default_input_path", return_value=Path("synthetic.bin")), \
                patch.object(live, "Monitor", return_value=monitor) as constructor, \
                patch.object(Path, "read_text", return_value="// synthetic live script"), \
                patch.object(live, "make_server", side_effect=OSError("occupied")) as make_server, \
                patch.object(live, "existing_instance", return_value=True), \
                patch.object(live, "open_browser") as browser:
            self.assertEqual(live.main([]), 0)
        self.assertEqual(constructor.call_args.kwargs["scan_seconds"], 300)
        self.assertEqual(constructor.call_args.kwargs["stable_seconds"], 60)
        self.assertEqual(make_server.call_args.args[2], 8767)
        browser.assert_called_once_with("http://127.0.0.1:8767/")
        monitor.tick.assert_not_called()

    def test_no_open_suppresses_browser_when_reusing_server(self):
        with patch.object(live, "default_input_path", return_value=Path("synthetic.bin")), \
                patch.object(live, "Monitor"), \
                patch.object(Path, "read_text", return_value=""), \
                patch.object(live, "make_server", side_effect=OSError("occupied")), \
                patch.object(live, "existing_instance", return_value=True), \
                patch.object(live, "open_browser") as browser:
            self.assertEqual(live.main(["--no-open", "--port", "8899"]), 0)
        browser.assert_not_called()

    def test_keyboard_interrupt_closes_http_and_stops_generator(self):
        monitor = Mock()
        monitor.tick.side_effect = KeyboardInterrupt
        server = Mock()
        with patch.object(live, "default_input_path", return_value=Path("synthetic.bin")), \
                patch.object(live, "Monitor", return_value=monitor), \
                patch.object(Path, "read_text", return_value=""), \
                patch.object(live, "make_server", return_value=server), \
                patch.object(live, "open_browser") as browser:
            self.assertEqual(live.main(["--no-open"]), 0)
        browser.assert_not_called()
        monitor.stop.assert_called_once_with()
        server.shutdown.assert_called_once_with()
        server.server_close.assert_called_once_with()

    def test_windows_uses_system_http_association(self):
        with patch.object(live.sys, "platform", "win32"), \
                patch.object(live.os, "startfile", create=True) as startfile, \
                patch.object(live.webbrowser, "open") as browser:
            live.open_browser("http://127.0.0.1:8767/")
        startfile.assert_called_once_with("http://127.0.0.1:8767/")
        browser.assert_not_called()

    def test_other_platform_uses_default_webbrowser(self):
        with patch.object(live.sys, "platform", "linux"), \
                patch.object(live.webbrowser, "open", return_value=True) as browser:
            live.open_browser("http://127.0.0.1:8767/")
        browser.assert_called_once_with("http://127.0.0.1:8767/")

    def test_other_program_using_port_returns_clear_error(self):
        with patch.object(live, "default_input_path", return_value=Path("synthetic.bin")), \
                patch.object(live, "Monitor"), \
                patch.object(Path, "read_text", return_value=""), \
                patch.object(live, "make_server", side_effect=OSError("occupied")), \
                patch.object(live, "existing_instance", return_value=False), \
                patch.object(live, "open_browser") as browser, \
                patch.object(live.sys, "stderr") as stderr:
            self.assertEqual(live.main(["--no-open"]), 1)
        browser.assert_not_called()
        self.assertIn("--port", "".join(call.args[0] for call in stderr.write.call_args_list))


if __name__ == "__main__":
    unittest.main()
