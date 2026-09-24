interface Work { run:()=>unknown; resolve:(value:unknown)=>void; reject:(error:unknown)=>void; deadline:number }
export class HostScheduler {
  private controls:Work[]=[];
  private executions:Work[]=[];
  private stopped=false;
  private consecutiveControls=0;
  run<T>(fn:()=>T, execution=false):Promise<T> {
    return new Promise<T>((resolve,reject)=>{
      if(this.stopped||this.controls.length+this.executions.length>=128) {reject(new Error('HOST_UNAVAILABLE'));return;}
      const item:Work={run:fn,resolve:resolve as (value:unknown)=>void,reject,deadline:performance.now()+2000};
      (execution?this.executions:this.controls).push(item);
    });
  }
  tick():void {
    const start=performance.now();
    for(let i=0;i<16&&performance.now()-start<2;i++) {
      const queue=this.controls.length && (this.consecutiveControls<8||!this.executions.length)?this.controls:this.executions;
      const item=queue.shift();if(!item) break;
      if(queue===this.controls) this.consecutiveControls++; else this.consecutiveControls=0;
      if(performance.now()>item.deadline){item.reject(new Error('HOST_UNAVAILABLE'));continue;}
      try {item.resolve(item.run());}catch(e){item.reject(e);}
    }
  }
  expire():void {
    for(const queue of [this.controls,this.executions]) for(let i=queue.length-1;i>=0;i--) if(queue[i]!.deadline<performance.now()) queue.splice(i,1)[0]!.reject(new Error('HOST_UNAVAILABLE'));
  }
  stop():void {this.stopped=true;for(const work of [...this.controls.splice(0),...this.executions.splice(0)])work.reject(new Error('HOST_UNAVAILABLE'));}
}
