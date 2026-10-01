// Culver's, from Culver's own menu — run on a schedule so a limited-time item appears by itself.
//
// Two sources, both the chain's own:
//   STRUCTURE + CALORIES  www.culvers.com/menu renders its ordering payload into the page
//                         (__NEXT_DATA__ -> props.pageProps.menuItem: baseCalories,
//                         primaryModifier, modifiers). Every section, its heading, its caps, its
//                         defaults, and which toppings are REMOVALS, verbatim.
//   MACROS                Culver's publishes protein / carbs / fat through the Nutritionix
//                         Interactive Nutrition Menu its own nutritionUrl points at. The per-item
//                         label is a client-rendered app, but the chain-wide menu table is server
//                         rendered, and its cells carry an aria-label naming the nutrient — so a
//                         column cannot slide the way it did when we read Portillo's by position.
//
// Writes culvers-live.json. Takes nothing on faith: a category that fails to load leaves the
// previous harvest's items alone rather than reading as a menu that shrank (see menu-feed.mjs).
//
// Usage: node harvest.mjs [--out culvers-live.json] [--concurrency 4]
import fs from "fs";

const UA_PHONE="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const UA_DESK="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const MENU="https://www.culvers.com/menu";
const NX="https://www.nutritionix.com/culvers/menu/premium";

const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d};
const OUT=arg("--out","culvers-live.json");
const CONC=Math.max(1,Math.min(8,+arg("--concurrency",4)||4));

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(url,ua,tries=3){
  let last;
  for(let i=0;i<tries;i++){
    try{
      const c=new AbortController();const t=setTimeout(()=>c.abort(),45000);
      const r=await fetch(url,{headers:{"user-agent":ua,"accept":"text/html,application/xhtml+xml"},signal:c.signal,redirect:"follow"});
      clearTimeout(t);
      if(!r.ok)throw new Error("HTTP "+r.status);
      return await r.text();
    }catch(e){last=e;await sleep(600*(i+1)*(i+1))}
  }
  throw last;
}
const nextData=htm=>{
  const m=/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(htm);
  if(!m)return null;
  try{return JSON.parse(m[1])}catch{return null}
};

// ---- macros, by nutrient NAME, from the chain-wide table -------------------------------------
const NUT={"Calories":"calories","Total Fat":"fat","Total Carbohydrates":"carbs","Protein":"protein","Sodium":"sodium"};
function parseNutritionix(htm){
  const out={};
  for(const tr of htm.split(/<tr[^>]*>/).slice(1)){
    const nm=/class="nmItem"[^>]*>([^<]+)<\/a>/.exec(tr);
    if(!nm)continue;
    const name=nm[1].replace(/&#0?39;/g,"'").replace(/&amp;/g,"&").replace(/&quot;/g,'"').trim();
    const vals={};
    for(const c of tr.matchAll(/aria-label="([^"]+)"[^>]*>([^<]*)<\/td>/g)){
      const lab=c[1],raw=c[2].replace(/,/g,"").trim();
      const mm=/^(?:[\d.]+|<\s*[\d.]+)\s*(?:g|mg)?\s+(.*)$/.exec(lab);
      if(!mm)continue;
      const key=NUT[mm[1].trim()];
      if(!key)continue;
      vals[key]=raw && !raw.startsWith("<") ? (+raw||0) : 0;
    }
    if("calories" in vals && !out[name])out[name]=vals;
  }
  return out;
}

