import base64
import contextlib
import importlib.util
import io
import json
import pathlib
import types
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).parent.parent / 'deploy/aws/verify-worker-controller.py'
spec = importlib.util.spec_from_file_location('controller_probe', SOURCE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ControllerProbeTest(unittest.TestCase):
    def run_probe(self, *, fail_ssh=False, resumed=False, missing_pin=False, mismatch_key=False):
        request = {'verificationId': 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'phase': 'resumed' if resumed else 'fresh',
                   'workerId': 'i-aaaaaaaaaaaaaaaaa', 'host': '10.84.2.22', 'region': 'us-east-2', 'account': '123456789012',
                   'secretArn': 'arn:aws:secretsmanager:us-east-2:123456789012:secret:fixture',
                   'publicKey': 'ssh-ed25519 AAAAFixturePublicKey', 'sentinel': 'fixture-sentinel'}
        known = 'verify-i-aaaaaaaaaaaaaaaaa ssh-ed25519 AAAAFixturePublicKey\n'
        if resumed and not missing_pin:
            request['knownHosts'] = known
        private = '-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE-UNIT-FIXTURE-NOT-A-REAL-KEY\n'
        paths = []

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
            self.assertNotIn(private, ' '.join(args))
            self.assertIn('UpdateHostKeys=no', args)
            self.assertIn('StrictHostKeyChecking=' + ('yes' if resumed else 'accept-new'), args)
            known_file = pathlib.Path(next(arg.split('=', 1)[1] for arg in args if arg.startswith('UserKnownHostsFile=')))
            if resumed:
                self.assertEqual(known_file.read_text(), known)
            else:
                known_file.write_text(known)
            return types.SimpleNamespace(returncode=1 if fail_ssh else 0, stdout=json.dumps({'audit': {'valid': True}}), stderr='PRIVATE-ERROR-FIXTURE')

        output = io.StringIO()
        with patch.object(probe.os, 'geteuid', return_value=0), patch.object(probe.pathlib.Path, 'is_file', return_value=True), patch.object(probe.subprocess, 'run', side_effect=run), patch.object(probe.sys, 'argv', ['probe', base64.b64encode(json.dumps(request).encode()).decode()]), contextlib.redirect_stdout(output):
            if fail_ssh or missing_pin or mismatch_key:
                with self.assertRaises(RuntimeError) as raised:
                    probe.main()
                self.assertNotIn('PRIVATE-', str(raised.exception))
            else:
                probe.main()
                result = json.loads(output.getvalue())
                self.assertEqual(result['knownHosts'], known)
                self.assertEqual(result['phase'], request['phase'])
        self.assertNotIn('PRIVATE-', output.getvalue())
        for directory in paths:
            self.assertFalse(directory.exists(), 'transport key tempfs directory must be removed on every path')

    def test_fresh_key_stays_local_and_tempfs_is_cleaned(self):
        self.run_probe()

    def test_resume_pins_previous_public_host_key(self):
        self.run_probe(resumed=True)

    def test_remote_failure_suppresses_private_output_and_cleans_key(self):
        self.run_probe(fail_ssh=True)

    def test_resume_requires_host_identity_and_key_pair_must_match(self):
        self.run_probe(resumed=True, missing_pin=True)
        self.run_probe(mismatch_key=True)


if __name__ == '__main__':
    unittest.main()
