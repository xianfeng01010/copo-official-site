'use strict';
/* Website-only adapter. Stage lifecycle and performances live in the shared engine. */
(() => {
  const engine=globalThis.CopoStageEngine;if(!engine)return;
  function attach(options){
    const nodes=[...document.querySelectorAll('main [data-motion-card], main .workbench-public-tool, main .service-directory, main .faq-contact-card, main .closing-inner')].filter(el=>!el.closest('[inert],[aria-hidden=true]'));
    function typeOf(el){
      if(el.closest('#pricing'))return 'pricing';if(el.closest('#faq'))return 'faq';if(el.closest('#inquiry'))return 'form';
      if(el.matches('.hero-case-preview'))return 'intro';if(el.matches('.journey-card,.animated-demo'))return 'steps';
      if(el.matches('.workbench-public-tool'))return el.dataset.toolId==='design-canvas'?'design':el.dataset.toolId==='dialogue-eval'?'compare':'investigate';
      if(el.matches('.service-directory'))return 'tools';if(el.matches('.value-card')||el.closest('#status'))return 'result';return 'default';
    }
    const stages=nodes.map((element,i)=>{
      const id=element.id||`card-${i+1}`,type=typeOf(element);element.dataset.robotStage=id;element.dataset.robotStageType=type;
      return {id,type,element,
        clip:()=>element.closest('.workbench-marquee')?.getBoundingClientRect(),
        targets:()=>[...element.querySelectorAll('h1,h2,h3,summary,a,.journey-native-kicker')].filter(el=>!el.closest('[inert]')).slice(0,3)};
    });
    let paused=null;
    const runtime=engine.attach({...options,stages,onStageChange:stage=>{
      const next=stage?.element.closest('.workbench-showcase')||null;if(next===paused)return;
      paused?.classList.remove('copo-stage-paused');next?.classList.add('copo-stage-paused');paused=next;
    }});
    const events=new AbortController();
    document.addEventListener('click',event=>{const summary=event.target.closest('summary');if(summary&&runtime.type==='faq')runtime.notify(runtime.current,{type:'expanded',target:summary});},{signal:events.signal});
    const destroy=runtime.destroy;runtime.destroy=()=>{events.abort();destroy();for(const stage of stages){delete stage.element.dataset.robotStage;delete stage.element.dataset.robotStageType;}};
    return runtime;
  }
  globalThis.CopoRobotStages={...engine,attach};
})();
