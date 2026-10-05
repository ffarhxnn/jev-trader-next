import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync, statSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FORWARD_ASSUMPTIONS, FORWARD_BOOK_POLICY, FORWARD_TRADE_POLICY, FORWARD_MARKET, FORWARD_WINDOW_RULE, selectForwardCapture } from "../src/forward-capture";
import { freezeForwardCapture } from "../src/freeze-forward-capture";
import { prepareSinglePlacementAudit } from "../src/single-placement-audit";
import { parseDepthJsonl } from "../src/research";
const protocol = () => ({ schemaVersion:4,declaredAt:"2026-10-01T10:23:33Z",sourceAudit:"paper-audit-2026-10-01T10-22-54-212Z.jsonl",
  sourceContract:"same-audit-explicit-observed-book-sequence",windowRule:FORWARD_WINDOW_RULE,fixedAssumptions:{...FORWARD_ASSUMPTIONS},
  model:"local heuristic only, fixed supplied actions; not Jev rerun",holdoutScored:false,realMoneyReady:false,
  bookFreshnessPolicy:FORWARD_BOOK_POLICY,bookStaleAfterMs:5000,tradeFeedLifecyclePolicy:FORWARD_TRADE_POLICY,tradeFeedStaleAfterMs:60000 });
const session = () => ({kind:"session_start",timestamp:0,mode:"paper",model:"stand-in momentum heuristic",market:FORWARD_MARKET,
  orderSizeMon:200,positionCapMon:1000,startingCashUsd:100,lossStopUsd:20,pollMs:1000,bookStaleAfterMs:5000,
  bookFreshnessPolicy:FORWARD_BOOK_POLICY,tradeFeedStaleAfterMs:60000,tradeFeedLifecyclePolicy:FORWARD_TRADE_POLICY,
  quotePricingPolicy:"whole-tick-improvement-or-touch-v1",quoteInsideTicks:1});
const book = (timestamp: number) => ({timestamp,block:timestamp+100,chainId:143,market:FORWARD_MARKET,tickSize:0.000001,
  sizePrecision:1e10,minSizeMon:200,makerFeeBps:0,takerFeeBps:0,captureIntervalMs:1000,bids:[[0.03,42]],asks:[[0.030002,71]]});
const observed = (timestamp:number) => ({kind:"book_observed",timestamp,observedAt:timestamp,publishedAt:timestamp+1,inputSnapshot:book(timestamp)});
const decision = (timestamp:number,action="hold") => ({kind:"decision",timestamp:timestamp+10,bookReceivedAt:timestamp,block:timestamp+100,
  chainId:143,bestBid:0.03,bestAsk:0.030002,mid:0.030001,spreadBps:0.666644,action,model:"stand-in momentum heuristic",
  decisionSource:"local demo heuristic",inputSnapshot:book(timestamp)});
const segment = (start:number,duration:number) => Array.from({length:duration/1000+1},(_,i)=>observed(start+i*1000));
const jsonl = (rows:unknown[]) => rows.map(r=>JSON.stringify(r)).join("\n")+"\n";
const goodRows = () => [session(),...segment(1000,601000),decision(1000)];
const select = (rows:unknown[],p=protocol()) => selectForwardCapture(p,jsonl(rows),p.sourceAudit);
const directories: string[] = [];
afterEach(()=>{ for (const path of directories.splice(0)) rmSync(path,{recursive:true,force:true}); });
function files(rows:unknown[]=goodRows()) {
  const dir=mkdtempSync(join(tmpdir(),"jev-forward-"));directories.push(dir);
  const p=protocol(),protocolPath=join(dir,"protocol.json"),auditPath=join(dir,p.sourceAudit),prefix=join(dir,"frozen");
  writeFileSync(protocolPath,JSON.stringify(p)+"\n");writeFileSync(auditPath,jsonl(rows));
  return {dir,p,protocolPath,auditPath,prefix};
}

