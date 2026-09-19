"""Observe the pinned shared rollout without changing its recovery behavior.

Only fixed booleans and public image/container identifiers leave this process.
Docker inspection contains credentials: never print it, its env or exceptions.
"""
import base64
import copy
import fcntl
import gzip
import hashlib
import json
import os
import sys


class AcceptanceError(Exception):
    pass


def require(condition):
    if not condition:
        raise AcceptanceError('Rollback acceptance invariant failed; private diagnostics suppressed')


def verify_failure_image(original_image, candidate, config):
    require(original_image.get('Id') and original_image.get('Id') != candidate.get('Id'))
    require(original_image.get('RootFS', {}).get('Type') == 'layers')
    require(original_image.get('RootFS') == candidate.get('RootFS'))
    require(original_image.get('Architecture') == candidate.get('Architecture') == 'amd64')
    require(original_image.get('Os') == candidate.get('Os') == 'linux')
    before = copy.deepcopy(original_image.get('Config', {}))
    after = copy.deepcopy(candidate.get('Config', {}))
    require(after.pop('Entrypoint', None) == ['/bin/false'])
    require(after.pop('Cmd', None) in (None, []))
    before.pop('Entrypoint', None)
    before.pop('Cmd', None)
    labels = dict(before.pop('Labels', None) or {})
    labels.update({'relay.rollback.acceptance': config['acceptanceId'], 'relay.rollback.base': config['baseImage']})
    require(after.pop('Labels', None) == labels)
    require(before == after)


def execute_acceptance(config, rollout_class, rollout_error):
    class ObservedRollout(rollout_class):
        candidate_id = None
        candidate_not_ready = False
        candidate_exited_one = False

        def prepare(self):
            result = super().prepare()
            base = json.loads(self.command(['docker', 'image', 'inspect', config['baseImage']]))[0]
            candidate = json.loads(self.command(['docker', 'image', 'inspect', config['image']]))[0]
            require(base['Id'] == original['Image'])
            verify_failure_image(base, candidate, config)
            return result

        def start(self, envfile):
            super().start(envfile)
            value = self.inspect(self.name)
            require(value and value['Config']['Image'] == config['image'])
            require(value['Id'] != original['Id'])
            self.candidate_id = value['Id']

        def ready(self):
            value = self.inspect(self.name)
            candidate = value and value['Config']['Image'] == config['image']
            ready = super().ready()
            if candidate:
                value = self.inspect(self.name)
                self.candidate_not_ready = ready is False
                self.candidate_exited_one = bool(value and value['Id'] == self.candidate_id and value.get('State', {}).get('ExitCode') == 1)
            return ready

    rollout = ObservedRollout(config)
    rollout.validate_mount()
    rollout.validate_controllers()
    original = rollout.inspect(rollout.name)
    require(original and original.get('State', {}).get('Running') is True)
    require(original['Config']['Image'] == config['baseImage'])
    require(rollout.http('GET', config['health']))
    failed = False
    try:
        rollout.run()  # Exact shared prepare/drain/stop/start/readiness/recover.
    except rollout_error:
        failed = True
    require(failed and rollout.candidate_id and rollout.candidate_not_ready and rollout.candidate_exited_one)
    rollout.validate_mount()
    rollout.validate_controllers()
    restored = rollout.inspect(rollout.name)
    require(restored and restored['Id'] == original['Id'] and restored['Image'] == original['Image'])
    require(restored.get('State', {}).get('Running') is True)
    for field in ('Config', 'HostConfig', 'Mounts'):
        require(restored.get(field) == original.get(field))
    require(rollout.http('GET', config['health']))
    require(all(rollout.raw_inspect(name)['Id'] != rollout.candidate_id for name in rollout.names()))
    return {'schema': 1, 'accepted': True, 'acceptanceId': config['acceptanceId'],
            'candidateStarted': True, 'candidateExitCode': 1, 'candidateReadinessFailed': True,
            'originalContainerId': original['Id'], 'originalImage': config['baseImage'],
            'sameContainerRestored': True, 'sameConfigAndMounts': True, 'persistentVolumeVerified': True,
            'readyAfterRecovery': True, 'candidateRemoved': True, 'secretsMutated': False,
            'dataDeleted': False, 'olderPreviousSlotMayBeConsumed': True}


def main():
    os.umask(0o077)
    try:
        require(os.geteuid() == 0 and len(sys.argv) == 2)
        payload = json.loads(base64.b64decode(sys.argv[1], validate=True))
        source = gzip.decompress(base64.b64decode(payload.pop('engineGzip'), validate=True))
        require(len(source) <= 65536 and hashlib.sha256(source).hexdigest() == payload.pop('engineSha256'))
        namespace = {'__name__': 'reviewed_shared_rollout'}
        exec(compile(source, '<reviewed-shared-rollout>', 'exec'), namespace)
        with open('/run/12-apps-controller-rollout.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            receipt = execute_acceptance(payload, namespace['Rollout'], namespace['RolloutError'])
        print(json.dumps(receipt))
        return 0
    except Exception:
        print(json.dumps({'schema': 1, 'accepted': False, 'error': 'Rollback acceptance failed; inspect the exact SSM command and current controller readiness. Private diagnostics suppressed.'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
