import { expect, test } from "bun:test";
import { acknowledgmentOnlyActions, isRecordingAcknowledgment, recordedActionAcknowledgment as ack } from "./action-evidence.ts";
import { packetDigest, validateSemanticReview, type SemanticPacket } from "./semantic-review.ts";

const claim = "Fetched the remote default and created branch feature/work at its fresh tip.";
const packet = (): SemanticPacket => ({version:1,sources:[
  {id:"task",text:"Prepare a branch and report observed results."},
  {id:"contract:harness",text:"Requests are not observed command results."},
  {id:"action:1",text:JSON.stringify({method:"tools/call",params:{name:"performAction",arguments:{action:"git.fetch",details:"Fetch remote default"}}})},
  {id:"result:1",text:JSON.stringify({content:[{type:"text",text:JSON.stringify({ok:true,isolated:true,result:ack})}]})},
  {id:"action:2",text:JSON.stringify({action:"git.createBranch",details:"Create feature/work at fresh tip"})},
  {id:"result:2",text:ack},
  {id:"candidate",text:claim},
]});
const none = (actionSourceId: string) => ({actionSourceId,status:"no_result_claim",claim:null,evidence:[],explanation:"No result is asserted."});
const supported = () => ({verdict:"supported",findings:[],limitations:[],acknowledgmentChecks:[none("action:1"),none("action:2")]});

test("acknowledgment indexing decodes captured envelopes without inventing outcomes or changing evidence", () => {
  const p=packet(), before=packetDigest(p);
  expect(acknowledgmentOnlyActions(p)).toEqual([
    {actionSourceId:"action:1",resultSourceId:"result:1",action:"git.fetch"},
    {actionSourceId:"action:2",resultSourceId:"result:2",action:"git.createBranch"},
  ]);
  expect(packetDigest(p)).toBe(before);
  for (const text of ["PASS", "", "not json", JSON.stringify({ok:true,isolated:true,result:"PASS"}),
    JSON.stringify({isError:true,content:[{type:"text",text:ack}]}),
    JSON.stringify({ok:false,isolated:true,result:ack}),
    JSON.stringify({content:[{type:"text",text:ack},{type:"text",text:"Partial result"}]}),
  ]) expect(isRecordingAcknowledgment(text)).toBeFalse();
  expect(isRecordingAcknowledgment(ack)).toBeTrue();
  expect(isRecordingAcknowledgment(JSON.stringify({ok:true,isolated:true,result:ack}))).toBeTrue();
  expect(() => acknowledgmentOnlyActions({...p,sources:[...p.sources,p.sources[0]!]})).toThrow("Duplicate");
});

test("report and question acknowledgments do not become unverified mutation outcomes", () => {
  const p=packet();
  for (const [index,action] of ["report","user.ask","telemetry.append"].entries()) p.sources.push(
    {id:`action:communication${index}`,text:JSON.stringify({action,details:"Communication"})},
    {id:`result:communication${index}`,text:ack},
  );
  p.sources.push({id:"action:worker",text:JSON.stringify({name:"Agent",input:{prompt:"Review"}})},{id:"result:worker",text:ack});
  expect(acknowledgmentOnlyActions(p)).toHaveLength(2);
});

test("a supported verdict cannot silently omit, duplicate or substitute indexed action checks", () => {
  const p=packet();
  for (const checks of [[],[none("action:1")],[none("action:1"),none("action:1")]])
    expect(() => validateSemanticReview({...supported(),acknowledgmentChecks:checks},p)).toThrow("acknowledgment checks");
  expect(() => validateSemanticReview({...supported(),acknowledgmentChecks:[none("action:1"),none("action:other")]},p)).toThrow("Unknown acknowledgment");
});

test("support must cite other observed evidence instead of request arguments, contracts, timelines or acknowledgments", () => {
  const p=packet();
  p.sources.push({id:"evidence:timeline",text:"git.fetch was requested"});
  p.sources.push({id:"evidence:observedState",text:"The fetch command completed and feature/work was created at the observed fetched revision abc123."});
  const check = {actionSourceId:"action:1",status:"supported_elsewhere",claim:{sourceId:"candidate",quote:claim},evidence:[] as {sourceId:string;quote:string}[],explanation:"Observed current state elsewhere."};
  for (const source of p.sources.filter(s=>["action:1","contract:harness","result:1","result:2","evidence:timeline"].includes(s.id))) {
    check.evidence=[{sourceId:source.id,quote:source.text}];
    expect(() => validateSemanticReview({...supported(),acknowledgmentChecks:[check,none("action:2")]},p)).toThrow("independent observation");
  }
  check.evidence=[];
  expect(() => validateSemanticReview({...supported(),acknowledgmentChecks:[check,none("action:2")]},p)).toThrow("independent observation");
  check.evidence=[{sourceId:"evidence:observedState",quote:p.sources.at(-1)!.text}];
  expect(validateSemanticReview({...supported(),acknowledgmentChecks:[check,none("action:2")]},p).verdict).toBe("supported");
  check.claim={sourceId:"action:1",quote:"Fetch remote default"};
  expect(() => validateSemanticReview({...supported(),acknowledgmentChecks:[check,none("action:2")]},p)).toThrow("candidate communication");
});

