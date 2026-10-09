import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnose } from '../doctor.mjs';
test('diagnostics identify missing local setup without exposing supplied credentials',t=>{
 const projectDir=mkdtempSync(join(tmpdir(),'shop-doctor-'));t.after(()=>rmSync(projectDir,{recursive:true,force:true}));
 const absent=diagnose({projectDir,env:{},discover:()=>'/installed/electrum'});
 assert.ok(absent.issues);assert.match(absent.lines.join('\n'),/No master public key found/);assert.match(absent.lines.join('\n'),/Automatic helper selected: no/);
 const secrets={ELECTRUM_RPC_PASSWORD:'private-password-marker',ELECTRUM_RPC_USER:'private-user-marker',ELECTRUM_MASTER_PUBLIC_KEY:'invalid-key-marker'};
 const result=diagnose({projectDir,env:secrets,discover:()=>'/installed/electrum'}).lines.join('\n');
 for(const value of Object.values(secrets)) assert.ok(!result.includes(value));
 assert.match(result,/invalid format or checksum/);assert.match(result,/ELECTRUM_RPC_PASSWORD: set \(value hidden\)/);
});