// ---- one item's sections, as the chain writes them -------------------------------------------
function sections(mi){
  const secs=[];
  const push=(s,primary)=>{
    if(!s||!Array.isArray(s.options)||!s.options.length)return;
    // Culver's packs a heading and its instruction into ONE comma-joined string, and leaves the
    // primary modifier untitled — its axis name ("Patties", "Pieces") sits in `description`.
    const raw=String(s.sectionTitle||"").trim();
    const cut=raw.indexOf(",");
    const title=(raw?(cut>0?raw.slice(0,cut):raw):String(s.description||"Size")).trim();
    secs.push({
      title, note:raw&&cut>0?raw.slice(cut+1).trim():"",
      primary:!!primary, mandatory:!!s.isMandatory,
      max:+s.maxAggregateQuantity||0, total:+s.totalQuantity||0,
      countable:(+s.maxAggregateQuantity||0)>1,
      options:s.options.map(o=>({
        n:String(o.name||"").trim(),
        cal:o.baseCalories==null?null:+o.baseCalories,
        def:!!o.isDefault, rm:!!o.isRemoval, ex:!!o.isExclusive
      })).filter(o=>o.n)
    });
  };
  push(mi.primaryModifier,true);
  (mi.modifiers||[]).forEach(s=>push(s,false));
  (mi.secondaryModifiers||[]).forEach(s=>push(s,false));
  return secs;
}

// ---- run -------------------------------------------------------------------------------------
async function pool(list,fn){
  const out=[];let i=0;
  await Promise.all(Array.from({length:Math.min(CONC,list.length)},async()=>{
    while(i<list.length){const k=i++;try{out[k]=await fn(list[k],k)}catch(e){out[k]={__err:String(e&&e.message||e)}}}
  }));
  return out;
}
const walk=(o,p="",acc=[])=>{
  if(o&&typeof o==="object"){for(const k of Object.keys(o))walk(o[k],p+"/"+k,acc)}
  else acc.push([p,o]);
  return acc;
};

