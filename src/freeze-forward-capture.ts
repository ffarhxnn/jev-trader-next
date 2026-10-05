import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { basename, dirname, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { selectForwardCapture, validateForwardProtocol } from "./forward-capture";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
interface SourceRead { path: string; fd: number; bytes: Buffer; dev: number; ino: number }
function readSource(path: string): SourceRead {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("SOURCE_SIZE_OR_TYPE");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("SOURCE_CHANGED");
      offset += count;
    }
    return { path, fd, bytes, dev: stat.dev, ino: stat.ino };
  } catch (error) { closeSync(fd); throw error; }
}
function verifySource(source: SourceRead, bytes: Buffer, allowAppend: boolean) {
  const pathStat = lstatSync(source.path), fdStat = fstatSync(source.fd);
  if (!pathStat.isFile() || pathStat.dev !== source.dev || pathStat.ino !== source.ino
    || fdStat.dev !== source.dev || fdStat.ino !== source.ino
    || (allowAppend ? fdStat.size < source.bytes.length : fdStat.size !== source.bytes.length)) throw new Error("SOURCE_CHANGED");
  // Validate the entire initially read prefix, including any incomplete tail, without requiring append inactivity.
  const again = Buffer.alloc(source.bytes.length);
  let offset = 0;
  while (offset < again.length) {
    const count = readSync(source.fd, again, offset, again.length - offset, offset);
    if (!count) throw new Error("SOURCE_CHANGED");
    offset += count;
  }
  if (!again.equals(source.bytes) || !again.subarray(0, bytes.length).equals(bytes)) throw new Error("SOURCE_CHANGED");
}
export interface FreezeForwardOptions {
  /** Test seam for producer mutation or append between snapshot and publication; CLI does not expose it. */
  beforePublish?: () => void;
}
/** A complete manifest commits an exclusive new freeze; failures remove only files created by this invocation. */
export function freezeForwardCapture(protocolPath: string, outPrefix: string, options: FreezeForwardOptions = {}) {
  const protocolFile = readSource(resolve(protocolPath));
  let auditFile: SourceRead | undefined;
  const created: string[] = [];
  try {
    const protocol = validateForwardProtocol(JSON.parse(protocolFile.bytes.toString("utf8")));
    const auditPath = resolve(dirname(protocolFile.path), protocol.sourceAudit);
    if (dirname(auditPath) !== dirname(protocolFile.path) || basename(auditPath) !== protocol.sourceAudit) throw new Error("SOURCE_PATH_MISMATCH");
    auditFile = readSource(auditPath);
    const lastNewline = auditFile.bytes.lastIndexOf(10);
    const complete = auditFile.bytes.subarray(0, lastNewline + 1);
    const selection = selectForwardCapture(protocol, complete.toString("utf8"), basename(auditPath));
    if (!selection) {
      verifySource(protocolFile, protocolFile.bytes, false);
      verifySource(auditFile, complete, true);
      return { status: "PENDING_CAPTURE" as const, sourceAudit: protocol.sourceAudit, minimumWindowSeconds: 600 };
    }
    const prefix = resolve(outPrefix);
    const frozenAuditPath = prefix + "-audit.jsonl", depthPath = prefix + "-depth.jsonl", manifestPath = prefix + "-manifest.json";
    if ([frozenAuditPath, depthPath, manifestPath].includes(protocolFile.path) || [frozenAuditPath, depthPath, manifestPath].includes(auditPath)) throw new Error("OUTPUT_SOURCE_COLLISION");
    // Reserve outputs before reading any outcome; existing files are never reused or overwritten.
    const auditContents = selection.auditContents;
    const depthContents = selection.snapshots.map(s => JSON.stringify(s)).join("\n") + "\n";
    const writeExclusive = (path: string, contents: string) => {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created.push(path);
      try { writeFileSync(fd, contents, "utf8"); } finally { closeSync(fd); }
      chmodSync(path, 0o400);
    };
    writeExclusive(frozenAuditPath, auditContents);
    writeExclusive(depthPath, depthContents);
    options.beforePublish?.();
    verifySource(protocolFile, protocolFile.bytes, false);
    verifySource(auditFile, complete, true);
    for (const [path, expected] of [[frozenAuditPath, auditContents], [depthPath, depthContents]]) {
      const output = readSource(path!);
      try {
        if (!output.bytes.equals(Buffer.from(expected!))) throw new Error("FROZEN_OUTPUT_CHANGED");
      } finally { closeSync(output.fd); }
    }
    const file = (path: string, contents: string) => ({path:relative(dirname(manifestPath), path),sha256:sha256(contents),sizeBytes:Buffer.byteLength(contents)});
    const source = (value: SourceRead, bytes: Buffer) => ({path:relative(dirname(manifestPath),value.path),sha256:sha256(bytes),sizeBytes:bytes.length,dev:value.dev,ino:value.ino});
    const window = { startTimestamp: selection.startTimestamp, endTimestamp: selection.endTimestamp };
    const manifest = {
      schemaVersion: 1, status: "FROZEN_FORWARD_WINDOW", window, fixedAssumptions: selection.protocol.fixedAssumptions,
      protocol: selection.protocol, files:{audit:file(frozenAuditPath,auditContents),depth:file(depthPath,depthContents)},
      sources:{protocol:source(protocolFile,protocolFile.bytes),audit:source(auditFile,complete)},
      sourceSnapshot:{completeLineBytes:complete.length,initialReadBytes:auditFile.bytes.length,omittedPartialTailBytes:auditFile.bytes.length-complete.length,appendAllowed:true},
      chainId:143,market:selection.snapshots[0]!.market,fromBlock:selection.snapshots[0]!.block,toBlock:selection.snapshots.at(-1)!.block,
      snapshots:selection.snapshots.length,decisions:selection.decisions,completionsCensoredAtEnd:selection.completionsCensoredAtEnd,
      incompleteSegmentsDiscarded:selection.incompleteSegmentsDiscarded,
      selectionRule:"first-complete-continuous-observed-book-window-in-file-order",
      evidenceStatus:"FROZEN_SOURCE_REQUIRES_FINALIZED_RECEIPT_RECONSTRUCTION",holdoutScored:false,realMoneyReady:false,
    };
    writeExclusive(manifestPath,JSON.stringify(manifest,null,2)+"\n");
    return {status:"FROZEN_FORWARD_WINDOW" as const,manifestPath,depthPath,auditPath:frozenAuditPath,window,fixedAssumptions:selection.protocol.fixedAssumptions};
  } catch(error) {
    for (const path of created.reverse()) { try { unlinkSync(path); } catch {} }
    throw error;
  } finally { closeSync(protocolFile.fd); if (auditFile) closeSync(auditFile.fd); }
}
