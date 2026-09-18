"""Optional cross-repository regression; runs no AWS or Docker commands.

python3 -B test/aws-rollback-shared-engine.py /absolute/pinned/12-apps/ci
"""
import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


if len(sys.argv) != 2:
    raise SystemExit('Supply the absolute reviewed shared-engine checkout')
engine_root = pathlib.Path(sys.argv.pop()).resolve()
revision = subprocess.check_output(['git', '-C', str(engine_root), 'rev-parse', 'HEAD'], text=True).strip()
if revision != '848182b33461640e9ac0feb7315f747a67877c88':
    raise SystemExit('Shared-engine regression requires the reviewed pinned revision')
shared = load('shared_rollout_fixture', engine_root / 'scripts/deploy/__tests__/aws_rollout_test.py')
operator = load('acceptance_operator', pathlib.Path(__file__).parents[1] / 'deploy/aws/rollback-acceptance-host.py')


class SharedEngineBridgeTest(unittest.TestCase):
    def test_exact_shared_deploy_and_recover_under_acceptance_observer(self):
        config = copy.deepcopy(shared.CONFIG)
        config.update({'acceptanceId': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'baseImage': shared.IMAGE + 'b' * 64})
        class Integration(shared.Fake):
            def __init__(self, value):
                super().__init__()
                self.config = copy.deepcopy(value)
                self.bad_image = value['image']
                self.containers['relay']['Id'] = 'c' * 64
                self.containers['relay']['Image'] = 'sha256:' + 'd' * 64
            def command(self, args, data=None, timeout=180, optional=False):
                if args[:3] == ['docker', 'image', 'inspect']:
                    image = {'Id': 'sha256:' + ('d' if args[-1] == config['baseImage'] else 'e') * 64, 'Architecture': 'amd64', 'Os': 'linux',
                             'RootFS': {'Type': 'layers', 'Layers': ['same']}, 'Config': {'Entrypoint': ['app'], 'Cmd': [], 'Env': ['PRIVATE-FIXTURE']}}
                    if args[-1] == config['image']:
                        image['Config']['Entrypoint'] = ['/bin/false']
                        image['Config']['Labels'] = {'relay.rollback.acceptance': config['acceptanceId'], 'relay.rollback.base': config['baseImage']}
                    return json.dumps([image])
                result = super().command(args, data=data, timeout=timeout, optional=optional)
                if args[:2] == ['docker', 'run']:
                    self.containers['relay']['State'].update({'Running': False, 'ExitCode': 1})
                return result
        receipt = operator.execute_acceptance(config, Integration, shared.module.RolloutError)
        self.assertTrue(receipt['accepted'] and receipt['sameContainerRestored'] and receipt['candidateRemoved'])
        self.assertNotIn('PRIVATE-', json.dumps(receipt))


if __name__ == '__main__': unittest.main()
