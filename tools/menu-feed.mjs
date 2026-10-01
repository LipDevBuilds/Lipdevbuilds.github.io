// Turn a harvest into the small delta the running app downloads.
//
// The app ships the whole menu baked into index.html, so it works with no network at all. This
// writes menu-feed.json beside it: only what has CHANGED since that bake — a new limited-time item,
// a figure the chain revised, an item it stopped selling. The app merges the feed over its own data
// at launch, caches it, and falls back to the bake if anything about the feed is wrong.
//
// Two rules the generator will not break:
//   * An item is never DELETED, only marked off-menu. Something logged last October must keep its
//     name, its macros and its breakdown forever; it just stops showing up in browse.
//   * A bad harvest must not look like a menu that shrank. Unless the harvest is healthy — every
//     category loaded, item count in range — no off-menu marks are emitted at all.
//
// Usage: node menu-feed.mjs [--live culvers-live.json] [--index ../../www/index.html]
//                           [--out ../../www/menu-feed.json] [--quiet]
import fs from "fs";
import path from "path";

const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d};
const here=path.dirname(new URL(import.meta.url).pathname);
const LIVE=arg("--live",path.join(here,"culvers-live.json"));
const INDEX=arg("--index",path.join(here,"../../www/index.html"));
const OUT=arg("--out",path.join(here,"../../www/menu-feed.json"));
const QUIET=process.argv.includes("--quiet");
const say=(...a)=>{if(!QUIET)console.log(...a)};

// health gates — below these the harvest is not trusted to say anything was removed
const MIN_CATEGORIES=10, MIN_ITEMS=80;
// Categories the app models some other way, so importing them as items would duplicate what it
// already does. A Value Basket is the chain's combo, which the builder offers as "Make it a Basket"
// on the sandwich itself; a Kids' Meal is the same shape. Importing them put 21 rows named
// "X Value Basket" in the burgers list beside the burgers they are made of.
// Sauces & Dressings are condiments the builder already offers as options on the item they go on;
// importing them as menu rows would put "Salt" and "Mayo" in the food list.
const SKIP_CATS=new Set(["value-baskets","kids-meals","sauces-and-dressings"]);

const live=JSON.parse(fs.readFileSync(LIVE,"utf8"));
const idx=fs.readFileSync(INDEX,"utf8");

// ---- what the bake already holds -------------------------------------------------------------
function braceSlice(s,from){
  const i=s.indexOf("{",from);let d=0;
  for(let j=i;j<s.length;j++){const c=s[j];if(c==='"'){while(++j<s.length&&(s[j]!=='"'||s[j-1]==="\\"));continue}
    if(c==="{")d++;else if(c==="}"){d--;if(!d)return s.slice(i,j+1)}}
  return null;
}
const litAfter=(name)=>{const i=idx.indexOf(`const ${name}=`);if(i<0)return null;
  const b=braceSlice(idx,i);try{return b?JSON.parse(b):null}catch{return null}};

const cvIdx=idx.indexOf('{"id":"culvers"');
if(cvIdx<0)throw new Error("index.html has no Culver's restaurant object");
const baked=JSON.parse(braceSlice(idx,cvIdx));
// Culver's loads from chains/culvers.json (rebuilt 2026-10-01), so its option lists are RB_MODS_CHAINS.culvers; the old RB_MODS_CV table no longer exists
const bakedMods=((litAfter("RB_MODS_CHAINS")||{}).culvers)||litAfter("RB_MODS_CV")||{};
const bakedNote=litAfter("CV_SEC_NOTE")||{};
const bakedCap=litAfter("CV_SEC_CAP")||{};
const prevFeed=(()=>{try{return JSON.parse(fs.readFileSync(OUT,"utf8"))}catch{return null}})();
const prevCv=(prevFeed&&prevFeed.chains&&prevFeed.chains.culvers)||{};

// the app's own normaliser, so a name matches here exactly as it matches at runtime
const SIZE_RX=/\s*\((single|double|triple|regular|large|small|value basket|basket|\d+\s*(?:pc|piece)s?)\)\s*$/i;
const cvKey=n=>String(n).toLowerCase().replace(/[®™]/g,"").replace(/^the\s+/,"")
  .replace(SIZE_RX,"").replace(/[^a-z0-9]+/g," ").trim();
const exact=n=>String(n).toLowerCase().replace(/[®™]/g,"").replace(/^the\s+/,"").replace(/[^a-z0-9]+/g," ").trim();

