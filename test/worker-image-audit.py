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

    def test_finalizer_removes_known_nontransport_keys_and_checks_the_only_retained_key(self):
        finalizer = script_at('/usr/local/sbin/agent-web-finalize-image')
        block = finalizer.split('# Remove nontransport SSH state,', 1)[1].split('# Remove builder host identity', 1)[0]
        block = '# Remove nontransport SSH state,' + block
        self.assertLess(finalizer.index('# Remove nontransport SSH state,'), finalizer.index('touch /opt/agent-web/IMAGE_FINALIZED'))
        public = b'ssh-ed25519 AAAAFixturePublicOnly\n'
        cases = ('clean', 'builder-keys', 'removal-failed', 'residual-directory', 'other-user-key', 'alternate-key', 'changed-transport-key', 'wrong-file-owner', 'wrong-directory-owner', 'loose-file', 'loose-directory', 'key-symlink', 'directory-symlink')
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory(prefix='relay-finalizer-keys-') as directory:
                scope = pathlib.Path(directory)
                for relative in ('root', 'home/agent', 'home/ubuntu/.ssh', 'opt/agent-web'):
                    (scope / relative).mkdir(parents=True, exist_ok=True)
                ssh = scope / 'home/ubuntu/.ssh'
                ssh.chmod(0o700)
                key = ssh / 'authorized_keys'
                key.write_bytes(public)
                key.chmod(0o600)
                # Files/modes/find/removal are real; only ownership names are
                # supplied because fixtures must never chown to system users.
                prefix = 'CASE=' + case + '''\nset -eu
stat() {
  if [ "$2" = '%U:%G' ]; then
    case "$CASE:$3" in
      wrong-file-owner:*/authorized_keys|wrong-directory-owner:*/.ssh) printf root:root ;;
      *) printf ubuntu:ubuntu ;;
    esac
  else command stat "$@"; fi
}
'''
                if case in ('builder-keys', 'removal-failed', 'residual-directory'):
                    for relative in ('root/.ssh', 'home/agent/.ssh'):
                        (scope / relative).mkdir()
                        (scope / relative / 'authorized_keys').write_text('PRIVATE-UNEXPECTED-KEY')
                        (scope / relative / 'id_ed25519').write_text('PRIVATE-UNEXPECTED-KEY')
                if case == 'removal-failed': prefix += 'rm() { return 1; }\n'
                if case == 'residual-directory': prefix += 'rm() { return 0; }\n'
                if case == 'other-user-key':
                    extra = scope / 'home/other/.ssh'; extra.mkdir(parents=True)
                    (extra / 'authorized_keys').write_text('PRIVATE-UNEXPECTED-KEY')
                if case == 'alternate-key': (ssh / 'authorized_keys2').write_text('PRIVATE-UNEXPECTED-KEY')
                if case == 'changed-transport-key': key.write_text('PRIVATE-UNEXPECTED-KEY')
                if case == 'loose-file': key.chmod(0o644)
                if case == 'loose-directory': ssh.chmod(0o755)
                if case == 'key-symlink':
                    target = scope / 'public-fixture'; target.write_bytes(public); target.chmod(0o600)
                    key.unlink(); key.symlink_to(target)
                if case == 'directory-symlink':
                    target = scope / 'public-directory'; ssh.rename(target); ssh.symlink_to(target, target_is_directory=True)
                safe_block = block.replace('/root', str(scope / 'root')).replace('/home', str(scope / 'home')).replace('/opt/agent-web', str(scope / 'opt/agent-web')).replace('__RELAY_WORKER_PUBLIC_KEY_BASE64__', base64.b64encode(public).decode())
                result = subprocess.run(['/bin/sh'], input=prefix + safe_block + '\nprintf FINALIZER_CONTINUED\n', text=True, capture_output=True)
                successful = case in ('clean', 'builder-keys')
                self.assertEqual(result.returncode == 0, successful, result.stderr)
                self.assertEqual('FINALIZER_CONTINUED' in result.stdout, successful)
                self.assertNotIn('PRIVATE', result.stdout + result.stderr)
                if successful:
                    self.assertEqual(key.read_bytes(), public)
                    self.assertFalse((scope / 'root/.ssh').exists())
                    self.assertFalse((scope / 'home/agent/.ssh').exists())

    def test_audit_still_rejects_each_nontransport_authorized_key(self):
        for unexpected in ('/root/.ssh/authorized_keys', '/home/agent/.ssh/authorized_keys'):
            with self.subTest(path=unexpected), patch.object(namespace['os'], 'walk', return_value=[]), patch.object(pathlib.Path, 'is_file', lambda p: str(p) == unexpected), patch.object(pathlib.Path, 'is_dir', return_value=False), patch.object(pathlib.Path, 'glob', return_value=iter([])), patch.object(namespace['os'].path, 'lexists', return_value=False):
                counts = namespace['credential_failures']()
                self.assertEqual(counts['unexpectedAuthorizedKeys'], 1)
                self.assertEqual(sum(counts.values()), 1)

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
