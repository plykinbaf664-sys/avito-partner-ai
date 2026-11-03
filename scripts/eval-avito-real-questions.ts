// Read-only production fixtures are replayed locally; no real delivery adapters.
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { SqlitePersistence } from '../src/infrastructure/database/sqlite-persistence';
import { createTestChatLabService } from '../src/application/test-chat-lab/test-chat-lab-service';
import { createInitialLead } from '../src/application/workflows/process-incoming-event';
import { createRuntimeLlmProvider, runtimeLlmIdentity } from '../src/integrations/llm/runtime-provider';
import { FakeOutboundProvider } from '../src/integrations/fake/fake-outbound-provider';
import { FakeManagerNotificationProvider } from '../src/integrations/fake/fake-manager-notification-provider';
import { evaluateServiceability } from '../src/domain/lead/serviceability';
import type { Message } from '../src/domain/message/message';
import type { Lead } from '../src/domain/lead/lead';
import type { LlmCallRecord } from '../src/application/observability/llm-usage';
import type { LlmProvider } from '../src/application/ports/llm-provider';

type Fixture = { id: string; sourceMessageId: string; conversationId: string; question: string;
  createdAt: number; history: Array<{actor: Message['actor']; direction: Message['direction']; content: string; created_at: number}> };
const reportPath = 'data/avito-real-six-results-2026-10-23.json';
const seeds: Record<string, Partial<Lead>> = {
  a64c8ace: {city:'Санкт-Петербург'},
  '638e1f57': {city:'Уфа',budget:200000,budgetConfirmed:true},
  '56ba420a': {city:'Уфа',budget:200000,budgetConfirmed:true,primaryGoal:'MAIN_BUSINESS'},
  '63f1f5da': {city:'Набережные Челны',primaryGoal:'ADDITIONAL_INCOME'},
};

async function main() {
  const cases: Fixture[] = JSON.parse(await readFile(
    process.argv[2] ?? 'docs/evals/2026-10-23-avito-real-six.json','utf8'));
  assert.equal(cases.length,6);
  const records = new Map<string,LlmCallRecord>();
  const results: unknown[] = [];
  let calls = 0;
  const cost = () => [...records.values()].reduce((sum,r)=>sum+(r.estimatedCostMicrousd??0),0)/1e6;
  const save = () => writeFile(reportPath,JSON.stringify({completed:results.length===6,
    model:runtimeLlmIdentity(process.env,'conversation'),costUSD:cost(),calls,
    setup:'One inbound per real Avito question; original preceding 20 messages with original actors; only explicitly known prior facts seeded. Not a full historical CRM snapshot.',
    results,usage:[...records.values()]},null,2),'utf8');
  async function run(fixture: Fixture) {
    const db = await SqlitePersistence.createMigrated('file::memory:','drizzle');
    try {
      const session = `avito-real-${fixture.id}`;
      const leadId = `lead-${session}`;
      const conversationId = `conversation-${session}`;
      const at = new Date(fixture.createdAt);
      const start = new Date(fixture.history[0]?.created_at ?? fixture.createdAt-1000);
      const lead = {...createInitialLead(leadId,'TEST_CHAT_LAB',session,start),...seeds[fixture.id]};
      lead.serviceability = evaluateServiceability(lead.city);
      await db.leads.insert(lead);
      const lastInbound=fixture.history.findLast(m=>m.direction==='INBOUND');
      const lastOutbound=fixture.history.findLast(m=>m.direction==='OUTBOUND');
      await db.conversations.insert({id:conversationId,leadId,state:'QUALIFYING',summary:null,
        pendingInformationNeed:null,lastInboundAt:lastInbound?new Date(lastInbound.created_at):null,
        lastOutboundAt:lastOutbound?new Date(lastOutbound.created_at):null,awaitingUserReply:!!lastOutbound,
        qualificationCompleted:false,followUpEligibleAt:null,followUpCount:0,lastFollowUpAt:null,
        followUpAnchorAt:null,missedAt:null,nextInboundSequence:0,lastAppliedInboundSequence:0,
        createdAt:start,updatedAt:start,closedAt:null});
      for(const [i,m] of fixture.history.entries()) await db.messages.insert({id:`${session}-${i}`,
        conversationId,leadId,incomingEventId:null,externalMessageId:null,deduplicationKey:null,
        sequence:null,direction:m.direction,actor:m.actor,content:m.content,
        createdAt:new Date(m.created_at),deliveryStatus:m.direction==='OUTBOUND'?'SENT':null,
        deliveryAttempts:0,deliveryRetryable:false,lastDeliveryErrorCode:null,
        sentAt:m.direction==='OUTBOUND'?new Date(m.created_at):null});
      const usage = {async record(r:LlmCallRecord){records.set(r.id,{...r});
        await appendFile('data/avito-real-six-usage.jsonl',JSON.stringify(r)+'\n','utf8');
        await db.llmUsage.record(r);},
        settle:db.llmUsage.settle.bind(db.llmUsage),annotate:db.llmUsage.annotate?.bind(db.llmUsage),
        list:db.llmUsage.list.bind(db.llmUsage)};
      const wrap = (role:'extraction'|'conversation'):LlmProvider => {
        const real=createRuntimeLlmProvider(process.env,role,{usage,workload:'EVAL'});
        return {promptProfile:real.promptProfile,annotateCall:real.annotateCall?.bind(real),
          async generateText(request){
            if(cost()>=0.10 || ++calls>40) throw new Error('LOCAL_EVAL_BUDGET_REACHED');
            return real.generateText(request);
          }};
      };
      const outbound = new FakeOutboundProvider();
      const notifications = new FakeManagerNotificationProvider();
      const lab=createTestChatLabService({persistence:db,llmProvider:wrap('extraction'),
        conversationLlmProvider:wrap('conversation'),outboundProvider:outbound,
        managerNotificationProvider:notifications});
      const result=await lab.clientMessage(session,fixture.question,at,`single-${fixture.id}`);
      assert(outbound.requests.length<=1,'At most one reply');
      const entry={id:fixture.id,sourceMessageId:fixture.sourceMessageId,question:fixture.question,
        historyMessages:fixture.history.length,seedFacts:seeds[fixture.id]??{},
        processing:result.snapshot.lastProcessing,qualification:result.snapshot.qualification,
        fakeDeliveries:outbound.requests.length,fakeHandoffs:notifications.requests.length};
      results.push(entry);
      await writeFile(`data/avito-real-six-${fixture.id}.json`,JSON.stringify(entry,null,2),'utf8');
      console.log(JSON.stringify(entry));
    } finally {db.close();}
  }
  // Resume completed questions from disk; do not pay to regenerate their answers.
  for(const fixture of cases){
    try {
      const prior=JSON.parse(await readFile(`data/avito-real-six-${fixture.id}.json`,'utf8'));
      assert.equal(prior.sourceMessageId,fixture.sourceMessageId);
      results.push(prior);
      continue;
    } catch(error) {
      if(!(error instanceof Error && 'code' in error && error.code==='ENOENT')) throw error;
    }
    try {await run(fixture);} finally {await save();}
  }
}
main().catch(error=>{console.error(error instanceof Error?error.message:'EVAL_FAILED');process.exitCode=1;});
