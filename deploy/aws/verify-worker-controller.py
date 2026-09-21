#!/usr/bin/python3 -I
"""Fixed controller-side acceptance probe, delivered through SSM without keys.

The controller retrieves its own deployment secret locally. Only public
identity hashes, a public known-host entry and booleans leave this process.
"""
import base64
import gzip
import json
import ipaddress
import os
import pathlib
import re
import shlex
import subprocess
import sys
import tempfile
import time


AUDIT_CHECKS = ('finalized', 'cloudInitDisabled', 'ssmDisabled', 'credentialsAbsent',
                'transportKeyMatches', 'metadataReachable', 'freshIdentity',
                'heartbeatEnabled', 'watchdogActive')
CREDENTIAL_COUNTS = ('providerAuthFiles', 'sshPrivateKeyFiles', 'pemFiles', 'ssmLibraryFiles',
                     'ssmSnapFiles', 'ssmSnapshotFiles', 'ssmPackageFiles',
                     'unexpectedAuthorizedKeys', 'scanErrors')
METADATA_RESULTS = ('token-endpoint-accessible', 'http-403-denied', 'http-401-unauthorized',
                    'unexpected-http-response', 'network-unavailable', 'unexpected-network-error')
PROBE_STAGES = ('request', 'identity', 'native-version', 'image-audit-run', 'image-audit-json',
                'image-audit-validation', 'heartbeat', 'sentinel', 'native-process',
                'application-transport', 'receipt')
EXCEPTION_CLASSES = ('RuntimeError', 'JSONDecodeError', 'FileNotFoundError', 'PermissionError',
                     'TimeoutExpired', 'CalledProcessError', 'OSError', 'ValueError', 'TypeError',
                     'KeyError', 'IndexError', 'AttributeError', 'NameError', 'UnboundLocalError',
                     'ImportError', 'ModuleNotFoundError', 'UnicodeDecodeError', 'AssertionError')
APPLICATION_STAGES = ('bundle', 'service', 'status', 'configure', 'connect', 'launch', 'attach',
                      'initialize-input', 'initialize-response', 'initialize-error', 'initialize-frame',
                      'initialize-timeout', 'initialize-notify', 'initialize-status', 'initialize-ack',
                      'checkpoint', 'takeover', 'read', 'read-error', 'read-frame',
                      'read-timeout', 'no-replay', 'terminate', 'release', 'native-terminate',
                      'browser-configure', 'browser-connect', 'browser-launch', 'browser-attach',
                      'browser-ready', 'browser-ready-fatal', 'browser-ready-frame', 'browser-ready-timeout',
                      'browser-state-input', 'browser-state-response', 'browser-state-error',
                      'browser-state-frame', 'browser-state-timeout', 'browser-identity',
                      'browser-takeover', 'browser-no-replay', 'browser-terminate', 'browser-release')
APPLICATION_FRAME_DETAILS = ('line', 'json', 'envelope', 'output-identity', 'output-data',
                             'output-size', 'stdout-json')
BROWSER_FAILURES = ('executable', 'sandbox', 'chrome-exited', 'startup-timeout', 'worker-fatal')


class ProbeFailure(RuntimeError):
    def __init__(self, category, exit_code=None, audit_checks=None, credential_counts=None, metadata_probe=None, details=None):
        super().__init__('Private worker SSH/audit failed; no key or private output emitted')
        self.diagnostic = {'stage': 'worker-probe', 'category': category}
        if isinstance(exit_code, int) and -255 <= exit_code <= 255:
            self.diagnostic['exitCode'] = exit_code
        if category == 'image-audit' and isinstance(audit_checks, dict):
            safe_checks = {key: audit_checks[key] for key in AUDIT_CHECKS
                           if type(audit_checks.get(key)) is bool}
            if safe_checks:
                self.diagnostic['auditChecks'] = safe_checks
        if category == 'image-audit' and isinstance(credential_counts, dict):
            safe_counts = {key: credential_counts[key] for key in CREDENTIAL_COUNTS
                           if type(credential_counts.get(key)) is int and 0 <= credential_counts[key] <= 1000000}
            if safe_counts:
                self.diagnostic['credentialFailureCounts'] = safe_counts
        if category == 'image-audit' and metadata_probe in METADATA_RESULTS:
            self.diagnostic['metadataProbe'] = metadata_probe
        if isinstance(details, dict):
            if details.get('probeStage') in PROBE_STAGES:
                self.diagnostic['probeStage'] = details['probeStage']
            for field in ('exceptionClass', 'helperExceptionClass'):
                if details.get(field) in EXCEPTION_CLASSES:
                    self.diagnostic[field] = details[field]
            if details.get('probeStage') == 'image-audit-json' and type(details.get('helperLine')) is int and 1 <= details['helperLine'] <= 10000:
                self.diagnostic['helperLine'] = details['helperLine']
            if category == 'application-transport' and details.get('applicationStage') in APPLICATION_STAGES:
                self.diagnostic['applicationStage'] = details['applicationStage']
            if category == 'application-transport' and details.get('applicationFrame') in APPLICATION_FRAME_DETAILS:
                self.diagnostic['applicationFrame'] = details['applicationFrame']
            if category == 'application-transport' and details.get('browserFailure') in BROWSER_FAILURES:
                self.diagnostic['browserFailure'] = details['browserFailure']


def probe_failure(result):
    """Classify private subprocess output locally; never return its contents."""
    try:
        worker_failure = json.loads(result.stdout)
        reason = worker_failure.get('reason')
    except Exception:
        reason = None
    known_checks = {'wrong worker user': 'worker-user', 'native version mismatch': 'native-version',
                    'image scrub audit failed': 'image-audit', 'boot heartbeat is stale': 'heartbeat',
                    'worker sentinel mismatch': 'sentinel', 'native process did not survive hibernation': 'native-process',
                    'application transport did not survive hibernation': 'application-transport',
                    'invalid-worker-receipt': 'invalid-receipt'}
    if reason in known_checks:
        return ProbeFailure(known_checks[reason], result.returncode, worker_failure.get('auditChecks'), worker_failure.get('credentialFailureCounts'), worker_failure.get('metadataProbe'), worker_failure)
    stderr = (result.stderr or '').lower()
    if 'host key verification failed' in stderr or 'remote host identification has changed' in stderr:
        category = 'ssh-host-key'
    elif 'permission denied' in stderr or 'authentication failed' in stderr:
        category = 'ssh-permission-denied'
    elif 'connection refused' in stderr:
        category = 'ssh-connection-refused'
    elif 'timed out' in stderr or 'no route to host' in stderr or 'network is unreachable' in stderr:
        category = 'ssh-network-unreachable'
    elif result.returncode == 127:
        category = 'remote-command-missing'
    else:
        category = 'ssh-transport' if result.returncode == 255 else 'remote-command-failed'
    return ProbeFailure(category, result.returncode)


