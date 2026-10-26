import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { importDot } from '../src/dot.js';
import { buildProject, compile, compileProject, writeGenerated } from '../src/compiler.js';
import { ProjectSchema } from '../src/types.js';
import { generateVisualization, loadAutomaton } from '../src/visualize.js';
import { runTlc } from '../src/tlc.js';

const dot = `strict digraph DiskGraph { subgraph cluster_graph {
1 [label="state = \\"New\\"", style=filled];
2 [label="state = \\"Done\\""];
1 -> 2 [label="Finish"];
2 -> 2 [label="Idle"];
{rank=same;1;}
}}`.replaceAll('\\"', '\\"');
const project = ProjectSchema.parse({version:1,name:'Example',spec:'Example.tla',config:'Example.cfg',stateVariable:'state',targets:['typescript'],binding:{kind:'transition',function:'transition'}});

test('imports nested real TLC shape and preserves repeated source-target action labels', () => {
  const input = dot.replace('1 -> 2 [label="Finish"];', '1 -> 2 [label="Finish"];1 -> 2 [label="Other"];');
  const model = importDot({dot:input,name:'Example',stateVariable:'state'});
  assert.deepEqual(model.initialStates, ['New']);
  assert.deepEqual(new Set(model.transitions.map(edge=>edge.event)), new Set(['Finish','Other','Idle']));
  assert.equal(model.source.stateCount, 2);
});

test('rejects unlabeled edges, unsupported state values, incomplete and missing-initial graphs', () => {
  for(const input of [dot.replace('[label="Finish"]',''), dot.replace('state = \\"Done\\"','state = <<1,2>>'),dot.slice(0,-2),dot.replace('style=filled','style=solid')]) {
    assert.throws(()=>importDot({dot:input,name:'Example',stateVariable:'state'}));
  }
});

test('rejects scalar projections that would collapse distinct TLA value types', () => {
  const input=dot.replace('state = \\"New\\"','state = 1').replace('state = \\"Done\\"','state = \\"1\\"');
  assert.throws(()=>importDot({dot:input,name:'Example',stateVariable:'state'}),/TLC101/);
});

test('generation is deterministic and contains actual language-specific source', () => {
  const a=compile({dot,project});const b=compile({dot,project});
  assert.deepEqual(a,b);
  assert.ok(a.files.some(file=>file.path==='typescript/checker.mjs'));
  assert.ok(a.files.every(file => !file.path.startsWith('rust/')));
});

test('imported DOT remains unverified and stale generation fails', async () => {
  const temp=await mkdtemp(join(tmpdir(),'sgd-compile-'));
  try {
    const projectPath=join(temp,'project.json');const graphPath=join(temp,'model.dot');const out=join(temp,'out');
    await writeFile(projectPath,JSON.stringify(project));await writeFile(graphPath,dot);
    await compileProject({project:projectPath,dot:graphPath,out});
    assert.equal(JSON.parse(await readFile(join(out,'verification.json'),'utf8')).kind,'imported-unverified');
    await compileProject({project:projectPath,dot:graphPath,out,check:true});
    await writeFile(join(out,'typescript/checker.mjs'),'edited');
    await assert.rejects(compileProject({project:projectPath,dot:graphPath,out,check:true}),/TLC104/);
  } finally { await rm(temp,{recursive:true,force:true}); }
});

test('output containment rejects traversal and dependency maps require all states', async () => {
  await assert.rejects(writeGenerated({out:'.runtime/test',files:[{path:'../escape',content:'bad'}]}),/TLC103/);
  assert.throws(()=>compile({dot,project:{...project,binding:{kind:'dependency',modules:{New:['src/new']}}}}),/TLC103/);
});

test('managed outputs remove obsolete checkers and reject unmanaged output reuse', async () => {
  const temp=await mkdtemp(join(tmpdir(),'sgd-output-'));
  try {
    const projectPath=join(temp,'project.json');const graphPath=join(temp,'model.dot');const out=join(temp,'out');
    await writeFile(projectPath,JSON.stringify(project));await writeFile(graphPath,dot);
    await compileProject({project:projectPath,dot:graphPath,out});
    await access(join(out,'typescript/checker.mjs'));
    await writeGenerated({out,files:[{path:'automaton.json',content:'new-model'}]});
    await assert.rejects(access(join(out,'typescript/checker.mjs')));
    const unmanaged=join(temp,'unmanaged');
    await writeGenerated({out:unmanaged,files:[]});
    await rm(join(unmanaged,'.sgd-generated.json'));
    await writeFile(join(unmanaged,'user-file.txt'),'keep');
    await assert.rejects(writeGenerated({out:unmanaged,files:[]}),/empty directory/);
    assert.equal(await readFile(join(unmanaged,'user-file.txt'),'utf8'),'keep');
  } finally {await rm(temp,{recursive:true,force:true});}
});

test('generated outputs cannot write through symbolic links', async () => {
  const temp=await mkdtemp(join(tmpdir(),'sgd-symlink-'));
  try {
    const out=join(temp,'out');
    await writeGenerated({out,files:[{path:'checker.mjs',content:'owned'}]});
    const protectedFile=join(temp,'protected.txt');await writeFile(protectedFile,'untouched');
    await rm(join(out,'checker.mjs'));await symlink(protectedFile,join(out,'checker.mjs'));
    await assert.rejects(writeGenerated({out,files:[{path:'checker.mjs',content:'overwrite'}]}),/symbolic link/);
    assert.equal(await readFile(protectedFile,'utf8'),'untouched');
  } finally {await rm(temp,{recursive:true,force:true});}
});

