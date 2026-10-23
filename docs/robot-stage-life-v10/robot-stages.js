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
    intro:{state:'happy',poke:'nod'},tools:{state:'curious',poke:'nod',scan:true},steps:{state:'listening',poke:'nod',scan:true},
    result:{state:'approving',poke:'bounce'},pricing:{state:'thinking'},faq:{state:'curious'},form:{state:'listening'},
    default:{state:'listening',poke:'nod'}
  };
  const policy=type=>policies[type]||policies.default;
  function attach(o) {
    const {motion,robot,size}=o, events=new AbortController(),signal=events.signal;
    const nodes=[...document.querySelectorAll('main [data-motion-card], main .workbench-public-tool, main .service-directory, main .faq-contact-card, main .closing-inner')]
      .filter(el=>!el.closest('[inert],[aria-hidden=true]'));
    function typeOf(el){
      if(el.closest('#pricing'))return 'pricing';if(el.closest('#faq'))return 'faq';if(el.closest('#inquiry'))return 'form';
      if(el.matches('.hero-case-preview'))return 'intro';if(el.matches('.journey-card,.animated-demo'))return 'steps';
      if(el.matches('.workbench-public-tool,.service-directory')||el.closest('#modules'))return 'tools';
      if(el.matches('.value-card')||el.closest('#status'))return 'result';return 'default';
    }
    const cards=nodes.map((el,i)=>({el,id:el.id||`card-${i+1}`,type:typeOf(el)}));
    for(const c of cards){c.el.dataset.robotStage=c.id;c.el.dataset.robotStageType=c.type;}
    let current=null,destination=null,anchor=null,dirty=true,pausedUntil=0,landed=false,destroyed=false,settleTimer=0;
    let lastAuto=performance.now(),lastCheck=0,cue=null,departing=false,session=0,pausedOwner=null;
    const view=()=>{const b=o.viewport();return {left:b.left,top:b.top,right:b.right+size(),bottom:b.bottom+size()};};
    const blockedSelector='h1,h2,h3,h4,h5,p,li,summary,a,button,input,textarea,select,[contenteditable=true]';
    const frameRect=card=>{const r=card.el.getBoundingClientRect(),clip=card.el.closest('.workbench-marquee');return clip?intersect(r,clip.getBoundingClientRect()):r;};
    function pauseCarousel(card){
      document.querySelectorAll('.copo-stage-paused').forEach(el=>el.classList.remove('copo-stage-paused'));
      if(card?.type==='tools')card.el.closest('.workbench-showcase')?.classList.add('copo-stage-paused');
    }
    function spot(card, preferred){
      if(!card?.el.isConnected)return null;
      const blocked=[...card.el.querySelectorAll(blockedSelector)].filter(el=>!el.closest('[aria-hidden=true],[inert]')).map(el=>el.getBoundingClientRect()).filter(r=>area(r));
      return dock(frameRect(card),view(),size(),blocked,preferred);
    }
    function pageBlocked(){
      const active=document.activeElement;
      return o.busy?.()||document.hidden||document.querySelector('dialog[open],[aria-modal=true]')||
        active?.matches('input,textarea,select,[contenteditable=true]')||!!getSelection()?.toString();
    }
    const suspended=()=>pageBlocked()||motion.hidden||performance.now()<pausedUntil;
    function remember(card,p){const r=card.el.getBoundingClientRect();anchor={x:p.x-r.left,y:p.y-r.top};}
    function gazeAt(target){
      const r=target.getBoundingClientRect(),at=motion.read();
      robot.look((r.left+r.width/2-at.x-size()/2)/(size()*2),-(r.top+r.height/2-at.y-size()/2)/(size()*2),1.3);
    }
    function respond(card){
      const p=policy(card.type);if(o.respond)o.respond(p);else robot.setState(p.state);
      if(!o.reduced()&&p.poke)robot.poke(p.poke);
      const target=card.el.querySelector('h1,h2,h3,summary,a');
      if(target)gazeAt(target);
      const nodes=p.scan?[...card.el.querySelectorAll('h2,h3,.journey-native-kicker,.workbench-tool-top')].filter(el=>!el.closest('[inert]')&&area(intersect(el.getBoundingClientRect(),intersect(card.el.getBoundingClientRect(),view())))):[];
      cue=nodes.length?{nodes:nodes.slice(0,3),at:performance.now(),index:-1}:null;
      lastAuto=performance.now();
    }
    function suspend(ms=8000){pausedOwner=destination?.id||current?.id;pausedUntil=performance.now()+ms;dirty=true;destination=null;landed=false;cue=null;}
    function available(card){
      return card?.el.isConnected&&getComputedStyle(card.el).visibility!=='hidden'&&spot(card);
    }
    function select(){
      let pool=cards.filter(c=>c.el.isConnected&&getComputedStyle(c.el).visibility!=='hidden').map(c=>({...c,rect:frameRect(c)}));
      while(pool.length){
        const candidate=choose(pool,view(),destination?.id||current?.id);if(!candidate)return null;
        const card=cards.find(c=>c.id===candidate.id),point=spot(card);
        if(point)return {card,point};
        pool=pool.filter(c=>c.id!==candidate.id);
      }
      return null;
    }
    function finishExit(){
      current=null;destination=null;anchor=null;landed=false;cue=null;departing=false;pausedUntil=0;pausedOwner=null;
      pauseCarousel(null);motion.setPresence(false);
    }
    function endSession(){
      cue=null;anchor=null;landed=false;destination=null;pausedUntil=0;
      if(!motion.present||motion.hidden||o.reduced()){motion.controller.cancel();finishExit();return;}
      if(!departing){departing=true;motion.controller.depart();}
    }
    function transfer(next,p){
      const entering=!motion.present||departing;
      if(departing){motion.controller.cancel();departing=false;}
      if(current?.id!==next.id)session++;
      pauseCarousel(next);destination=next;landed=false;cue=null;pausedUntil=0;pausedOwner=null;
      motion.setPresence(true);
      if(motion.hidden)return;
      const rect=next.el.getBoundingClientRect(),local={x:p.x-rect.left,y:p.y-rect.top};
      if(entering){const v=o.viewport();motion.relocate({x:p.x,y:Math.min(v.bottom,p.y+size()*.7)});}
      const result=motion.controller.hopTo(()=>{
        if(!next.el.isConnected)return null;
        const r=next.el.getBoundingClientRect();return {x:r.left+local.x,y:r.top+local.y};
      },{enter:entering});
      if(!result.ok){finishExit();return;}
      if(o.reduced()){current=next;destination=null;remember(next,p);landed=true;respond(next);}
    }
    function tick(now=performance.now()) {
      if(destroyed||document.hidden)return;
      if(departing&&!motion.active){finishExit();dirty=true;}
      // Lifecycle validation precedes manual cooldowns and performances: no orphaned owner.
      if(dirty&&now-lastCheck>=100){
        lastCheck=now;dirty=false;
        const selected=select();
        if(!selected){endSession();return;}
        const owner=destination||current,ownerValid=available(owner);
        if(motion.hidden){motion.setPresence(true);return;}
        if(now<pausedUntil&&selected.card.id===pausedOwner){
          if(!ownerValid){motion.controller.cancel();current=null;destination=null;anchor=null;landed=false;cue=null;pauseCarousel(null);motion.setPresence(false);}
          return;
        }
        if(pageBlocked()&&!ownerValid){endSession();return;}
        if(!ownerValid||!motion.present||departing||(!suspended()&&(selected.card.id!==owner?.id||(!landed&&!destination&&!motion.active)))){
          transfer(selected.card,selected.point);return;
        }
      }
      if(departing)return;
      if(suspended()){
        if(motion.active==='hop'){motion.controller.cancel();destination=null;landed=false;}
        return;
      }
      if(motion.active&&motion.active!=='hop'){dirty=true;return;}
      if(destination&&!motion.active){
        if(!available(destination)){dirty=true;return;}
        current=destination;destination=null;remember(current,motion.read());landed=true;respond(current);
      }
      if(cue){const index=Math.floor((now-cue.at)/650);if(index>=cue.nodes.length)cue=null;else if(index!==cue.index){gazeAt(cue.nodes[index]);cue.index=index;}}
      if(motion.active||motion.hidden)return;
      if(current&&anchor&&landed){
        const r=current.el.getBoundingClientRect(),p={x:r.left+anchor.x,y:r.top+anchor.y},v=view(),m=size()*.32+6;
        if(p.x-m>=v.left&&p.x+size()+m<=v.right&&p.y-m>=v.top&&p.y+size()+m<=v.bottom)motion.relocate(p);else {landed=false;dirty=true;}
      }
      if(!landed&&current){dirty=true;}
      if(current&&landed&&now-lastAuto>=60000)respond(current);
    }
    function scrolled(){
      if(destroyed)return;dirty=true;cue=null;tick(performance.now());
      // Retarget during scrolling instead of cancelling the flight on every input event.
      clearTimeout(settleTimer);settleTimer=setTimeout(()=>tick(),90);
    }
    addEventListener('scroll',scrolled,{passive:true,capture:true,signal});
    addEventListener('resize',()=>{landed=false;dirty=true;scrolled();},{passive:true,signal});
    document.addEventListener('click',e=>{
      if(e.target.closest('[data-robot-controls]')){suspend(e.target.closest('[data-robot-action=stop]')?60000:8000);return;}
      const detail=e.target.closest('summary');if(detail&&current?.type==='faq')respond(current);
    },{signal});
    document.addEventListener('toggle',e=>{if(e.target.matches('dialog'))scrolled();},{capture:true,signal});
    document.addEventListener('keydown',e=>{if(e.key==='Escape')suspend(60000);},{signal});
    document.addEventListener('visibilitychange',()=>{if(document.hidden){destination=null;landed=false;dirty=true;}else scrolled();},{signal});
    document.addEventListener('focusin',e=>{if(e.target.matches('input,textarea,select,[contenteditable=true]')){suspend(1000);if(motion.active==='hop')motion.controller.cancel();}},{signal});
    const api={tick,suspend,invalidate:scrolled,get current(){return current?.id||null;},get type(){return current?.type||null;},get session(){return session;},get phase(){return departing?'departing':destination?'transit':landed?'resident':motion.present?'waiting':'dormant';},
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
      destroy(){destroyed=true;pauseCarousel(null);clearTimeout(settleTimer);events.abort();for(const c of cards){delete c.el.dataset.robotStage;delete c.el.dataset.robotStageType;}}};
    // This is also used when reduced motion disables the host animation loop.
    settleTimer=setTimeout(()=>tick(),100);
    return api;
  }
  globalThis.CopoRobotStages={score,choose,dock,policy,attach};
})();