def failure_receipt(error):
    # RuntimeError descriptions originate in this fixed script. Other exception
    # strings can contain subprocess output, secret JSON or paths: omit them.
    result = {'error': 'Controller worker acceptance failed; private diagnostics suppressed',
              'reason': str(error) if isinstance(error, RuntimeError) else 'unexpected-probe-failure'}
    if isinstance(error, ProbeFailure):
        result['diagnostic'] = error.diagnostic
    return result


WORKER_PROBE = r'''
import base64, hashlib, json, os, pathlib, re, select, shutil, socket, subprocess, sys, time, zlib
audit_checks = {}
credential_counts = {}
metadata_probe = None
application_stage = 'bundle'
application_frame_detail = None
browser_failure = None
stage = 'request'
audit = None
exception_classes = ('RuntimeError', 'JSONDecodeError', 'FileNotFoundError', 'PermissionError', 'TimeoutExpired', 'CalledProcessError', 'OSError', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'AttributeError', 'NameError', 'UnboundLocalError', 'ImportError', 'ModuleNotFoundError', 'UnicodeDecodeError', 'AssertionError')

def application_failure():
    raise RuntimeError('application transport did not survive hibernation')

def application_at(value):
    global application_stage
    application_stage = value

def application_frame_failure(value):
    global application_frame_detail
    application_frame_detail = value
    application_failure()

def browser_start_failure(value):
    global browser_failure
    message = value.get('message', '') if isinstance(value, dict) else ''
    lowered = message.lower() if isinstance(message, str) else ''
    if 'enoent' in lowered or 'no such file' in lowered:
        browser_failure = 'executable'
    elif 'sandbox' in lowered or 'namespace' in lowered:
        browser_failure = 'sandbox'
    elif 'timed out' in lowered:
        browser_failure = 'startup-timeout'
    elif 'chrome exited' in lowered:
        browser_failure = 'chrome-exited'
    else:
        browser_failure = 'worker-fatal'
    application_at('browser-ready-fatal')
    application_failure()

SUPERVISOR_FILES = ('worker-process-anchor.mjs', 'worker-process-supervisor.mjs',
                    'worker-transport-wire.mjs', 'worker-supervisor-paths.mjs',
                    'worker-supervisor-daemon.mjs', 'worker-supervisor-daemon-cli.mjs',
                    'worker-supervisor-control.mjs', 'worker-supervisor-bridge.mjs',
                    'worker-supervisor-service.mjs')

def install_supervisor(request, phase):
    application_at('bundle')
    encoded = request.get('supervisorBundle')
    if not isinstance(encoded, str) or len(encoded) > 32768 or not re.fullmatch(r'[A-Za-z0-9+/=]+', encoded):
        application_failure()
    try:
        compressed = base64.b64decode(encoded, validate=True)
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
        raw = decoder.decompress(compressed, 131073)
        if len(raw) > 131072 or decoder.unconsumed_tail or decoder.unused_data or not decoder.eof:
            application_failure()
        bundle = json.loads(raw)
    except (ValueError, TypeError, OSError, json.JSONDecodeError):
        application_failure()
    if bundle.get('schema') != 1 or bundle.get('version') != 'v3' or set(bundle.get('files', {})) != set(SUPERVISOR_FILES) or not isinstance(bundle.get('browserWorker'), str) or not isinstance(bundle.get('unit'), str):
        application_failure()
    root = pathlib.Path('/opt/agent-web/supervisor-code')
    unit = pathlib.Path('/home/agent/.config/systemd/user/agent-relay-worker-supervisor.service')
    if phase == 'fresh':
        if root.exists() or unit.exists():
            application_failure()
        root.mkdir(mode=0o700)
        unit.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in SUPERVISOR_FILES:
        content = bundle['files'].get(name)
        if not isinstance(content, str) or len(content.encode()) > 65536:
            application_failure()
        target = root / name
        if phase == 'fresh':
            fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'w') as output:
                output.write(content)
        elif not target.is_file() or target.is_symlink() or target.read_text() != content:
            application_failure()
    browser_source = bundle['browserWorker']
    if len(browser_source.encode()) > 65536:
        application_failure()
    browser_target = root / 'browser-worker.mjs'
    if phase == 'fresh':
        fd = os.open(browser_target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(browser_source)
    elif not browser_target.is_file() or browser_target.is_symlink() or browser_target.read_text() != browser_source:
        application_failure()
    if phase == 'fresh':
        fd = os.open(unit, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as output:
            output.write(bundle['unit'])
    elif not unit.is_file() or unit.is_symlink() or unit.read_text() != bundle['unit']:
        application_failure()
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/home/agent',
                   'XDG_RUNTIME_DIR': '/run/user/' + str(os.getuid()), 'LANG': 'C.UTF-8'}
    command = ['systemctl', '--user', 'is-active', '--quiet', 'agent-relay-worker-supervisor.service']
    if phase == 'fresh':
        command = ['/bin/sh', '-c', 'systemctl --user daemon-reload && systemctl --user enable --now agent-relay-worker-supervisor.service && systemctl --user is-active --quiet agent-relay-worker-supervisor.service']
    application_at('service')
    active = subprocess.run(command, capture_output=True, timeout=20, env=environment)
    if active.returncode:
        application_failure()

def supervisor_control(value):
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/home/agent',
                   'XDG_RUNTIME_DIR': '/run/user/' + str(os.getuid()), 'LANG': 'C.UTF-8'}
    result = subprocess.run(['/usr/bin/node', '/opt/agent-web/supervisor-code/worker-supervisor-control.mjs'],
                            input=json.dumps(value), capture_output=True, text=True, timeout=15, env=environment)
    if result.returncode:
        application_failure()
    try:
        parsed = json.loads(result.stdout)
    except (json.JSONDecodeError, TypeError):
        application_failure()
    if not isinstance(parsed, dict) or parsed.get('error'):
        application_failure()
    return parsed

class ApplicationClient:
    def __init__(self, identity, credential, receipt=None, cursor=0, process_id='native-agent'):
        self.identity = identity
        self.credential = credential
        self.receipt = receipt
        self.cursor = cursor
        self.process_id = process_id
        self.counter = 0
        self.stdout = b''
        self.messages = []
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(60)
        self.sock.connect('/run/user/' + str(os.getuid()) + '/agent-relay-worker/process.sock')
        self.stream = self.sock.makefile('rb')

    def close(self):
        try:
            self.stream.close()
        finally:
            self.sock.close()

    def frame(self):
        line = self.stream.readline(262145)
        if not line or len(line) > 262144 or not line.endswith(b'\n'):
            application_frame_failure('line')
        try:
            value = json.loads(line)
        except (json.JSONDecodeError, UnicodeDecodeError):
            application_frame_failure('json')
        if not isinstance(value, dict):
            application_frame_failure('envelope')
        if value.get('event') == 'output':
            if not self.receipt or value.get('supervisorInstanceId') != self.receipt.get('supervisorInstanceId') or value.get('processId') != self.process_id or value.get('processInstanceId') != self.receipt.get('processInstanceId') or value.get('seq') != self.cursor + 1 or value.get('channel') not in ('stdout', 'stderr', 'exit'):
                application_frame_failure('output-identity')
            try:
                data = base64.b64decode(value.get('data', ''), validate=True)
            except (ValueError, TypeError):
                application_frame_failure('output-data')
            if len(data) > 16384:
                application_frame_failure('output-size')
            self.cursor = value['seq']
            if value['channel'] == 'stdout':
                self.stdout += data
                while b'\n' in self.stdout:
                    line, self.stdout = self.stdout.split(b'\n', 1)
                    try:
                        message = json.loads(line)
                    except (json.JSONDecodeError, UnicodeDecodeError):
                        application_frame_failure('stdout-json')
                    if isinstance(message, dict):
                        self.messages.append(message)
            return None
        return value

    def request(self, action, fields=None):
        self.counter += 1
        request_id = 'acceptance-' + str(self.counter)
        value = {'protocol': 'relay-worker-process/1', 'id': request_id, 'action': action,
                 'processId': self.process_id, 'identity': self.identity, 'lease': self.credential}
        value.update(fields or {})
        encoded = (json.dumps(value, separators=(',', ':')) + '\n').encode()
        if len(encoded) > 262144:
            application_failure()
        self.sock.sendall(encoded)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            response = self.frame()
            if response is None:
                continue
            if response.get('id') != request_id or response.get('error') or not isinstance(response.get('result'), dict):
                application_failure()
            return response['result']
        application_failure()

    def line_response(self, response_id, stage):
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            for message in self.messages:
                if message.get('id') == response_id and 'method' not in message:
                    if message.get('error'):
                        application_at(stage + '-error')
                        application_failure()
                    return message
            try:
                self.frame()
            except socket.timeout:
                continue
            except RuntimeError:
                application_at(stage + '-frame')
                raise
        application_at(stage + '-timeout')
        application_failure()

    def app_response(self, response_id, stage):
        return self.line_response(response_id, stage).get('result')

    def event(self, name, stage, keepalive=None):
        deadline = time.monotonic() + 120
        last_keepalive = time.monotonic()
        while time.monotonic() < deadline:
            for message in self.messages:
                if message.get('event') == name:
                    return message.get('value')
                if name == 'ready' and message.get('event') in ('fatal', 'closed', 'chromeStopped'):
                    browser_start_failure(message.get('value'))
            if keepalive and time.monotonic() - last_keepalive >= 10:
                try:
                    keepalive()
                    self.request('status', {'processInstanceId': self.receipt['processInstanceId']})
                except OSError:
                    application_at(stage + '-frame')
                    application_frame_failure('line')
                except RuntimeError:
                    application_at(stage + '-frame')
                    raise
                last_keepalive = time.monotonic()
                continue
            try:
                readable, _, _ = select.select([self.sock], [], [], 5)
                if not readable:
                    continue
                self.frame()
            except OSError:
                application_at(stage + '-frame')
                application_frame_failure('line')
            except RuntimeError:
                application_at(stage + '-frame')
                raise
        application_at(stage + '-timeout')
        application_failure()

    def input(self, sequence, message):
        data = (json.dumps(message, separators=(',', ':')) + '\n').encode()
        self.request('input', {'processInstanceId': self.receipt['processInstanceId'], 'seq': sequence,
                              'data': base64.b64encode(data).decode()})

def process_record(pid):
    raw = pathlib.Path('/proc/' + str(pid) + '/stat').read_text()
    fields = raw[raw.rfind(') ') + 2:].split()
    command = pathlib.Path('/proc/' + str(pid) + '/cmdline').read_bytes().split(b'\0')
    return {'pid': pid, 'ppid': int(fields[1]), 'start': fields[19], 'command': command}

def browser_process_state(worker_pid):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            records = {}
            for item in pathlib.Path('/proc').iterdir():
                if item.name.isdigit():
                    try:
                        record = process_record(int(item.name)); records[record['pid']] = record
                    except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError, IndexError):
                        pass
            descendants = {worker_pid}
            changed = True
            while changed:
                changed = False
                for record in records.values():
                    if record['ppid'] in descendants and record['pid'] not in descendants:
                        descendants.add(record['pid']); changed = True
            selected = [records[pid] for pid in descendants if pid in records]
            # Chrome's zygote may rewrite descendant argv into one space-joined
            # /proc cmdline field. Classify fixed flags across the complete byte
            # sequence rather than assuming one NUL-delimited flag per entry.
            command_line = lambda record: b'\0'.join(record['command'])
            browsers = [record for record in selected if b'--remote-debugging-pipe' in command_line(record) and b'--type=' not in command_line(record)]
            renderers = [record for record in selected if b'--type=renderer' in command_line(record)]
            worker = records.get(worker_pid)
            if worker and len(browsers) == 1 and renderers:
                renderer = min(renderers, key=lambda value: value['pid'])
                return {'boot': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                        'worker': {'pid': worker['pid'], 'start': worker['start']},
                        'browser': {'pid': browsers[0]['pid'], 'start': browsers[0]['start']},
                        'renderer': {'pid': renderer['pid'], 'start': renderer['start']}}
        except (FileNotFoundError, PermissionError, ProcessLookupError, ValueError, IndexError):
            pass
        time.sleep(0.1)
    application_failure()

def process_state_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

def terminate_application(client, receipt, label):
    application_at(label + '-terminate')
    client.request('terminate', {'processInstanceId': receipt['processInstanceId']})
    deadline = time.monotonic() + 15
    transport_status = {}
    while time.monotonic() < deadline:
        transport_status = client.request('status', {'processInstanceId': receipt['processInstanceId']})
        if transport_status.get('state') == 'exited':
            break
        time.sleep(0.1)
    if transport_status.get('state') != 'exited':
        application_failure()
    if client.cursor:
        client.request('ackOutput', {'processInstanceId': receipt['processInstanceId'], 'seq': client.cursor})

def application_probe(request):
    verification_id = request['verificationId']
    phase = request['phase']
    state_path = pathlib.Path('/opt/agent-web/verify-' + verification_id + '.application')
    home = pathlib.Path('/tmp/relay-hibernation-' + verification_id)
    identity = {'deploymentId': request['deployment'], 'ownerId': 'acceptance-owner',
                'chatId': 'acceptance-chat', 'workerId': request['workerId'], 'provider': 'codex',
                'accountId': 'acceptance-account', 'attemptId': 'acceptance-' + verification_id}
    generation = 1 if phase == 'fresh' else 2
    def lease_for(process_id):
        credential = base64.urlsafe_b64encode(hashlib.sha256(('lease:' + phase + ':' + process_id + ':' + verification_id).encode()).digest()).decode().rstrip('=')
        return {'id': 'acceptance-' + phase + '-' + process_id, 'generation': generation,
                'expiresAt': int(time.time() * 1000) + 55000, 'credential': credential}
    install_supervisor(request, phase)
    application_at('status')
    status = None
    for attempt in range(20):
        try:
            status = supervisor_control({'action': 'status'})
            break
        except RuntimeError:
            if attempt == 19:
                raise
            time.sleep(0.25)
    if status.get('protocol') != 'relay-worker-supervisor/1' or status.get('version') != 'v3' or not isinstance(status.get('daemonInstanceId'), str):
        application_failure()
    if phase == 'fresh':
        if status.get('configured') is not False or state_path.exists():
            application_failure()
        home.mkdir(mode=0o700)
        state = None
    else:
        try:
            state = json.loads(state_path.read_text())
        except (OSError, json.JSONDecodeError):
            application_failure()
        if status.get('configured') is not True or status.get('daemonInstanceId') != state.get('daemonInstanceId') or status.get('supervisorInstanceId') != state.get('receipt', {}).get('supervisorInstanceId'):
            application_failure()
        processes = status.get('processes')
        indexed = {item.get('processId'): item for item in processes} if isinstance(processes, list) else {}
        if set(indexed) != {'native-agent', 'shared-chrome'} or indexed['native-agent'].get('processInstanceId') != state.get('receipt', {}).get('processInstanceId') or indexed['shared-chrome'].get('processInstanceId') != state.get('browserReceipt', {}).get('processInstanceId'):
            application_failure()
    native_lease = lease_for('native-agent')
    application_at('configure')
    configured = supervisor_control({'action': 'configure', 'identity': identity, 'processId': 'native-agent', 'lease': native_lease})
    if configured.get('configured') is not True or configured.get('daemonInstanceId') != status['daemonInstanceId'] or configured.get('processId') != 'native-agent' or configured.get('lease', {}).get('generation') != generation:
        application_failure()
    application_at('connect')
    client = ApplicationClient(identity, native_lease['credential'], state.get('receipt') if state else None, state.get('cursor', 0) if state else 0)
    try:
        if phase == 'fresh':
            application_at('launch')
            codex_path = shutil.which('codex', path='/usr/local/bin:/usr/bin:/bin')
            if codex_path not in ('/usr/local/bin/codex', '/usr/bin/codex') or not os.access(codex_path, os.X_OK):
                application_failure()
            receipt = client.request('launch', {'spec': {'command': codex_path,
                'args': ['app-server', '-c', 'cli_auth_credentials_store="ephemeral"'], 'cwd': '/tmp',
                'env': {'HOME': str(home), 'CODEX_HOME': str(home), 'PATH': '/usr/local/bin:/usr/bin:/bin',
                        'LANG': 'C.UTF-8', 'USER': 'agent'}}})
            client.receipt = receipt
            if receipt.get('protocol') != 'relay-worker-process/1' or receipt.get('processId') != 'native-agent' or not isinstance(receipt.get('pid'), int):
                application_failure()
            application_at('attach')
            attached = client.request('attach', {'processInstanceId': receipt['processInstanceId'], 'committedOutputSeq': 0})
            if attached.get('processInstanceId') != receipt['processInstanceId']:
                application_failure()
            application_at('initialize-input')
            client.input(1, {'method': 'initialize', 'id': 1, 'params': {'clientInfo': {'name': 'relay_hibernation_acceptance', 'version': '1'}, 'capabilities': {'experimentalApi': True}}})
            application_at('initialize-response')
            client.app_response(1, 'initialize')
            application_at('initialize-notify')
            client.input(2, {'method': 'initialized', 'params': {}})
            application_at('initialize-status')
            transport_status = client.request('status', {'processInstanceId': receipt['processInstanceId']})
            if transport_status.get('inputAcceptedThrough') != 2 or transport_status.get('pid') != receipt['pid']:
                application_failure()
            if client.cursor:
                application_at('initialize-ack')
                client.request('ackOutput', {'processInstanceId': receipt['processInstanceId'], 'seq': client.cursor})
            state = {'daemonInstanceId': status['daemonInstanceId'], 'receipt': receipt, 'cursor': client.cursor}
        else:
            application_at('takeover')
            receipt = state['receipt']
            inspected = client.request('inspect')
            stable = ('supervisorInstanceId', 'processInstanceId', 'processId', 'pid', 'startedAt', 'groupAnchor')
            if any(inspected.get(key) != receipt.get(key) for key in stable):
                application_failure()
            attached = client.request('attach', {'processInstanceId': receipt['processInstanceId'], 'committedOutputSeq': state['cursor']})
            if attached.get('processInstanceId') != receipt['processInstanceId']:
                application_failure()
            application_at('read')
            client.input(3, {'method': 'thread/list', 'id': 2, 'params': {'limit': 1}})
            listed = client.app_response(2, 'read')
            if not isinstance(listed, dict) or not isinstance(listed.get('data'), list):
                application_failure()
            transport_status = client.request('status', {'processInstanceId': receipt['processInstanceId']})
            application_at('no-replay')
            if transport_status.get('inputAcceptedThrough') != 3 or transport_status.get('pid') != receipt['pid']:
                application_failure()
            if client.cursor:
                client.request('ackOutput', {'processInstanceId': receipt['processInstanceId'], 'seq': client.cursor})
        browser_lease = lease_for('shared-chrome')
        application_at('browser-configure')
        browser_configured = supervisor_control({'action': 'configure', 'identity': identity, 'processId': 'shared-chrome', 'lease': browser_lease})
        if browser_configured.get('configured') is not True or browser_configured.get('daemonInstanceId') != status['daemonInstanceId'] or browser_configured.get('supervisorInstanceId') != configured.get('supervisorInstanceId') or browser_configured.get('processId') != 'shared-chrome' or browser_configured.get('lease', {}).get('generation') != generation:
            application_failure()
        def browser_keepalive():
            browser_lease['expiresAt'] = int(time.time() * 1000) + 55000
            renewed = supervisor_control({'action': 'configure', 'identity': identity, 'processId': 'shared-chrome', 'lease': browser_lease})
            if renewed.get('configured') is not True or renewed.get('processId') != 'shared-chrome' or renewed.get('lease', {}).get('generation') != generation:
                application_failure()
        application_at('browser-connect')
        browser_client = ApplicationClient(identity, browser_lease['credential'], state.get('browserReceipt') if state else None, state.get('browserCursor', 0) if state else 0, 'shared-chrome')
        try:
            browser_token = hashlib.sha256(('browser-state:' + verification_id).encode()).hexdigest()
            browser_state_identity = hashlib.sha256(('renderer:' + browser_token).encode()).hexdigest()
            if phase == 'fresh':
                application_at('browser-launch')
                browser_receipt = browser_client.request('launch', {'spec': {'command': '/usr/bin/node',
                    'args': ['--input-type=module', '-e', "import {runBrowserWorker} from 'file:///opt/agent-web/supervisor-code/browser-worker.mjs'; await runBrowserWorker();"],
                    'cwd': '/tmp', 'env': {'HOME': str(home), 'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
                                             'AGENT_CHROME_BIN': '/usr/bin/google-chrome'}}})
                browser_client.receipt = browser_receipt
                if browser_receipt.get('protocol') != 'relay-worker-process/1' or browser_receipt.get('processId') != 'shared-chrome' or not isinstance(browser_receipt.get('pid'), int):
                    application_failure()
                application_at('browser-attach')
                attached = browser_client.request('attach', {'processInstanceId': browser_receipt['processInstanceId'], 'committedOutputSeq': 0})
                if attached.get('processInstanceId') != browser_receipt['processInstanceId']:
                    application_failure()
                application_at('browser-ready')
                ready = browser_client.event('ready', 'browser-ready', browser_keepalive)
                if not isinstance(ready, dict) or not isinstance(ready.get('tabs'), list):
                    application_failure()
                expression = "(() => { globalThis.__relayHibernation = { token: " + json.dumps(browser_token) + ", counter: 1 }; return {...globalThis.__relayHibernation}; })()"
                application_at('browser-state-input')
                browser_client.input(1, {'id': 1, 'action': 'evaluate', 'params': {'expression': expression}})
                application_at('browser-state-response')
                browser_value = browser_client.line_response(1, 'browser-state').get('value')
                if browser_value != {'token': browser_token, 'counter': 1}:
                    application_failure()
                browser_counter = 1
                application_at('browser-identity')
                browser_state = browser_process_state(browser_receipt['pid'])
                browser_process_identity = process_state_hash(browser_state)
                browser_status = browser_client.request('status', {'processInstanceId': browser_receipt['processInstanceId']})
                if browser_status.get('inputAcceptedThrough') != 1 or browser_status.get('pid') != browser_receipt['pid']:
                    application_failure()
                if browser_client.cursor:
                    browser_client.request('ackOutput', {'processInstanceId': browser_receipt['processInstanceId'], 'seq': browser_client.cursor})
                state.update({'browserReceipt': browser_receipt, 'browserCursor': browser_client.cursor,
                              'browserProcess': browser_state, 'browserStateIdentity': browser_state_identity})
                application_at('checkpoint')
                fd = os.open(state_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, 'w') as target:
                    json.dump(state, target, sort_keys=True, separators=(',', ':'))
            else:
                application_at('browser-takeover')
                browser_receipt = state['browserReceipt']
                inspected = browser_client.request('inspect')
                stable = ('supervisorInstanceId', 'processInstanceId', 'processId', 'pid', 'startedAt', 'groupAnchor')
                if any(inspected.get(key) != browser_receipt.get(key) for key in stable):
                    application_failure()
                attached = browser_client.request('attach', {'processInstanceId': browser_receipt['processInstanceId'], 'committedOutputSeq': state['browserCursor']})
                if attached.get('processInstanceId') != browser_receipt['processInstanceId']:
                    application_failure()
                application_at('browser-identity')
                browser_state = browser_process_state(browser_receipt['pid'])
                browser_process_identity = process_state_hash(browser_state)
                if browser_state != state.get('browserProcess') or browser_state_identity != state.get('browserStateIdentity'):
                    application_failure()
                expression = "(() => { const value = globalThis.__relayHibernation; if (!value || value.token !== " + json.dumps(browser_token) + " || value.counter !== 1) return null; value.counter += 1; return {...value}; })()"
                application_at('browser-state-input')
                browser_client.input(2, {'id': 2, 'action': 'evaluate', 'params': {'expression': expression}})
                application_at('browser-state-response')
                browser_value = browser_client.line_response(2, 'browser-state').get('value')
                if browser_value != {'token': browser_token, 'counter': 2}:
                    application_failure()
                browser_counter = 2
                browser_status = browser_client.request('status', {'processInstanceId': browser_receipt['processInstanceId']})
                application_at('browser-no-replay')
                if browser_status.get('inputAcceptedThrough') != 2 or browser_status.get('pid') != browser_receipt['pid']:
                    application_failure()
                if browser_client.cursor:
                    browser_client.request('ackOutput', {'processInstanceId': browser_receipt['processInstanceId'], 'seq': browser_client.cursor})
                terminate_application(browser_client, browser_receipt, 'browser')
                terminate_application(client, receipt, 'native')
                application_at('browser-release')
                browser_released = supervisor_control({'action': 'release', 'processId': 'shared-chrome',
                    'processInstanceId': browser_receipt['processInstanceId'], 'leaseId': browser_lease['id']})
                application_at('release')
                native_released = supervisor_control({'action': 'release', 'processId': 'native-agent',
                    'processInstanceId': receipt['processInstanceId'], 'leaseId': native_lease['id']})
                if browser_released.get('released') is not True or native_released.get('released') is not True or supervisor_control({'action': 'reset'}).get('reset') is not True:
                    application_failure()
                state_path.unlink()
                shutil.rmtree(home)
        finally:
            browser_client.close()
    finally:
        client.close()
    native_stable = {key: receipt.get(key) for key in ('supervisorInstanceId', 'processInstanceId', 'processId', 'pid', 'startedAt', 'groupAnchor')}
    browser_stable = {key: browser_receipt.get(key) for key in ('supervisorInstanceId', 'processInstanceId', 'processId', 'pid', 'startedAt', 'groupAnchor')}
    application_identity = hashlib.sha256(json.dumps({'native': native_stable, 'browser': browser_stable}, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return {'applicationIdentity': application_identity, 'browserProcessIdentity': browser_process_identity,
            'browserStateIdentity': browser_state_identity, 'browserCounter': browser_counter}

try:
    request = json.loads(sys.argv[1])
    stage = 'identity'
    if subprocess.check_output(['/usr/bin/id', '-un'], text=True).strip() != 'agent':
        raise RuntimeError('wrong worker user')
    versions = {}
    stage = 'native-version'
    for command, expected in [('codex', 'codex-cli 0.154.0'), ('claude', '2.1.222 (Claude Code)')]:
        result = subprocess.run([command, '--version'], capture_output=True, text=True, timeout=30)
        if result.returncode or result.stdout.strip() != expected:
            raise RuntimeError('native version mismatch')
        versions[command] = expected
    stage = 'image-audit-run'
    audit = subprocess.run(['/usr/bin/sudo', '-n', '/usr/local/sbin/agent-web-audit-image'], capture_output=True, text=True, timeout=30)
    stage = 'image-audit-json'
    receipt = json.loads(audit.stdout)
    stage = 'image-audit-validation'
    audit_checks = {key: receipt[key] for key in ('finalized', 'cloudInitDisabled', 'ssmDisabled', 'credentialsAbsent', 'transportKeyMatches', 'metadataReachable', 'freshIdentity', 'heartbeatEnabled', 'watchdogActive') if type(receipt.get(key)) is bool}
    counts = receipt.get('credentialFailureCounts', {})
    if isinstance(counts, dict):
        credential_counts = {key: counts[key] for key in ('providerAuthFiles', 'sshPrivateKeyFiles', 'pemFiles', 'ssmLibraryFiles', 'ssmSnapFiles', 'ssmSnapshotFiles', 'ssmPackageFiles', 'unexpectedAuthorizedKeys', 'scanErrors') if type(counts.get(key)) is int and 0 <= counts[key] <= 1000000}
    if receipt.get('metadataProbe') in ('token-endpoint-accessible', 'http-403-denied', 'http-401-unauthorized', 'unexpected-http-response', 'network-unavailable', 'unexpected-network-error'):
        metadata_probe = receipt['metadataProbe']
    if audit.returncode or receipt.get('valid') is not True:
        raise RuntimeError('image scrub audit failed')
    stage = 'heartbeat'
    heartbeat = pathlib.Path('/opt/agent-web/.heartbeat')
    fresh = 0 <= time.time() - heartbeat.stat().st_mtime < 180
    if not fresh:
        raise RuntimeError('boot heartbeat is stale')
    stage = 'sentinel'
    sentinel = pathlib.Path('/opt/agent-web/verify-' + request['verificationId'])
    if request['phase'] == 'fresh' and not sentinel.exists():
        fd = os.open(sentinel, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as target:
            target.write(request['sentinel'])
    persisted = sentinel.read_text() == request['sentinel']
    if not persisted:
        raise RuntimeError('worker sentinel mismatch')
    process_identity = None
    application_identity = None
    browser_process_identity = None
    browser_state_identity = None
    browser_counter = None
    if request.get('hibernation') is True:
        stage = 'native-process'
        marker = 'relay-hibernation-' + request['verificationId']
        process_file = pathlib.Path('/opt/agent-web/verify-' + request['verificationId'] + '.native')
        if request['phase'] == 'fresh':
            child = subprocess.Popen(['/usr/bin/python3', '-I', '-c', 'import time; time.sleep(1800)', marker],
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     start_new_session=True, close_fds=True)
            time.sleep(0.1)
            if child.poll() is not None:
                raise RuntimeError('native process did not survive hibernation')
            stat = pathlib.Path('/proc/' + str(child.pid) + '/stat').read_text().split()
            saved = {'pid': child.pid, 'start': stat[21], 'boot': pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'marker': marker}
            fd = os.open(process_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(fd, 'w') as target:
                json.dump(saved, target, sort_keys=True, separators=(',', ':'))
        else:
            saved = json.loads(process_file.read_text())
        encoded_identity = json.dumps(saved, sort_keys=True, separators=(',', ':')).encode()
        process_identity = hashlib.sha256(encoded_identity).hexdigest()
        process_path = pathlib.Path('/proc/' + str(saved.get('pid')))
        try:
            stat = (process_path / 'stat').read_text().split()
            cmdline = (process_path / 'cmdline').read_bytes().split(b'\0')
            same_process = stat[21] == saved.get('start') and saved.get('marker', '').encode() in cmdline
            same_kernel = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip() == saved.get('boot')
        except (FileNotFoundError, PermissionError, IndexError):
            same_process = same_kernel = False
        if (request['phase'] == 'resumed' and request.get('processIdentity') != process_identity) or not same_process or not same_kernel:
            raise RuntimeError('native process did not survive hibernation')
        stage = 'application-transport'
        application = application_probe(request)
        application_identity = application['applicationIdentity']
        browser_process_identity = application['browserProcessIdentity']
        browser_state_identity = application['browserStateIdentity']
        browser_counter = application['browserCounter']
        if request['phase'] == 'resumed' and (request.get('applicationIdentity') != application_identity or request.get('browserProcessIdentity') != browser_process_identity or request.get('browserStateIdentity') != browser_state_identity):
            raise RuntimeError('application transport did not survive hibernation')
    stage = 'receipt'
    print(json.dumps({'audit': receipt, 'versions': versions, 'heartbeatFresh': fresh, 'sentinelPresent': persisted,
                      **({'processIdentity': process_identity, 'applicationTransport': True,
                          'applicationIdentity': application_identity, 'browserTransport': True,
                          'browserProcessIdentity': browser_process_identity,
                          'browserStateIdentity': browser_state_identity,
                          'browserCounter': browser_counter} if process_identity else {})}))
except Exception as error:
    reasons = ('wrong worker user', 'native version mismatch', 'image scrub audit failed', 'boot heartbeat is stale',
               'worker sentinel mismatch', 'native process did not survive hibernation',
               'application transport did not survive hibernation')
    failure = {'error': 'Worker acceptance checks failed; no private diagnostics emitted', 'reason': str(error) if isinstance(error, RuntimeError) and str(error) in reasons else 'invalid-worker-receipt'}
    failure['probeStage'] = stage
    if type(error).__name__ in exception_classes:
        failure['exceptionClass'] = type(error).__name__
    if stage == 'image-audit-json' and audit is not None:
        # Parse private stderr locally, returning only fixed class names and a
        # bounded line number for the one immutable helper path. Never echo a
        # message, arbitrary filename, source line, stdout or traceback.
        stderr = audit.stderr if isinstance(audit.stderr, str) else ''
        classes = re.findall(r'^([A-Za-z]+Error|TimeoutExpired|CalledProcessError):', stderr, re.MULTILINE)
        if classes and classes[-1] in exception_classes:
            failure['helperExceptionClass'] = classes[-1]
        lines = re.findall(r'^  File "/usr/local/sbin/agent-web-audit-image", line ([0-9]{1,5}), in [A-Za-z_][A-Za-z0-9_]*$|^  File "/usr/local/sbin/agent-web-audit-image", line ([0-9]{1,5}), in <module>$', stderr, re.MULTILINE)
        if lines:
            number = int(lines[-1][0] or lines[-1][1])
            if 1 <= number <= 10000:
                failure['helperLine'] = number
    if failure['reason'] == 'image scrub audit failed':
        failure['auditChecks'] = audit_checks
        failure['credentialFailureCounts'] = credential_counts
        failure['metadataProbe'] = metadata_probe
    if failure['reason'] == 'application transport did not survive hibernation' and application_stage in ('bundle', 'service', 'status', 'configure', 'connect', 'launch', 'attach', 'initialize-input', 'initialize-response', 'initialize-error', 'initialize-frame', 'initialize-timeout', 'initialize-notify', 'initialize-status', 'initialize-ack', 'checkpoint', 'takeover', 'read', 'read-error', 'read-frame', 'read-timeout', 'no-replay', 'terminate', 'release', 'native-terminate', 'browser-configure', 'browser-connect', 'browser-launch', 'browser-attach', 'browser-ready', 'browser-ready-fatal', 'browser-ready-frame', 'browser-ready-timeout', 'browser-state-input', 'browser-state-response', 'browser-state-error', 'browser-state-frame', 'browser-state-timeout', 'browser-identity', 'browser-takeover', 'browser-no-replay', 'browser-terminate', 'browser-release'):
        failure['applicationStage'] = application_stage
    if failure['reason'] == 'application transport did not survive hibernation' and application_frame_detail in ('line', 'json', 'envelope', 'output-identity', 'output-data', 'output-size', 'stdout-json'):
        failure['applicationFrame'] = application_frame_detail
    if failure['reason'] == 'application transport did not survive hibernation' and browser_failure in ('executable', 'sandbox', 'chrome-exited', 'startup-timeout', 'worker-fatal'):
        failure['browserFailure'] = browser_failure
    print(json.dumps(failure))
    sys.exit(1)
'''


