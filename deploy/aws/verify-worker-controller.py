#!/usr/bin/python3 -I
"""Fixed controller-side acceptance probe, delivered through SSM without keys.

The controller retrieves its own deployment secret locally. Only public
identity hashes, a public known-host entry and booleans leave this process.
"""
import base64
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


class ProbeFailure(RuntimeError):
    def __init__(self, category, exit_code=None, audit_checks=None, credential_counts=None, metadata_probe=None):
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


def probe_failure(result):
    """Classify private subprocess output locally; never return its contents."""
    try:
        worker_failure = json.loads(result.stdout)
        reason = worker_failure.get('reason')
    except Exception:
        reason = None
    known_checks = {'wrong worker user': 'worker-user', 'native version mismatch': 'native-version',
                    'image scrub audit failed': 'image-audit', 'boot heartbeat is stale': 'heartbeat',
                    'worker sentinel mismatch': 'sentinel', 'invalid-worker-receipt': 'invalid-receipt'}
    if reason in known_checks:
        return ProbeFailure(known_checks[reason], result.returncode, worker_failure.get('auditChecks'), worker_failure.get('credentialFailureCounts'), worker_failure.get('metadataProbe'))
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
import json, os, pathlib, subprocess, sys, time
audit_checks = {}
credential_counts = {}
metadata_probe = None
try:
    request = json.loads(sys.argv[1])
    if subprocess.check_output(['/usr/bin/id', '-un'], text=True).strip() != 'agent':
        raise RuntimeError('wrong worker user')
    versions = {}
    for command, expected in [('codex', 'codex-cli 0.154.0'), ('claude', '2.1.222 (Claude Code)')]:
        result = subprocess.run([command, '--version'], capture_output=True, text=True, timeout=30)
        if result.returncode or result.stdout.strip() != expected:
            raise RuntimeError('native version mismatch')
        versions[command] = expected
    audit = subprocess.run(['/usr/bin/sudo', '-n', '/usr/local/sbin/agent-web-audit-image'], capture_output=True, text=True, timeout=30)
    receipt = json.loads(audit.stdout)
    audit_checks = {key: receipt[key] for key in ('finalized', 'cloudInitDisabled', 'ssmDisabled', 'credentialsAbsent', 'transportKeyMatches', 'metadataReachable', 'freshIdentity', 'heartbeatEnabled', 'watchdogActive') if type(receipt.get(key)) is bool}
    counts = receipt.get('credentialFailureCounts', {})
    if isinstance(counts, dict):
        credential_counts = {key: counts[key] for key in ('providerAuthFiles', 'sshPrivateKeyFiles', 'pemFiles', 'ssmLibraryFiles', 'ssmSnapFiles', 'ssmSnapshotFiles', 'ssmPackageFiles', 'unexpectedAuthorizedKeys', 'scanErrors') if type(counts.get(key)) is int and 0 <= counts[key] <= 1000000}
    if receipt.get('metadataProbe') in ('token-endpoint-accessible', 'http-403-denied', 'http-401-unauthorized', 'unexpected-http-response', 'network-unavailable', 'unexpected-network-error'):
        metadata_probe = receipt['metadataProbe']
    if audit.returncode or receipt.get('valid') is not True:
        raise RuntimeError('image scrub audit failed')
    heartbeat = pathlib.Path('/opt/agent-web/.heartbeat')
    fresh = 0 <= time.time() - heartbeat.stat().st_mtime < 180
    if not fresh:
        raise RuntimeError('boot heartbeat is stale')
    sentinel = pathlib.Path('/opt/agent-web/verify-' + request['verificationId'])
    if request['phase'] == 'fresh' and not sentinel.exists():
        fd = os.open(sentinel, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as target:
            target.write(request['sentinel'])
    persisted = sentinel.read_text() == request['sentinel']
    if not persisted:
        raise RuntimeError('worker sentinel mismatch')
    print(json.dumps({'audit': receipt, 'versions': versions, 'heartbeatFresh': fresh, 'sentinelPresent': persisted}))
except Exception as error:
    reasons = ('wrong worker user', 'native version mismatch', 'image scrub audit failed', 'boot heartbeat is stale', 'worker sentinel mismatch')
    failure = {'error': 'Worker acceptance checks failed; no private diagnostics emitted', 'reason': str(error) if isinstance(error, RuntimeError) and str(error) in reasons else 'invalid-worker-receipt'}
    if failure['reason'] == 'image scrub audit failed':
        failure['auditChecks'] = audit_checks
        failure['credentialFailureCounts'] = credential_counts
        failure['metadataProbe'] = metadata_probe
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
    if not re.fullmatch(r'i-[a-f0-9]{8,17}', request['workerId']):
        raise RuntimeError('Invalid worker ID')
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
        worker_request = {key: request[key] for key in ('verificationId', 'phase', 'sentinel')}
        command = 'python3 -I -c ' + shlex.quote(WORKER_PROBE) + ' ' + shlex.quote(json.dumps(worker_request))
        deadline = time.monotonic() + 240
        audit_attempts = 0
        while True:
            try:
                probed = subprocess.run(ssh + [command], capture_output=True, text=True, timeout=100)
            except subprocess.TimeoutExpired:
                raise ProbeFailure('ssh-probe-timeout') from None
            except OSError:
                raise ProbeFailure('ssh-executable-unavailable') from None
            failure = probe_failure(probed) if probed.returncode else None
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
