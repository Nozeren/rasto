"""
pytest-bdd plugin: records every browser scenario with Rasto, with the banner following the step that is running.

    PYTHONPATH=path/to/rasto/integrations/pytest pytest -p pytest_rasto --rasto [--rasto-subject X] [--rasto-config Y]

Each scenario that opens a Playwright ``page`` becomes one recording of one case: Rasto records that browser tab (headless
too), steps along with pytest-bdd, and closes the case as pass, fail (a step raised) or blocked (a step has no
definition). Scenarios that never open a page are left alone. Nothing in the project under test needs to change.

Needs Rasto running with ⚙ Settings → Remote control on, and Chromium (Playwright launches it with Rasto's debugging
port added). It only uses Rasto's remote-control API (see the README, "Remote control"), and only the standard library.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import pytest

# The Rasto state of each test item, by node id.
_cases: dict[str, "_Case"] = {}


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("rasto", "Record pytest-bdd scenarios with Rasto")
    group.addoption("--rasto", action="store_true", help="Record every scenario that opens a browser page with Rasto.")
    group.addoption("--rasto-subject", metavar="NAME", help="Rasto subject folder (default: what Rasto has in ③ Save to).")
    group.addoption("--rasto-config", metavar="NAME", help="Rasto config folder (default: what Rasto has in ③ Save to).")


# --- Rasto's remote control --------------------------------------------------------------------------------------------


def _user_data() -> Path:
    """Rasto's user-data folder, as Electron names it; RASTO_USER_DATA overrides it (like bin/remote-client.js)."""
    if os.environ.get("RASTO_USER_DATA"):
        return Path(os.environ["RASTO_USER_DATA"])
    home = Path.home()
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Rasto"
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", home / "AppData" / "Roaming")) / "Rasto"
    return Path(os.environ.get("XDG_CONFIG_HOME", home / ".config")) / "Rasto"


