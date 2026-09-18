import contextlib
import io
import json
import pathlib
import runpy
import types
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).parent.parent / 'deploy/aws/worker-bootstrap-check.py'


class BootstrapCheckTest(unittest.TestCase):
    def check(self, state, *, cycle=False, missing=False):
        def run(args, **kwargs):
            if args[0] == 'cloud-init':
                return types.SimpleNamespace(returncode=0 if state['status'] == 'done' else 1, stdout=json.dumps(state), stderr='PRIVATE-BOOTSTRAP-DIAGNOSTIC')
            if args[0] == 'systemd-analyze':
                return types.SimpleNamespace(returncode=1 if cycle else 0, stdout='', stderr='Ordering cycle found: PRIVATE-BOOTSTRAP-DIAGNOSTIC' if cycle else '')
            return types.SimpleNamespace(returncode=0, stdout={'codex': 'codex-cli 0.154.0', 'claude': '2.1.222 (Claude Code)'}.get(args[0], 'version'), stderr='')
        output = io.StringIO()
        with patch('subprocess.run', side_effect=run), patch('shutil.which', return_value=None if missing else '/fixture'), patch('pathlib.Path.is_file', return_value=True), contextlib.redirect_stdout(output):
            with self.assertRaises(SystemExit) as stopped:
                runpy.run_path(str(SOURCE), run_name='__main__')
        self.assertNotIn('PRIVATE-', output.getvalue())
        return stopped.exception.code, json.loads(output.getvalue())

    def test_success_does_not_invent_failed_modules(self):
        code, receipt = self.check({'status': 'done', 'errors': [], 'modules-final': {'errors': []}})
        self.assertEqual(code, 0)
        self.assertEqual(receipt['failedModules'], [])

    def test_failure_preserves_only_bounded_stage_categories(self):
        code, receipt = self.check({'status': 'error', 'modules-final': {'errors': ['cc_package_update_upgrade_install: PRIVATE-ERROR']}})
        self.assertEqual(code, 1)
        self.assertEqual(receipt['failedModules'], ['modules-final', 'package-update-upgrade-install'])

    def test_cycle_or_missing_tools_fail_even_if_cloud_init_reports_done(self):
        for options in ({'cycle': True}, {'missing': True}):
            code, receipt = self.check({'status': 'done'}, **options)
            self.assertEqual(code, 1)
        self.assertFalse(receipt['checks']['codex'])


if __name__ == '__main__':
    unittest.main()
