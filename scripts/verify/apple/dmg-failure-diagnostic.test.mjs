import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failureOutput, ownedEntities, processFields, collectDmgFailure, retainDmgFailure } from './dmg-failure-diagnostic.mjs';
const image='/tmp/rea-macos-bundle-synth/MacFixture.dmg';
const mount='/tmp/rea-dmg-synth/ReaFixture';
const make = (images) => ({images});
const own={ 'image-path':image,'system-entities':[{'dev-entry':'/dev/disk37'},{'dev-entry':'/dev/disk38s1','mount-point':mount}]};
const canonical=async s=>s;

test('large valid JSON projects complete error but not raw normalized result/environment',()=>{
 const message='x'.repeat(70000); const r=failureOutput({code:1,killed:false,stdout:JSON.stringify({error:{code:'cleanup_incomplete',message,retryable:false,details:{resources:['DMG device /dev/disk37'],env:{SECRET:'no'}}},normalized_result:{private:'do not persist'},env:'no'})});
 assert.equal(r.error.message.length,70000);assert.equal(r.error.code,'cleanup_incomplete');assert.equal(r.error.retryable,false);
 assert.ok(!JSON.stringify(r).includes('SECRET'));assert.ok(!JSON.stringify(r).includes('do not persist'));assert.equal(r.exit_code,1);
});
test('empty invalid and truncated stdout not retained',()=>{for(const stdout of ['', 'secret unparsed', '{"error":']) {const r=failureOutput({stdout});assert.equal(r.parse,stdout?'invalid-or-truncated-json':'empty');assert.ok(!JSON.stringify(r).includes('secret unparsed'));}});
test('only exact unique synthetic image owns devices',()=>{assert.deepEqual(ownedEntities(make([{...own,'image-path':'/other.dmg'}]),image),[]);assert.deepEqual(ownedEntities(make([own,own]),image),[]);assert.deepEqual(ownedEntities(make([own,{...own,'image-path':'/other.dmg'}]),image).map(x=>x.device),['/dev/disk37','/dev/disk38s1']);});
test('lsof projection excludes names and unrequested fields',()=>{assert.deepEqual(processFields('p123\ncibtoold\nf3\nn/private/secret\nTsecret\n'),[{pid:123,command:'ibtoold',fds:['3']}]);});
test('owned device/mount filtered and occupancy gets no other image',async()=>{
 const calls=[];const inv=make([own,{'image-path':'/private/other.dmg','system-entities':[{'dev-entry':'/dev/disk99','mount-point':'/private/secret'}]}]);
 const execute=(file,args,input)=>{calls.push({file,args}); if(file.endsWith('hdiutil'))return{status:0,stdout:'plist'};if(file.endsWith('plutil')){assert.equal(input,'plist');return{status:0,stdout:JSON.stringify(inv)}};return{status:0,stdout:'p123\ncibtoold\nf3\nn/private/secret\n'};};
 const r=await collectDmgFailure({failure:{stdout:'{"error":{"code":"cleanup_incomplete"}}'},imagePath:image,temporaryRoot:'/tmp',execute,canonical});
 assert.deepEqual(r.devices,['/dev/disk37','/dev/disk38s1']);assert.equal(r.occupancy.length,1);assert.equal(calls[2].args[2],mount);assert.ok(!JSON.stringify(r).includes('/private'));assert.equal(r.phase,'after-cli-exit-before-fixture-finally');
});
test('unowned mount and malicious image never sampled',async()=>{
 let lsof=0; const execute=(file)=>{if(file.endsWith('lsof'))lsof++;return{status:0,stdout:JSON.stringify(make([{...own,'system-entities':[{'dev-entry':'/dev/disk37','mount-point':'/Volumes/private'}]}]))}};
 const r=await collectDmgFailure({failure:{},imagePath:image,temporaryRoot:'/tmp',execute,canonical});assert.equal(lsof,0);assert.equal(r.occupancy[0].status,'outside-owned-temporary-mount');
 await assert.rejects(()=>collectDmgFailure({failure:{},imagePath:'/tmp/user.dmg',temporaryRoot:'/tmp',execute,canonical}));
});
test('inventory unavailable yields no occupancy command',async()=>{let calls=0;const r=await collectDmgFailure({failure:{},imagePath:image,temporaryRoot:'/tmp',canonical,execute:()=>{calls++;return{status:2,stderr:'private'}}});assert.equal(calls,1);assert.equal(r.inventory,'unavailable');assert.ok(!JSON.stringify(r).includes('private'));});
test('diagnostic write is exclusive, errors do not mask original failure',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rea-diagnostic-test-'));const path=join(root,'out.json');const options={failure:{stdout:'{}'},imagePath:image,temporaryRoot:'/tmp',canonical,execute:()=>({status:2})};
 try{await retainDmgFailure(options,path);const original=await readFile(path,'utf8');await retainDmgFailure({...options,failure:{stdout:'{"error":"changed"}'}},path);assert.equal(await readFile(path,'utf8'),original);await retainDmgFailure({...options,canonical:async()=>{throw Error('private')}},path);}finally{await rm(root,{recursive:true,force:true})}
});
test('invalid inventory never exposes raw output or samples processes',async()=>{
 let n=0; const r=await collectDmgFailure({failure:{},imagePath:image,temporaryRoot:'/tmp',canonical,
 execute:()=>({status:0,stdout:++n===1?'plist':'invalid private inventory'})});assert.equal(n,2);assert.equal(r.inventory,'invalid');assert.equal(typeof r.elapsed_ms,'number');assert.ok(!JSON.stringify(r).includes('private'));
});
test('mount budget explicitly marks omitted observations',async()=>{
 let lsof=0;const inv=make([{...own,'system-entities':Array.from({length:6},(_,i)=>({'dev-entry':`/dev/disk${i+1}`,'mount-point':`/tmp/rea-dmg-test-${i}/volume`}))}]);
 const r=await collectDmgFailure({failure:{},imagePath:image,temporaryRoot:'/tmp',canonical,execute:(file)=>file.endsWith('lsof')?(lsof++,{status:0,stdout:''}):({status:0,stdout:JSON.stringify(inv)})});assert.equal(lsof,4);assert.equal(r.mounts_omitted_by_budget,2);
});
test('collector failure preserves structured original failure without diagnostic exception',async()=>{
 const root=await mkdtemp(join(tmpdir(),'rea-diagnostic-test-')); const path=join(root,'out.json');
 try { assert.equal(await retainDmgFailure({failure:{code:1,stdout:'{"error":{"code":"cleanup_incomplete"}}'},imagePath:image,temporaryRoot:'/tmp',canonical:async()=>{throw Error('private diagnostic exception')}},path),true);
 const r=JSON.parse(await readFile(path,'utf8'));assert.equal(r.collection_status,'failed');assert.equal(r.output.error.code,'cleanup_incomplete');assert.ok(!JSON.stringify(r).includes('private')); } finally {await rm(root,{recursive:true,force:true});}
});
