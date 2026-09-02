import { call, login, loginPin } from './tests/probe.mjs';
import pg from './node_modules/pg/lib/index.js';
const pool = new pg.Pool({connectionString:'postgres://erp:erp_dev_password@127.0.0.1:5432/erp'});
const q = async (s,p=[]) => (await pool.query(s,p)).rows;
const amountOf = (err) => { const m = String(err).match(/bill is [^0-9]*([\d,]+\.\d\d)/); return m ? Number(m[1].replace(/,/g,'')) : NaN; };

const mgr  = await login('sunita@hardwareerp.in','Manager@12345');
const cash = await loginPin('9900000005','1234');
const prods = await call('GET','/api/catalog/products?limit=80',{token:cash.token});
const stock = await call('GET','/api/inventory/stock?limit=100',{token:mgr.token});
const ws = stock.body.filter(s=>Number(s.base_unit_qty)>20);
const p = prods.body.find(x=>ws.some(s=>s.product_id===x.product_id) && Number(x.selling_price)>100);
const till = await call('POST','/api/billing/till-sessions',{token:cash.token,body:{counter_id:'PE-'+Date.now(),opening_float:1000}});
const T = till.body.session_id;

async function sell(lines, method='CASH'){
  const probe = await call('POST','/api/billing/invoices',{token:cash.token,body:{invoice_type:'GST',till_session_id:T,lines,payments:[{method,amount:1}]}});
  const total = amountOf(probe.body.error);
  const real  = await call('POST','/api/billing/invoices',{token:cash.token,body:{invoice_type:'GST',till_session_id:T,lines,payments:[{method,amount:total}]}});
  return { total, res: real };
}

const s1 = await sell([{product_id:p.product_id, qty_in_sale_unit:2}]);
console.log('cash sale ->', s1.res.status, s1.res.body.invoice_number, 'total', s1.total);
const rec1 = await call('GET',`/api/billing/till-sessions/${T}/reconcile`,{token:cash.token});
console.log('till after sale: expected', rec1.body.expected_drawer_cash, '| cash_sales', rec1.body.cash_sales);

const el = await call('GET',`/api/returns/eligibility/${s1.res.body.invoice_id}`,{token:cash.token});
const line = el.body.lines[0];
const ret = await call('POST','/api/returns',{token:cash.token,body:{
  invoice_id: s1.res.body.invoice_id, return_reason:'probe cash refund', refund_method:'CASH',
  lines:[{invoice_line_id:line.line_id, qty_base_unit:line.returnable_qty, condition:'RESELLABLE'}]}});
console.log('return ->', ret.status, 'cash refunded', ret.body.cash_refund_amount);
const rec2 = await call('GET',`/api/billing/till-sessions/${T}/reconcile`,{token:cash.token});
console.log('till after CASH REFUND: expected', rec2.body.expected_drawer_cash, '| cash_sales', rec2.body.cash_sales);
console.log(rec2.body.expected_drawer_cash === rec1.body.expected_drawer_cash
  ? '*** BUG: cash left the drawer for a refund but the till still expects it ***' : 'ok: till adjusted');

const bt = await q(`SELECT batch_id, qty_remaining, product_id FROM stock_batches WHERE branch_id=$1 AND qty_remaining > 5 LIMIT 1`,[cash.user.branch_id]);
if (bt.length){
  const before = Number(bt[0].qty_remaining);
  const s2 = await sell([{product_id:bt[0].product_id, qty_in_sale_unit:1, batch_id:bt[0].batch_id}]);
  const mid = Number((await q('SELECT qty_remaining FROM stock_batches WHERE batch_id=$1',[bt[0].batch_id]))[0].qty_remaining);
  const v = await call('POST',`/api/billing/invoices/${s2.res.body.invoice_id}/void`,{token:mgr.token,body:{reason:'probe'}});
  const after = Number((await q('SELECT qty_remaining FROM stock_batches WHERE batch_id=$1',[bt[0].batch_id]))[0].qty_remaining);
  console.log(`\nbatch qty: ${before} -> after sale ${mid} -> after void ${after} (void ${v.status})`);
  console.log(after===before ? 'ok: batch restored' : '*** BUG: void did not restore the batch quantity ***');
}
await pool.end();
