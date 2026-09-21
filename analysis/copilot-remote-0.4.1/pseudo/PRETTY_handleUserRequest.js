handleUserRequest(t){
const e=t?.requestId??""
;if(!e||this.seenRequestIds.has(e))return
;this.seenRequestIds.add(e)
;const r=t?.message?.text??t?.message?.value??t?.text??t?.prompt??t?.content??t?.value??""
;r&&!this.isInjectedEcho(r)&&(this.send({
type:"USER_MESSAGE",text:r
}
),this.ws.sendToPhone({
type:"COPILOT_TYPING"
}
))
}
