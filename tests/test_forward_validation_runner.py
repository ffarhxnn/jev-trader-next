import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('forward', Path(__file__).resolve().parents[1] / 'scripts/run-forward-validation.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.now = 0
        self.calls = []
        self.protocol = module.json_bytes({'fixedAssumptions': module.ASSUMPTIONS, 'holdoutScored': False, 'realMoneyReady': False})
        self.window = {'startTimestamp': 1000000, 'endTimestamp': 1600000}

    def sleep(self, seconds):
        self.now += seconds

    def frozen(self):
        files = {}
        response = {'status': 'FROZEN_FORWARD_WINDOW', 'window': self.window, 'fixedAssumptions': module.ASSUMPTIONS}
        for name in ['audit', 'depth']:
            path = self.directory / ('frozen-' + name + '.jsonl')
            contents = b'{}\n' if name == 'audit' else b''.join(module.json_bytes({'timestamp': timestamp, 'block': block, 'minSizeMon': 1, 'makerFeeBps': 0, 'tickSize': 0.000001}).replace(b'\n', b'') + b'\n' for timestamp, block in [(1000000, 100), (1600000, 200)])
            module.exclusive(path, contents)
            os.chmod(path, 0o400)
            files[name] = {'path': path.name, 'sha256': module.digest(path.read_bytes()), 'sizeBytes': len(contents)}
            response[name + 'Path'] = str(path)
        manifest = {'schemaVersion': 1, 'status': 'FROZEN_FORWARD_WINDOW', 'window': self.window,
            'fixedAssumptions': module.ASSUMPTIONS, 'files': files,
            'sources': {'protocol': {'sha256': module.digest(self.protocol)}},
            'snapshots': 2, 'fromBlock': 100, 'toBlock': 200, 'decisions': 1,
            'chainId': 143, 'market': module.MARKET, 'holdoutScored': False, 'realMoneyReady': False}
        path = self.directory / 'frozen-manifest.json'
        module.exclusive(path, module.json_bytes(manifest))
        response['manifestPath'] = str(path)
        return {'ok': True, 'result': response}

    def execute(self, command, timeout, rpc=False):
        self.calls.append((command, timeout, rpc))
        script = Path(command[2]).name
        if script == 'freeze-forward-window.ts':
            return self.frozen()
        if script == 'reconstruct-receipt-trades.ts':
            path = Path(command[4])
            module.exclusive(path, b'{"kind":"trade","receiptFinalizedVerified":true}\n')
            return {'ok': True, 'result': {'evidenceStatus': 'RECEIPT_VERIFIED_MARKET_LOG_RECONSTRUCTION',
                'chainId': 143, 'market': module.MARKET, 'implementation': module.IMPLEMENTATION,
                'receiptFailures': 0, 'upgradeEvents': 0, 'verifiedEvents': 1, 'tradeLogs': 1, 'uniqueTransactions': 1,
                'finalizedVerification': {'block': 200, 'hash': '0x' + 'a' * 64, 'exactTransactionIndex': True, 'canonicalBlocksReadAfterCommitment': True},
                'clockAlignment': {'sampleCount': 2, 'maxResidualMs': 0},
                'capture': {**self.window, 'snapshots': 2, 'fromBlock': 100, 'toBlock': 200}, 'outputPath': str(path)}}
        flags = dict(zip(command[6::2], command[7::2]))
        files = [Path(path) for path in command[3:6]]
        return {'ok': True, 'result': {'holdoutScored': False, 'realMoneyReady': False, 'validationStatus': 'INSUFFICIENT_SAMPLE',
            'executionTimingModel': 'SINGLE_PLACEMENT_DELAYED_RECEIPT_PROXY', 'evidenceStatus': 'RESEARCH_PROXY_ONLY',
            'inputFiles': [{'name': path.name, 'sha256': module.digest(path.read_bytes()), 'sizeBytes': path.stat().st_size} for path in files],
            'source': {'chainId': 143, 'market': module.MARKET, 'firstTimestamp': 1000000, 'lastTimestamp': 1600000,
                'snapshots': 2, 'inputSnapshotsAdded': 0, 'decisions': 1, 'receiptVerifiedTrades': 1, 'finalizedCanonicalTrades': 1},
            'durationSeconds': 600, 'minimumWindowSeconds': 600, 'minimumFillFloor': 20,
            'assumptions': {'startingCash': 100, 'startingMon': 0, 'orderSizeMon': 200, 'positionCapMon': 1000,
                'maxLossUsd': 20, 'insideTicks': 1, 'maxSpreadBps': 50, 'gasUsdPerUpdate': 0.01,
                'orderLatencyMs': int(flags['--order-latency-ms']), 'receiptConfirmationDelayMs': 1000,
                'minimumOrderSizeMon': 1, 'feeBps': 0, 'tickSize': 0.000001},
            'executionStopped': False, 'counts': {key: 0 for key in ['attempts', 'applied', 'reverted', 'unresolved', 'pendingAtEnd', 'buyFills', 'sellFills', 'fills']},
            'attempts': [], 'fillDetails': [], 'endingCashUsd': 100, 'endingMon': 0, 'feesUsd': 0, 'gasCostsUsd': 0, 'grossPnlUsd': 0, 'netPnlUsd': 0}}

    def runner(self, execute=None, seconds=1000):
        return module.Runner(self.directory, self.protocol, '/fake/bun', seconds, 60,
            execute=execute or self.execute, clock=lambda: self.now, sleep=self.sleep)

    def test_complete_exact_flags_and_research_only(self):
        result = self.runner().run()
        self.assertEqual(result['status'], 'COMPLETED_RESEARCH_ONLY')
        self.assertFalse(result['realMoneyReady'])
        replays = [call for call in self.calls if Path(call[0][2]).name == 'single-placement-replay.ts']
        self.assertEqual(len(replays), 4)
        for (command, timeout, rpc), latency in zip(replays, [0, 500, 1000, 3000]):
            self.assertFalse(rpc)
            self.assertEqual(command[1], '--no-env-file')
            flags = dict(zip(command[6::2], command[7::2]))
            self.assertEqual(flags, {'--start-iso': module.iso(1000000), '--end-iso': module.iso(1600000),
                '--order-latency-ms': str(latency), '--receipt-confirmation-delay-ms': '1000', '--gas-usd-per-update': '0.01',
                '--starting-cash-usd': '100', '--starting-mon': '0', '--order-size-mon': '200', '--position-cap-mon': '1000',
                '--max-loss-usd': '20', '--inside-ticks': '1', '--max-spread-bps': '50', '--minimum-fills': '20', '--minimum-window-seconds': '600'})
        for path in self.directory.iterdir():
            if path.is_file():
                self.assertEqual(path.stat().st_mode & 0o777, 0o400 if path.name.startswith(('frozen-', 'replay-')) and path.name != 'frozen-provenance.json' else 0o600)

    def test_retries_same_window_partial_outputs_never_promoted(self):
        def fail(command, timeout, rpc=False):
            if Path(command[2]).name == 'reconstruct-receipt-trades.ts':
                self.calls.append((command, timeout, rpc))
                module.exclusive(Path(command[4]), b'partial')
                return {'ok': False, 'code': 'CHILD_TIMEOUT'}
            return self.execute(command, timeout, rpc)
        result = self.runner(fail).run()
        self.assertEqual(result['status'], 'PENDING_EXTERNAL_DATA')
        recon = [c for c in self.calls if c[2]]
        self.assertEqual(len(recon), 3)
        self.assertEqual(len(set(c[0][3] for c in recon)), 1)
        self.assertEqual(sum(Path(c[0][2]).name == 'freeze-forward-window.ts' for c in self.calls), 1)
        self.assertEqual(self.now, 120)
        self.assertFalse(list(self.directory.glob('replay-*')))

    def test_frozen_hash_mutation_refused_before_replay(self):
        def mutate(command, timeout, rpc=False):
            result = self.execute(command, timeout, rpc)
            if rpc:
                (self.directory / 'frozen-depth.jsonl').write_bytes(b'changed')
            return result
        self.assertEqual(self.runner(mutate).run()['status'], 'FAILED_SOURCE')
        self.assertFalse(list(self.directory.glob('replay-*')))

    def test_pending_capture_bounded_deadline(self):
        def pending(command, timeout, rpc=False):
            self.calls.append((command, timeout, rpc))
            return {'ok': True, 'result': {'status': 'PENDING_CAPTURE'}}
        result = self.runner(pending, seconds=121).run()
        self.assertEqual(result['status'], 'PENDING_EXTERNAL_DATA')
        self.assertEqual(self.now, 121)
        self.assertEqual(len(self.calls), 3)
        self.assertFalse((self.directory / 'frozen-manifest.json').exists())

    def test_protocol_assumption_drift_refused(self):
        self.protocol = module.json_bytes({'fixedAssumptions': {}, 'holdoutScored': False, 'realMoneyReady': False})
        self.assertEqual(self.runner().run()['status'], 'FAILED_SOURCE')
        self.assertEqual(self.calls, [])

    def test_exclusive_no_overwrite(self):
        self.runner()
        with self.assertRaises(FileExistsError):
            self.runner()

    def test_clean_env_and_timeout_kills_process_group(self):
        class FakeProcess:
            pid = 991
            returncode = 0
            def __init__(self): self.waits = 0
            def wait(self, timeout=None):
                self.waits += 1
                if self.waits == 1: raise subprocess.TimeoutExpired('safe', timeout)
        with patch.object(module.subprocess, 'Popen', return_value=FakeProcess()) as popen, patch.object(module.os, 'killpg') as kill:
            result = module.child(['/fake/bun', '--no-env-file', 'public-read.ts'], 120, rpc=True)
        self.assertEqual(result, {'ok': False, 'code': 'CHILD_TIMEOUT'})
        self.assertEqual(popen.call_args.kwargs['env'], {'PATH': '/fake:' + module.PATH, 'READ_RPC_URL': 'https://rpc.monad.xyz'})
        self.assertTrue(popen.call_args.kwargs['start_new_session'])
        self.assertEqual(popen.call_args.kwargs['stderr'], subprocess.DEVNULL)
        kill.assert_called_once_with(991, module.signal.SIGKILL)

    def test_already_running_no_new_run_directory(self):
        with patch.object(module, 'ROOT', self.directory), patch.object(module.fcntl, 'flock', side_effect=BlockingIOError), patch('sys.argv', ['runner', str(self.directory / 'protocol.json')]):
            (self.directory / 'data').mkdir()
            with patch('builtins.print') as output:
                self.assertEqual(module.main(), 2)
            self.assertEqual(json.loads(output.call_args.args[0])['status'], 'ALREADY_RUNNING')
            self.assertFalse(list((self.directory / 'data').glob('forward-validation-*')))

    def test_replay_ready_claim_refused(self):
        def invalid(command, timeout, rpc=False):
            result = self.execute(command, timeout, rpc)
            if Path(command[2]).name == 'single-placement-replay.ts':
                result['result']['realMoneyReady'] = True
            return result
        result = self.runner(invalid).run()
        self.assertEqual(result['status'], 'PENDING_EXTERNAL_DATA')
        self.assertFalse(result['realMoneyReady'])
        self.assertFalse(list(self.directory.glob('replay-*')))

    def test_partial_freeze_refused_without_retry(self):
        def partial(command, timeout, rpc=False):
            self.calls.append(command)
            module.exclusive(self.directory / 'frozen-depth.jsonl', b'partial')
            return {'ok': True, 'result': {'status': 'PENDING_CAPTURE'}}
        self.assertEqual(self.runner(partial).run()['status'], 'FAILED_SOURCE')
        self.assertEqual(len(self.calls), 1)

    def test_original_protocol_changes_refused(self):
        source = self.directory / 'original.json'
        module.exclusive(source, self.protocol)
        runner = module.Runner(self.directory, self.protocol, '/fake/bun', 1000, 60,
            execute=self.execute, clock=lambda: self.now, sleep=self.sleep, protocol_path=source)
        source.write_bytes(b'changed')
        self.assertEqual(runner.run()['status'], 'FAILED_SOURCE')
        self.assertEqual(self.calls, [])

    def test_retry_success_keeps_same_window(self):
        attempts = []
        def retry(command, timeout, rpc=False):
            if rpc:
                attempts.append(command)
                if len(attempts) < 3:
                    return {'ok': False, 'code': 'CHILD_NONZERO', 'returnCode': 1}
            return self.execute(command, timeout, rpc)
        self.assertEqual(self.runner(retry).run()['status'], 'COMPLETED_RESEARCH_ONLY')
        self.assertEqual(len(attempts), 3)
        self.assertEqual(len(set(cmd[3] for cmd in attempts)), 1)

    def test_missing_or_incorrect_replay_evidence_never_completes(self):
        for field in ['inputFiles', 'executionTimingModel', 'source', 'assumptions', 'counts', 'minimumFillFloor']:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                self.directory = Path(directory)
                self.now = 0
                def malformed(command, timeout, rpc=False):
                    result = self.execute(command, timeout, rpc)
                    if Path(command[2]).name == 'single-placement-replay.ts':
                        result['result'].pop(field)
                    return result
                result = self.runner(malformed).run()
                self.assertIn(result['status'], ['FAILED_SOURCE', 'PENDING_EXTERNAL_DATA'])
                self.assertFalse(result['realMoneyReady'])
                self.assertFalse(list(self.directory.glob('replay-*')))

    def test_reconstruction_provenance_refused(self):
        for field in ['implementation', 'market', 'finalizedVerification', 'verifiedEvents', 'capture']:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                self.directory = Path(directory)
                self.now = 0
                def malformed(command, timeout, rpc=False):
                    result = self.execute(command, timeout, rpc)
                    if rpc:
                        result['result'].pop(field)
                    return result
                result = self.runner(malformed).run()
                self.assertIn(result['status'], ['FAILED_SOURCE', 'PENDING_EXTERNAL_DATA'])
                self.assertFalse(list(self.directory.glob('replay-*')))

    def test_frozen_symlink_refused(self):
        runner = self.runner()
        result = self.frozen()['result']
        path = self.directory / 'frozen-depth.jsonl'
        moved = self.directory / 'other.jsonl'
        path.rename(moved)
        path.symlink_to(moved)
        with self.assertRaises(module.Refusal):
            runner.freeze(result)

    def test_explicit_bun_path_skips_environment_lookup(self):
        with patch.object(module, 'ROOT', self.directory), patch('sys.argv', ['runner', str(self.directory / 'protocol.json'), '--bun-path', '/usr/bin/true']):
            (self.directory / 'data').mkdir()
            module.exclusive(self.directory / 'protocol.json', self.protocol)
            with patch.object(module.shutil, 'which', side_effect=AssertionError('Unexpected lookup')), patch.object(module.Runner, 'run', return_value={'status': 'PENDING_EXTERNAL_DATA'}), patch('builtins.print'):
                self.assertEqual(module.main(), 0)

    def test_child_bad_json_sanitized(self):
        class FakeProcess:
            returncode = 0
            def wait(self, timeout=None): return 0
        def fake_popen(command, **kwargs):
            kwargs['stdout'].write(b'private-looking raw output that must never escape')
            return FakeProcess()
        with patch.object(module.subprocess, 'Popen', side_effect=fake_popen):
            self.assertEqual(module.child(['bun'], 120), {'ok': False, 'code': 'CHILD_INVALID_JSON'})

if __name__ == '__main__':
    unittest.main()