test("selects first qualifying interval rather than best outcome or longest, at first end observation",()=>{
  const result=select([session(),...segment(1000,602000),decision(1000,"hold"),...segment(700000,800000),decision(700000,"buy"),
    {kind:"fill",timestamp:800000,pnl:999999}])!;
  expect(result.startTimestamp).toBe(1000);expect(result.endTimestamp).toBe(601000);
  expect(result.snapshots).toHaveLength(601);expect(result.decisions).toBe(1);
  expect(result.auditContents).not.toContain("999999");expect(result.auditContents).not.toContain('"buy"');
});
test("discards incomplete prefix and preserves first real gap marker",()=>{
  const result=select([session(),...segment(1000,2000),...segment(10000,600000),decision(10000)])!;
  expect(result.startTimestamp).toBe(10000);expect(result.incompleteSegmentsDiscarded).toBe(1);
  expect(result.snapshots[0]!.gapBefore).toBe(true);expect(result.snapshots.slice(1).some(s=>s.gapBefore)).toBe(false);
  expect(prepareSinglePlacementAudit(result.auditContents,result.snapshots,10000,610000,true).snapshots).toEqual(result.snapshots);
});
test("internal gap cannot be bridged and incomplete duration returns pending",()=>{
  expect(select([session(),...segment(1000,300000),...segment(400000,300000),decision(1000)])).toBeNull();
  expect(select([session(),...segment(1000,599000),decision(1000)])).toBeNull();
});
test("missing observed data and selected decision fail; no later better window fallback",()=>{
  expect(()=>select([session(),decision(1000)])).toThrow("Missing observed-book");
  expect(()=>select([session(),...segment(1000,600000),...segment(700000,600000),decision(700000)])).toThrow("No complete recorded decisions");
  expect(()=>select([session(),...segment(1000,600000),{...decision(1000),inputSnapshot:book(1500)}])).toThrow();
});
test("rejects protocol assumptions, source and session policies or provenance mismatch",()=>{
  for (const p of [{...protocol(),schemaVersion:3},{...protocol(),windowRule:"best window"},
    {...protocol(),fixedAssumptions:{...FORWARD_ASSUMPTIONS,minimumFillFloor:1}},
    {...protocol(),sourceAudit:"../escape.jsonl"}]) expect(()=>selectForwardCapture(p,jsonl(goodRows()),protocol().sourceAudit)).toThrow();
  for(const patch of [{tradeFeedLifecyclePolicy:"old"},{bookStaleAfterMs:60000},{pollMs:2000},{mode:"live"},{model:"provider"}])
    expect(()=>select([{...session(),...patch},...segment(1000,600000),decision(1000)])).toThrow("Session start");
  expect(()=>selectForwardCapture(protocol(),jsonl(goodRows()),"different.jsonl")).toThrow("filename");
  expect(()=>select([session(),{...observed(1000),inputSnapshot:{...book(1000),market:`0x${"1".repeat(40)}`}}])).toThrow("provenance");
});
test("time/block rollback and contradictory books cannot be hidden after selected window",()=>{
  expect(()=>select([...goodRows(),observed(999)])).toThrow("rollback");
  expect(()=>select([...goodRows(),{...observed(1000),inputSnapshot:{...book(1000),bids:[[0.03,99]]}}])).toThrow("Contradictory");
});
test("unknown fields, arbitrary kinds and prompts never enter frozen audit or protocol",()=>{
  const result=select([{...session(),prompt:"PRIVATE_SENTINEL"},...segment(1000,600000),
    {...decision(1000),prompt:"PRIVATE_SENTINEL",positionMon:777,inputSnapshot:{...book(1000),secret:"PRIVATE_SENTINEL"}},
    {kind:"unrecognized",timestamp:3,prompt:"PRIVATE_SENTINEL"}],{...protocol(),prompt:"PRIVATE_SENTINEL"} as ReturnType<typeof protocol>)!;
  expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
  expect(result.auditContents).not.toContain("positionMon");
});
test("freezes owner-only new files with exact hashes and strict same-audit lineage",()=>{
  const f=files();const result=freezeForwardCapture(f.protocolPath,f.prefix);
  expect(result.status).toBe("FROZEN_FORWARD_WINDOW");if(result.status!=="FROZEN_FORWARD_WINDOW")throw new Error("fixture");
  const manifest=JSON.parse(readFileSync(result.manifestPath,"utf8"));
  for(const file of Object.values(manifest.files) as Array<{path:string;sha256:string;sizeBytes:number}>) {
    const bytes=readFileSync(join(f.dir,file.path));expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
    expect(bytes.length).toBe(file.sizeBytes);expect(statSync(join(f.dir,file.path)).mode&0o777).toBe(0o400);
  }
  expect(statSync(result.manifestPath).mode&0o777).toBe(0o400);
  const depth=parseDepthJsonl(readFileSync(result.depthPath,"utf8"));
  expect(prepareSinglePlacementAudit(readFileSync(result.auditPath,"utf8"),depth,result.window.startTimestamp,result.window.endTimestamp,true).snapshots).toEqual(depth);
  expect(manifest.sources.audit.sizeBytes).toBe(readFileSync(f.auditPath).length);
  expect(()=>freezeForwardCapture(f.protocolPath,f.prefix)).toThrow();
  expect(readFileSync(result.manifestPath,"utf8")).toBe(JSON.stringify(manifest,null,2)+"\n");
});
test("partial trailing write is omitted; append-only producer growth before publish is allowed",()=>{
  const f=files();appendFileSync(f.auditPath,'{"kind":"book_observed"');
  const result=freezeForwardCapture(f.protocolPath,f.prefix,{beforePublish:()=>appendFileSync(f.auditPath,',"ignored":true}\n')});
  expect(result.status).toBe("FROZEN_FORWARD_WINDOW");if(result.status!=="FROZEN_FORWARD_WINDOW")throw new Error("fixture");
  const manifest=JSON.parse(readFileSync(result.manifestPath,"utf8"));
  expect(manifest.sourceSnapshot.omittedPartialTailBytes).toBeGreaterThan(0);
  expect(readFileSync(result.auditPath,"utf8")).not.toContain("ignored");
});
test("complete malformed row fails instead of treating corruption as an appending tail",()=>{
  const f=files();appendFileSync(f.auditPath,'{bad}\n');expect(()=>freezeForwardCapture(f.protocolPath,f.prefix)).toThrow("Invalid complete audit row");
  expect(readdirSync(f.dir).some(name=>name.startsWith("frozen"))).toBe(false);
});
test("source mutation, replacement or protocol mutation aborts and cleans only new partial artifacts",()=>{
  for(const kind of ["audit","replacement","protocol"]) {
    const f=files();
    expect(()=>freezeForwardCapture(f.protocolPath,f.prefix,{beforePublish:()=>{
      if(kind==="replacement") {rmSync(f.auditPath);writeFileSync(f.auditPath,jsonl(goodRows()));}
      else if(kind==="protocol") appendFileSync(f.protocolPath," ");
      else writeFileSync(f.auditPath,jsonl([session(),...segment(2000,600000),decision(2000)]));
    }})).toThrow("SOURCE_CHANGED");
    expect(readdirSync(f.dir).some(name=>name.startsWith("frozen"))).toBe(false);
  }
});
test("collision during partial freeze preserves existing output and removes only new artifacts",()=>{
  for(const suffix of ["-audit.jsonl","-depth.jsonl","-manifest.json"]) {
    const f=files();writeFileSync(f.prefix+suffix,"EXISTING",{mode:0o600});
    expect(()=>freezeForwardCapture(f.protocolPath,f.prefix)).toThrow();
    expect(readFileSync(f.prefix+suffix,"utf8")).toBe("EXISTING");
    expect(readdirSync(f.dir).filter(name=>name.startsWith("frozen"))).toEqual(["frozen"+suffix]);
  }
});
test("pending capture produces no output artifacts",()=>{
  const f=files([session(),...segment(1000,1000),decision(1000)]);
  expect(freezeForwardCapture(f.protocolPath,f.prefix).status).toBe("PENDING_CAPTURE");
  expect(readdirSync(f.dir).some(name=>name.startsWith("frozen"))).toBe(false);
});
test("mutated new frozen output cannot be committed under its expected hash",()=>{
  const f=files();
  expect(()=>freezeForwardCapture(f.protocolPath,f.prefix,{beforePublish:()=>{
    chmodSync(f.prefix+"-depth.jsonl",0o600);writeFileSync(f.prefix+"-depth.jsonl","CHANGED");
  }})).toThrow("FROZEN_OUTPUT_CHANGED");
  expect(readdirSync(f.dir).some(name=>name.startsWith("frozen"))).toBe(false);
});
