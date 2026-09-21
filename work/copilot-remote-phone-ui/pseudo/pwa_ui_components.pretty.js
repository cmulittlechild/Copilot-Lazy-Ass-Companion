

// ---- uS ----
function uS({msg:e,onConfirm:t}){switch(e.role){
  case"user":return P.jsx(aS,{msg:e});
  case"agent":return P.jsx(sS,{msg:e});
  case"tool":return P.jsx(fS,{msg:e});
  case"confirm":return P.jsx(pS,{msg:e,onConfirm:t});
  case"system":return P.jsx(hS,{msg:e});
  case"typing":return P.jsx(dS,{});default:return null}}

// ---- aS ----
function aS({msg:e}){return P.jsx("div",{
  className:"flex justify-end animate-fade-in",children:P.jsx("div",{
  className:"max-w-[80%] bg-blue-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm leading-relaxed shadow-md whitespace-pre-wrap",children:e.text})})}

// ---- sS ----
function sS({msg:e}){return P.jsx("div",{
  className:"flex justify-start animate-fade-in",children:P.jsxs("div",{
  className:"max-w-[92%]",children:[P.jsxs("div",{
  className:"flex items-center gap-1.5 mb-1 ml-1",children:[P.jsx("span",{
  className:"w-2 h-2 rounded-full bg-emerald-400 "+(e.streaming?"animate-pulse-dot":"")}),P.jsx("span",{
  className:"text-[10px] text-slate-400 font-mono",children:"Copilot"}),e.streaming&&P.jsx("span",{
  className:"text-[10px] text-slate-500 font-mono",children:"typing…"})]}),P.jsx("div",{
  className:"bg-slate-800 text-slate-100 rounded-2xl rounded-tl-sm px-4 py-3 text-sm leading-relaxed shadow "+(e.streaming?"cursor-blink":""),children:e.text?P.jsx(cS,{text:e.text}):P.jsx("span",{
  className:"text-slate-500 italic",children:"thinking…"})})]})})}

// ---- cS ----
function cS({text:e}){return P.jsx(Kk,{remarkPlugins:[oS],components:{p:({children:e})=>P.jsx("p",{
  className:"mb-2 last:mb-0 leading-relaxed",children:e}),h1:({children:e})=>P.jsx("h1",{
  className:"text-base font-bold text-white mt-3 mb-1 first:mt-0",children:e}),h2:({children:e})=>P.jsx("h2",{
  className:"text-sm font-bold text-slate-100 mt-3 mb-1 first:mt-0",children:e}),h3:({children:e})=>P.jsx("h3",{
  className:"text-sm font-semibold text-slate-200 mt-2 mb-1 first:mt-0",children:e}),code:({children:e,className:t})=>{if(null==t?void 0:t.startsWith("language-")){const n=(null==t?void 0:t.replace("language-",""))??"";return P.jsxs("div",{
  className:"my-2 rounded-lg overflow-hidden",children:[n&&P.jsx("div",{
  className:"bg-slate-950 px-3 py-1 text-[10px] font-mono text-slate-400 border-b border-slate-700",children:n}),P.jsx("pre",{
  className:"bg-slate-950 px-3 py-2.5 overflow-x-auto",children:P.jsx("code",{
  className:"text-[12px] font-mono text-emerald-300 leading-relaxed whitespace-pre",children:e})})]})}return P.jsx("code",{
  className:"bg-slate-700 text-emerald-300 rounded px-1 py-0.5 text-[12px] font-mono",children:e})},pre:({children:e})=>P.jsx(P.Fragment,{children:e}),ul:({children:e})=>P.jsx("ul",{
  className:"list-disc list-outside ml-4 mb-2 space-y-0.5",children:e}),ol:({children:e})=>P.jsx("ol",{
  className:"list-decimal list-outside ml-4 mb-2 space-y-0.5",children:e}),li:({children:e})=>P.jsx("li",{
  className:"leading-relaxed",children:e}),strong:({children:e})=>P.jsx("strong",{
  className:"font-semibold text-white",children:e}),em:({children:e})=>P.jsx("em",{
  className:"italic text-slate-300",children:e}),blockquote:({children:e})=>P.jsx("blockquote",{
  className:"border-l-2 border-slate-500 pl-3 my-2 text-slate-400 italic",children:e}),hr:()=>P.jsx("hr",{
  className:"border-slate-600 my-3"}),a:({href:e,children:t})=>P.jsx("a",{href:e,target:"_blank",rel:"noopener noreferrer",
  className:"text-blue-400 underline underline-offset-2 hover:text-blue-300",children:t}),table:({children:e})=>P.jsx("div",{
  className:"overflow-x-auto my-2",children:P.jsx("table",{
  className:"text-xs border-collapse w-full",children:e})}),th:({children:e})=>P.jsx("th",{
  className:"border border-slate-600 bg-slate-700 px-2 py-1 text-left font-semibold text-slate-200",children:e}),td:({children:e})=>P.jsx("td",{
  className:"border border-slate-700 px-2 py-1 text-slate-300",children:e})},children:e})}