class _Rasto:
    def __init__(self) -> None:
        folder = _user_data()
        try:
            remote = json.loads((folder / "remote.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise pytest.UsageError(
                f"--rasto: Rasto isn't running with remote control on (no remote.json in {folder}). "
                "Start Rasto and turn on ⚙ Settings → Remote control."
            ) from None
        self.url = f"http://127.0.0.1:{remote['port']}"
        self.token = remote["token"]
        try:
            preferences = json.loads((folder / "settings.json").read_text(encoding="utf-8")).get("preferences", {})
        except (FileNotFoundError, json.JSONDecodeError):
            preferences = {}
        self.port = int(preferences.get("browserPort", 9222))
        self.include_background = bool(preferences.get("includeBackground", True))

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        request = urllib.request.Request(
            self.url + path,
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            return json.loads(error.read() or b"{}") or {"ok": False, "error": str(error)}
        except OSError as error:
            return {"ok": False, "error": f"Rasto can't be reached ({error})"}

    def status(self) -> dict:
        return self._call("GET", "/status")

    def record(self, feature: Path, tab: str, subject: str | None, config: str | None) -> dict:
        body = {"feature": str(feature), "tab": tab}
        if subject:
            body["subject"] = subject
        if config:
            body["config"] = config
        return self._call("POST", "/record", body)

    def control(self, action: str) -> dict:
        return self._call("POST", "/control", {"action": action})

    def wait(self, until, timeout: float = 120) -> dict:
        """Polls the status until ``until(status)`` holds (or the timeout passes) and returns the last status."""
        deadline = time.monotonic() + timeout
        status = self.status()
        while not until(status) and time.monotonic() < deadline:
            time.sleep(0.2)
            status = self.status()
        return status


def _idle(status: dict) -> bool:
    return not status.get("recording") and not status.get("compressing")


def _warn(message: str) -> None:
    sys.stderr.write(f"\n[rasto] {message}\n")


# --- One scenario = one case ---------------------------------------------------------------------------------------------


class _Case:
    def __init__(self, feature, scenario) -> None:
        self.feature = feature
        self.scenario = scenario
        # The feature's Background (and its Rule's) come first in scenario.steps.
        self.steps = list(scenario.steps)
        backgrounds = (feature.background, getattr(getattr(scenario, "rule", None), "background", None))
        self.background = sum(len(background.steps) for background in backgrounds if background is not None)
        self.started = -1  # index in self.steps of the step pytest-bdd is running
        self.recording = False
        self.closed = False

    def feature_text(self) -> str:
        """The scenario alone, as a .feature Rasto can load: its tags (the @C<id> case id), Background and steps."""
        def step_line(step) -> str:
            keyword = (getattr(step, "keyword", "") or step.type).strip()
            return f"    {keyword} {step.name}"

        lines = [f"Feature: {self.feature.name}", ""]
        if self.background:
            lines += ["  Background:", *map(step_line, self.steps[: self.background]), ""]
        tags = sorted(set(self.feature.tags) | set(self.scenario.tags))
        if tags:
            lines.append("  " + " ".join("@" + tag for tag in tags))
        lines += [f"  Scenario: {self.scenario.name}", *map(step_line, self.steps[self.background :]), ""]
        return "\n".join(lines)

    def rasto_step(self, rasto: _Rasto, index: int) -> int | None:
        """Rasto's step number (1-based) for pytest-bdd's step ``index``; None while in a Background Rasto leaves out."""
        if rasto.include_background:
            return index + 1
        return index - self.background + 1 if index >= self.background else None


def _sync(rasto: _Rasto, case: _Case) -> None:
    """Moves Rasto to the step pytest-bdd is running, whatever step it is on now."""
    target = case.rasto_step(rasto, case.started)
    if target is None:
        return
    for _ in range(len(case.steps)):
        step = (rasto.status().get("step") or {}).get("number")
        if step is None or step >= target:
            return
        rasto.control("next")


def _close(rasto: _Rasto, case: _Case, result: str) -> None:
    if case.recording and not case.closed:
        case.closed = True
        answer = rasto.control(result)
        if not answer.get("ok"):
            _warn(f"could not close the case as {result}: {answer.get('error')}")


# --- Hooks ----------------------------------------------------------------------------------------------------------------

_RASTO = pytest.StashKey[_Rasto]()



def pytest_configure(config: pytest.Config) -> None:
    if not config.getoption("rasto"):
        return
    if getattr(config.option, "numprocesses", None) or hasattr(config, "workerinput"):
        raise pytest.UsageError("--rasto records one scenario at a time: run without -n (pytest-xdist).")
    rasto = _Rasto()
    config.stash[_RASTO] = rasto
    _add_debugging_port(rasto.port)


def _rasto(request: pytest.FixtureRequest) -> _Rasto | None:
    return request.config.stash.get(_RASTO, None)


def _add_debugging_port(port: int) -> None:
    """Chromium launched by Playwright also listens on Rasto's debugging port, so Rasto can record its tabs."""
    try:
        from playwright.sync_api import BrowserType
    except ImportError:
        return
    if getattr(BrowserType.launch, "_rasto", False):
        return
    launch = BrowserType.launch

    def launch_with_port(self, *args, **kwargs):
        if self.name == "chromium":
            flags = list(kwargs.get("args") or [])
            if not any(flag.startswith("--remote-debugging-port") for flag in flags):
                flags.append(f"--remote-debugging-port={port}")
            kwargs["args"] = flags
        return launch(self, *args, **kwargs)

    launch_with_port._rasto = True
    BrowserType.launch = launch_with_port


def pytest_bdd_before_scenario(request, feature, scenario) -> None:
    if _rasto(request):
        _cases[request.node.nodeid] = _Case(feature, scenario)


def pytest_bdd_before_step(request, feature, scenario, step, step_func) -> None:
    rasto, case = _rasto(request), _cases.get(request.node.nodeid)
    if not rasto or not case:
        return
    case.started += 1
    if case.recording and not case.closed:
        _sync(rasto, case)


@pytest.hookimpl(wrapper=True)
def pytest_fixture_setup(fixturedef, request):
    page = yield
    rasto, case = _rasto(request), _cases.get(request.node.nodeid)
    if fixturedef.argname == "page" and rasto and case and not case.recording:
        _start(rasto, case, page, request)
    return page


def _start(rasto: _Rasto, case: _Case, page, request) -> None:
    """The page exists (usually in the middle of the first UI step): record its tab, then catch up with pytest-bdd."""
    # A title no other tab has, so Rasto picks this one; the page replaces it as soon as it loads something.
    title = f"rasto-{uuid.uuid4().hex[:12]}"
    page.evaluate("title => { document.title = title; }", title)

    status = rasto.wait(_idle)
    if not _idle(status):
        _warn(f"Rasto is still busy with the previous recording; {case.scenario.name!r} is not recorded")
        return

    with tempfile.TemporaryDirectory(prefix="rasto-") as folder:
        # Rasto reads the file before it answers, so it can go right after.
        feature = Path(folder) / (Path(case.feature.filename).stem + ".feature")
        feature.write_text(case.feature_text(), encoding="utf-8")
        answer = rasto.record(feature, title, request.config.getoption("rasto_subject"), request.config.getoption("rasto_config"))
    if not answer.get("ok"):
        _warn(f"{case.scenario.name!r} is not recorded: {answer.get('error')}")
        return
    case.recording = True
    if case.started > 0:
        _sync(rasto, case)


def pytest_bdd_step_error(request, feature, scenario, step, step_func, step_func_args, exception) -> None:
    rasto, case = _rasto(request), _cases.get(request.node.nodeid)
    if rasto and case:
        _close(rasto, case, "fail")


def pytest_bdd_step_func_lookup_error(request, feature, scenario, step, exception) -> None:
    rasto, case = _rasto(request), _cases.get(request.node.nodeid)
    if rasto and case:
        case.started += 1
        _sync(rasto, case)
        _close(rasto, case, "blocked")


def pytest_bdd_after_scenario(request, feature, scenario) -> None:
    # Called after a failure too (pytest-bdd calls it in a finally): only a case still open passed.
    rasto, case = _rasto(request), _cases.get(request.node.nodeid)
    if rasto and case:
        _close(rasto, case, "pass")


@pytest.hookimpl(wrapper=True)
def pytest_runtest_teardown(item, nextitem):
    rasto, case = item.config.stash.get(_RASTO, None), _cases.pop(item.nodeid, None)
    if rasto and case and case.recording:
        # Something stopped the scenario before any result (e.g. a fixture failed): it can't be called passed.
        _close(rasto, case, "blocked")
        # The result shows for 2 s, then Rasto stops: wait for that before the fixtures tear down (logout, closing
        # the page), so the video ends with the result rather than the clean-up.
        rasto.wait(lambda status: not status.get("recording"), timeout=30)
    return (yield)


def pytest_sessionfinish(session: pytest.Session) -> None:
    rasto = session.config.stash.get(_RASTO, None)
    if rasto:
        # Rasto compresses the last video after it stops; don't let the run end (and maybe Rasto quit) before that.
        rasto.wait(lambda status: not status.get("compressing"), timeout=300)