(async()=>{
  const started=new Date().toISOString();
  const errors=[];

  // 1. the chain's own category list, so a new category cannot be missed
  const menuHtml=await get(MENU,UA_PHONE);
  const menu=nextData(menuHtml);
  if(!menu)throw new Error("menu page carried no __NEXT_DATA__ — the site's shape changed");
  const cats=[...new Set(walk(menu).filter(([p,v])=>p.endsWith("/slug")&&typeof v==="string").map(([,v])=>v))];
  if(cats.length<6)throw new Error(`only ${cats.length} categories found — refusing to treat that as the whole menu`);

  // 2. every item in every category
  const catPages=await pool(cats,async c=>({c,html:await get(`${MENU}/${c}`,UA_PHONE)}));
  const items=[],catOk=[];
  for(const r of catPages){
    if(r.__err||!r.html){errors.push(`category ${r&&r.c}: ${r&&r.__err}`);continue}
    const d=nextData(r.html);if(!d){errors.push(`category ${r.c}: no __NEXT_DATA__`);continue}
    const groups=[];
    for(const [p,v] of walk(d)){
      if(!/\/customData\/categor(y|ies)/.test(p)||!p.endsWith("/slug")||typeof v!=="string")continue;
      groups.push([p,v]);
    }
    // the item records themselves, pulled out whole
    const seen=new Set();let n=0;
    const pick=o=>{
      if(!o||typeof o!=="object")return;
      if(Array.isArray(o)){o.forEach(pick);return}
      if(typeof o.slug==="string"&&typeof o.name==="string"&&!seen.has(o.slug)&&o.slug!==r.c){
        seen.add(o.slug);n++;
        items.push({cat:r.c,slug:o.slug,name:o.name,desc:String(o.description||"").trim(),
          image:o.image||"",listCal:o.baseCalories==null?null:+o.baseCalories});
      }
      Object.values(o).forEach(pick);
    };
    pick(((d.props||{}).pageProps||{}).page||{});
    catOk.push(r.c);
    if(!n)errors.push(`category ${r.c}: 0 items`);
  }

  // 3. each item's own page: calories and the chain's own sections
  const detail=await pool(items,async it=>{
    const html=await get(`${MENU}/${it.cat}/${it.slug}`,UA_PHONE);
    const d=nextData(html);
    const mi=d&&((d.props||{}).pageProps||{}).menuItem;
    if(!mi)return{...it,__err:"no menuItem"};
    const secs=sections(mi);
    const prim=secs.find(s=>s.primary);
    const cal=mi.baseCalories!=null?+mi.baseCalories
      :prim?((prim.options.find(o=>o.def)||prim.options[0]||{}).cal??null):null;
    return{...it,name:String(mi.name||it.name).trim(),cal,
      nutritionUrl:mi.nutritionUrl||"",basket:!!mi.valueBasketLink,
      eightySixed:!!mi.isEightySixed,secs};
  });

  // 4. macros, by nutrient name, from the chain's published table
  let macros={};
  try{macros=parseNutritionix(await get(NX,UA_DESK))}
  catch(e){errors.push("nutritionix: "+String(e&&e.message||e))}
  const norm=x=>String(x).toLowerCase().replace(/[®™©]/g,"").replace(/^the\s+/,"").replace(/[^a-z0-9]+/g," ").trim();
  const mByNorm={};for(const k of Object.keys(macros))mByNorm[norm(k)]=macros[k];

  // Nutritionix lists one row per SIZE ("The Culver's® Deluxe, Double") where Culver's own menu
  // lists one item with a Patties section, so a bare name match finds almost nothing. Try the
  // name, then the name with each primary option appended, then a length-guarded containment.
  const lookup=(name,opt)=>{
    const want=norm(opt?`${name}, ${opt}`:name);
    if(mByNorm[want])return mByNorm[want];
    // No containment fallback. It matched "Smoked Cheddar CurderBurger" against the chain's
    // "... Value Basket" row and handed a basket the sandwich's macros, and a basket is a
    // different product. An unmatched item is recorded calories-only, which is the truth.
    return null;
  };
  // only trust a published row whose calories agree with the ordering screen's; a wide
  // disagreement means the two names are different products, not two readings of one
  const agrees=(m,cal)=>!!(m&&cal!=null&&m.calories>0&&Math.abs(m.calories-cal)<=Math.max(30,cal*0.15));
  const fill=(m,cal)=>({calories:cal,protein:m.protein??0,carbs:m.carbs??0,fat:m.fat??0,...(m.sodium!=null?{sodium:m.sodium}:{})});

  const out=[];
  for(const it of detail){
    if(it.__err){errors.push(`item ${it.cat}/${it.slug}: ${it.__err}`);continue}
    const prim=(it.secs||[]).find(s=>s.primary);
    const opts=prim?prim.options.filter(o=>o.cal!=null):[];
    let macros=null,src="none",variants=null;

    // per-option macros, where the chain publishes a row for each ("..., Single" / "..., Double")
    if(opts.length>1){
      const vs=[];
      for(const o of opts){
        const m=lookup(it.name,o.n);
        vs.push({sizeId:o.n.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,""),sizeName:o.n,
          macros:agrees(m,o.cal)?fill(m,o.cal):{calories:o.cal,protein:0,carbs:0,fat:0},
          src:agrees(m,o.cal)?"published":"calories-only"});
      }
      if(vs.some(v=>v.src==="published"))variants=vs;
      const def=vs.find((v,i)=>opts[i].def)||vs[0];
      if(def){macros=def.macros;src=def.src}
    }
    if(!macros){
      const m=lookup(it.name);
      if(agrees(m,it.cal)){macros=fill(m,it.cal);src="published"}
      else if(it.cal!=null){macros={calories:it.cal,protein:0,carbs:0,fat:0};src="calories-only"}
    }
    out.push({...it,macros,macroSrc:src,...(variants?{variants}:{})});
  }

  const doc={chain:"culvers",harvested:started,finished:new Date().toISOString(),
    source:{menu:MENU,nutrition:NX},
    categories:catOk,counts:{categories:catOk.length,items:out.length,
      withMacros:out.filter(x=>x.macroSrc==="published").length,
      caloriesOnly:out.filter(x=>x.macroSrc==="calories-only").length},
    errors,items:out};
  fs.writeFileSync(OUT,JSON.stringify(doc,null,1));
  console.log(`culvers: ${out.length} items across ${catOk.length} categories, ${doc.counts.withMacros} with published macros, ${errors.length} problems -> ${OUT}`);
  if(errors.length)console.log(errors.slice(0,10).map(e=>"  ! "+e).join("\n"));
})().catch(e=>{console.error("harvest failed:",String(e&&e.stack||e));process.exit(1)});
