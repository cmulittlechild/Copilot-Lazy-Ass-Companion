applyResponseMutation(t,e,r,n){
const i=this.respParts.get(t)??[]
;if("number"!=typeof n)return this.respParts.set(t,r.slice()),this.emitBlocks(t),void this.scheduleFinalize(e,!0)
;i.splice(n,0,...r),this.respParts.set(t,i),this.emitBlocks(t),this.scheduleFinalize(e,!0)
}
