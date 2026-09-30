import {createHash} from 'node:crypto';
// Close Call fold, integer port of close_call_fold.py (tag close-1).
// Prices and quantities are cents. Cash, fees and PnL are micro-POLF (1e-6).
// 0.01 * qty * px lands on an integer number of micros when both have two decimals.
// Owner keys are stored as 128-bit hashes so a multi-million mint list stays small enough to replay.
const DID = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;
const TRADE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CENTS_TEXT = /^[0-9]{1,7}(?:\.[0-9]{1,2})?$/;
const MINT = 10_000_000_000n;
const MIN_QTY = 10n;
const LOCK = 2556;

class KeySet{
  constructor(){this.mask = (1 << 23) - 1; this.hi = new BigUint64Array(this.mask + 1); this.lo = new BigUint64Array(this.mask + 1); this.used = new Uint8Array(this.mask + 1); this.n = 0}
  #hash(key){const digest = createHash('sha256').update(key).digest(); return [digest.readBigUInt64BE(0), digest.readBigUInt64BE(8)]}
  #slot(lo){return Number(lo & BigInt(this.mask))}
  add(key){
    const [hi, lo] = this.#hash(key);
    let i = this.#slot(lo);
    for(let step = 0; step <= this.mask; step++){
      if(!this.used[i]){this.used[i] = 1; this.hi[i] = hi; this.lo[i] = lo; this.n += 1; return}
      if(this.hi[i] === hi && this.lo[i] === lo) return;
      i = (i + 1) & this.mask;
    }
    throw Error('owner set is full');
  }
  has(key){
    const [hi, lo] = this.#hash(key);
    let i = this.#slot(lo);
    for(let step = 0; step <= this.mask; step++){
      if(!this.used[i]) return false;
      if(this.hi[i] === hi && this.lo[i] === lo) return true;
      i = (i + 1) & this.mask;
    }
    return false;
  }
  get size(){return this.n}
}

