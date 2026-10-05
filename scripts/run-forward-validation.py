#!/usr/bin/env python3
"""Bounded public-data forward replay; never enables trading."""
import argparse
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
ASSUMPTIONS = dict(startingCashUsd=100, startingMon=0, orderSizeMon=200,
    positionCapMon=1000, maxLossUsd=20, insideTicks=1, maxSpreadBps=50,
    gasUsdPerUpdate=0.01, orderLatencyMsScenarios=[0, 500, 1000, 3000],
    receiptConfirmationDelayMs=1000, minimumWindowSeconds=600, minimumFillFloor=20)
PATH = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin'
RPC = 'https://rpc.monad.xyz'
MARKET = '0x065c9d28e428a0db40191a54d33d5b7c71a9c394'
IMPLEMENTATION = '0x5e3446c600524be453bbcefd46a9e4c9be8899a0'

class Refusal(Exception):
    pass

def digest(data):
    return hashlib.sha256(data).hexdigest()

def exclusive(path, data):
    with open(path, 'xb') as stream:
        os.chmod(path, 0o600)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())

def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()

def child(command, timeout, rpc=False):
    """No inherited environment or dotenv; discard all stderr and raw failures."""
    env = {'PATH': str(Path(command[0]).resolve().parent) + ':' + PATH}
    if rpc:
        env['READ_RPC_URL'] = RPC
    with tempfile.TemporaryFile() as stdout:
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=stdout,
            stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL, start_new_session=True)
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            return {'ok': False, 'code': 'CHILD_TIMEOUT'}
        if process.returncode != 0:
            return {'ok': False, 'code': 'CHILD_NONZERO', 'returnCode': process.returncode}
        stdout.seek(0)
        raw = stdout.read(2_000_001)
    if len(raw) > 2_000_000:
        return {'ok': False, 'code': 'CHILD_OUTPUT_LIMIT'}
    try:
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError()
        return {'ok': True, 'result': result}
    except (ValueError, UnicodeError, RecursionError):
        return {'ok': False, 'code': 'CHILD_INVALID_JSON'}

