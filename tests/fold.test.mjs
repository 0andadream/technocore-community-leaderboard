import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Fold} from '../scripts/fold.mjs';
import {confirmation, findLine, findMint, lookup, writeMintBin} from '../scripts/confirm.mjs';

const sweep1 = JSON.parse(fs.readFileSync('tests/fixtures/sweep-1.json', 'utf8'));
const sweep2 = JSON.parse(fs.readFileSync('tests/fixtures/sweep-2.json', 'utf8'));

function replay(records){
  const fold = new Fold();
  fold.seed('226.14');
  return {fold, results: records.map(record => fold.sweep(record.input))};
}

const sweep3 = JSON.parse(fs.readFileSync('tests/fixtures/sweep-3.json', 'utf8'));
function money(text){return Number(text)}
test('published sweep files replay to the same mints, fees and prices', () => {
  const {results} = replay([sweep1, sweep2, sweep3]);
  for(const [result, record] of [[results[0], sweep1], [results[1], sweep2], [results[2], sweep3]]){
    assert.deepEqual(result.minted, record.output.minted);
    assert.equal(result.global_price, record.output.global_price);
    assert.equal(result.trades.length, record.output.trades.length);
    for(let i = 0; i < result.trades.length; i++){
      const actual = result.trades[i], expected = record.output.trades[i];
      assert.equal(actual.id, expected.id);
      assert.equal(actual.outcome, expected.outcome);
      if(actual.outcome === 'void') assert.equal(actual.reason, expected.reason);
      else{assert.equal(money(actual.maker_fee), money(expected.maker_fee)); assert.equal(money(actual.taker_fee), money(expected.taker_fee))}
    }
  }
});

test('a redacted private-room trade is left out of the replay', () => {
  const fold = new Fold();
  fold.seed('226.14');
  fold.sweep(sweep1.input);
  const input = structuredClone(sweep2.input);
  input.trades = [{redacted: 'private room'}, ...input.trades];
  const result = fold.sweep(input);
  assert.deepEqual(result.trades, sweep2.output.trades);
  assert.deepEqual(result.minted, sweep2.output.minted);
});

test('lookup reports a mint and a public position, and misses an absent key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-archive-'));
  const minted = sweep2.output.minted[0];
  const {fold} = replay([sweep1, sweep2]);
  const trader = sweep2.input.trades[0].maker;
  const snap = fold.snapshot(trader, sweep2.output.close);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({status: 'ready', through: 2, checkedAt: '2026-09-30T09:45:00.000Z', redactedTrades: 1, positionsReliable: true, mark: sweep2.output.close, markSweep: 2}));
  fs.writeFileSync(path.join(dir, 'minted.tsv'), [`${minted}\t2`, `${trader}\t2`].sort().join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'positions.tsv'), [trader, snap.side, snap.qty, snap.entry, snap.cash, snap.fees, snap.pnl, snap.settled, snap.voids].join('\t') + '\n');
  const hit = lookup(trader, dir);
  assert.equal(hit.gotIn, true);
  assert.equal(hit.headline, 'Got in.');
  assert.match(hit.detail, /minted at sweep #2/);
  assert.equal(hit.position.side, snap.side);
  assert.match(hit.position.detail, /not the referee position/);
  const quiet = lookup(minted, dir);
  assert.equal(quiet.gotIn, true);
  assert.equal(quiet.position, null);
  assert.match(quiet.detail, /open position is not ruled out/);
  const miss = lookup('did:key:z6Mk' + '1'.repeat(44), dir);
  assert.equal(miss.gotIn, false);
  assert.match(miss.detail, /unknown, not zero/);
  assert.equal(findLine(path.join(dir, 'minted.tsv'), minted).endsWith('\t2'), true);
  const pending = confirmation({did: trader, meta: {status: 'building'}});
  assert.equal(pending.status, 'pending');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('byte-order sort matches DID lookup order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-sort-'));
  const file = path.join(dir, 'rows');
  const keys = ['did:key:z6Mkea1aSdGyq5avnq8cGFtxyvwRhay56vBRt4PWBo7YzE5d', 'did:key:z6Mkea1DPepMdRxEYja466KMv9mPyvdPPgywPhLjnuAsFLbT'];
  fs.writeFileSync(file, keys.map(key => `${key}\t1`).reverse().join('\n') + '\n');
  const sorted = path.join(dir, 'sorted');
  const ran = spawnSync('sort', ['-t', '\t', '-k1,1', '-s', '-o', sorted, file], {env: {...process.env, LC_ALL: 'C', LANG: 'C'}});
  assert.equal(ran.status, 0);
  const lines = fs.readFileSync(sorted, 'utf8').trim().split('\n').map(line => line.split('\t')[0]);
  assert.deepEqual(lines, [...keys].sort());
  assert.equal(findLine(sorted, keys[1])?.startsWith(keys[1]), true);
  fs.rmSync(dir, {recursive: true, force: true});
});

test('compact mint index answers the same keys as the text list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-bin-'));
  const keys = ['did:key:z6Mkea1aSdGyq5avnq8cGFtxyvwRhay56vBRt4PWBo7YzE5d', 'did:key:z6Mkea1DPepMdRxEYja466KMv9mPyvdPPgywPhLjnuAsFLbT'];
  fs.writeFileSync(path.join(dir, 'minted.tsv'), `${keys[1]}\t1036\n${keys[0]}\t17\n`);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({status: 'ready', through: 1119, checkedAt: '2026-09-30T09:45:00.000Z', redactedTrades: 1, positionsReliable: false, replayStoppedAt: 333}));
  assert.equal(writeMintBin(path.join(dir, 'minted.tsv'), path.join(dir, 'minted.bin')), 2);
  fs.rmSync(path.join(dir, 'minted.tsv'));
  assert.equal(findMint(path.join(dir, 'minted.bin'), keys[0]), 17);
  assert.equal(findMint(path.join(dir, 'minted.bin'), keys[1]), 1036);
  assert.equal(findMint(path.join(dir, 'minted.bin'), 'did:key:z6Mk' + '1'.repeat(44)), null);
  const hit = lookup(keys[1], dir);
  assert.equal(hit.gotIn, true);
  assert.equal(hit.mintedSweep, 1036);
  assert.equal(hit.position, null);
  assert.match(hit.detail, /stopped matching published outcomes at sweep #333/);
  fs.rmSync(dir, {recursive: true, force: true});
});
