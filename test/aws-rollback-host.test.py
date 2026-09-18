import copy
import importlib.util
import json
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('rollback_acceptance', pathlib.Path(__file__).parents[1] / 'deploy/aws/rollback-acceptance-host.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
RUN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
BASE = 'owned.ecr/relay@sha256:' + 'a' * 64
CANDIDATE = 'owned.ecr/relay@sha256:' + 'b' * 64
CONFIG = {'acceptanceId': RUN, 'baseImage': BASE, 'image': CANDIDATE, 'health': '/readyz'}
IMAGE = {'Id': 'sha256:' + '1' * 64, 'Architecture': 'amd64', 'Os': 'linux', 'RootFS': {'Type': 'layers', 'Layers': ['sha256:fixture']},
         'Config': {'Entrypoint': ['node', 'app'], 'Cmd': [], 'Env': ['PRIVATE-ENV-FIXTURE'], 'User': '1000', 'Labels': {'base': 'label'}}}
FAIL_IMAGE = copy.deepcopy(IMAGE)
FAIL_IMAGE['Id'] = 'sha256:' + '2' * 64
FAIL_IMAGE['Config']['Entrypoint'] = ['/bin/false']
FAIL_IMAGE['Config']['Labels'].update({'relay.rollback.acceptance': RUN, 'relay.rollback.base': BASE})
ORIGINAL = {'Id': '3' * 64, 'Image': IMAGE['Id'], 'Config': {'Image': BASE, 'Env': ['PRIVATE-ENV-FIXTURE']},
            'HostConfig': {'RestartPolicy': {'Name': 'unless-stopped'}}, 'Mounts': [{'Source': '/srv/relay/data', 'Destination': '/var/lib/relay'}], 'State': {'Running': True}}


class Failure(Exception):
    pass


def fixture(*, busy=False, candidate_ready=False, bad_exit=False, wrong_id=False, config_changed=False, candidate_left=False, bad_image=False):
    class Fake:
        events = []
        def __init__(self, config):
            self.config, self.name = config, 'relay'
            self.value = copy.deepcopy(ORIGINAL)
        def validate_mount(self): self.events.append('mount-check')
        def validate_controllers(self): self.events.append('controller-check')
        def inspect(self, name): return copy.deepcopy(self.value)
        def raw_inspect(self, name): return {'Id': self.candidate_id} if candidate_left else copy.deepcopy(self.value)
        def names(self): return ['relay']
        def http(self, method, path): return self.value['State']['Running']
        def command(self, args):
            image = copy.deepcopy(IMAGE if args[-1] == BASE else FAIL_IMAGE)
            if bad_image and args[-1] == CANDIDATE: image['Config']['Env'] = ['EVIL']
            return json.dumps([image])
        def prepare(self): self.events.append('prepare'); return 'private-env-file'
        def start(self, envfile):
            self.events.append('candidate-start')
            self.value = {'Id': '4' * 64, 'Config': {'Image': CANDIDATE}, 'State': {'Running': False, 'ExitCode': 2 if bad_exit else 1}}
        def ready(self): return candidate_ready if self.value['Config']['Image'] == CANDIDATE else True
        def run(self):
            self.prepare()
            self.events.append('drain')
            if busy: raise Failure()
            self.events.append('old-stop')
            self.start('private-env-file')
            if self.ready(): return {'ok': True}
            self.events.append('recover')
            self.value = copy.deepcopy(ORIGINAL)
            if wrong_id: self.value['Id'] = '5' * 64
            if config_changed: self.value['Config']['Env'] = ['CHANGED']
            raise Failure()
    return Fake


class RollbackAcceptanceTest(unittest.TestCase):
    def test_controlled_failure_proves_exact_original_recovered_without_private_output(self):
        fake = fixture()
        result = module.execute_acceptance(CONFIG, fake, Failure)
        self.assertTrue(result['accepted'])
        self.assertTrue(result['sameContainerRestored'])
        self.assertEqual(result['candidateExitCode'], 1)
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertEqual(fake.events.count('candidate-start'), 1)
        self.assertEqual(fake.events.count('recover'), 1)

    def test_acceptance_requires_actual_failure_and_exact_config_id_cleanup(self):
        for changed in ({'candidate_ready': True}, {'bad_exit': True}, {'wrong_id': True}, {'config_changed': True}, {'candidate_left': True}):
            with self.subTest(changed=changed), self.assertRaises(module.AcceptanceError):
                module.execute_acceptance(CONFIG, fixture(**changed), Failure)

    def test_busy_controller_is_not_stopped_and_does_not_claim_rollback(self):
        fake = fixture(busy=True)
        with self.assertRaises(module.AcceptanceError): module.execute_acceptance(CONFIG, fake, Failure)
        self.assertNotIn('old-stop', fake.events)
        self.assertNotIn('candidate-start', fake.events)

    def test_bad_candidate_is_rejected_before_drain(self):
        fake = fixture(bad_image=True)
        with self.assertRaises(module.AcceptanceError): module.execute_acceptance(CONFIG, fake, Failure)
        self.assertNotIn('drain', fake.events)

    def test_only_entrypoint_cmd_and_exact_labels_may_differ_from_base_image(self):
        module.verify_failure_image(IMAGE, FAIL_IMAGE, CONFIG)
        for transform in [lambda i: i['RootFS']['Layers'].append('foreign'), lambda i: i['Config'].update({'Env': ['EVIL']}),
                          lambda i: i['Config'].update({'Entrypoint': ['/bin/sh']}), lambda i: i['Config'].update({'Cmd': ['bad']}),
                          lambda i: i['Config']['Labels'].update({'relay.rollback.acceptance': 'wrong'}), lambda i: i.update({'Architecture': 'arm64'})]:
            changed = copy.deepcopy(FAIL_IMAGE)
            transform(changed)
            with self.assertRaises(module.AcceptanceError): module.verify_failure_image(IMAGE, changed, CONFIG)


if __name__ == '__main__': unittest.main()
