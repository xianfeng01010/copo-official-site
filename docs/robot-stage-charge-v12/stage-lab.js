'use strict';
(() => {
  const resources={'zh-CN':{steps:['观察','整理','回顾']}};
  const copy=resources[document.documentElement.lang]||resources['zh-CN'];
  const target=document.getElementById('lab-character'),visual=document.getElementById('lab-visual'),robot=CopoRobot;
  const size=()=>innerWidth<720?52:72;robot.mount(visual,{size:size()});
  let runtime=null;
  const motion=CopoRobotMotion.attach({target,visual,robot,stageManaged:true,size,
    localBounds:()=>runtime?.bounds(),safe:p=>runtime?.safe(p)!==false,autoManaged:()=>true,
    before:action=>{if(!['hop','grip','depart','show','hide'].includes(action))runtime?.suspend(8000);},
    destroy:()=>runtime?.destroy()});
  const descriptors=[...document.querySelectorAll('[data-lab-stage]')].map(element=>({id:element.id,element,type:element.dataset.labStage,targets:()=>[...element.querySelectorAll('h2,.lab-art b,summary')]}));
  runtime=CopoStageEngine.attach({motion,robot,size,viewport:motion.viewport,reduced:()=>matchMedia('(prefers-reduced-motion:reduce)').matches,stages:descriptors});
  let step=0;
  document.addEventListener('click',event=>{
    const action=event.target.closest('[data-lab-action]')?.dataset.labAction;if(!action)return;
    if(action==='draw')runtime.notify('lab-design',{type:'focus'});
    if(action==='next'){step=(step+1)%copy.steps.length;document.getElementById('lab-step').textContent=copy.steps[step];runtime.notify('lab-process',{type:'progress',target:document.querySelectorAll('.lab-process-art b')[step]});}
    if(action==='remove'){runtime.unregister('lab-help');document.getElementById('lab-help').remove();}
  });
  document.querySelector('#lab-help details').addEventListener('toggle',()=>{runtime.invalidate();runtime.notify('lab-help',{type:'expanded',target:document.querySelector('#lab-help summary')});});
  let mountedSize=size();addEventListener('resize',()=>{if(size()!==mountedSize){mountedSize=size();robot.destroy();robot.mount(visual,{size:mountedSize});robot.setVisible(motion.present&&!motion.hidden);}runtime.invalidate();});
  globalThis.CopoStageLab={engine:runtime,motion,robot};
})();