def main():
    if os.geteuid() != 0 or len(sys.argv) != 2:
        raise RuntimeError('Controller acceptance requires root and one validated request')
    request = json.loads(base64.b64decode(sys.argv[1], validate=True))
    if not pathlib.Path('/var/lib/relay-controller-ready').is_file():
        raise RuntimeError('Controller bootstrap is not ready')
    if not re.fullmatch(r'[a-f0-9-]{36}', request['verificationId']) or request['phase'] not in ('fresh', 'resumed'):
        raise RuntimeError('Invalid verification request')
    continuity = ('processIdentity', 'applicationIdentity', 'browserProcessIdentity', 'browserStateIdentity')
    if type(request.get('hibernation')) is not bool or request['phase'] == 'resumed' and request['hibernation'] and any(not re.fullmatch(r'[a-f0-9]{64}', request.get(key, '')) for key in continuity):
        raise RuntimeError('Invalid verification request')
    if request['hibernation'] and (not isinstance(request.get('supervisorBundle'), str) or len(request['supervisorBundle']) > 32768):
        raise RuntimeError('Invalid supervisor acceptance bundle')
    if not re.fullmatch(r'i-[a-f0-9]{8,17}', request['workerId']):
        raise RuntimeError('Invalid worker ID')
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9-]{0,127}', request.get('deployment', '')):
        raise RuntimeError('Invalid deployment binding')
    host = ipaddress.ip_address(request['host'])
    if not any(host in ipaddress.ip_network(network) for network in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise RuntimeError('Worker SSH requires a private IPv4 address')
    arn_prefix = 'arn:aws:secretsmanager:' + request['region'] + ':' + request['account'] + ':secret:'
    if not request['secretArn'].startswith(arn_prefix):
        raise RuntimeError('Invalid scoped secret ARN')
    # Force the instance-role chain: do not adopt ambient operator credentials.
    aws_env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8',
               'AWS_REGION': request['region'], 'AWS_DEFAULT_REGION': request['region'],
               'AWS_SHARED_CREDENTIALS_FILE': '/dev/null', 'AWS_CONFIG_FILE': '/dev/null',
               'AWS_PAGER': '', 'AWS_CLI_AUTO_PROMPT': 'off'}
    fetched = subprocess.run(['/usr/local/bin/aws', '--region', request['region'], '--no-cli-pager',
                              'secretsmanager', 'get-secret-value', '--secret-id', request['secretArn'],
                              '--query', 'SecretString', '--output', 'text'],
                             env=aws_env, capture_output=True, text=True, timeout=30)
    if fetched.returncode:
        raise RuntimeError('Controller could not read its scoped deployment secret')
    secret = json.loads(fetched.stdout)
    encoded = secret.get('AGENT_WORKER_SSH_KEY_BASE64', '')
    if not isinstance(encoded, str) or len(encoded) > 16384:
        raise RuntimeError('Invalid controller transport key')
    private_key = base64.b64decode(encoded, validate=True)
    if not private_key.startswith(b'-----BEGIN OPENSSH PRIVATE KEY-----\n'):
        raise RuntimeError('Invalid controller transport key')
    with tempfile.TemporaryDirectory(prefix='relay-worker-acceptance-', dir='/dev/shm') as directory:
        os.chmod(directory, 0o700)
        key_file = pathlib.Path(directory) / 'worker-key'
        fd = os.open(key_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as target:
            target.write(private_key)
        derived = subprocess.run(['/usr/bin/ssh-keygen', '-y', '-f', str(key_file)], capture_output=True, text=True, timeout=10)
        if derived.returncode or derived.stdout.split()[:2] != request['publicKey'].split()[:2]:
            raise RuntimeError('Deployment transport key does not match the selected AMI key pair')
        known_file = pathlib.Path(directory) / 'known-hosts'
        known_file.write_text(request.get('knownHosts', ''))
        os.chmod(known_file, 0o600)
        if request['phase'] == 'resumed' and not request.get('knownHosts'):
            raise RuntimeError('Resume requires the first boot SSH host identity')
        ssh = ['/usr/bin/ssh', '-F', '/dev/null', '-T', '-i', str(key_file),
               '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ForwardAgent=no',
               '-o', 'ClearAllForwardings=yes', '-o', 'ConnectTimeout=5',
               '-o', 'StrictHostKeyChecking=' + ('yes' if request['phase'] == 'resumed' else 'accept-new'),
               '-o', 'UserKnownHostsFile=' + str(known_file),
               '-o', 'GlobalKnownHostsFile=/dev/null',
               '-o', 'UpdateHostKeys=no',
               '-o', 'HostKeyAlias=verify-' + request['workerId'],
               '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
               'ubuntu@' + request['host']]
        worker_request = {key: request[key] for key in ('verificationId', 'phase', 'sentinel', 'hibernation', 'workerId', 'deployment')}
        if request['hibernation']:
            worker_request['supervisorBundle'] = request['supervisorBundle']
        if request.get('processIdentity'):
            worker_request['processIdentity'] = request['processIdentity']
        if request.get('applicationIdentity'):
            worker_request['applicationIdentity'] = request['applicationIdentity']
        if request.get('browserProcessIdentity'):
            worker_request['browserProcessIdentity'] = request['browserProcessIdentity']
        if request.get('browserStateIdentity'):
            worker_request['browserStateIdentity'] = request['browserStateIdentity']
        command = 'python3 -I -c ' + shlex.quote(WORKER_PROBE) + ' ' + shlex.quote(json.dumps(worker_request))
        deadline = time.monotonic() + 240
        audit_attempts = 0
        native_warmup_attempts = 0
        while True:
            try:
                probed = subprocess.run(ssh + [command], capture_output=True, text=True, timeout=300)
            except subprocess.TimeoutExpired:
                raise ProbeFailure('ssh-probe-timeout') from None
            except OSError:
                raise ProbeFailure('ssh-executable-unavailable') from None
            failure = probe_failure(probed) if probed.returncode else None
            if (failure and failure.diagnostic.get('category') == 'invalid-receipt'
                    and failure.diagnostic.get('probeStage') == 'native-version'
                    and failure.diagnostic.get('exceptionClass') == 'TimeoutExpired'):
                native_warmup_attempts += 1
                # SSH can become ready while the just-booted image is still
                # contending on disk for the installed CLI. This stage runs
                # before any sentinel or application process is created, so a
                # tightly bounded retry cannot replay acceptance side effects.
                if native_warmup_attempts < 3 and time.monotonic() < deadline:
                    time.sleep(2)
                    continue
            if failure and failure.diagnostic['category'] == 'image-audit':
                audit_attempts += 1
                # A just-booted systemd unit can settle after SSH is available.
                # Give it two short retries, not the network's four-minute
                # retry budget, then expose only the fixed boolean checks.
                if audit_attempts < 3 and time.monotonic() < deadline:
                    time.sleep(2)
                    continue
            if not failure or probed.returncode != 255 or failure.diagnostic['category'] not in ('ssh-connection-refused', 'ssh-network-unreachable', 'ssh-transport') or time.monotonic() >= deadline:
                break
            time.sleep(5)
        if failure:
            raise failure
        try:
            result = json.loads(probed.stdout)
            if not isinstance(result, dict) or not isinstance(result.get('audit'), dict):
                raise ValueError('invalid receipt')
        except (ValueError, TypeError):
            raise ProbeFailure('invalid-receipt', probed.returncode) from None
        result.update({'schema': 1, 'verificationId': request['verificationId'], 'workerId': request['workerId'],
                       'phase': request['phase'], 'knownHosts': known_file.read_text()})
        print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps(failure_receipt(error)))
        sys.exit(1)
