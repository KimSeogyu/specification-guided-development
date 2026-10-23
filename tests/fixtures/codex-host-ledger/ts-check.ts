import { createLedgerFactRow, foldLedgerFact, type LedgerFactRow, type LedgerFactPartitionReport } from './generated/typescript/dist/machine.js';
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function same(actual: unknown, expected: unknown, message: string): void { const encode=(value: unknown):string=>JSON.stringify(value,(_key: string,item: unknown)=>typeof item==='bigint'?item.toString():item); assert(encode(actual)===encode(expected),message); }
function snapshot(row: LedgerFactRow): readonly string[] { return [row.symbol,String(row.key),String(row.time),String(row.value),String(row.received)]; }
function observe(value: unknown): void { console.log('SGD_HOST_LEDGER_TS '+JSON.stringify(value)); }
function row(key:bigint,value:bigint,received:bigint): LedgerFactRow { return createLedgerFactRow({symbol:'LEDGER',key,time:1n,value,received}); }
function report(baseline:readonly LedgerFactRow[],incoming:readonly LedgerFactRow[]): LedgerFactPartitionReport {
 const trial=foldLedgerFact({baseline,incoming}); assert(trial.ok,'fold accepted');
 const result=trial.value.intoReport(); assert(result.ok,'first consume accepted');
 const second=trial.value.intoReport(); assert(!second.ok && second.reason==='already-consumed','second consume refused');
 assert(Object.isFrozen(result.value),'report frozen'); return result.value;
}
{
 const r=report([], [row(10n,100n,1n),row(-2n,20n,2n),row(10n,100n,99n),row(-(2n**63n),30n,3n),row(2n**63n-1n,40n,4n)]);
 assert(r.kind==='Write','Write'); same(r.rows.map(r=>r.key),[-(2n**63n),-2n,10n,2n**63n-1n],'signed ordering');
 same(r.counts.inserted,4n,'inserted');same(r.counts.unchanged,1n,'unchanged');same(r.rows[2]?.received,1n,'first received');
 assert(Object.isFrozen(r.rows) && Object.isFrozen(r.rows[0]),'complete rows frozen');
 same(r.rows.map(snapshot),[snapshot(row(-(2n**63n),30n,3n)),snapshot(row(-2n,20n,2n)),snapshot(row(10n,100n,1n)),snapshot(row(2n**63n-1n,40n,4n))],'all complete Write fields');
 observe({scenario:'write',rows:r.rows.map(snapshot)});
}
{
 const r=report([row(4n,40n,4n),row(-2n,20n,2n)],[row(9n,90n,9n),row(4n,41n,10n),row(4n,41n,11n),row(-2n,21n,12n),row(4n,40n,13n)]);
 assert(r.kind==='Refused','Refused');same(r.original.map(r=>r.key),[4n,-2n],'original order, no provisional row');
 same(r.counts.inserted,0n,'rollback inserted');same(r.counts.unchanged,1n,'unchanged retained');same(r.conflicts.length,3,'all conflicts');
 same(r.conflicts.map(c=>c.stored.received),[4n,4n,2n],'stored complete provenance');same(r.conflicts.map(c=>c.rejected.received),[10n,11n,12n],'ordered complete rejected provenance');
 same(r.conflicts.map(c=>c.rejected.value),[41n,41n,21n],'ordered payloads');
 same(r.original.map(snapshot),[snapshot(row(4n,40n,4n)),snapshot(row(-2n,20n,2n))],'all original fields');
 const pairs=r.conflicts.map(c=>[snapshot(c.stored),snapshot(c.rejected)]);
 same(pairs,[[snapshot(row(4n,40n,4n)),snapshot(row(4n,41n,10n))],[snapshot(row(4n,40n,4n)),snapshot(row(4n,41n,11n))],[snapshot(row(-2n,20n,2n)),snapshot(row(-2n,21n,12n))]],'all conflict pair fields');
 observe({scenario:'rollback',original:r.original.map(snapshot),conflicts:pairs});
}
{
 const r=report([row(4n,40n,1n),row(4n,42n,2n)],[row(4n,42n,99n)]);assert(r.kind==='Noop','equal-only Noop');same(r.rows.map(r=>r.received),[1n,2n],'original duplicates retained');same(r.rows.map(snapshot),[snapshot(row(4n,40n,1n)),snapshot(row(4n,42n,2n))],'all Noop fields');observe({scenario:'noop',rows:r.rows.map(snapshot)});
 const empty=report([],[]);assert(empty.kind==='Noop' && empty.rows.length===0 && empty.group===null,'empty Noop');observe({scenario:'empty',rows:empty.rows.map(snapshot)});
 const w=report([row(4n,40n,1n),row(4n,42n,2n)],[row(-3n,30n,3n)]);assert(w.kind==='Write','duplicate baseline Write');same(w.rows.map(r=>r.key),[-3n,4n],'deduplicated order');same(w.rows[1]?.received,2n,'last baseline row');same(w.rows.map(snapshot),[snapshot(row(-3n,30n,3n)),snapshot(row(4n,42n,2n))],'all duplicate Write fields');observe({scenario:'duplicate-write',rows:w.rows.map(snapshot)});
}
{
 const base=row(1n,10n,1n);
 for (const [incoming,reason] of [[createLedgerFactRow({symbol:'OTHER',key:1n,time:1n,value:10n,received:1n}),'wrong-group'],[createLedgerFactRow({symbol:'LEDGER',key:1n,time:86_400_000_000n,value:10n,received:1n}),'wrong-group'],[createLedgerFactRow({symbol:'LEDGER',key:1n,time:-1n,value:10n,received:1n}),'invalid-calendar']] as const) {
   const r=foldLedgerFact({baseline:[base],incoming:[incoming]});assert(!r.ok && r.reason===reason,'group/calendar rejection');
 }
 const forged={symbol:'LEDGER',key:1n,time:1n,value:10n,received:1n} as unknown as LedgerFactRow;
 const invalid=foldLedgerFact({baseline:[],incoming:[forged]});assert(!invalid.ok && invalid.reason==='invalid-row','forged row');
 const sparse=foldLedgerFact({baseline:[],incoming:new Array<LedgerFactRow>(1)});assert(!sparse.ok && sparse.reason==='invalid-batch','sparse array');
 let getterCalled=false;const accessors=Object.defineProperty([],0,{get(){getterCalled=true;return base;}}) as LedgerFactRow[];
 const accessor=foldLedgerFact({baseline:[],incoming:accessors});assert(!accessor.ok && !getterCalled,'accessor refused without execution');
 const otherPath='./generated/typescript/dist/machine.js';const other=await import(otherPath+'?separate');
 const foreign=other.createLedgerFactRow({symbol:'LEDGER',key:1n,time:1n,value:10n,received:1n}) as LedgerFactRow;
 const foreignResult=foldLedgerFact({baseline:[],incoming:[foreign]});assert(!foreignResult.ok && foreignResult.reason==='invalid-row','cross-module token');
 observe({scenario:'boundaries',passed:true});
}
console.log('TypeScript behavior passed: Write, Noop, Refused, rollback, all conflicts, received retention, signed order, duplicates, group/calendar, tokens, arrays, single consumption.');