export function parseCents(text){
  if(typeof text !== 'string' || !CENTS_TEXT.test(text)) return null;
  const [whole, frac = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return cents > 0n ? cents : null;
}
export function formatCents(cents){
  const neg = cents < 0n;
  const v = neg ? -cents : cents;
  return `${neg ? '-' : ''}${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`;
}
export function formatMicro(micro){
  const neg = micro < 0n;
  const v = neg ? -micro : micro;
  const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${v / 1_000_000n}${frac ? `.${frac}` : ''}`;
}
function abs(v){return v < 0n ? -v : v}
function halfEven(numer, denom){
  const neg = numer < 0n;
  const n = neg ? -numer : numer;
  const q = n / denom;
  const r = n % denom;
  const twice = r * 2n;
  const up = twice > denom || (twice === denom && q % 2n === 1n);
  const out = q + (up ? 1n : 0n);
  return neg ? -out : out;
}

class Account{
  constructor(key){this.key = key; this.cash = MINT; this.lots = []; this.fees = 0n; this.settled = 0; this.voids = 0}
  position(){return this.lots.reduce((sum, lot) => sum + lot.qty, 0n)}
  opening(side, qty){
    const against = -side * this.position();
    const room = against > 0n ? against : 0n;
    const closing = qty < room ? qty : room;
    return qty - closing;
  }
  apply(side, qty, px, fee){
    this.cash -= fee;
    this.fees += fee;
    let left = qty;
    while(left > 0n && this.lots.length && this.lots[0].qty * side < 0n){
      const lot = this.lots[0];
      const size = left < abs(lot.qty) ? left : abs(lot.qty);
      this.cash += side < 0n ? size * px * 100n : size * (2n * lot.px - px) * 100n;
      left -= size;
      if(size === abs(lot.qty)) this.lots.shift();
      else lot.qty += side * size;
    }
    if(left > 0n){
      this.cash -= left * px * 100n;
      this.lots.push({qty: side * left, px});
    }
  }
  valueAt(mark){
    let value = this.cash;
    for(const lot of this.lots) value += lot.qty > 0n ? lot.qty * mark * 100n : -lot.qty * (2n * lot.px - mark) * 100n;
    return value;
  }
}

export class Fold{
  constructor(){this.accounts = new Map(); this.owners = new KeySet(); this.settledIds = new Set(); this.sweepN = 0; this.seeded = false}
  seed(px){
    if(this.seeded || parseCents(px) === null) throw Error('seed: expected one opening price');
    this.seeded = true;
    this.globalCents = parseCents(px);
  }
  ensure(key){
    let acct = this.accounts.get(key);
    if(!acct){acct = new Account(key); this.accounts.set(key, acct)}
    return acct;
  }
  sideFees(side, qty, px, close){
    const base = qty * px;
    const gap = (close - px) * qty * 100n;
    const buyer = base > gap ? base : gap;
    const seller = base > -gap ? base : -gap;
    return side > 0n ? [buyer, seller] : [seller, buyer];
  }
  check(trade, n, ref, close){
    if(!trade || typeof trade !== 'object') return 'shape';
    const {maker, taker, countersigner: signer} = trade;
    const qty = parseCents(trade.qty), px = parseCents(trade.px);
    if(typeof trade.id !== 'string' || !TRADE_ID.test(trade.id) || (trade.side !== 'buy' && trade.side !== 'sell') || qty === null || px === null || !Number.isSafeInteger(trade.until) || typeof maker !== 'string' || typeof signer !== 'string' || !(taker === 'any' || typeof taker === 'string')) return 'shape';
    if(qty < MIN_QTY) return 'shape';
    if(!this.owners.has(maker) || !this.owners.has(signer)) return 'not_owner';
    const mk = this.ensure(maker), tk = this.ensure(signer);
    if(taker !== 'any' && taker !== signer) return 'taker';
    if(this.settledIds.has(trade.id)) return 'settled';
    if(n > trade.until) return 'expired';
    if(n > LOCK) return 'locked';
    if(abs(px - ref) * 100n > ref * 5n) return 'limits';
    const side = trade.side === 'buy' ? 1n : -1n;
    const [mkFee, tkFee] = this.sideFees(side, qty, px, close);
    if(mk === tk){if(mk.cash < mkFee + tkFee) return 'funds'}
    else if(mk.cash < mk.opening(side, qty) * px * 100n + mkFee || tk.cash < tk.opening(-side, qty) * px * 100n + tkFee) return 'funds';
    return null;
  }
  sweep(input){
    const n = input?.n, ref = parseCents(input?.ref), close = parseCents(input?.close);
    if(!this.seeded || ref === null || close === null || !Number.isSafeInteger(n) || n <= this.sweepN) throw Error(`sweep ${n}: needs a seed, a reference and a closing price, and an increasing sweep number`);
    this.sweepN = n;
    const minted = [];
    for(const key of input.owners || []){
      if(typeof key === 'string' && DID.test(key) && !this.owners.has(key) && n <= LOCK){
        this.owners.add(key);
        minted.push(key);
      }
    }
    const outcomes = [];
    let volume = 0n, notional = 0n;
    for(const trade of input.trades || []){
      if(trade && trade.redacted) continue;
      const reason = this.check(trade, n, ref, close);
      const id = trade && typeof trade === 'object' ? trade.id ?? null : null;
      if(reason){
        outcomes.push({id, outcome: 'void', reason});
        for(const key of [trade?.maker, trade?.countersigner]){const acct = this.accounts.get(key); if(acct) acct.voids += 1}
        continue;
      }
      const qty = parseCents(trade.qty), px = parseCents(trade.px), side = trade.side === 'buy' ? 1n : -1n;
      const [mkFee, tkFee] = this.sideFees(side, qty, px, close);
      const mk = this.accounts.get(trade.maker), tk = this.accounts.get(trade.countersigner);
      if(mk === tk){mk.cash -= mkFee + tkFee; mk.fees += mkFee + tkFee; mk.settled += 1}
      else{mk.apply(side, qty, px, mkFee); tk.apply(-side, qty, px, tkFee); mk.settled += 1; tk.settled += 1}
      this.settledIds.add(trade.id);
      volume += qty;
      notional += qty * px * 100n;
      outcomes.push({id, outcome: 'settled', maker_fee: formatMicro(mkFee), taker_fee: formatMicro(tkFee)});
    }
    if(volume > 0n) this.globalCents = halfEven(notional, 100n * volume);
    return {sweep: n, reference: formatCents(ref), close: formatCents(close), minted, trades: outcomes, global_price: formatCents(this.globalCents)};
  }
  snapshot(did, markText){
    const acct = this.accounts.get(did);
    if(!acct || (acct.settled === 0 && acct.voids === 0)) return null;
    const mark = parseCents(markText);
    const net = acct.position();
    const prices = new Set(acct.lots.map(lot => lot.px));
    const pnl = acct.valueAt(mark) - MINT;
    return {side: net > 0n ? 'long' : net < 0n ? 'short' : 'flat', qty: formatCents(abs(net)), entry: prices.size === 1 ? formatCents([...prices][0]) : '', cash: formatMicro(acct.cash), fees: formatMicro(acct.fees), pnl: formatMicro(pnl), settled: acct.settled, voids: acct.voids};
  }
}
