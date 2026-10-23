'use strict';
/* Card geometry is semantic; the character stays in the unclipped page overlay. */
(() => {
  const clamp = (n,a,b) => Math.max(a,Math.min(b,n));
  const intersect = (a,b) => ({left:Math.max(a.left,b.left),top:Math.max(a.top,b.top),right:Math.min(a.right,b.right),bottom:Math.min(a.bottom,b.bottom)});
  const area = r => Math.max(0,r.right-r.left)*Math.max(0,r.bottom-r.top);
  function score(rect, view) {
    const visible=intersect(rect,view); if(!area(visible))return 0;
    const center=(view.top+view.bottom)/2, nearest=clamp(center,visible.top,visible.bottom);
    const cx=(visible.left+visible.right)/2,vcx=(view.left+view.right)/2;
    const proximity=1-Math.hypot((nearest-center)/(view.bottom-view.top),(cx-vcx)/(view.right-view.left));
    return area(visible)/Math.max(1,area(view))*.7 + proximity*.3;
  }
  function choose(cards, view, current) {
    const ranked=cards.map(c=>({...c,score:score(c.rect,view)})).filter(c=>c.score>.12).sort((a,b)=>b.score-a.score);
    const first=ranked[0];if(!first)return null;
    const old=ranked.find(c=>c.id===current);
    return old && first.score-old.score<.12 ? old : first;
  }
  function dock(rect, view, size, blocked=[], preferred=null) {
    const box=intersect(rect,view), margin=Math.ceil(size*.32)+6;
    const b={left:box.left+margin,right:box.right-size-margin,top:box.top+margin,bottom:box.bottom-size-margin};
    if(b.right<b.left||b.bottom<b.top)return null;
    const points=[];
    if(preferred)points.push({x:clamp(preferred.x,b.left,b.right),y:clamp(preferred.y,b.top,b.bottom)});
    // Search quiet corners first, then sample interior gaps. Never clip to simulate containment.
    for(const fy of [1,0,.5,.25,.75])for(const fx of [1,0,.5,.25,.75])points.push({x:b.left+(b.right-b.left)*fx,y:b.top+(b.bottom-b.top)*fy});
    return points.find(p=>!blocked.some(r=>r.left<p.x+size+margin&&r.right>p.x-margin&&r.top<p.y+size+margin&&r.bottom>p.y-margin))||null;
  }
  const policies={
    intro:{state:'happy',poke:'nod'},design:{state:'curious',poke:'nod',trace:true},compare:{state:'thinking',scan:true},
    investigate:{state:'curious',poke:'nod',scan:true},tools:{state:'curious',poke:'nod',scan:true},steps:{state:'listening',poke:'nod',scan:true},
    result:{state:'approving',poke:'bounce'},pricing:{state:'thinking'},faq:{state:'curious'},form:{state:'listening'},default:{state:'listening',poke:'nod'}
  };
  const aliases={introduction:'intro',process:'steps',choice:'pricing',help:'faq',input:'form'};
  const policy=type=>policies[aliases[type]||type]||policies.default;
  function scrollSample(previous,y,now,height){
    if(!previous)return {y,at:now,speed:0,fastSince:null,fast:false};
    const dt=Math.max(8,now-previous.at),raw=Math.abs(y-previous.y)/Math.max(1,height)*1000/dt;
    const speed=previous.speed+(raw-previous.speed)*(1-Math.exp(-dt/80));
    const fastSince=speed>1?(previous.fastSince??now):null;
    return {y,at:now,speed,fastSince,fast:fastSince!==null&&now-fastSince>=100};
  }
  const effectiveSpeed=(sample,now)=>sample?sample.speed*Math.exp(-Math.max(0,now-sample.at-60)/90):0;
  const switchReady=(candidate,id,now,residentMs,ownerValid,flying)=>!flying&&(!ownerValid||residentMs>=900&&candidate.id===id&&now-candidate.since>=280);
  function attach(o) {
    const {motion,robot,size}=o, events=new AbortController(),signal=events.signal;
    const cards=[],geometry=new Map(),metrics={obstacleReads:0,selections:0,transfers:0,grips:0,invalidGeometry:0};
    let geometryVersion=0,workRaf=0,wakeTimer=0;
    const fullRect=c=>{try{const r=c.measure?c.measure():c.el.getBoundingClientRect();if(r&&['left','top','right','bottom'].every(k=>Number.isFinite(r[k]))&&r.right>=r.left&&r.bottom>=r.top)return r;}catch(_){}metrics.invalidGeometry++;return {left:0,top:0,right:0,bottom:0};};
    const connected=c=>!!c&&c.available?.()!==false&&(!c.el||c.el.isConnected);
    const visible=c=>connected(c)&&(!c.el||getComputedStyle(c.el).visibility!=='hidden');
    function register(stage){
      if(destroyed)throw new TypeError('STAGE_ENGINE_DESTROYED');
      if(!stage||typeof stage.id!=='string'||!stage.id||(!stage.element&&!stage.measure))throw new TypeError('INVALID_STAGE');
      if(cards.some(c=>c.id===stage.id))throw new TypeError('DUPLICATE_STAGE');
      const c={...stage,el:stage.element,type:stage.type||'default'};cards.push(c);if(c.el)resizeObserver?.observe(c.el);return c;
    }
    let resizeObserver=null;
    let current=null,destination=null,anchor=null,dirty=true,pausedUntil=0,landed=false,destroyed=false,settleTimer=0;
    let lastAuto=performance.now(),lastCheck=0,cue=null,departing=false,session=0,pausedOwner=null;
    let scroll=null,grip=null,candidate={id:null,since:0},residentAt=0,unsafeAt=0;
    const view=()=>{const b=o.viewport();return {left:b.left,top:b.top,right:b.right+size(),bottom:b.bottom+size()};};
    const blockedSelector='h1,h2,h3,h4,h5,p,li,summary,a,button,input,textarea,select,[contenteditable=true]';
    const frameRect=card=>{const r=fullRect(card),clip=card.clip?.();return clip?intersect(r,clip):r;};
    let pausedStage=null;
    function pauseCarousel(card){if(pausedStage===card?.id)return;pausedStage=card?.id;o.onStageChange?.(card||null);}
    function obstacleRects(card){
      const root=fullRect(card);let cache=geometry.get(card.id);
      if(!cache||cache.version!==geometryVersion){
        const rects=card.obstacles?card.obstacles():card.el?[...card.el.querySelectorAll(blockedSelector)].filter(el=>!el.closest('[aria-hidden=true],[inert]')).map(el=>el.getBoundingClientRect()):[];
        metrics.obstacleReads++;cache={version:geometryVersion,offsets:rects.filter(r=>area(r)).map(r=>({left:r.left-root.left,right:r.right-root.left,top:r.top-root.top,bottom:r.bottom-root.top}))};geometry.set(card.id,cache);
      }
      return cache.offsets.map(r=>({left:r.left+root.left,right:r.right+root.left,top:r.top+root.top,bottom:r.bottom+root.top}));
    }
    function spot(card,preferred){return connected(card)?dock(frameRect(card),view(),size(),obstacleRects(card),preferred):null;}
    function pageBlocked(){
      const active=document.activeElement;
      return o.busy?.()||document.hidden||document.querySelector('dialog[open],[aria-modal=true]')||
        active?.matches('input,textarea,select,[contenteditable=true]')||!!getSelection()?.toString();
    }
    const suspended=()=>pageBlocked()||motion.hidden||performance.now()<pausedUntil;
    function remember(card,p){const r=fullRect(card);anchor={x:p.x-r.left,y:p.y-r.top};}
    function gazeAt(target){
      if(!target)return;const r=typeof target.getBoundingClientRect==='function'?target.getBoundingClientRect():target,at=motion.read();
      const width=Number.isFinite(r.width)?r.width:r.right-r.left,height=Number.isFinite(r.height)?r.height:r.bottom-r.top;
      if(![r.left,r.top,width,height].every(Number.isFinite))return;
      robot.look((r.left+width/2-at.x-size()/2)/(size()*2),-(r.top+height/2-at.y-size()/2)/(size()*2),1.3);
    }
    function respond(card){
      robot.setPaused?.(false);
      const p={...policy(card.type),...card.behavior};if(o.respond)o.respond(p);else robot.setState(p.state);
      if(!o.reduced()&&p.poke)robot.poke(p.poke);
      const targets=card.targets?.()||[];
      if(targets[0])gazeAt(targets[0]);
      if(o.reduced()){cue=null;motion.setResting?.(true);lastAuto=performance.now();return;}
      const nodes=p.scan?targets.slice(0,3):[];
      cue={nodes,at:performance.now(),index:-1,until:performance.now()+2200,trace:!!p.trace};
      motion.setResting?.(false);
      lastAuto=performance.now();
    }
    function suspend(ms=8000){grip=null;motion.holdGrip?.(null);motion.contentEffect?.(null);pausedOwner=destination?.id||current?.id;pausedUntil=performance.now()+ms;dirty=true;destination=null;landed=false;cue=null;schedule(ms+20);}
    function available(card){
      return visible(card)&&spot(card);
    }
    function select(){
      metrics.selections++;
      let pool=cards.filter(visible).map(c=>({...c,rect:frameRect(c)}));
      while(pool.length){
        const candidate=choose(pool,view(),destination?.id||current?.id);if(!candidate)return null;
        const card=cards.find(c=>c.id===candidate.id),point=spot(card);
        if(point)return {card,point};
        pool=pool.filter(c=>c.id!==candidate.id);
      }
      return null;
    }
    function finishExit(){
      current=null;destination=null;anchor=null;landed=false;cue=null;departing=false;pausedUntil=0;pausedOwner=null;grip=null;motion.holdGrip?.(null);
      pauseCarousel(null);motion.setPresence(false);
    }
    function endSession(){
      grip=null;motion.holdGrip?.(null);      robot.setPaused?.(false);motion.setResting?.(false);motion.contentEffect?.(null);
      cue=null;anchor=null;landed=false;destination=null;pausedUntil=0;
      if(!motion.present||motion.hidden||o.reduced()){motion.controller.cancel();finishExit();return;}
      if(!departing){departing=true;motion.controller.depart();}
    }
    function transfer(next,p){
      metrics.transfers++;robot.setPaused?.(false);motion.setResting?.(false);
      const entering=!motion.present||departing;
      if(departing){motion.controller.cancel();departing=false;}
      if(current?.id!==next.id)session++;
      pauseCarousel(next);destination=next;landed=false;cue=null;pausedUntil=0;pausedOwner=null;
      motion.setPresence(true);
      if(motion.hidden)return;
      const rect=fullRect(next),local={x:p.x-rect.left,y:p.y-rect.top};
      if(entering){const v=o.viewport();motion.relocate({x:p.x,y:Math.min(v.bottom,p.y+size()*.7)});}
      const result=motion.controller.hopTo(()=>{
        if(!connected(next))return null;
        const r=fullRect(next);return {x:r.left+local.x,y:r.top+local.y};
      },{enter:entering});
      if(!result.ok){finishExit();return;}
      if(o.reduced()){current=next;destination=null;remember(next,p);landed=true;residentAt=performance.now();respond(next);}
    }
    function catchEdge(now){
      const p=motion.read(),v=o.viewport(),left=p.x<(innerWidth-size())/2;
      const point={x:left?8:innerWidth-size()-8,y:clamp(p.y,v.top,v.bottom)},side=left?'left':'right';
      departing=false;grip={side,point,at:now,heldAt:0,target:null,since:now};metrics.grips++;
      cue=null;destination=null;landed=false;motion.contentEffect?.(null);robot.setPaused?.(false);motion.setResting?.(false);
      motion.controller.gripTo(point,side);
    }
    function waitAtEdge(now){
      if(!grip)return false;
      if(motion.hidden||pageBlocked()){endSession();return true;}
      if(motion.active==='grip')return true;
      if(!grip.heldAt){motion.holdGrip?.(grip.side);grip.heldAt=now;}
      if(now-grip.heldAt>=180)motion.setResting?.(true);
      if(now-lastCheck<160)return true;
      lastCheck=now;
      const selected=select(),id=selected?.card.id||null,p=selected?.point;
      if(grip.target!==id||p&&grip.lastPoint&&Math.hypot(p.x-grip.lastPoint.x,p.y-grip.lastPoint.y)>4){grip.target=id;grip.since=now;}
      grip.lastPoint=p;
      if(selected&&effectiveSpeed(scroll,now)<.15&&now-grip.since>=280&&now-grip.heldAt>=250){
        const target=selected;grip=null;motion.holdGrip?.(null);robot.setPaused?.(false);transfer(target.card,target.point);return true;
      }
      if(!selected&&scroll&&now-scroll.at>2000){endSession();return true;}
      return true;
    }
    function tick(now=performance.now()) {
      if(destroyed||document.hidden)return;
      if(!o.reduced()&&!motion.hidden&&!pageBlocked()&&now>=pausedUntil&&scroll?.fast&&effectiveSpeed(scroll,now)>.8&&motion.present&&(current||destination)&&!grip)catchEdge(now);
      if(waitAtEdge(now))return;
      if(departing&&!motion.active){finishExit();dirty=true;}
      // Lifecycle validation precedes manual cooldowns and performances: no orphaned owner.
      if(dirty&&now-lastCheck>=160){
        lastCheck=now;dirty=false;
        const selected=select();
        if(!selected){if(!o.reduced()&&motion.present&&current&&now>=pausedUntil&&effectiveSpeed(scroll,now)>.4){catchEdge(now);return;}endSession();return;}
        const owner=destination||current,ownerValid=available(owner);
        if(!ownerValid&&motion.present&&current&&!o.reduced()&&now>=pausedUntil&&effectiveSpeed(scroll,now)>.4){catchEdge(now);return;}
        if(candidate.id!==selected.card.id)candidate={id:selected.card.id,since:now};
        if(motion.hidden){motion.setPresence(true);return;}
        if(now<pausedUntil&&selected.card.id===pausedOwner){
          if(!ownerValid){motion.controller.cancel();current=null;destination=null;anchor=null;landed=false;cue=null;pauseCarousel(null);motion.setPresence(false);}
          return;
        }
        if(pageBlocked()&&!ownerValid){endSession();return;}
        if(!ownerValid||!motion.present||departing||(!suspended()&&((selected.card.id!==owner?.id&&switchReady(candidate,selected.card.id,now,now-residentAt,ownerValid,!!destination))||(!landed&&!destination&&!motion.active&&now-unsafeAt>=180)))){
          transfer(selected.card,selected.point);return;
        }
        if(!destination&&selected.card.id!==owner?.id)dirty=true;
      }
      if(departing)return;
      if(suspended()){
        if(motion.active==='hop'){motion.controller.cancel();destination=null;landed=false;}
        return;
      }
      if(motion.active&&motion.active!=='hop'){dirty=true;return;}
      if(destination&&!motion.active){
        if(!available(destination)){dirty=true;return;}
        current=destination;destination=null;remember(current,motion.read());landed=true;residentAt=now;unsafeAt=0;respond(current);
      }
      if(cue){
        const index=Math.floor((now-cue.at)/650);
        if(cue.trace)motion.contentEffect?.('trace',Math.min(1,(now-cue.at)/1800));
        if(now>=cue.until){cue=null;motion.contentEffect?.(null);if(o.rest)o.rest(current);else robot.setState('idle');motion.setResting?.(true);}
        else if(index<cue.nodes.length&&index!==cue.index){gazeAt(cue.nodes[index]);cue.index=index;}
      }
      if(motion.active||motion.hidden)return;
      if(current&&anchor&&landed){
        const r=fullRect(current),p={x:r.left+anchor.x,y:r.top+anchor.y},v=view();
        if(p.x>=v.left-2&&p.x+size()<=v.right+2&&p.y>=v.top-2&&p.y+size()<=v.bottom+2){unsafeAt=0;motion.relocate(p);}else {if(!unsafeAt)unsafeAt=now;if(now-unsafeAt>=180)landed=false;dirty=true;}
      }
      if(!landed&&current){dirty=true;}
      if(current&&landed&&now-lastAuto>=60000&&!o.reduced())respond(current);
    }
    function schedule(delay=0){
      if(destroyed)return;
      clearTimeout(wakeTimer);
      wakeTimer=setTimeout(()=>{wakeTimer=0;tick();pump();},Math.max(0,delay));
    }
    function pump(){
      if(destroyed||document.hidden||workRaf)return;
      if(motion.active||cue){workRaf=requestAnimationFrame(now=>{workRaf=0;tick(now);pump();});}
      else if(grip)schedule(120);
      else if(o.busy?.())schedule(160);
      else if(performance.now()<pausedUntil)schedule(pausedUntil-performance.now()+20);
      else if(dirty)schedule(180);
      else if(current&&landed&&!o.reduced())schedule(Math.max(300,60000-(performance.now()-lastAuto)));
    }
    function reportScroll(position,now=performance.now(),height=innerHeight){
      if(destroyed)return;scroll=scrollSample(scroll,position,now,height);dirty=true;cue=null;motion.contentEffect?.(null);tick(now);pump();schedule(300);
    }
    const scrolled=()=>reportScroll(scrollY);
    function invalidate(options={}){if(destroyed)return;if(options.layout!==false){geometryVersion++;geometry.clear();if(current&&landed){const at=motion.read(),p=spot(current,at);if(p&&Math.hypot(p.x-at.x,p.y-at.y)>2){landed=false;unsafeAt=performance.now()-200;}}}dirty=true;tick();pump();schedule(180);}
    if(o.listen!==false){
      matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{if(grip){grip=null;motion.holdGrip?.(null);}cue=null;motion.contentEffect?.(null);invalidate({layout:false});},{signal});
      addEventListener('scroll',scrolled,{passive:true,capture:true,signal});
      const resized=()=>{if(grip){grip=null;motion.holdGrip?.(null);motion.controller.cancel();}landed=false;unsafeAt=0;invalidate();};
      addEventListener('resize',resized,{passive:true,signal});
      globalThis.visualViewport?.addEventListener('resize',resized,{signal});
      document.addEventListener('click',e=>{if(e.target.closest('[data-robot-controls]')){suspend(e.target.closest('[data-robot-action=stop]')?60000:8000);pump();schedule(200);}},{signal});
      document.addEventListener('toggle',e=>{if(e.target.matches('dialog'))invalidate({layout:false});},{capture:true,signal});
      document.addEventListener('keydown',e=>{if(e.key==='Escape')suspend(60000);},{signal});
      document.addEventListener('visibilitychange',()=>{
        if(document.hidden){if(workRaf)cancelAnimationFrame(workRaf);workRaf=0;clearTimeout(wakeTimer);destination=null;landed=false;dirty=true;}
        else invalidate({layout:false});
      },{signal});
      document.addEventListener('focusin',e=>{if(e.target.matches('input,textarea,select,[contenteditable=true]')){suspend(1000);if(motion.active)motion.controller.cancel();}},{signal});
    }
    if(typeof ResizeObserver==='function')resizeObserver=new ResizeObserver(()=>invalidate());
    for(const stage of o.stages||[])register(stage);
    const api={tick,suspend,invalidate,scroll:reportScroll,register(stage){const c=register(stage);invalidate();return ()=>api.unregister(c.id);},
      unregister(id){if(destroyed)return false;const index=cards.findIndex(c=>c.id===id);if(index<0)return false;const [c]=cards.splice(index,1);if(c.el)resizeObserver?.unobserve(c.el);geometry.delete(id);if(grip&&(current?.id===id||destination?.id===id))endSession();invalidate();return true;},
      update(id,patch){if(destroyed)return false;const c=cards.find(c=>c.id===id);if(!c)return false;if(!patch||patch.id&&patch.id!==id)throw new TypeError('INVALID_STAGE_UPDATE');if(patch.element&&patch.element!==c.el){if(c.el)resizeObserver?.unobserve(c.el);c.el=patch.element;resizeObserver?.observe(c.el);}Object.assign(c,patch);invalidate({layout:['element','measure','obstacles','clip'].some(key=>key in patch)});return true;},
      notify(id,event){if(destroyed)return false;if(id!==current?.id||!landed||suspended())return false;robot.setPaused?.(false);motion.setResting?.(false);respond(current);if(event?.target){gazeAt(event.target);if(cue)cue.nodes=[event.target];}if(event?.type==='completed')robot.setState('approving');if(event?.type==='error')robot.setState('confused');pump();return true;},
      get metrics(){return {...metrics,scrollSpeed:effectiveSpeed(scroll,performance.now()),fast:!!scroll?.fast};},get current(){return current?.id||null;},get type(){return current?.type||null;},get session(){return session;},get phase(){return grip?(motion.active==='grip'?'gripping':'gripped'):departing?'departing':destination?'transit':landed?'resident':motion.present?'waiting':'dormant';},
      frameBounds(){
        if(!current||destination||departing)return null;
        const r=intersect(frameRect(current),view()),m=Math.ceil(size()*.32)+6,b={left:r.left+m,top:r.top+m,right:r.right-size()-m,bottom:r.bottom-size()-m};
        return b.right>=b.left&&b.bottom>=b.top?b:null;
      },
      bounds(){return api.frameBounds();},
      safe(p){
        if(!api.bounds())return true;
        const next=spot(current,p);return !!next&&Math.hypot(next.x-p.x,next.y-p.y)<.1;
      },
      destroy(){if(destroyed)return;destroyed=true;motion.controller.cancel();motion.setPresence(false);motion.contentEffect?.(null);motion.holdGrip?.(null);pauseCarousel(null);if(workRaf)cancelAnimationFrame(workRaf);clearTimeout(wakeTimer);clearTimeout(settleTimer);resizeObserver?.disconnect();events.abort();geometry.clear();cards.length=0;current=destination=null;cue=null;grip=null;robot.setPaused?.(false);}};
    // This is also used when reduced motion disables the host animation loop.
    settleTimer=setTimeout(()=>{tick();pump();},100);
    return api;
  }
  globalThis.CopoStageEngine={score,choose,dock,policy,scrollSample,effectiveSpeed,switchReady,attach};
})();
