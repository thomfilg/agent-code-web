#!/usr/bin/python3 -I
"""Emit only bounded stage/boolean diagnostics, never cloud-init log contents."""
import json
import os
import pathlib
import shutil
import subprocess
import sys

try:
    completed = subprocess.run(['cloud-init', 'status', '--wait', '--format', 'json'], capture_output=True, text=True, timeout=1650)
    try:
        state = json.loads(completed.stdout)
    except (TypeError, ValueError):
        state = {}
except (OSError, subprocess.TimeoutExpired):
    completed = None
    state = {}

status = state.get('status', 'unknown')
if status not in ('done', 'running', 'error', 'disabled', 'not run'):
    status = 'unknown'
error_values = [state.get('errors'), state.get('recoverable_errors')]
failed_modules = []
for stage in ('init-local', 'init-network', 'modules-config', 'modules-final'):
    detail = state.get(stage)
    if isinstance(detail, dict) and (detail.get('errors') or detail.get('recoverable_errors')):
        failed_modules.append(stage)
        error_values.extend([detail.get('errors'), detail.get('recoverable_errors')])
errors = json.dumps(error_values).replace('_', '-')
failed_modules.extend(name for name in ('package-update-upgrade-install', 'scripts-user', 'ssh') if name in errors)


def version_ok(command, expected=None):
    if not shutil.which(command):
        return False
    try:
        result = subprocess.run([command, '--version'], capture_output=True, text=True, timeout=30)
        return result.returncode == 0 and (expected is None or result.stdout.strip() == expected)
    except (OSError, subprocess.TimeoutExpired):
        return False


checks = {
    'node': version_ok('node'),
    'codex': version_ok('codex', 'codex-cli 0.154.0'),
    'claude': version_ok('claude', '2.1.222 (Claude Code)'),
    'docker': version_ok('docker'),
    'chrome': version_ok('google-chrome'),
    'readyMarker': pathlib.Path('/opt/agent-web/READY').is_file(),
    'finalizer': pathlib.Path('/usr/local/sbin/agent-web-finalize-image').is_file() and os.access('/usr/local/sbin/agent-web-finalize-image', os.X_OK),
    'auditHelper': pathlib.Path('/usr/local/sbin/agent-web-audit-image').is_file() and os.access('/usr/local/sbin/agent-web-audit-image', os.X_OK),
    'systemdVerified': False,
}
ordering_cycle = False
try:
    verified = subprocess.run(['systemd-analyze', 'verify', '/etc/systemd/system/agent-web-hostkeys.service', 'ssh.socket', 'ssh.service'], capture_output=True, text=True, timeout=30)
    ordering_cycle = 'ordering cycle' in verified.stderr.lower()
    checks['systemdVerified'] = verified.returncode == 0
except (OSError, subprocess.TimeoutExpired):
    pass

receipt = {'kind': 'relay-worker-bootstrap', 'schema': 1, 'status': status, 'failedModules': failed_modules, 'checks': checks, 'sshOrderingCycle': ordering_cycle}
print(json.dumps(receipt))
sys.exit(0 if completed is not None and completed.returncode == 0 and status == 'done' and all(checks.values()) and not ordering_cycle else 1)