// Every item the BAKE holds. Deliberately not the previous feed: `add` is recomputed from scratch
// every run, so the feed is always a complete delta against the bake rather than a delta against
// itself — one quiet run cannot drop an item the last run added.
const known=new Map();
for(const c of baked.components||[]){
  known.set(exact(c.name),c);
  if(!known.has(cvKey(c.name)))known.set(cvKey(c.name),c);
}
// Culver's writes "The Culver's® Bacon Deluxe" where our menu says "Bacon Deluxe (Single)", and
// "Crispy Chicken" where ours says "Crispy Chicken Sandwich". The app's own cvFind bridges that
// with containment, so this does too — but only at a WORD BOUNDARY and only when the two names are
// close in length, because the cost of a wrong match is a new limited-time item never being added
// at all. Every containment match is reported, so a wrong one is visible rather than silent.
const matchedByName=[];
// Returns {c, exact}. The distinction matters: an EXACT name match may revise the figures on a
// researched row, a name BRIDGED by containment may only stop a duplicate being added. "Beef Pot
// Roast" bridges to both "Beef Pot Roast Sandwich" and "Beef Pot Roast Dinner", and letting a
// bridge revise figures rewrote the 750 cal dinner as the 410 cal sandwich.
// A name short enough to collide is never added automatically. Culver's sells a product called
// "Shake"; our menu carries "Vanilla Shake (Regular)" and "Chocolate Shake (Regular)". Whether
// those are the same thing is a judgement, not a string comparison, so it goes on a review list
// instead of into the app.
const ADD_MIN_KEY=9, BRIDGE_MAX=14, NEAR_MAX=26;
function lookupItem(name,cal){
  const e=exact(name),k=cvKey(name);
  const direct=known.get(e)||known.get(k);
  if(direct)return{c:direct,exact:true};
  if(k.length<ADD_MIN_KEY)return{c:null,exact:false,tooShort:true};
  const boundary=(a,b)=>a===b||a.startsWith(b+" ")||a.endsWith(" "+b);
  const cands=[],near=[];
  for(const [ck,c] of known){
    if(ck===k)return{c,exact:true};
    if(ck.length<5)continue;
    if(!(boundary(ck,k)||boundary(k,ck)))continue;
    const d=Math.abs(ck.length-k.length);
    if(d>NEAR_MAX)continue;
    if(d>BRIDGE_MAX){if(!near.some(x=>x.c===c))near.push({c,len:d});continue}
    if(!cands.some(x=>x.c===c))cands.push({c,len:d});
  }
  // a name that nearly matches something we hold is too close to call: review, do not add
  if(!cands.length)return near.length?{c:null,exact:false,nearTo:near[0].c.name}:null;
  // several names bridge: the one whose own calories are closest is the same serving
  cands.sort((a,b)=>{
    const da=cal!=null?Math.abs((+((a.c.macros||{}).calories)||0)-cal):0;
    const db=cal!=null?Math.abs((+((b.c.macros||{}).calories)||0)-cal):0;
    return da-db||a.len-b.len;
  });
  matchedByName.push(`${name} -> ${cands[0].c.name}${cands.length>1?` (over ${cands.slice(1,3).map(x=>x.c.name).join(", ")})`:""}`);
  return{c:cands[0].c,exact:false};
}

// ---- which app category a harvest category belongs to, learned from the items in both ---------
const tally={};
for(const it of live.items||[]){
  if(SKIP_CATS.has(it.cat))continue;
  const m=lookupItem(it.name,it.cal);const hit=m&&m.c;
  if(!hit||hit.isModifier)continue;
  ((tally[it.cat]=tally[it.cat]||{})[hit.category]=(tally[it.cat][hit.category]||0)+1);
}
const CAT={};
for(const c of Object.keys(tally)){
  const best=Object.entries(tally[c]).sort((a,b)=>b[1]-a[1])[0];
  if(best&&best[1]>=2)CAT[c]=best[0];                 // two agreeing items is a mapping, one is a coincidence
}
// carry forward a mapping an earlier run learned, so one quiet week cannot lose it
Object.assign(CAT,Object.fromEntries(Object.entries(prevCv.catMap||{}).filter(([k])=>!CAT[k])),CAT);

// ---- the delta --------------------------------------------------------------------------------
// A category that loaded and simply holds nothing is fine — Lemon Ice is a summer product and this
// is October, so Culver's publishes the category with no items in it. A category that FAILED to
// load is a different matter: every item in it would read as one the chain had stopped selling.
const failedCats=(live.errors||[]).filter(e=>/^category /.test(e)&&!/: 0 items$/.test(e));
const healthy=(live.categories||[]).length>=MIN_CATEGORIES
  && (live.items||[]).length>=MIN_ITEMS
  && !failedCats.length;
const notes={},caps={},mods={};
const add=[],set=[],off=[],skipped=[],needsReview=[];
const seenKeys=new Set();
const idFor=slug=>"cu-live-"+String(slug).replace(/[^a-z0-9]+/gi,"-").toLowerCase().replace(/^-|-$/g,"");
const same=(a,b)=>!!a&&!!b&&["calories","protein","carbs","fat"].every(k=>(+a[k]||0)===(+b[k]||0));

