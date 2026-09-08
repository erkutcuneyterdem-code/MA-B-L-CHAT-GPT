import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT=Number(process.env.PORT||8080);
const AF='https://v3.football.api-sports.io';
const cache=new Map();
const json=(res,data,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))};
const localDate=()=>new Date().toLocaleDateString('sv-SE',{timeZone:'Europe/Istanbul'});

async function af(endpoint,ttl=120000){
  if(!process.env.APIFOOTBALL_KEY) throw new Error('APIFOOTBALL_KEY eksik');
  const hit=cache.get(endpoint); if(hit&&Date.now()-hit.t<ttl) return hit.v;
  const r=await fetch(`${AF}/${endpoint}`,{headers:{'x-apisports-key':process.env.APIFOOTBALL_KEY},signal:AbortSignal.timeout(18000)});
  const j=await r.json(); if(!r.ok||j.errors&&Object.keys(j.errors).length) throw new Error(`API-Football: ${r.status} ${JSON.stringify(j.errors||{})}`);
  cache.set(endpoint,{t:Date.now(),v:j}); return j;
}
function pct(v){return Number(String(v||0).replace('%',''))||0}
function norm(o){const s=(o.one||0)+(o.draw||0)+(o.two||0)||1;return {one:o.one/s*100,draw:o.draw/s*100,two:o.two/s*100}}
function implied(o){return o?.one&&o?.draw&&o?.two?norm({one:100/o.one,draw:100/o.draw,two:100/o.two}):null}
function formScore(list,teamId){let pts=0,gf=0,ga=0,n=0;for(const f of list||[]){const h=f.teams.home.id===teamId;const a=h?f.goals.home:f.goals.away,b=h?f.goals.away:f.goals.home;if(a==null||b==null)continue;n++;gf+=a;ga+=b;pts+=a>b?3:a===b?1:0}return n?Math.max(0,Math.min(100,pts/(n*3)*70+Math.max(0,Math.min(1,((gf-ga)/n+2)/4))*30)):50}
function radar({model,odds,fh,fa,rankH,rankA,injH,injA,coverage}){
  const market=implied(odds),base=model||market||{one:33.3,draw:33.4,two:33.3};let p=norm(base);
  const edge=.55*((fh-fa)/100)+.30*(rankH&&rankA?Math.max(-1,Math.min(1,(rankA-rankH)/20)):0)+.15*Math.max(-1,Math.min(1,(injA-injH)/5));
  p=norm({one:p.one+edge*8,draw:p.draw,two:p.two-edge*8});
  const arr=[['1',p.one],['X',p.draw],['2',p.two]].sort((a,b)=>b[1]-a[1]);const pick=arr[0][0],top=arr[0][1],sep=top-arr[1][1];
  const mp=market?(pick==='1'?market.one:pick==='X'?market.draw:market.two):null;const value=mp==null?null:+(top-mp).toFixed(1);
  const confidence=Math.round(Math.max(48,Math.min(94,45+top*.28+sep*.55+coverage*18+(value>0?value*.3:0))));
  const labels=[]; if(value!=null&&value>=5&&confidence>=62)labels.push('VALUE');if(confidence>=78&&top>=55&&coverage>=.65)labels.push('BANKO ADAYI');if(confidence<75||sep<9)labels.push('ÇİFTE ŞANSLA KAPAT');
  if(odds){const underdogOdd=pick==='1'?odds.one:pick==='X'?odds.draw:odds.two;if(underdogOdd>=3&&value>=7)labels.push('SÜRPRİZ ADAYI')}
  return {prediction:pick,probabilities:{one:+p.one.toFixed(1),draw:+p.draw.toFixed(1),two:+p.two.toFixed(1)},confidence,risk:confidence>=76&&sep>=9?'LOW':confidence>=62?'MID':'HIGH',value,labels,doubleChance:pick==='1'?'1X':pick==='2'?'X2':'1X',dataCoverage:coverage};
}
async function fixtures(date){const j=await af(`fixtures?date=${encodeURIComponent(date)}`,60000);return (j.response||[]).map(f=>({fixtureId:f.fixture.id,date:f.fixture.date,status:f.fixture.status,league:f.league,home:f.teams.home,away:f.teams.away,goals:f.goals}))}
async function oddsFor(id){const j=await af(`odds?fixture=${id}`,120000);for(const row of j.response||[])for(const b of row.bookmakers||[])for(const bet of b.bets||[])if((bet.name||'').toLowerCase()==='match winner'){const o={};for(const v of bet.values||[]){if(v.value==='Home')o.one=Number(v.odd);if(v.value==='Draw')o.draw=Number(v.odd);if(v.value==='Away')o.two=Number(v.odd)}if(o.one&&o.draw&&o.two)return {bookmaker:b.name,odds:o}}return {bookmaker:null,odds:null}}
async function prediction(id){const j=await af(`predictions?fixture=${id}`,1800000);const p=j.response?.[0]?.predictions;if(!p)return null;return {model:{one:pct(p.percent?.home),draw:pct(p.percent?.draw),two:pct(p.percent?.away)},advice:p.advice,winner:p.winner,goals:p.goals,underOver:p.under_over}}
async function detail(f){const [pr,od,hf,afm,st,inj,lu,h2]=await Promise.all([
 prediction(f.fixtureId).catch(()=>null),oddsFor(f.fixtureId).catch(()=>({bookmaker:null,odds:null})),
 af(`fixtures?team=${f.home.id}&last=5`,300000).then(x=>x.response||[]).catch(()=>[]),af(`fixtures?team=${f.away.id}&last=5`,300000).then(x=>x.response||[]).catch(()=>[]),
 af(`standings?league=${f.league.id}&season=${process.env.FOOTBALL_SEASON||2026}`,3600000).then(x=>x.response?.[0]?.league?.standings?.[0]||[]).catch(()=>[]),
 af(`injuries?fixture=${f.fixtureId}`,300000).then(x=>x.response||[]).catch(()=>[]),af(`fixtures/lineups?fixture=${f.fixtureId}`,180000).then(x=>x.response||[]).catch(()=>[]),
 af(`fixtures/headtohead?h2h=${f.home.id}-${f.away.id}&last=6`,1800000).then(x=>x.response||[]).catch(()=>[])
 ]);
 const rh=st.find(x=>x.team.id===f.home.id)?.rank||null,ra=st.find(x=>x.team.id===f.away.id)?.rank||null,ih=inj.filter(x=>x.team.id===f.home.id).length,ia=inj.filter(x=>x.team.id===f.away.id).length;
 const fsH=formScore(hf,f.home.id),fsA=formScore(afm,f.away.id),coverage=[pr,od.odds,hf.length,afm.length,st.length].filter(Boolean).length/5;
 return {...f,bookmaker:od.bookmaker,odds:od.odds,radar:radar({model:pr?.model,odds:od.odds,fh:fsH,fa:fsA,rankH:rh,rankA:ra,injH:ih,injA:ia,coverage}),apiPrediction:pr,meta:{homeForm:+fsH.toFixed(1),awayForm:+fsA.toFixed(1),homeRank:rh,awayRank:ra,injHome:ih,injAway:ia},lineups:lu,h2h:h2};
}
async function groq(payload){if(!process.env.GROQ_KEY)return {available:false,error:'GROQ_KEY eksik'};const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${process.env.GROQ_KEY}`,'content-type':'application/json'},body:JSON.stringify({model:process.env.GROQ_MODEL||'openai/gpt-oss-120b',temperature:.2,response_format:{type:'json_object'},messages:[{role:'system',content:'Türkçe futbol karar destek analistisin. Sadece verilen veriyi kullan, veri uydurma, kesinlik iddia etme. JSON: {"summary":"","mainPick":"","firstHalf":"","overUnder25":"","btts":"","riskNote":"","reasoning":[]}'},{role:'user',content:JSON.stringify(payload)}]})});const j=await r.json();if(!r.ok)throw new Error(`Groq ${r.status}`);return JSON.parse(j.choices?.[0]?.message?.content||'{}')}
function leagues(list){const m=new Map();for(const x of list){const k=`${x.league.country} • ${x.league.name}`;const v=m.get(k)||{key:k,name:k,count:0,leagueId:x.league.id};v.count++;m.set(k,v)}return [...m.values()].sort((a,b)=>a.name.localeCompare(b.name,'tr'))}
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://x');if(u.pathname==='/health')return json(res,{ok:true,name:'MaçBil Radar PRO v5',apiFootball:!!process.env.APIFOOTBALL_KEY,groq:!!process.env.GROQ_KEY,date:localDate()});if(u.pathname==='/api/board'){const date=u.searchParams.get('date')||localDate();const list=await fixtures(date);return json(res,{date,count:list.length,leagues:leagues(list),matches:list})}if(u.pathname==='/api/match'){const id=Number(u.searchParams.get('fixture')),date=u.searchParams.get('date')||localDate();const f=(await fixtures(date)).find(x=>x.fixtureId===id);if(!f)return json(res,{error:'Maç bulunamadı'},404);return json(res,await detail(f))}if(u.pathname==='/api/analyze'&&req.method==='POST'){let b='';for await(const c of req)b+=c;return json(res,{ai:await groq(JSON.parse(b||'{}'))})}if(u.pathname==='/'||u.pathname==='/index.html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return fs.createReadStream(path.resolve('frontend/index.html')).pipe(res)}return json(res,{error:'Not found'},404)}catch(e){return json(res,{error:String(e.message||e)},500)}});server.listen(PORT,()=>console.log(`MaçBil Radar PRO v5 :${PORT}`));