test('regeneration preserves unowned files and check requires volatile evidence files', async () => {
  const out=await mkdtemp(join(tmpdir(),'sgd-owned-'));
  try {
    await writeGenerated({out,files:[{path:'automaton.json',content:'owned'}]});
    await writeFile(join(out,'index.html'),'user content');
    await assert.rejects(writeGenerated({out,files:[{path:'index.html',content:'generated'}]}),/unowned/);
    assert.equal(await readFile(join(out,'index.html'),'utf8'),'user content');
    const files=[{path:'verification.json',content:'receipt',volatile:true}];
    await writeGenerated({out,files});
    await writeGenerated({out,files:[{path:'verification.json',content:'new transient metadata',volatile:true}],check:true});
    await rm(join(out,'verification.json'));
    await assert.rejects(writeGenerated({out,files,check:true}),/TLC104/);
  } finally {await rm(out,{recursive:true,force:true});}
});

test('concurrent writers cannot mix generated outputs', async () => {
  const out=await mkdtemp(join(tmpdir(),'sgd-concurrent-'));
  try {
    const results=await Promise.allSettled([
      writeGenerated({out,files:[{path:'one.json',content:'one'}]}),
      writeGenerated({out,files:[{path:'two.json',content:'two'}]}),
    ]);
    assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(results.filter(result=>result.status==='rejected').length,1);
    await assert.rejects(access(join(out,'.sgd-output.lock')));
    await writeGenerated({out,files:[{path:'final.json',content:'final'}]});
    assert.equal(await readFile(join(out,'final.json'),'utf8'),'final');
  } finally {await rm(out,{recursive:true,force:true});}
});

test('Pele renders architecture and behavior with a structural containment edge', () => {
  const model=importDot({dot,name:'Architecture',stateVariable:'state'});
  const child={...model,name:'Child',parent:{model:'Architecture',state:'New'}};
  const files=generateVisualization([model,child]);
  assert.ok(files.find(file=>file.path==='structure.svg')?.content.includes('<svg'));
  assert.ok(files.find(file=>file.path==='structure.mmd')?.content.includes('contains model'));
  const html=files.find(file=>file.path==='index.html')?.content ?? '';
  assert.ok(html.includes('Filter transition rows'));
  assert.ok(!html.includes('src="http'));
  assert.throws(()=>generateVisualization([model,model]),/duplicate model/);
});

const jar=process.env.TLA2TOOLS_JAR;
test('real TLC completes, drives TypeScript output, and supports a deterministic check', {skip:!jar}, async () => {
  assert.ok(jar);
  const temp=await mkdtemp(join(tmpdir(),'sgd-e2e-'));
  try {
    const input={project:resolve('examples/order/project.json'),jar:resolve(jar),out:temp};
    const automaton=await buildProject(input);
    assert.ok(automaton.transitions.some(edge=>edge.from==='Pending'&&edge.event==='Ack'&&edge.to==='Acked'));
    await buildProject({...input,check:true});
    const evidence=JSON.parse(await readFile(join(temp,'verification.json'),'utf8'));
    assert.equal(evidence.kind,'tlc-completed');
    await writeFile(join(temp,'verification.json'),JSON.stringify({...evidence,kind:'forged'}));
    await assert.rejects(buildProject({...input,check:true}),/TLC104/);
    await writeFile(join(temp,'verification.json'),JSON.stringify(evidence));
    assert.equal((await loadAutomaton(join(temp,'automaton.json'))).name,'Order');
    await writeFile(join(temp,'good.ts'),'transition("Pending", "Ack", "Acked");');
    const result=execFileSync(process.execPath,[join(temp,'typescript/checker.mjs'),'--root',temp,'good.ts'],{cwd:process.cwd(),encoding:'utf8'});
    assert.deepEqual(JSON.parse(result),[]);
    const spec=join(temp,'Bad.tla');const config=join(temp,'Bad.cfg');
    await writeFile(spec,'---- MODULE Bad ----\nVARIABLE x\nInit == x = 0\nNext == x\' = 1\nSpec == Init /\\ [][Next]_x\nSafe == x = 0\n====\n');
    await writeFile(config,'SPECIFICATION Spec\nINVARIANT Safe\n');
    await assert.rejects(runTlc({spec,config,jar:resolve(jar)}),/TLC102/);
    await writeFile(spec,String.raw`---- MODULE Bad ----
VARIABLES state, validated
Init == /\ state = "Received" /\ validated = FALSE
Validate == /\ state = "Received" /\ state' = "Validated" /\ validated' = TRUE
Store == /\ state = "Validated" /\ state' = "Stored" /\ UNCHANGED validated
Idle == /\ state = "Stored" /\ UNCHANGED <<state, validated>>
Next == Validate \/ Store \/ Idle
Spec == Init /\ [][Next]_<<state, validated>>
Safe == state = "Stored" => validated
====
`);
    const multi=await runTlc({spec,config,jar:resolve(jar)});
    const projected=importDot({dot:multi.dot,name:'MultiVariable',stateVariable:'state'});
    assert.deepEqual(projected.states,['Received','Stored','Validated']);
    assert.ok(projected.transitions.some(edge=>edge.from==='Validated'&&edge.event==='Store'&&edge.to==='Stored'));
  } finally { await rm(temp,{recursive:true,force:true}); }
});