const secRows=(it)=>{
  const out={};
  for(const s of it.secs||[]){
    if(!s.options.length)continue;
    // A mandatory section with ONE option is not a choice, it is the item restated. Culver's writes
    // the CurderBurger's only option as "Sandwich, 890" — the burger's whole calorie count — and a
    // builder that adds option rows as deltas would have counted the sandwich twice.
    if(s.primary&&s.options.length===1)continue;
    const one=s.mandatory&&!s.countable&&s.max<=1;
    out[s.title]=s.options.map(o=>{
      let fl="";
      if(one)fl+="1";
      if(o.def)fl+="d";
      if(o.rm)fl+="r";
      if(s.countable)fl+="a";
      // The chain offers it and publishes no figure: not-known, never 0 — except for the option that
      // is ALREADY CHOSEN, which adds nothing by definition, so 0 is the right answer for it.
      if(o.cal==null&&!o.def)fl+="?";
      const cal=o.cal==null?0:o.cal;
      return fl?[o.n,cal,0,0,0,fl]:[o.n,cal,0,0,0];
    });
    const key="@"+it.name+"|"+s.title;
    if(s.note)notes[key]=s.note;
    if(s.max>1)caps[key]=s.max;
  }
  return out;
};

matchedByName.length=0;                 // the tally pass above was a dry run; report the real one
for(const it of live.items||[]){
  if(SKIP_CATS.has(it.cat)){
    // still count it as SEEN: the bake carries these rows now, and leaving them out of seenKeys
    // listed all 21 Value Baskets as baked items the harvest never named, which is noise
    seenKeys.add(exact(it.name));seenKeys.add(cvKey(it.name));
    skipped.push(`${it.name}: "${it.cat}" is the chain's combo, which the builder already offers`);continue}
  if(!it.macros||it.cal==null){skipped.push(`${it.name}: no calories published`);continue}
  const key=exact(it.name);seenKeys.add(key);seenKeys.add(cvKey(it.name));
  const m=lookupItem(it.name,it.cal);const hit=m&&m.c;
  const cat=CAT[it.cat];

  if(!hit&&m&&(m.tooShort||m.nearTo)){
    needsReview.push({name:it.name,cat:it.cat,cal:it.cal,macros:it.macros,
      why:m.tooShort?`"${it.name}" is too short a name to add without a look`:`nearly matches "${m.nearTo}"`});
    continue;
  }
  if(!hit){
    if(!cat){skipped.push(`${it.name}: category "${it.cat}" maps to nothing the app has`);continue}
    const row={id:idFor(it.slug),name:it.name,category:cat,macros:it.macros};
    if(it.variants&&it.variants.length>1){
      row.sizeVariants=it.variants.map(v=>({sizeId:v.sizeId,sizeName:v.sizeName,macros:v.macros}));
      const prim=(it.secs||[]).find(s=>s.primary);
      const def=prim&&(prim.options.find(o=>o.def)||prim.options[0]);
      row.defaultSizeId=def?row.sizeVariants[(prim.options.indexOf(def))]?.sizeId:row.sizeVariants[0].sizeId;
      row.macros=(row.sizeVariants.find(v=>v.sizeId===row.defaultSizeId)||row.sizeVariants[0]).macros;
    }
    if(it.macroSrc==="calories-only")row.calOnly=true;
    add.push(row);
    const rows=secRows(it);if(Object.keys(rows).length)mods["@"+it.name]=rows;
    continue;
  }

  // An item we already have: revise a figure only when the two rows are unambiguously the SAME
  // serving. Our menu carries a row per size ("Mushroom & Swiss (Single)" = 490) where Culver's
  // carries one item whose default option is the Double (780). Comparing those two said the single
  // had gained 290 calories, and writing that back would have corrupted a researched row with the
  // wrong serving's figure.
  const prim2=(it.secs||[]).find(s=>s.primary);
  const multi=prim2&&prim2.options.filter(o=>o.cal!=null).length>1;
  const sized=/\(([^()]*)\)\s*$/.test(hit.name);
  if(!m.exact){
    skipped.push(`${hit.name}: left alone — "${it.name}" only matches it by name, not exactly`);
  }else if(multi||sized){
    if((+hit.macros.calories||0)!==(+it.macros.calories||0))
      skipped.push(`${hit.name}: left alone — our row is one serving of "${it.name}", which the chain lists with ${multi?"several":"a"} size option${multi?"s":""}`);
  }else if(!same(hit.macros,it.macros)){
    // never overwrite published macros with a calories-only reading
    const losing=it.macroSrc!=="published"&&((+hit.macros.protein||0)||(+hit.macros.carbs||0)||(+hit.macros.fat||0));
    if(losing){
      if((+hit.macros.calories||0)!==(+it.macros.calories||0))
        skipped.push(`${it.name}: calories moved ${hit.macros.calories} -> ${it.macros.calories} but the chain publishes no macros for it now`);
    }else set.push({id:hit.id,was:hit.macros,macros:it.macros});
  }
  // (2026-10-01) An item the bake already has keeps the bake's option list: Culver's menu is baked from its own
  // ordering screen and guide (chains/culvers.json), and a harvested list is keyed by the site's name, which
  // would not find the baked item. Option lists come with ADDED items only.
}

