"""Offline tests for the actual image helper embedded in cloud-init."""
import ast
import base64
import contextlib
import errno
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
import urllib.error
from unittest.mock import patch

RECIPE = (pathlib.Path(__file__).parent.parent / 'deploy/aws/worker-cloud-init.yaml').read_text()


def script_at(path):
    section = RECIPE.split('  - path: ' + path + '\n', 1)[1].split('\n  - path:', 1)[0]
    return '\n'.join(line[6:] for line in section.split('    content: |\n', 1)[1].splitlines())


tree = ast.parse(script_at('/usr/local/sbin/agent-web-audit-image'))
helpers = ast.Module(body=[node for node in tree.body if isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef))], type_ignores=[])
namespace = {}
exec(compile(helpers, '<image-audit-helper>', 'exec'), namespace)


class ImageAuditTest(unittest.TestCase):
    def probe(self, response=None, error=None):
        class Response:
            status = response
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, *args): raise AssertionError('Metadata token body must never be read')
        def build(*handlers):
            self.assertEqual(handlers[0].proxies, {})
            self.assertIsNone(handlers[1].redirect_request(None, None, 302, '', {}, 'http://private.invalid'))
            def open_request(request, timeout):
                self.assertEqual(request.full_url, 'http://169.254.169.254/latest/api/token')
                self.assertEqual(request.method, 'PUT')
                self.assertEqual(request.data, b'')
                self.assertEqual(request.get_header('X-aws-ec2-metadata-token-ttl-seconds'), '1')
                self.assertEqual(timeout, 2)
                if error: raise error
                return Response()
            return types.SimpleNamespace(open=open_request)
        output = io.StringIO()
        with patch('urllib.request.build_opener', side_effect=build), contextlib.redirect_stdout(output):
            result = namespace['metadata_probe']()
        self.assertEqual(output.getvalue(), '')
        self.assertNotIn('PRIVATE', json.dumps(result))
        return result

    def test_token_endpoint_200_fails_without_reading_or_printing_token(self):
        self.assertEqual(self.probe(response=200), (True, 'token-endpoint-accessible'))

    def test_only_403_is_http_denied_not_401_or_unexpected_status(self):
        for code in (301, 302, 400, 401, 403, 404, 500, 503):
            with self.subTest(code=code):
                result = self.probe(error=urllib.error.HTTPError('PRIVATE', code, 'PRIVATE', {}, None))
                self.assertEqual(result[0], code != 403)
                if code == 401: self.assertEqual(result[1], 'http-401-unauthorized')
        self.assertEqual(self.probe(response=204), (True, 'unexpected-http-response'))

    def test_only_typed_network_unavailability_passes(self):
        for error in (TimeoutError('PRIVATE'), OSError(errno.ECONNREFUSED, 'PRIVATE'), OSError(errno.ENETUNREACH, 'PRIVATE'), OSError(errno.EHOSTUNREACH, 'PRIVATE'), OSError(errno.ETIMEDOUT, 'PRIVATE')):
            self.assertEqual(self.probe(error=error), (False, 'network-unavailable'))
            self.assertEqual(self.probe(error=urllib.error.URLError(error)), (False, 'network-unavailable'))
        for error in (urllib.error.URLError('PRIVATE'), OSError(errno.EINVAL, 'PRIVATE')):
            self.assertEqual(self.probe(error=error), (True, 'unexpected-network-error'))

    def counts(self, *, errors=False):
        def walk(root, *, followlinks, onerror):
            self.assertFalse(followlinks)
            if errors: onerror(PermissionError('PRIVATE'))
            if root == '/root': return [(root, [], ['auth.json', 'credentials', 'id_ed25519', 'PRIVATE.pem', 'harmless'])]
            if root == '/home': return [(root, [], ['.credentials.json', 'id_rsa'])]
            if root == '/var/lib/amazon/ssm': return [(root, [], ['PRIVATE-unknown-state'])]
            if root == '/var/snap/amazon-ssm-agent': return [(root, [], ['PRIVATE-unknown-state', 'PRIVATE-other'])]
            return []
        dirs = {'/var/lib/amazon/ssm', '/var/snap/amazon-ssm-agent'}
        with patch.object(namespace['os'], 'walk', side_effect=walk), patch.object(namespace['pathlib'].Path, 'is_file', lambda p: str(p) == '/root/.ssh/authorized_keys'), patch.object(namespace['pathlib'].Path, 'is_dir', lambda p: str(p) in dirs), patch.object(namespace['pathlib'].Path, 'glob', return_value=iter(['PRIVATE.zip'])), patch.object(namespace['os'].path, 'lexists', side_effect=lambda p: p == '/usr/bin/amazon-ssm-agent'):
            return namespace['credential_failures']()

    def test_credential_diagnostics_count_categories_without_names_or_contents(self):
        counts = self.counts()
        self.assertEqual(counts, {'providerAuthFiles': 3, 'sshPrivateKeyFiles': 2, 'pemFiles': 1, 'ssmLibraryFiles': 1, 'ssmSnapFiles': 2, 'ssmSnapshotFiles': 1, 'ssmPackageFiles': 1, 'unexpectedAuthorizedKeys': 1, 'scanErrors': 0})
        self.assertNotIn('PRIVATE', json.dumps(counts))
        self.assertTrue(any(counts.values()), 'Unknown SSM state must still reject the image')

    def test_scan_errors_fail_closed(self):
        self.assertGreater(self.counts(errors=True)['scanErrors'], 0)

    def test_whole_rendered_helper_executes_top_level_and_emits_strict_receipt(self):
        public = b'ssh-ed25519 AAAAWholeHelperFixture\n'
        source = script_at('/usr/local/sbin/agent-web-audit-image').replace('__RELAY_WORKER_PUBLIC_KEY_BASE64__', base64.b64encode(public).decode())
        def read_text(file, *args, **kwargs):
            if str(file) == '/usr/local/share/agent-relay-builder-identity.json': return json.dumps({'machine': 'old-machine-hash', 'hostKeys': {'old': 'old-public-hash'}})
            raise AssertionError('Unexpected fixture read')
        def read_bytes(file):
            if str(file) == '/etc/machine-id': return b'new-machine-id'
            if str(file) == '/home/ubuntu/.ssh/authorized_keys': return public
            if str(file) == '/etc/ssh/ssh_host_ed25519_key.pub': return b'ssh-ed25519 AAAANewHostKey\n'
            raise AssertionError('Unexpected fixture read')
        def glob(file, pattern):
            if str(file) == '/etc/ssh': return iter([pathlib.Path('/etc/ssh/ssh_host_ed25519_key.pub')])
            return iter([])
        def unit(args, **kwargs):
            return types.SimpleNamespace(returncode=1 if 'ssm' in args[-1] else 0)
        output = io.StringIO()
        with patch.object(namespace['os'], 'geteuid', return_value=0), patch.object(sys, 'argv', ['helper']), patch.object(namespace['os'], 'walk', return_value=[]), patch.object(pathlib.Path, 'read_text', read_text), patch.object(pathlib.Path, 'read_bytes', read_bytes), patch.object(pathlib.Path, 'glob', glob), patch.object(pathlib.Path, 'is_file', lambda p: str(p) in ('/opt/agent-web/IMAGE_FINALIZED', '/etc/cloud/cloud-init.disabled')), patch.object(pathlib.Path, 'is_dir', return_value=False), patch.object(pathlib.Path, 'exists', return_value=False), patch.object(namespace['os'].path, 'lexists', return_value=False), patch.object(subprocess, 'run', side_effect=unit), patch('urllib.request.build_opener', return_value=types.SimpleNamespace(open=lambda *args, **kwargs: (_ for _ in ()).throw(urllib.error.HTTPError('PRIVATE', 403, 'PRIVATE', {}, None)))), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as raised:
                exec(compile(source, '/usr/local/sbin/agent-web-audit-image', 'exec'), {})
        self.assertEqual(raised.exception.code, 0)
        receipt = json.loads(output.getvalue())
        self.assertIs(receipt['valid'], True)
        self.assertIs(receipt['credentialsAbsent'], True)
        self.assertIs(receipt['metadataReachable'], False)
        self.assertEqual(receipt['metadataProbe'], 'http-403-denied')
        self.assertNotIn('PRIVATE', output.getvalue())

    def test_finalizer_shell_is_valid_and_removes_only_exact_builder_package(self):
        finalizer = script_at('/usr/local/sbin/agent-web-finalize-image')
        result = subprocess.run(['/bin/sh', '-n'], input=finalizer, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('timeout 180 snap remove --purge amazon-ssm-agent', finalizer)
        self.assertIn('timeout 180 dpkg --purge amazon-ssm-agent', finalizer)
        self.assertLess(finalizer.index('systemctl disable --now "$unit"'), finalizer.index('snap remove --purge'))
        self.assertLess(finalizer.index('snap remove --purge'), finalizer.index('touch /opt/agent-web/IMAGE_FINALIZED'))
        self.assertNotIn('autoremove', finalizer)

    def test_removal_failure_or_residual_package_prevents_finalizer_continuation(self):
        finalizer = script_at('/usr/local/sbin/agent-web-finalize-image')
        block = finalizer.split('# Builder-only package removal.', 1)[1].split('cloud-init clean', 1)[0]
        block = '# Builder-only package removal.' + block
        # Execute only the removal block with shell function fixtures; no real
        # package/systemd operation and no privileged filesystem write occurs.
        for case in ('success', 'snap-failed', 'dpkg-failed', 'inventory-failed', 'residual-package', 'residual-snapshot'):
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix='relay-finalizer-fixture-') as directory:
                scope = pathlib.Path(directory)
                safe_block = block.replace('/var/lib/snapd/snapshots/', str(scope / 'snapshots') + '/').replace('/snap/amazon-ssm-agent/current', str(scope / 'package')).replace('/usr/bin/amazon-ssm-agent', str(scope / 'deb')).replace('/usr/local/bin/amazon-ssm-agent', str(scope / 'custom')).replace('dpkg-query ', 'dpkg_query ')
                if case == 'residual-package': (scope / 'package').touch()
                if case == 'residual-snapshot':
                    (scope / 'snapshots').mkdir()
                    (scope / 'snapshots' / '1_amazon-ssm-agent_rev.zip').touch()
                prefix = '''set -eu
timeout() { shift; "$@"; }
snap() {
  if [ "$1" = list ]; then
    [ "$CASE" != inventory-failed ] || return 1
    printf '%s\\n' 'Name Version Rev' 'amazon-ssm-agent fixture 1'
  else
    [ "$*" = 'remove --purge amazon-ssm-agent' ] || return 99
    [ "$CASE" != snap-failed ] || return 1
  fi
}
dpkg_query() { printf '%s' 'install ok installed'; }
dpkg() { [ "$*" = '--purge amazon-ssm-agent' ] && [ "$CASE" != dpkg-failed ]; }
systemctl() { return 0; }
'''
                result = subprocess.run(['/bin/sh'], input='CASE=' + case + '\n' + prefix + safe_block + '\nprintf FINALIZER_CONTINUED\n', text=True, capture_output=True)
                self.assertEqual(result.returncode == 0, case == 'success', result.stderr)
                self.assertEqual('FINALIZER_CONTINUED' in result.stdout, case == 'success')


if __name__ == '__main__':
    unittest.main()
