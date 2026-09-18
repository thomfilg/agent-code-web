import base64
import contextlib
import importlib.util
import io
import json
import pathlib
import subprocess
import types
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).parent.parent / 'deploy/aws/verify-worker-controller.py'
spec = importlib.util.spec_from_file_location('controller_probe', SOURCE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ControllerProbeTest(unittest.TestCase):
    def run_probe(self, *, fail_ssh=False, resumed=False, missing_pin=False, mismatch_key=False, ssh_result=None, ssh_exception=None):
        request = {'verificationId': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'phase': 'resumed' if resumed else 'fresh',
                   'workerId': 'i-aaaaaaaaaaaaaaaaa', 'host': '10.84.2.22', 'region': 'us-east-2', 'account': '123456789012',
                   'secretArn': 'arn:aws:secretsmanager:us-east-2:123456789012:secret:fixture',
                   'publicKey': 'ssh-ed25519 AAAAFixturePublicKey', 'sentinel': 'fixture-sentinel'}
        known = 'verify-i-aaaaaaaaaaaaaaaaa ssh-ed25519 AAAAFixturePublicKey\n'
        if resumed and not missing_pin:
            request['knownHosts'] = known
        private = '-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE-UNIT-FIXTURE-NOT-A-REAL-KEY\n'
        paths = []
        ssh_calls, sleeps = [], []

        def run(args, **kwargs):
            if 'get-secret-value' in args:
                self.assertEqual(args[args.index('--secret-id') + 1], request['secretArn'])
                self.assertEqual(kwargs['env']['AWS_SHARED_CREDENTIALS_FILE'], '/dev/null')
                self.assertNotIn('AWS_ACCESS_KEY_ID', kwargs['env'])
                self.assertNotIn('OPENAI_API_KEY', kwargs['env'])
                return types.SimpleNamespace(returncode=0, stdout=json.dumps({'AGENT_WORKER_SSH_KEY_BASE64': base64.b64encode(private.encode()).decode(), 'GOOGLE_CLIENT_SECRET': 'PRIVATE-GOOGLE-FIXTURE'}))
            if args[0] == '/usr/bin/ssh-keygen':
                key = pathlib.Path(args[-1])
                self.assertEqual(key.stat().st_mode & 0o777, 0o600)
                self.assertEqual(key.parent.stat().st_mode & 0o777, 0o700)
                self.assertTrue(str(key).startswith('/dev/shm/relay-worker-acceptance-'))
                self.assertEqual(key.read_text(), private)
                paths.append(key.parent)
                return types.SimpleNamespace(returncode=0, stdout='ssh-ed25519 ' + ('WrongKey' if mismatch_key else 'AAAAFixturePublicKey'))
            self.assertEqual(args[0], '/usr/bin/ssh')
            ssh_calls.append(args)
            self.assertNotIn(private, ' '.join(args))
            self.assertIn('UpdateHostKeys=no', args)
            self.assertIn('StrictHostKeyChecking=' + ('yes' if resumed else 'accept-new'), args)
            known_file = pathlib.Path(next(arg.split('=', 1)[1] for arg in args if arg.startswith('UserKnownHostsFile=')))
            if resumed:
                self.assertEqual(known_file.read_text(), known)
            else:
                known_file.write_text(known)
            if ssh_exception:
                raise ssh_exception
            return ssh_result or types.SimpleNamespace(returncode=1 if fail_ssh else 0, stdout=json.dumps({'audit': {'valid': True}}), stderr='PRIVATE-ERROR-FIXTURE')

        output = io.StringIO()
        with patch.object(probe.os, 'geteuid', return_value=0), patch.object(probe.pathlib.Path, 'is_file', return_value=True), patch.object(probe.subprocess, 'run', side_effect=run), patch.object(probe.sys, 'argv', ['probe', base64.b64encode(json.dumps(request).encode()).decode()]), patch.object(probe.time, 'sleep', side_effect=sleeps.append), contextlib.redirect_stdout(output):
            if fail_ssh or missing_pin or mismatch_key or ssh_result or ssh_exception:
                with self.assertRaises(RuntimeError) as raised:
                    probe.main()
                self.assertNotIn('PRIVATE-', str(raised.exception))
                self.assertNotIn('PRIVATE-', json.dumps(probe.failure_receipt(raised.exception)))
            else:
                probe.main()
                result = json.loads(output.getvalue())
                self.assertEqual(result['knownHosts'], known)
                self.assertEqual(result['phase'], request['phase'])
        self.assertNotIn('PRIVATE-', output.getvalue())
        for directory in paths:
            self.assertFalse(directory.exists(), 'transport key tempfs directory must be removed on every path')
        return len(ssh_calls), sleeps

    def test_fresh_key_stays_local_and_tempfs_is_cleaned(self):
        self.run_probe()

    def test_resume_pins_previous_public_host_key(self):
        self.run_probe(resumed=True)

    def test_remote_failure_suppresses_private_output_and_cleans_key(self):
        self.run_probe(fail_ssh=True)

    def test_resume_requires_host_identity_and_key_pair_must_match(self):
        self.run_probe(resumed=True, missing_pin=True)
        self.run_probe(mismatch_key=True)

    def test_safe_diagnostics_classify_without_echoing_subprocess_output(self):
        cases = [(255, '', 'Host key verification failed PRIVATE-SECRET', 'ssh-host-key'),
                 (255, '', 'Permission denied (publickey) PRIVATE-SECRET', 'ssh-permission-denied'),
                 (255, '', 'Connection refused PRIVATE-SECRET', 'ssh-connection-refused'),
                 (255, '', 'Connection timed out PRIVATE-SECRET', 'ssh-network-unreachable'),
                 (255, '', 'PRIVATE-SECRET', 'ssh-transport'),
                 (127, '', 'PRIVATE-SECRET', 'remote-command-missing'),
                 (1, '', 'PRIVATE-SECRET', 'remote-command-failed'),
                 (1, '{"reason":"wrong worker user","private":"PRIVATE-SECRET"}', '', 'worker-user'),
                 (1, '{"reason":"image scrub audit failed"}', '', 'image-audit'),
                 (1, '{"reason":"PRIVATE-SECRET"}', '', 'remote-command-failed')]
        for code, stdout, stderr, category in cases:
            with self.subTest(category=category):
                failure = probe.probe_failure(types.SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr))
                receipt = probe.failure_receipt(failure)
                self.assertEqual(receipt['diagnostic'], {'stage': 'worker-probe', 'category': category, 'exitCode': code})
                self.assertNotIn('PRIVATE-', json.dumps(receipt))

    def test_auth_hostkey_timeout_missing_executable_and_invalid_json_clean_keys(self):
        for stderr in ('Permission denied PRIVATE-SECRET', 'Host key verification failed PRIVATE-SECRET'):
            self.run_probe(ssh_result=types.SimpleNamespace(returncode=255, stdout='', stderr=stderr))
        self.run_probe(ssh_result=types.SimpleNamespace(returncode=0, stdout='PRIVATE-INVALID-JSON', stderr=''))
        self.run_probe(ssh_exception=subprocess.TimeoutExpired('PRIVATE-COMMAND', 100, output='PRIVATE-OUTPUT'))
        self.run_probe(ssh_exception=OSError('PRIVATE-ERROR'))

    def test_failed_audit_receipt_contains_only_allowlisted_boolean_checks(self):
        worker = {'reason': 'image scrub audit failed', 'auditChecks': {
            'finalized': True, 'ssmDisabled': False, 'credentialsAbsent': False,
            'freshIdentity': 'PRIVATE-SECRET', 'watchdogActive': 1,
            'private': 'PRIVATE-SECRET', 'hostKeys': 'PRIVATE-SECRET'}}
        failure = probe.probe_failure(types.SimpleNamespace(returncode=1, stdout=json.dumps(worker), stderr='PRIVATE-SECRET'))
        safe = probe.failure_receipt(failure)
        self.assertEqual(safe['diagnostic']['auditChecks'], {'finalized': True, 'ssmDisabled': False, 'credentialsAbsent': False})
        self.assertNotIn('PRIVATE-', json.dumps(safe))
        worker['reason'] = 'wrong worker user'
        non_audit = probe.probe_failure(types.SimpleNamespace(returncode=1, stdout=json.dumps(worker), stderr=''))
        self.assertNotIn('auditChecks', probe.failure_receipt(non_audit)['diagnostic'])

    def test_permanent_image_failure_gets_only_two_short_boot_race_retries(self):
        calls, sleeps = self.run_probe(ssh_result=types.SimpleNamespace(returncode=1, stdout=json.dumps({
            'reason': 'image scrub audit failed', 'auditChecks': {'ssmDisabled': False}}), stderr='PRIVATE-SECRET'))
        self.assertEqual(calls, 3)
        self.assertEqual(sleeps, [2, 2])

    def test_credential_counts_and_metadata_diagnostics_are_bounded_allowlists(self):
        for metadata in ('http-403-denied', 'PRIVATE-SECRET'):
            worker = {'reason': 'image scrub audit failed', 'credentialFailureCounts': {
                'providerAuthFiles': 0, 'ssmSnapFiles': 2, 'pemFiles': True, 'scanErrors': -1,
                'ssmLibraryFiles': 1000001, 'ssmPackageFiles': 'PRIVATE-SECRET', 'private': 'PRIVATE-SECRET'}, 'metadataProbe': metadata}
            safe = probe.failure_receipt(probe.probe_failure(types.SimpleNamespace(returncode=1, stdout=json.dumps(worker), stderr='')))
            self.assertEqual(safe['diagnostic']['credentialFailureCounts'], {'providerAuthFiles': 0, 'ssmSnapFiles': 2})
            self.assertEqual(safe['diagnostic'].get('metadataProbe'), 'http-403-denied' if metadata == 'http-403-denied' else None)
            self.assertNotIn('PRIVATE-', json.dumps(safe))

    def test_embedded_worker_failure_filters_audit_output_before_ssh(self):
        audit = {'valid': False, 'finalized': True, 'ssmDisabled': False,
                 'metadataReachable': False, 'freshIdentity': 'PRIVATE-SECRET',
                 'watchdogActive': 1, 'secret': 'PRIVATE-SECRET', 'machine': 'PRIVATE-SECRET',
                 'credentialFailureCounts': {'ssmSnapFiles': 2, 'pemFiles': True, 'scanErrors': -1, 'private': 'PRIVATE-SECRET'}, 'metadataProbe': 'http-403-denied'}
        def run(args, **kwargs):
            if args[0] == 'codex':
                return types.SimpleNamespace(returncode=0, stdout='codex-cli 0.154.0')
            if args[0] == 'claude':
                return types.SimpleNamespace(returncode=0, stdout='2.1.222 (Claude Code)')
            return types.SimpleNamespace(returncode=1, stdout=json.dumps(audit))
        output = io.StringIO()
        with patch.object(probe.subprocess, 'check_output', return_value='agent'), patch.object(probe.subprocess, 'run', side_effect=run), patch.object(probe.sys, 'argv', ['probe', '{}']), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                exec(probe.WORKER_PROBE, {})
        self.assertEqual(raised.exception.code, 1)
        self.assertEqual(json.loads(output.getvalue())['auditChecks'], {'finalized': True, 'ssmDisabled': False, 'metadataReachable': False})
        self.assertEqual(json.loads(output.getvalue())['credentialFailureCounts'], {'ssmSnapFiles': 2})
        self.assertEqual(json.loads(output.getvalue())['metadataProbe'], 'http-403-denied')
        self.assertNotIn('PRIVATE-', output.getvalue())


if __name__ == '__main__':
    unittest.main()