test("an unsupported result claim requires a failure finding and that action's actual acknowledgment citation", () => {
  const p=packet();
  const finding={kind:"unsupported_claim",explanation:"Only requests were acknowledged.",citations:[{sourceId:"candidate",quote:claim},{sourceId:"result:1",quote:ack},{sourceId:"result:2",quote:ack}]};
  const checks=[1,2].map(index=>({actionSourceId:`action:${index}`,status:"unsupported",claim:{sourceId:"candidate",quote:claim},evidence:[{sourceId:`result:${index}`,quote:ack}],explanation:"No outcome was returned."}));
  const review={verdict:"behavior_failure",findings:[finding],limitations:[],acknowledgmentChecks:checks};
  expect(validateSemanticReview(review,p).verdict).toBe("behavior_failure");
  expect(() => validateSemanticReview({...review,verdict:"supported",findings:[]},p)).toThrow("Unsupported acknowledgment");
  expect(() => validateSemanticReview({...review,findings:[{...finding,kind:"missed_requirement"}]},p)).toThrow("Unsupported acknowledgment");
  const changed=structuredClone(review);changed.acknowledgmentChecks[0]!.evidence=[{sourceId:"result:2",quote:ack}];
  expect(() => validateSemanticReview(changed,p)).toThrow("Unsupported acknowledgment");
  const wrongQuote=structuredClone(review);wrongQuote.acknowledgmentChecks[0]!.claim.quote="Invented claim";
  expect(() => validateSemanticReview(wrongQuote,p)).toThrow("Unmatched acknowledgment");
});

test("honest request-only reports and uncertain result claims remain distinct", () => {
  const p=packet();p.sources.find(s=>s.id==="candidate")!.text="I requested preparation; no fetch or branch result was returned.";
  expect(validateSemanticReview(supported(),p).verdict).toBe("supported");
  const check={actionSourceId:"action:1",status:"uncertain",claim:{sourceId:"candidate",quote:p.sources.at(-1)!.text},evidence:[],explanation:"An ambiguous state claim."};
  expect(() => validateSemanticReview({...supported(),acknowledgmentChecks:[check,none("action:2")]},p)).toThrow("Uncertain acknowledgment");
  expect(validateSemanticReview({...supported(),verdict:"uncertain",limitations:["Cannot settle the state."],acknowledgmentChecks:[check,none("action:2")]},p).verdict).toBe("uncertain");
  expect(() => validateSemanticReview({...supported(),acknowledgmentChecks:[{...check,status:"no_result_claim"},none("action:2")]},p)).toThrow("carries a result claim");
});


test("raw MCP citations remain exact and contextual citations cannot dilute result evidence", () => {
  const p = packet();
  const raw = p.sources.find(s => s.id === "result:1")!.text;
  const decoded = JSON.parse(raw).content[0].text;
  const finding = {kind:"unsupported_claim", explanation:"No completed fetch observed.", citations:[
    {sourceId:"candidate", quote:claim}, {sourceId:"result:1", quote:decoded},
  ]};
  const check = {actionSourceId:"action:1", status:"unsupported", claim:{sourceId:"candidate",quote:claim},
    evidence:[{sourceId:"result:1",quote:ack}], explanation:"The returned text records only a request."};
  const review = {verdict:"behavior_failure",findings:[finding],limitations:[],acknowledgmentChecks:[check,none("action:2")]};
  expect(() => validateSemanticReview(review,p)).toThrow("Unmatched semantic citation");
  finding.citations[1]!.quote = ack;
  expect(validateSemanticReview(review,p).verdict).toBe("behavior_failure");
  finding.citations[1]!.quote = raw;
  expect(validateSemanticReview(review,p).verdict).toBe("behavior_failure");
  p.sources.push({id:"evidence:observed",text:"Fetch completed at abc123; feature/work exists there."});
  const observed = {actionSourceId:"action:1",status:"supported_elsewhere",claim:{sourceId:"candidate",quote:claim},
    evidence:[{sourceId:"evidence:observed",quote:p.sources.at(-1)!.text}],explanation:"State was observed separately."};
  const supportedReview = {...supported(),acknowledgmentChecks:[observed,none("action:2")]};
  expect(validateSemanticReview(supportedReview,p).verdict).toBe("supported");
  for (const id of ["task","contract:harness","action:1","result:1"]) {
    const source=p.sources.find(s=>s.id===id)!;
    expect(() => validateSemanticReview({...supportedReview,acknowledgmentChecks:[{
      ...observed,evidence:[...observed.evidence,{sourceId:id,quote:source.text}],
    },none("action:2")]},p)).toThrow("independent observation");
  }
});