// ---- fS ----
function fS({msg:e}){return P.jsx("div",{
  className:"animate-fade-in",children:P.jsxs("details",{
  className:"bg-slate-900 border border-slate-700 rounded-xl overflow-hidden",children:[P.jsxs("summary",{
  className:"flex items-center gap-2 px-3 py-2 select-none hover:bg-slate-800 transition-colors cursor-pointer",children:[P.jsx("span",{
  className:"text-xs font-mono text-amber-400",children:"⚙"}),P.jsx("span",{
  className:"text-xs font-mono text-amber-300 flex-1 truncate",children:e.text}),P.jsx("span",{
  className:"text-[10px] px-1.5 py-0.5 rounded-full font-mono "+(e.isComplete?"bg-emerald-900 text-emerald-300":"bg-amber-900 text-amber-300 animate-pulse-dot"),children:e.isComplete?"done":"running"})]}),null!=e.input&&P.jsxs("div",{
  className:"px-3 pb-3 pt-1 text-[11px] font-mono text-slate-400 bg-slate-950 overflow-x-auto",children:[P.jsx("p",{
  className:"text-slate-500 mb-1",children:"Input:"}),P.jsx("pre",{
  className:"whitespace-pre-wrap break-all",children:JSON.stringify(e.input,null,2)})]}),null!=e.result&&P.jsxs("div",{
  className:"px-3 pb-3 text-[11px] font-mono text-slate-400 bg-slate-950 overflow-x-auto border-t border-slate-800",children:[P.jsx("p",{
  className:"text-slate-500 mb-1 pt-2",children:"Result:"}),P.jsx("pre",{
  className:"whitespace-pre-wrap break-all",children:String(e.result)})]})]})})}

// ---- pS ----
function pS({msg:e,onConfirm:t}){return e.buttons&&0!==e.buttons.length?P.jsxs("div",{
  className:"animate-fade-in bg-indigo-950 border border-indigo-700 rounded-xl px-4 py-3 space-y-3",children:[P.jsxs("div",{children:[P.jsx("p",{
  className:"text-xs font-semibold text-indigo-300 mb-1",children:e.title??"Confirm"}),P.jsx("p",{
  className:"text-sm text-slate-300 leading-relaxed",children:e.text})]}),P.jsx("div",{
  className:"flex flex-wrap gap-2",children:e.buttons.map(e=>P.jsx("button",{onClick:()=>null==t?void 0:t(e),
  className:"px-4 py-1.5 rounded-lg text-sm font-medium transition-all active:scale-95 "+(e.toLowerCase().includes("cancel")||e.toLowerCase().includes("no")?"bg-slate-700 text-slate-300 hover:bg-slate-600":"bg-indigo-600 text-white hover:bg-indigo-500 shadow-md"),children:e},e))})]}):P.jsxs("div",{
  className:"animate-fade-in bg-slate-900 border border-slate-700 rounded-xl px-4 py-2.5 opacity-70",children:[P.jsx("p",{
  className:"text-xs font-semibold text-slate-400 mb-0.5",children:e.title??"Confirm"}),P.jsx("p",{
  className:"text-xs text-emerald-400 font-mono",children:e.text||"Resolved in VS Code ✓"})]})}

// ---- dS ----
function dS(){return P.jsx("div",{
  className:"flex justify-start animate-fade-in",children:P.jsxs("div",{
  className:"max-w-[92%]",children:[P.jsxs("div",{
  className:"flex items-center gap-1.5 mb-1 ml-1",children:[P.jsx("span",{
  className:"w-2 h-2 rounded-full bg-emerald-400 animate-pulse-dot"}),P.jsx("span",{
  className:"text-[10px] text-slate-400 font-mono",children:"Copilot"}),P.jsx("span",{
  className:"text-[10px] text-slate-500 font-mono",children:"thinking…"})]}),P.jsx("div",{
  className:"bg-slate-800 rounded-2xl rounded-tl-sm px-4 py-3 shadow inline-flex items-center gap-1.5",children:[0,200,400].map(e=>P.jsx("span",{
  className:"w-2 h-2 rounded-full bg-slate-400 animate-typing-bounce",style:{animationDelay:`${e}ms`}},e))})]})})}

// ---- hS ----
function hS({msg:e}){return P.jsx("div",{
  className:"text-center animate-fade-in",children:P.jsx("span",{
  className:"text-[11px] text-slate-500 font-mono bg-slate-900 px-2 py-0.5 rounded-full",children:e.text})})}const mS=[{id:"agent",label:"Agent",color:"text-emerald-400"},{id:"ask",label:"Ask",color:"text-blue-400"},{id:"edit",label:"Edit",color:"text-purple-400"}];

// ---- gS ----
function gS({onSend:e,disabled:t,agents:n=[],agent:r="Auto",onAgentChange:l}