def iso(timestamp):
    return datetime.datetime.fromtimestamp(timestamp / 1000, datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

class Runner:
    def __init__(self, directory, protocol_bytes, bun, deadline_seconds=21600,
                 poll_seconds=60, execute=child, clock=time.monotonic, sleep=time.sleep, protocol_path=None):
        self.directory = Path(directory)
        self.protocol_bytes = protocol_bytes
        self.protocol_path = Path(protocol_path) if protocol_path else self.directory / 'protocol.json'
        self.bun = bun
        self.execute = execute
        self.clock = clock
        self.sleep = sleep
        self.deadline = clock() + deadline_seconds
        self.poll_seconds = poll_seconds
        self.manifest = None
        self.pins = {}
        self.provenance = {'protocolSha256': digest(protocol_bytes), 'fixedAssumptions': ASSUMPTIONS,
            'holdoutScored': False, 'realMoneyReady': False, 'readRpcUrl': RPC,
            'maximumReconstructionAttempts': 3, 'childTimeoutSeconds': 120,
            'deadlineSeconds': deadline_seconds, 'pollSeconds': poll_seconds}
        exclusive(self.directory / 'protocol.json', protocol_bytes)
        exclusive(self.directory / 'provenance.json', json_bytes(self.provenance))
        self.status('WAITING_CAPTURE')

    def status(self, status, **details):
        value = {'status': status, 'holdoutScored': False, 'realMoneyReady': False, **details}
        temporary = self.directory / ('status-' + str(time.time_ns()) + '.tmp')
        exclusive(temporary, json_bytes(value))
        os.replace(temporary, self.directory / 'status.json')
        return value

    def invoke(self, script, arguments, rpc=False):
        remaining = self.deadline - self.clock()
        if remaining <= 0:
            return {'ok': False, 'code': 'DEADLINE_EXPIRED'}
        return self.execute([self.bun, '--no-env-file', str(ROOT / 'scripts' / script), *map(str, arguments)], min(120, remaining), rpc=rpc)

    def pause(self, seconds):
        self.sleep(max(0, min(seconds, self.deadline - self.clock())))

    def freeze(self, response):
        base = self.directory.resolve()
        manifest_path = Path(response['manifestPath'])
        if manifest_path.is_symlink():
            raise Refusal('SYMLINK_MANIFEST_REFUSED')
        manifest_path = manifest_path.resolve()
        if manifest_path.parent != base:
            raise Refusal('MANIFEST_OUTSIDE_RUN')
        raw = manifest_path.read_bytes()
        manifest = json.loads(raw)
        if manifest.get('status') != 'FROZEN_FORWARD_WINDOW' or manifest.get('schemaVersion') != 1 or manifest.get('fixedAssumptions') != ASSUMPTIONS:
            raise Refusal('INVALID_FROZEN_MANIFEST')
        if manifest['sources']['protocol']['sha256'] != digest(self.protocol_bytes):
            raise Refusal('PROTOCOL_HASH_MISMATCH')
        window = manifest['window']
        if window != response.get('window') or window['endTimestamp'] - window['startTimestamp'] < 600000:
            raise Refusal('INVALID_FROZEN_WINDOW')
        self.pins[manifest_path] = digest(raw)
        for name in ['audit', 'depth']:
            record = manifest['files'][name]
            path = base / record['path']
            if path.is_symlink() or Path(response[name + 'Path']).is_symlink():
                raise Refusal('SYMLINK_ARTIFACT_REFUSED')
            path = path.resolve()
            if path.parent != base or path != Path(response[name + 'Path']).resolve() or path.is_symlink():
                raise Refusal('ARTIFACT_OUTSIDE_RUN')
            contents = path.read_bytes()
            if digest(contents) != record['sha256'] or len(contents) != record['sizeBytes']:
                raise Refusal('ARTIFACT_HASH_MISMATCH')
            os.chmod(path, 0o400)
            self.pins[path] = record['sha256']
        os.chmod(manifest_path, 0o400)
        self.manifest = manifest
        self.depth = Path(response['depthPath']).resolve()
        self.audit = Path(response['auditPath']).resolve()
        rows = [json.loads(row) for row in self.depth.read_text().splitlines() if row]
        self.book = rows[0]
        if len(rows) != manifest['snapshots'] or rows[0]['block'] != manifest['fromBlock'] or rows[-1]['block'] != manifest['toBlock'] or rows[0]['timestamp'] != window['startTimestamp'] or rows[-1]['timestamp'] != window['endTimestamp']:
            raise Refusal('FROZEN_DEPTH_METADATA_MISMATCH')
        if manifest.get('chainId') != 143 or str(manifest.get('market')).lower() != MARKET or manifest.get('holdoutScored') is not False or manifest.get('realMoneyReady') is not False:
            raise Refusal('FROZEN_SOURCE_REFUSED')
        self.verify()
        exclusive(self.directory / 'frozen-provenance.json', json_bytes({
            'manifestSha256': digest(raw), 'protocolSha256': digest(self.protocol_bytes),
            'window': window, 'files': manifest['files'], 'fixedAssumptions': ASSUMPTIONS,
            'holdoutScored': False, 'realMoneyReady': False}))

    def verify(self):
        if self.protocol_path.read_bytes() != self.protocol_bytes or (self.directory / 'protocol.json').read_bytes() != self.protocol_bytes:
            raise Refusal('PROTOCOL_HASH_MISMATCH')
        for path, expected in self.pins.items():
            if path.is_symlink() or digest(path.read_bytes()) != expected:
                raise Refusal('FROZEN_HASH_MISMATCH')

    def replay_args(self, tape, latency):
        w = self.manifest['window']
        values = {'start-iso': iso(w['startTimestamp']), 'end-iso': iso(w['endTimestamp']),
            'order-latency-ms': latency, 'receipt-confirmation-delay-ms': 1000,
            'gas-usd-per-update': 0.01, 'starting-cash-usd': 100, 'starting-mon': 0,
            'order-size-mon': 200, 'position-cap-mon': 1000, 'max-loss-usd': 20,
            'inside-ticks': 1, 'max-spread-bps': 50, 'minimum-fills': 20,
            'minimum-window-seconds': 600}
        return [self.depth, tape, self.audit, *[item for key, val in values.items() for item in ('--' + key, str(val))]]

    @staticmethod
    def natural(value, positive=False):
        return type(value) is int and value >= (1 if positive else 0)

    def reconstruction_valid(self, report, candidate):
        capture = report.get('capture', {})
        finality = report.get('finalizedVerification', {})
        alignment = report.get('clockAlignment', {})
        expected = {**self.manifest['window'], 'snapshots': self.manifest['snapshots'],
                    'fromBlock': self.manifest['fromBlock'], 'toBlock': self.manifest['toBlock']}
        if not (report.get('evidenceStatus') == 'RECEIPT_VERIFIED_MARKET_LOG_RECONSTRUCTION'
            and report.get('chainId') == 143 and str(report.get('market')).lower() == MARKET
            and str(report.get('implementation')).lower() == IMPLEMENTATION
            and report.get('receiptFailures') == 0 and report.get('upgradeEvents') == 0
            and all(capture.get(key) == value for key, value in expected.items())
            and finality.get('exactTransactionIndex') is True
            and finality.get('canonicalBlocksReadAfterCommitment') is True
            and self.natural(finality.get('block')) and finality['block'] >= self.manifest['toBlock']
            and isinstance(finality.get('hash'), str) and len(finality['hash']) == 66
            and finality['hash'].startswith('0x')
            and all(c in '0123456789abcdefABCDEF' for c in finality['hash'][2:])
            and self.natural(report.get('verifiedEvents'), True) and self.natural(report.get('tradeLogs'), True)
            and self.natural(report.get('uniqueTransactions'), True)
            and report['uniqueTransactions'] <= report['tradeLogs'] <= report['verifiedEvents']
            and self.natural(alignment.get('sampleCount'), True)
            and type(alignment.get('maxResidualMs')) in (int, float)
            and 0 <= alignment['maxResidualMs'] <= 5000
            and report.get('outputPath') == str(candidate)
            and candidate.is_file() and not candidate.is_symlink()):
            return False
        rows = [json.loads(row) for row in candidate.read_text().splitlines() if row]
        trades = [row for row in rows if row.get('kind') == 'trade']
        return len(trades) == report['verifiedEvents'] and all(row.get('receiptFinalizedVerified') is True for row in trades)

    def replay_valid(self, report, tape, latency):
        source = report.get('source', {})
        assumptions = report.get('assumptions', {})
        counts = report.get('counts', {})
        expected_assumptions = {'startingCash': 100, 'startingMon': 0, 'orderSizeMon': 200,
            'positionCapMon': 1000, 'maxLossUsd': 20, 'insideTicks': 1, 'maxSpreadBps': 50,
            'gasUsdPerUpdate': 0.01, 'orderLatencyMs': latency, 'receiptConfirmationDelayMs': 1000,
            'minimumOrderSizeMon': self.book['minSizeMon'], 'feeBps': self.book['makerFeeBps'], 'tickSize': self.book['tickSize']}
        expected_files = [{'name': path.name, 'sha256': self.pins[path], 'sizeBytes': path.stat().st_size}
                          for path in [self.depth, tape, self.audit]]
        if not (report.get('holdoutScored') is False and report.get('realMoneyReady') is False
            and report.get('executionTimingModel') == 'SINGLE_PLACEMENT_DELAYED_RECEIPT_PROXY'
            and report.get('evidenceStatus') == 'RESEARCH_PROXY_ONLY'
            and report.get('inputFiles') == expected_files
            and source.get('chainId') == 143 and str(source.get('market')).lower() == MARKET
            and source.get('firstTimestamp') == self.manifest['window']['startTimestamp']
            and source.get('lastTimestamp') == self.manifest['window']['endTimestamp']
            and source.get('snapshots') == self.manifest['snapshots']
            and source.get('inputSnapshotsAdded') == 0
            and source.get('decisions') == self.manifest['decisions']
            and self.natural(source.get('receiptVerifiedTrades'))
            and source.get('receiptVerifiedTrades') == source.get('finalizedCanonicalTrades')
            and report.get('durationSeconds') == (self.manifest['window']['endTimestamp'] - self.manifest['window']['startTimestamp']) / 1000
            and report['durationSeconds'] >= 600 and report.get('minimumWindowSeconds') == 600
            and report.get('minimumFillFloor') == 20 and assumptions == expected_assumptions
            and type(report.get('executionStopped')) is bool
            and all(self.natural(counts.get(key)) for key in ['attempts', 'applied', 'reverted', 'unresolved', 'pendingAtEnd', 'buyFills', 'sellFills', 'fills'])
            and counts.get('fills') == counts.get('buyFills') + counts.get('sellFills')
            and isinstance(report.get('fillDetails'), list) and len(report['fillDetails']) == counts['fills']
            and isinstance(report.get('attempts'), list) and len(report['attempts']) == counts['attempts']
            and all(type(report.get(key)) in (int, float) and math.isfinite(report[key]) for key in ['endingCashUsd', 'endingMon', 'feesUsd', 'gasCostsUsd', 'grossPnlUsd', 'netPnlUsd'])):
            return False
        status = 'UNRESOLVED_EXECUTION_PROXY' if report['executionStopped'] else 'INSUFFICIENT_SAMPLE' if counts['fills'] < 20 else 'FILL_FLOOR_MET_RESEARCH_ONLY'
        return report.get('validationStatus') == status

    def run(self):
        try:
            protocol = json.loads(self.protocol_bytes)
            if protocol.get('fixedAssumptions') != ASSUMPTIONS or protocol.get('holdoutScored') is not False or protocol.get('realMoneyReady') is not False:
                raise Refusal('PROTOCOL_ASSUMPTIONS_REFUSED')
            while self.clock() < self.deadline:
                self.verify()
                response = self.invoke('freeze-forward-window.ts', [self.protocol_path, '--out-prefix', self.directory / 'frozen'])
                if not response['ok']:
                    return self.status('FAILED_SOURCE', errorCode=response['code'])
                result = response['result']
                if result.get('status') == 'FROZEN_FORWARD_WINDOW':
                    self.freeze(result)
                    self.status('FROZEN', window=self.manifest['window'])
                    break
                if result.get('status') != 'PENDING_CAPTURE':
                    raise Refusal('FREEZE_STATUS_REFUSED')
                if any(self.directory.glob('frozen-*')):
                    raise Refusal('PARTIAL_FREEZE_REFUSED')
                self.verify()
                self.pause(self.poll_seconds)
            if self.manifest is None:
                return self.status('PENDING_EXTERNAL_DATA', errorCode='CAPTURE_DEADLINE_EXPIRED')
            tape = None
            for attempt in range(1, 4):
                self.verify()
                self.status('RECONSTRUCTION_PENDING', attempt=attempt, window=self.manifest['window'])
                attempt_dir = self.directory / ('reconstruction-' + str(attempt))
                attempt_dir.mkdir(mode=0o700)
                candidate = attempt_dir / 'receipt-trades.jsonl'
                outcome = self.invoke('reconstruct-receipt-trades.ts', [self.depth, candidate], rpc=True)
                self.verify()
                report = outcome.get('result', {})
                if outcome['ok'] and self.reconstruction_valid(report, candidate):
                    os.chmod(candidate, 0o400)
                    exclusive(attempt_dir / 'report.json', json_bytes(report))
                    os.chmod(attempt_dir / 'report.json', 0o400)
                    self.pins[attempt_dir / 'report.json'] = digest((attempt_dir / 'report.json').read_bytes())
                    tape = candidate
                    self.pins[tape] = digest(tape.read_bytes())
                    break
                if candidate.exists() and not candidate.is_symlink():
                    os.chmod(candidate, 0o400)
                exclusive(attempt_dir / 'failure.json', json_bytes({'errorCode': outcome.get('code', 'INCOMPLETE_RECONSTRUCTION'), 'holdoutScored': False, 'realMoneyReady': False}))
                if attempt < 3 and self.clock() < self.deadline:
                    self.pause(60)
                else:
                    break
            if tape is None:
                return self.status('PENDING_EXTERNAL_DATA', errorCode='RECONSTRUCTION_UNAVAILABLE')
            summaries = []
            for latency in ASSUMPTIONS['orderLatencyMsScenarios']:
                self.verify()
                outcome = self.invoke('single-placement-replay.ts', self.replay_args(tape, latency))
                self.verify()
                report = outcome.get('result', {})
                if not outcome['ok'] or not self.replay_valid(report, tape, latency):
                    return self.status('PENDING_EXTERNAL_DATA', errorCode=outcome.get('code', 'INVALID_REPLAY_REPORT'))
                replay_path = self.directory / ('replay-' + str(latency) + 'ms.json')
                exclusive(replay_path, json_bytes(report))
                os.chmod(replay_path, 0o400)
                self.pins[replay_path] = digest(replay_path.read_bytes())
                summaries.append({'orderLatencyMs': latency, 'validationStatus': report.get('validationStatus')})
            return self.status('COMPLETED_RESEARCH_ONLY', scenarios=summaries, window=self.manifest['window'])
        except Exception:
            return self.status('FAILED_SOURCE', errorCode='SOURCE_OR_ARTIFACT_REFUSED')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('protocol', type=Path)
    parser.add_argument('--bun-path', type=Path, help='Explicit Bun executable; default searches the fixed generic PATH')
    parser.add_argument('--max-wait-seconds', '--deadline-seconds', dest='deadline_seconds', type=int, default=21600)
    parser.add_argument('--poll-seconds', type=int, default=60)
    args = parser.parse_args()
    if not 1 <= args.deadline_seconds <= 43200 or not 30 <= args.poll_seconds <= 60:
        parser.error('deadline must be 1..43200 seconds and poll must be 30..60 seconds')
    os.umask(0o077)
    data = ROOT / 'data'
    if args.protocol.is_symlink():
        raise Refusal('SYMLINK_PROTOCOL_REFUSED')
    protocol_path = args.protocol.resolve()
    lock_path = data / ('.forward-validation-' + digest(str(protocol_path).encode()) + '.lock')
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status': 'ALREADY_RUNNING', 'holdoutScored': False, 'realMoneyReady': False}))
            return 2
        bun = str(args.bun_path.resolve()) if args.bun_path is not None else shutil.which('bun', path=PATH)
        if bun and (not Path(bun).is_file() or not os.access(bun, os.X_OK)):
            bun = None
        if not bun:
            print(json.dumps({'status': 'FAILED_SOURCE', 'errorCode': 'BUN_UNAVAILABLE'}))
            return 2
        directory = Path(tempfile.mkdtemp(prefix='forward-validation-', dir=data))
        os.chmod(directory, 0o700)
        try:
            result = Runner(directory, protocol_path.read_bytes(), bun, args.deadline_seconds, args.poll_seconds, protocol_path=protocol_path).run()
        except Exception:
            result = {'status': 'FAILED_SOURCE', 'errorCode': 'PROTOCOL_SNAPSHOT_FAILED', 'holdoutScored': False, 'realMoneyReady': False}
            exclusive(directory / 'status.json', json_bytes(result))
        print(json.dumps({'runDirectory': str(directory), **result}))
        return 0 if result['status'] in ['COMPLETED_RESEARCH_ONLY', 'PENDING_EXTERNAL_DATA'] else 2
    finally:
        os.close(descriptor)

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print(json.dumps({'status': 'FAILED_SOURCE', 'errorCode': 'RUNNER_START_REFUSED', 'holdoutScored': False, 'realMoneyReady': False}))
        raise SystemExit(2)