// Only an item a FEED added can a feed retire. A baked item was researched by hand and carries
// macros the chain does not publish under that name; its absence from one harvest is far more
// likely a name we failed to match than a product the chain dropped, and hiding half the menu on
// that guess is worse than showing one item too long. 38 of 76 baked items missed on the first
// run, which is exactly the evidence for this rule.
// An item the FEED added and the harvest no longer lists is marked off-menu: hidden from browse,
// still fully resolvable, so anything logged against it keeps its name, macros and breakdown. A
// baked item is never marked off — it was researched by hand, it carries macros the chain does not
// publish under that name, and its absence from one harvest is far likelier a name we failed to
// match than a product the chain dropped. 38 of 76 baked items missed on the first run, which is
// exactly the evidence for that rule.
if(healthy){
  for(const c of (prevCv.add||[])){
    if(seenKeys.has(exact(c.name))||seenKeys.has(cvKey(c.name)))continue;
    off.push(c.id);
  }
  // A baked item marked lto:true has opted IN to being retired. The CurderBurger is baked in so it
  // works with no network at all, but it is on sale for a few weeks; without this it would sit in
  // the burger list all year. The flag is per item and deliberate — no baked item is retired by
  // accident, and retiring still only hides it.
  for(const c of baked.components||[]){
    if(!c.lto||c.isModifier)continue;
    if(seenKeys.has(exact(c.name))||seenKeys.has(cvKey(c.name)))continue;
    if(!off.includes(c.id))off.push(c.id);
  }
  for(const id of (prevCv.off||[])){
    // an item comes back off the off-list the moment the chain lists it again
    const was=(prevCv.add||[]).find(a=>a.id===id);
    if(was&&(seenKeys.has(exact(was.name))||seenKeys.has(cvKey(was.name))))continue;
    if(!off.includes(id))off.push(id);
  }
}
const unmatched=(baked.components||[]).filter(c=>!c.isModifier
  &&!seenKeys.has(exact(c.name))&&!seenKeys.has(cvKey(c.name))).map(c=>c.name);

const doc={v:1,generated:new Date().toISOString(),
  source:{chain:"culvers",harvested:live.harvested,menu:(live.source||{}).menu,nutrition:(live.source||{}).nutrition},
  health:{healthy,categories:(live.categories||[]).length,items:(live.items||[]).length,
    harvestErrors:(live.errors||[]).length,
    ...(failedCats.length?{failedCategories:failedCats}:{}),
    emptyCategories:(live.errors||[]).filter(e=>/: 0 items$/.test(e)).map(e=>e.replace(/^category /,"").replace(/: 0 items$/,"")),
    offMenuEmitted:healthy?off.length:0,
    ...(healthy?{}:{whyNoOffMenu:"the harvest did not pass its own health gates, so nothing is marked off-menu"})},
  chains:{culvers:{catMap:CAT,add,set,off,mods,notes,caps}},
  // reported, never acted on: a baked item the harvest did not name. Worth a human look when it
  // grows, because it is either a rename on their side or a gap in our matching.
  // a harvested item this run would not add on its own judgement — a human decides once, and the
  // decision lands in the bake, after which the feed stops asking
  needsReview,
  unmatchedBaked:unmatched,
  // every name bridged by containment rather than matched outright — read this when an item you
  // expected to be added is missing
  matchedByName,
  skipped};

const prevJson=prevFeed?JSON.stringify({...prevFeed,generated:""}):"";
const nextJson=JSON.stringify({...doc,generated:""});
fs.writeFileSync(OUT,JSON.stringify(doc,null,1));
say(`menu-feed: +${add.length} new, ${set.length} revised, ${off.length} off-menu, ${Object.keys(mods).length} option sets, ${needsReview.length} to review, ${skipped.length} skipped, ${unmatched.length} baked items unmatched -> ${path.relative(process.cwd(),OUT)}`);
if(!healthy)say("  ! harvest unhealthy — no off-menu marks emitted");
say(prevJson===nextJson?"  (no change since the last feed)":"  (changed)");
if(skipped.length)say(skipped.slice(0,8).map(s=>"  - "+s).join("\n"));
process.exitCode=0;
