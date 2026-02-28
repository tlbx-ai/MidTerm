using System.IO.Compression;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Ai.Tlbx.MidTerm.Models.WebPreview;
using Ai.Tlbx.MidTerm.Services;

namespace Ai.Tlbx.MidTerm.Services.WebPreview;

public sealed partial class WebPreviewProxyMiddleware
{
    private const string ProxyPrefix = "/webpreview";
    private const int WsBufferSize = 8192;
    private static readonly TimeSpan WsCloseTimeout = TimeSpan.FromSeconds(5);

    // Injected into proxied HTML to rewrite URLs in fetch/XHR/DOM at runtime.
    // Rewrites root-relative URLs to /webpreview/... and absolute external URLs
    // to /webpreview/_ext?u=... so all requests go through the MT proxy.
    // Patches: fetch, XHR, element .src/.href setters, setAttribute, window.open.
    private const string UrlRewriteScript = """
        <script>(function(){
          if(window.__mtProxy)return;window.__mtProxy=1;
          // Iframe cloaking: make the page think it's top-level
          try{Object.defineProperty(window,"top",{get:function(){return window},configurable:true});}catch(e){}
          try{Object.defineProperty(window,"parent",{get:function(){return window},configurable:true});}catch(e){}
          try{Object.defineProperty(window,"frameElement",{get:function(){return null},configurable:true});}catch(e){}
          var P="/webpreview",E=P+"/_ext?u=";
          // r(u): rewrite a URL to go through the proxy (add /webpreview prefix or _ext proxy)
          function r(u){
            if(typeof u!=="string")return u;
            if(u.startsWith("data:")||u.startsWith("blob:")||u.startsWith("about:")||u.startsWith("javascript:")||u.startsWith("#"))return u;
            if(!u.includes("://")&&!u.startsWith("/")&&!u.startsWith("//")){
              try{return r(new URL(u,document.baseURI).toString());}catch(e){}
            }
            if(u.startsWith("/")&&!u.startsWith(P+"/")&&!u.startsWith("//"))return P+u;
            if(u.startsWith("http://")||u.startsWith("https://")||u.startsWith("ws://")||u.startsWith("wss://")){
              try{var h=new URL(u);
                if(h.host===location.host&&!h.pathname.startsWith(P+"/"))return h.protocol+"//"+ h.host+P+h.pathname+h.search+h.hash;
                if(h.host!==location.host){
                  return E+encodeURIComponent(u);
                }
              }catch(e){}
            }
            return u;
          }
          // s(u): strip proxy prefix from a URL (inverse of r, for location spoofing)
          function s(u){
            if(typeof u!=="string")return u;
            try{var h=new URL(u);
              if(h.host===location.host&&h.pathname.startsWith(P+"/")){h.pathname=h.pathname.slice(P.length);return h.toString();}
              if(h.host===location.host&&h.pathname.startsWith(P)){h.pathname=h.pathname.slice(P.length)||"/";return h.toString();}
            }catch(e){}
            if(u.startsWith(P+"/"))return u.slice(P.length);
            if(u===P)return "/";
            return u;
          }
          // === Network APIs ===
          var F=window.fetch;
          window.fetch=function(u,o){
            if(typeof u==="string")return F.call(this,r(u),o);
            if(u&&typeof u==="object"&&u.url){try{return F.call(this,new Request(r(u.url),u),o);}catch(e){}}
            return F.call(this,u,o);
          };
          var X=XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=r(u);return X.apply(this,a);};
          if(navigator.sendBeacon){var sb=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){return sb(r(u),d);};}
          // === Element property setters ===
          // .src on elements that load resources
          ["HTMLScriptElement","HTMLImageElement","HTMLIFrameElement","HTMLSourceElement","HTMLEmbedElement","HTMLVideoElement","HTMLAudioElement"].forEach(function(n){
            var p=window[n]&&window[n].prototype;if(!p)return;
            var d=Object.getOwnPropertyDescriptor(p,"src");if(!d||!d.set)return;
            Object.defineProperty(p,"src",{set:function(v){d.set.call(this,r(v));},get:d.get,configurable:true,enumerable:true});
          });
          // .href on link elements (stylesheets, preloads)
          var ld=Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,"href");
          if(ld&&ld.set){Object.defineProperty(HTMLLinkElement.prototype,"href",{set:function(v){ld.set.call(this,r(v));},get:ld.get,configurable:true,enumerable:true});}
          // .href on anchor elements
          var ad=Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype,"href");
          if(ad&&ad.set){Object.defineProperty(HTMLAnchorElement.prototype,"href",{set:function(v){ad.set.call(this,r(v));},get:ad.get,configurable:true,enumerable:true});}
          // .action on form elements
          var fd=Object.getOwnPropertyDescriptor(HTMLFormElement.prototype,"action");
          if(fd&&fd.set){Object.defineProperty(HTMLFormElement.prototype,"action",{set:function(v){fd.set.call(this,r(v));},get:fd.get,configurable:true,enumerable:true});}
          // .data on object elements
          var od=Object.getOwnPropertyDescriptor(HTMLObjectElement.prototype,"data");
          if(od&&od.set){Object.defineProperty(HTMLObjectElement.prototype,"data",{set:function(v){od.set.call(this,r(v));},get:od.get,configurable:true,enumerable:true});}
          // srcset rewriting: each entry is "url descriptor, ..." — rewrite each URL
          function rss(v){
            if(typeof v!=="string")return v;
            return v.replace(/(^|,\s*)([^\s,]+)/g,function(m,pre,url){return pre+r(url);});
          }
          // .srcset on img/source elements
          ["HTMLImageElement","HTMLSourceElement"].forEach(function(n){
            var p=window[n]&&window[n].prototype;if(!p)return;
            var d=Object.getOwnPropertyDescriptor(p,"srcset");if(!d||!d.set)return;
            Object.defineProperty(p,"srcset",{set:function(v){d.set.call(this,rss(v));},get:d.get,configurable:true,enumerable:true});
          });
          // .poster on video elements
          var vpd=Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype,"poster");
          if(vpd&&vpd.set){Object.defineProperty(HTMLVideoElement.prototype,"poster",{set:function(v){vpd.set.call(this,r(v));},get:vpd.get,configurable:true,enumerable:true});}
          // setAttribute for src/href/action/poster/data/formaction/srcset
          var sa=Element.prototype.setAttribute;
          Element.prototype.setAttribute=function(n,v){
            if(typeof v==="string"){
              if(/^(src|href|action|poster|data|formaction)$/i.test(n))v=r(v);
              else if(/^srcset$/i.test(n))v=rss(v);
            }
            return sa.call(this,n,v);
          };
          // === Constructors ===
          var wo=window.open;
          window.open=function(u){var a=[].slice.call(arguments);if(typeof u==="string")a[0]=r(u);return wo.apply(this,a);};
          var OWS=window.WebSocket;
          if(OWS&&window.Proxy){
            try{window.WebSocket=new Proxy(OWS,{construct:function(t,a){if(a&&a.length>0)a[0]=r(a[0]);return Reflect.construct(t,a);}});}catch(e){}
          }
          var OES=window.EventSource;
          if(OES&&window.Proxy){
            try{window.EventSource=new Proxy(OES,{construct:function(t,a){if(a&&a.length>0)a[0]=r(a[0]);return Reflect.construct(t,a);}});}catch(e){}
          }
          var OA=window.Audio;
          if(OA){window.Audio=function(u){return new OA(r(u));};window.Audio.prototype=OA.prototype;}
          var OI=window.Image;
          if(OI){window.Image=function(w,h){return new OI(w,h);};window.Image.prototype=OI.prototype;}
          // Worker/SharedWorker constructors
          if(window.Worker){var OW=window.Worker;window.Worker=function(u,o){return new OW(r(u),o);};window.Worker.prototype=OW.prototype;}
          if(window.SharedWorker){var OSW=window.SharedWorker;window.SharedWorker=function(u,o){return new OSW(r(u),o);};window.SharedWorker.prototype=OSW.prototype;}
          // Service worker registration
          if(navigator.serviceWorker&&navigator.serviceWorker.register){
            var swr=navigator.serviceWorker.register.bind(navigator.serviceWorker);
            navigator.serviceWorker.register=function(u,o){return swr(r(u),o);};
          }
          // === Navigation APIs ===
          var hps=history.pushState.bind(history),hrs=history.replaceState.bind(history);
          history.pushState=function(s,t,u){return hps(s,t,u?r(u):u);};
          history.replaceState=function(s,t,u){return hrs(s,t,u?r(u):u);};
          var la=location.assign.bind(location),lr=location.replace.bind(location);
          location.assign=function(u){return la(r(u));};
          location.replace=function(u){return lr(r(u));};
          try{var ld2=Object.getOwnPropertyDescriptor(window.Location.prototype,"href")||Object.getOwnPropertyDescriptor(location,"href");
            if(ld2&&ld2.set){var lhs=ld2.set;Object.defineProperty(location,"href",{set:function(v){lhs.call(this,r(v));},get:function(){return s(ld2.get.call(this));},configurable:true,enumerable:true});}
          }catch(e){}
          // === Location spoofing: strip /webpreview from reads so apps see real paths ===
          try{
            var LP=window.Location.prototype;
            ["pathname","search","hash"].forEach(function(prop){
              var pd=Object.getOwnPropertyDescriptor(LP,prop);
              if(pd&&pd.get){Object.defineProperty(location,prop,{get:function(){
                var v=pd.get.call(this);
                if(prop==="pathname"&&v.startsWith(P+"/"))return v.slice(P.length);
                if(prop==="pathname"&&v===P)return "/";
                return v;
              },set:pd.set?function(v){pd.set.call(this,v);}:undefined,configurable:true,enumerable:true});}
            });
            var tsd=Object.getOwnPropertyDescriptor(LP,"toString")||{value:location.toString};
            location.toString=function(){return s(tsd.value?tsd.value.call(location):LP.toString.call(location));};
          }catch(e){}
          // Spoof document.URL/documentURI/baseURI/referrer to hide proxy prefix
          try{
            var duRL=Object.getOwnPropertyDescriptor(Document.prototype,"URL");
            if(duRL&&duRL.get){Object.defineProperty(document,"URL",{get:function(){return s(duRL.get.call(this));},configurable:true,enumerable:true});}
            var ddURI=Object.getOwnPropertyDescriptor(Document.prototype,"documentURI");
            if(ddURI&&ddURI.get){Object.defineProperty(document,"documentURI",{get:function(){return s(ddURI.get.call(this));},configurable:true,enumerable:true});}
            var dRef=Object.getOwnPropertyDescriptor(Document.prototype,"referrer");
            if(dRef&&dRef.get){Object.defineProperty(document,"referrer",{get:function(){return s(dRef.get.call(this));},configurable:true,enumerable:true});}
            // document.baseURI — React Router, Vue Router, Angular all read this
            var dbU=Object.getOwnPropertyDescriptor(Document.prototype,"baseURI")||Object.getOwnPropertyDescriptor(Node.prototype,"baseURI");
            if(dbU&&dbU.get){Object.defineProperty(document,"baseURI",{get:function(){return s(dbU.get.call(this));},configurable:true,enumerable:true});}
          }catch(e){}
          // Spoof HTMLBaseElement.href getter — Angular reads base[href] element
          try{
            var bhd=Object.getOwnPropertyDescriptor(HTMLBaseElement.prototype,"href");
            if(bhd&&bhd.get){Object.defineProperty(HTMLBaseElement.prototype,"href",{get:function(){return s(bhd.get.call(this));},set:bhd.set,configurable:true,enumerable:true});}
          }catch(e){}
          // === Cookie bridge ===
          var C=P+"/_cookies",cc="";
          function rc(){return fetch(C,{credentials:"same-origin"}).then(function(x){return x.ok?x.json():null;}).then(function(j){cc=j&&j.header?j.header:"";}).catch(function(){});}
          rc();
          try{
            var d=Object.getOwnPropertyDescriptor(Document.prototype,"cookie")||Object.getOwnPropertyDescriptor(HTMLDocument.prototype,"cookie");
            if(d&&d.configurable){
              Object.defineProperty(document,"cookie",{configurable:true,get:function(){return cc;},set:function(v){
                if(typeof v!=="string")return;
                var n=v.split(";")[0]||"";if(n){var i=n.indexOf("="),k=i>0?n.slice(0,i).trim():"";if(k){var p=cc?cc.split(/;\s*/):[];var nx=[];for(var z=0;z<p.length;z++){if(!p[z].startsWith(k+"="))nx.push(p[z]);}nx.push(n.trim());cc=nx.join("; ");}}
                fetch(C,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({raw:v})}).then(rc).catch(function(){});
              }});
            }
          }catch(e){}
          // === MutationObserver: catch dynamically added elements ===
          function rewriteEl(el){
            if(!el.getAttribute)return;
            ["src","href","action","data","formaction","poster"].forEach(function(attr){
              var v=el.getAttribute(attr);
              if(v){var rv=r(v);if(rv!==v)sa.call(el,attr,rv);}
            });
            var ss=el.getAttribute("srcset");
            if(ss){var rv=rss(ss);if(rv!==ss)sa.call(el,"srcset",rv);}
            // <meta http-equiv="refresh" content="0;url=/path"> — PHP redirect pattern
            if(el.tagName==="META"&&/^refresh$/i.test(el.getAttribute("http-equiv")||"")){
              var ct=el.getAttribute("content")||"";
              var rm=ct.match(/^(\d+\s*;\s*url\s*=\s*)(.+)$/i);
              if(rm){var ru=r(rm[2].trim());sa.call(el,"content",rm[1]+ru);}
            }
          }
          new MutationObserver(function(muts){
            for(var i=0;i<muts.length;i++){
              var nodes=muts[i].addedNodes;
              for(var j=0;j<nodes.length;j++){
                var n=nodes[j];if(n.nodeType!==1)continue;
                rewriteEl(n);
                if(n.querySelectorAll){
                  var els=n.querySelectorAll("[src],[href],[action],[data],[formaction],[poster],[srcset],meta[http-equiv]");
                  for(var k=0;k<els.length;k++)rewriteEl(els[k]);
                }
              }
            }
          }).observe(document.documentElement,{childList:true,subtree:true});
          // Browser command channel: WebSocket to /ws/browser for agent-driven interaction
          var bws,bwsReady=false;
          function truncDom(el,d,mx){
            if(d>=mx)return"<!-- ... -->";
            var t=el.cloneNode(false);
            if(el.childNodes)for(var i=0;i<el.childNodes.length;i++){
              var c=el.childNodes[i];
              if(c.nodeType===1)t.appendChild(truncDom(c,d+1,mx).content?truncDom(c,d+1,mx):document.createRange().createContextualFragment(truncDom(c,d+1,mx)));
              else if(c.nodeType===3)t.appendChild(c.cloneNode(false));
            }
            return t.outerHTML||t.textContent||"";
          }
          function truncEl(el,mx){
            if(!mx||mx<1)return el.outerHTML;
            var clone=el.cloneNode(true);
            function trim(n,d){if(d>=mx){n.innerHTML="<!-- ... -->";return;}
              for(var i=0;i<n.children.length;i++)trim(n.children[i],d+1);
            }
            trim(clone,0);return clone.outerHTML;
          }
          function handleBCmd(msg){
            var res={id:msg.id,success:true,result:null,error:null,matchCount:null};
            try{
              switch(msg.command){
                case"query":{
                  if(!msg.selector){res.success=false;res.error="selector required";break;}
                  var els=document.querySelectorAll(msg.selector);
                  res.matchCount=els.length;
                  var parts=[];var mx=msg.maxDepth||0;
                  for(var i=0;i<els.length&&i<50;i++){
                    parts.push(msg.textOnly?els[i].textContent:mx>0?truncEl(els[i],mx):els[i].outerHTML);
                  }
                  res.result=parts.join("\n---\n");
                  break;}
                case"click":{
                  if(!msg.selector){res.success=false;res.error="selector required";break;}
                  var el=document.querySelector(msg.selector);
                  if(!el){res.success=false;res.error="element not found: "+msg.selector;break;}
                  el.click();res.result="clicked";
                  break;}
                case"fill":{
                  if(!msg.selector){res.success=false;res.error="selector required";break;}
                  var el=document.querySelector(msg.selector);
                  if(!el){res.success=false;res.error="element not found: "+msg.selector;break;}
                  var nv=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value");
                  if(nv&&nv.set)nv.set.call(el,msg.value||"");
                  else el.value=msg.value||"";
                  el.dispatchEvent(new Event("input",{bubbles:true}));
                  el.dispatchEvent(new Event("change",{bubbles:true}));
                  res.result="filled";
                  break;}
                case"exec":{
                  if(!msg.value){res.success=false;res.error="js code required";break;}
                  var rv=eval(msg.value);
                  res.result=rv===undefined?"undefined":String(rv);
                  break;}
                case"wait":{
                  if(!msg.selector){res.success=false;res.error="selector required";break;}
                  var to=(msg.timeout||5)*1000,start=Date.now();
                  (function poll(){
                    var found=document.querySelector(msg.selector);
                    if(found){res.result="found";res.matchCount=document.querySelectorAll(msg.selector).length;bws.send(JSON.stringify(res));}
                    else if(Date.now()-start>to){res.success=false;res.error="timeout waiting for: "+msg.selector;bws.send(JSON.stringify(res));}
                    else setTimeout(poll,200);
                  })();return;}
                case"screenshot":{
                  var scr=document.createElement("script");
                  scr.src="/js/html2canvas.min.js";
                  scr.onload=function(){
                    html2canvas(document.documentElement,{useCORS:true,logging:false,scale:1}).then(function(canvas){
                      res.result=canvas.toDataURL("image/png");bws.send(JSON.stringify(res));
                    }).catch(function(e){res.success=false;res.error="screenshot failed: "+e.message;bws.send(JSON.stringify(res));});
                  };
                  scr.onerror=function(){res.success=false;res.error="failed to load html2canvas";bws.send(JSON.stringify(res));};
                  document.head.appendChild(scr);return;}
                case"snapshot":{
                  res.result=document.documentElement.outerHTML;
                  break;}
                case"navigate":{
                  if(!msg.value){res.success=false;res.error="url required";break;}
                  location.href=msg.value;res.result="navigating";
                  break;}
                case"reload":{
                  location.reload();res.result="reloading";
                  break;}
                case"outline":{
                  var mx=msg.maxDepth||4;
                  function ol(el,d,ind){
                    if(d>=mx)return"";
                    var tag=el.tagName.toLowerCase();
                    var id=el.id?"#"+el.id:"";
                    var cls=el.className&&typeof el.className==="string"?"."+el.className.trim().split(/\s+/).join("."):"";
                    var line=ind+tag+id+cls;
                    var ch=[].slice.call(el.children);
                    var lines=[line];var ci=0;
                    while(ci<ch.length){
                      var ce=ch[ci];var cnt=1;
                      while(ci+cnt<ch.length&&ch[ci+cnt].tagName===ce.tagName&&(ch[ci+cnt].className||"")===(ce.className||""))cnt++;
                      if(cnt>2&&!ce.id){
                        lines.push(ind+"  "+ce.tagName.toLowerCase()+(ce.className&&typeof ce.className==="string"?"."+ce.className.trim().split(/\s+/).join("."):"")+" x"+cnt);
                        ci+=cnt;
                      }else{lines.push(ol(ce,d+1,ind+"  "));ci++;}
                    }
                    return lines.filter(Boolean).join("\n");
                  }
                  res.result=ol(document.documentElement,0,"");
                  break;}
                case"attrs":{
                  if(!msg.selector){res.success=false;res.error="selector required";break;}
                  var els=document.querySelectorAll(msg.selector);
                  res.matchCount=els.length;
                  var parts=[];
                  for(var i=0;i<els.length&&i<30;i++){
                    var ae=els[i].cloneNode(false);ae.innerHTML="";
                    parts.push(ae.outerHTML.replace("></"+ae.tagName.toLowerCase()+">",">"));
                  }
                  res.result=parts.join("\n---\n");
                  break;}
                case"css":{
                  if(!msg.selector){res.success=false;res.error="selector required";break;}
                  if(!msg.value){res.success=false;res.error="css properties required (comma-separated)";break;}
                  var props=msg.value.split(",").map(function(p){return p.trim();});
                  var els=document.querySelectorAll(msg.selector);
                  res.matchCount=els.length;
                  var parts=[];
                  for(var i=0;i<els.length&&i<20;i++){
                    var cs=getComputedStyle(els[i]);
                    var lines=[msg.selector+" ("+(i+1)+" of "+els.length+")"];
                    for(var j=0;j<props.length;j++)lines.push("  "+props[j]+": "+cs.getPropertyValue(props[j]));
                    parts.push(lines.join("\n"));
                  }
                  res.result=parts.join("\n---\n");
                  break;}
                case"log":{
                  if(!window.__mtLog){
                    window.__mtLog=[];
                    var orig={log:console.log,warn:console.warn,error:console.error};
                    ["error","warn","log"].forEach(function(lvl){
                      console[lvl]=function(){
                        var a=[].slice.call(arguments).map(function(x){try{return typeof x==="object"?JSON.stringify(x):String(x);}catch(e){return String(x);}}).join(" ");
                        window.__mtLog.push({l:lvl,m:a,t:Date.now()});
                        if(window.__mtLog.length>50)window.__mtLog.shift();
                        orig[lvl].apply(console,arguments);
                      };
                    });
                    window.addEventListener("error",function(ev){
                      window.__mtLog.push({l:"error",m:ev.message+" ("+(ev.filename||"")+":"+(ev.lineno||0)+")",t:Date.now()});
                      if(window.__mtLog.length>50)window.__mtLog.shift();
                    });
                  }
                  var flt=msg.value||"all";
                  var ent=window.__mtLog.filter(function(e){return flt==="all"||e.l===flt;});
                  res.result=ent.length?ent.map(function(e){return"["+e.l+"] "+e.m;}).join("\n"):"(no entries)";
                  res.matchCount=ent.length;
                  break;}
                case"links":{
                  var anchors=document.querySelectorAll("a[href]");
                  var seen={},parts=[];
                  for(var i=0;i<anchors.length;i++){
                    var href=anchors[i].getAttribute("href");
                    if(!href||href==="#"||seen[href])continue;
                    seen[href]=1;
                    var txt=(anchors[i].textContent||"").trim().substring(0,80);
                    parts.push(href+" > "+txt);
                  }
                  parts.sort();
                  res.result=parts.join("\n");
                  res.matchCount=parts.length;
                  break;}
                case"forms":{
                  var fsel=msg.selector||"form";
                  var forms=document.querySelectorAll(fsel);
                  res.matchCount=forms.length;
                  var parts=[];
                  for(var i=0;i<forms.length;i++){
                    var f=forms[i];
                    var ftag=f.tagName.toLowerCase();
                    var fid=f.id?"#"+f.id:"";
                    var fhdr=ftag+fid;
                    if(f.action)fhdr+=" (action="+f.getAttribute("action")+", method="+(f.method||"GET").toUpperCase()+")";
                    var flines=[fhdr];
                    var inputs=f.querySelectorAll("input,select,textarea,button");
                    for(var j=0;j<inputs.length;j++){
                      var inp=inputs[j];
                      var it=inp.tagName.toLowerCase();
                      var iname=inp.name?"[name="+inp.name+"]":"";
                      var itp=inp.type?" type="+inp.type:"";
                      var ireq=inp.required?" required":"";
                      var ival=it==="select"?" value=\""+(inp.options[inp.selectedIndex]||{}).text+"\"":
                               it==="button"?" \""+(inp.textContent||"").trim()+"\"":
                               " value=\""+((inp.type==="password"?"***":inp.value)||"")+"\"";
                      var ilbl="";
                      if(inp.id){var le=f.querySelector("label[for="+inp.id+"]");if(le)ilbl=" label=\""+le.textContent.trim()+"\"";}
                      if(!ilbl&&inp.closest&&inp.closest("label"))ilbl=" label=\""+inp.closest("label").textContent.trim()+"\"";
                      flines.push("  "+it+iname+itp+ireq+ival+ilbl);
                    }
                    parts.push(flines.join("\n"));
                  }
                  res.result=parts.join("\n---\n");
                  break;}
                default:res.success=false;res.error="unknown command: "+msg.command;
              }
            }catch(e){res.success=false;res.error=e.message||String(e);}
            bws.send(JSON.stringify(res));
          }
          function connectBws(){
            try{
              var proto=location.protocol==="https:"?"wss:":"ws:";
              bws=new OWS(proto+"//"+location.host+"/ws/browser");
              bws.onopen=function(){bwsReady=true;};
              bws.onmessage=function(e){try{handleBCmd(JSON.parse(e.data));}catch(ex){}};
              bws.onclose=function(){bwsReady=false;setTimeout(connectBws,3000);};
              bws.onerror=function(){};
            }catch(e){}
          }
          setTimeout(connectBws,500);
        })();</script>
        """;


    private static readonly HashSet<string> HopByHopHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
        "TE", "Trailer", "Transfer-Encoding", "Upgrade"
    };

    private static readonly HashSet<string> StrippedResponseHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "Content-Security-Policy", "Content-Security-Policy-Report-Only",
        "X-Frame-Options", "Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy",
        "Cross-Origin-Resource-Policy",
        "Set-Cookie"  // Cookies managed by server-side cookie jar, not forwarded to browser
    };

    // Headers that must NOT be forwarded from browser to upstream.
    // Everything else is forwarded (blocklist approach for maximum compatibility).
    private static readonly HashSet<string> BlockedRequestHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        // Hop-by-hop (also in HopByHopHeaders, but listed for completeness)
        "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
        "TE", "Trailer", "Transfer-Encoding", "Upgrade",
        // Host is set by HttpClient from the request URI
        "Host",
        // Browser cookies are MT session cookies — upstream cookies come from CookieContainer
        "Cookie",
        // WebSocket negotiation headers managed by ClientWebSocket
        "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Sec-WebSocket-Extensions",
        "Sec-WebSocket-Protocol",
        // Browser security headers that would confuse the upstream
        "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User",
        // Content headers are set on HttpContent, not the request
        "Content-Type", "Content-Length"
    };

    private readonly RequestDelegate _next;
    private readonly WebPreviewService _service;

    // Learned path prefixes where subpath-prefixed requests returned 404 but server-root
    // succeeded. Keyed by prefix (e.g. "/_framework/"), value is true = prefer root.
    // Reset when the target URL changes.
    private readonly Dictionary<string, bool> _rootFallbackPrefixes = new(StringComparer.OrdinalIgnoreCase);
    private string? _rootFallbackTarget;

    public WebPreviewProxyMiddleware(RequestDelegate next, WebPreviewService service)
    {
        _next = next;
        _service = service;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path;

        if (path.StartsWithSegments(ProxyPrefix, out var remaining))
        {
            // External URL proxy: /webpreview/_ext?u=https%3A%2F%2Fexample.com%2Fscript.js
            var remainingPath = remaining.Value ?? "";
            if (remainingPath.StartsWith("/_ext", StringComparison.Ordinal))
            {
                if (context.WebSockets.IsWebSocketRequest)
                {
                    await ProxyExternalWebSocketAsync(context);
                }
                else
                {
                    await ProxyExternalAsync(context);
                }
                return;
            }
            if (remainingPath.Equals("/_cookies", StringComparison.Ordinal))
            {
                await HandleCookieBridgeAsync(context);
                return;
            }

            var targetUri = _service.TargetUri;
            if (targetUri is null)
            {
                context.Response.StatusCode = 502;
                context.Response.ContentType = "text/plain";
                await context.Response.WriteAsync("No web preview target configured.");
                return;
            }

            if (context.WebSockets.IsWebSocketRequest)
            {
                await ProxyWebSocketAsync(context, targetUri, remaining.Value ?? "/");
            }
            else
            {
                await ProxyHttpAsync(context, targetUri, remaining.Value ?? "/");
            }

            return;
        }

        // Catch-all: if web preview is active and this isn't a known MidTerm path,
        // it's likely a leaked root-relative URL from the proxied site (e.g. /s/player/...,
        // /youtubei/v1/...). Proxy it to the upstream target directly.
        if (_service.IsActive && !IsMidTermPath(path.Value ?? "/"))
        {
            var targetUri = _service.TargetUri!;
            var proxyPath = path.Value ?? "/";
            if (context.WebSockets.IsWebSocketRequest)
            {
                await ProxyWebSocketAsync(context, targetUri, proxyPath);
            }
            else
            {
                await ProxyHttpAsync(context, targetUri, proxyPath);
            }

            return;
        }

        await _next(context);
    }

    /// <summary>
    /// Returns true if the path belongs to MidTerm itself (API, WebSocket, static files).
    /// Paths that don't match are candidates for proxying to the web preview target.
    /// </summary>
    private static bool IsMidTermPath(string path)
    {
        // Known MidTerm path prefixes
        if (path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/ws/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/js/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/css/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/fonts/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/locales/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/img/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("/favicon/", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        // Root-level MidTerm files
        return path is "/"
            or "/index.html"
            or "/login.html"
            or "/trust.html"
            or "/web-preview-popup.html"
            or "/favicon.ico"
            or "/site.webmanifest"
            or "/THIRD-PARTY-LICENSES.txt"
            or "/midFont-style.css";
    }

    private async Task ProxyHttpAsync(HttpContext context, Uri targetUri, string path)
    {
        var upstreamOrigin = $"{targetUri.Scheme}://{targetUri.Authority}";
        var targetBase = targetUri.AbsolutePath.TrimEnd('/');
        var hasSubpath = !string.IsNullOrEmpty(targetBase) && targetBase != "/";

        // Determine primary URL (may use root fallback if previously learned)
        var primaryPath = BuildUpstreamPath(targetUri, path);
        var useRootFirst = hasSubpath && ShouldTryRootFirst(path, targetBase);
        if (useRootFirst)
        {
            primaryPath = string.IsNullOrEmpty(path) || path == "/" ? "/" : path;
            if (!primaryPath.StartsWith('/'))
                primaryPath = "/" + primaryPath;
        }

        var currentUrl = BuildUpstreamUrlFromPath(targetUri, primaryPath, context.Request.QueryString.Value);

        var originalMethod = new HttpMethod(context.Request.Method);
        byte[]? requestBodyBuffer = null;
        var requestHasBody = context.Request.ContentLength > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding");
        if (requestHasBody && originalMethod != HttpMethod.Get && originalMethod != HttpMethod.Head)
        {
            await using var bodyCopy = new MemoryStream();
            await context.Request.Body.CopyToAsync(bodyCopy, context.RequestAborted);
            requestBodyBuffer = bodyCopy.ToArray();
        }

        HttpRequestMessage BuildRequest(HttpMethod method, string url)
        {
            var msg = new HttpRequestMessage(method, url);
            ForwardRequestHeaders(context.Request, msg, upstreamOrigin);
            msg.Headers.TryAddWithoutValidation("X-Forwarded-For",
                context.Connection.RemoteIpAddress?.ToString() ?? "127.0.0.1");
            msg.Headers.TryAddWithoutValidation("X-Forwarded-Proto", "https");
            msg.Headers.TryAddWithoutValidation("X-Forwarded-Host", context.Request.Host.ToString());
            AttachRequestBody(msg, method, requestBodyBuffer, context.Request.ContentType, context.Request.ContentLength);
            return msg;
        }

        var (upstreamResponse, errorCode, finalUrl) = await SendUpstreamAsync(
            context, originalMethod, currentUrl, BuildRequest, context.RequestAborted);

        // Retry-on-404: if we got 404 and the target has a subpath, try the alternate path.
        // If we tried subpath-prefixed first, retry at server root. If we tried root first
        // (from learned cache), retry with subpath-prefixed.
        if (hasSubpath
            && upstreamResponse is not null
            && upstreamResponse.StatusCode == System.Net.HttpStatusCode.NotFound
            && !PathAlreadyUnderTarget(path, targetBase))
        {
            var fallbackPath = useRootFirst
                ? BuildUpstreamPath(targetUri, path)
                : (string.IsNullOrEmpty(path) || path == "/" ? "/" : (path.StartsWith('/') ? path : "/" + path));

            if (fallbackPath != primaryPath)
            {
                var fallbackUrl = BuildUpstreamUrlFromPath(targetUri, fallbackPath, context.Request.QueryString.Value);
                var (fallbackResponse, fallbackError, fallbackFinalUrl) = await SendUpstreamAsync(
                    context, originalMethod, fallbackUrl, BuildRequest, context.RequestAborted);

                if (fallbackResponse is not null
                    && fallbackResponse.StatusCode != System.Net.HttpStatusCode.NotFound)
                {
                    upstreamResponse.Dispose();
                    upstreamResponse = fallbackResponse;
                    errorCode = fallbackError;
                    finalUrl = fallbackFinalUrl;

                    // Learn: if root worked, remember this prefix for future requests
                    if (!useRootFirst)
                    {
                        LearnRootFallback(path, targetUri.ToString());
                    }
                }
                else
                {
                    fallbackResponse?.Dispose();
                    // Learn: if subpath worked from root-first attempt, un-learn
                    if (useRootFirst && fallbackResponse?.StatusCode != System.Net.HttpStatusCode.NotFound)
                    {
                        UnlearnRootFallback(path);
                    }
                }
            }
        }

        _service.PersistCookies();

        if (upstreamResponse is null)
        {
            context.Response.StatusCode = errorCode;
            if (errorCode == 502)
            {
                context.Response.ContentType = "text/plain";
                await context.Response.WriteAsync("Failed to connect to upstream server.");
            }
            else if (errorCode == 504)
            {
                context.Response.ContentType = "text/plain";
                await context.Response.WriteAsync("Upstream server timed out.");
            }
            return;
        }

        using (upstreamResponse)
        {
            context.Response.StatusCode = (int)upstreamResponse.StatusCode;
            CopyResponseHeaders(upstreamResponse, context.Response);
            await DispatchResponseBodyAsync(context, upstreamResponse, finalUrl);
        }
    }

    private async Task ProxyHtmlResponseAsync(HttpContext context, HttpResponseMessage upstreamResponse, string? finalUrl)
    {
        var html = await DecompressTextAsync(upstreamResponse, context.RequestAborted);

        // Rewrite root-relative URLs to go through the proxy.
        // <base href> only handles truly relative URLs (foo/bar.js),
        // but root-relative URLs (/path/to/file) need explicit rewriting.
        html = RootRelativeAttrRegex().Replace(html, "$1/webpreview/");
        html = RootRelativeSrcsetRegex().Replace(html, "$1/webpreview/");
        html = RootRelativeCssUrlRegex().Replace(html, "url(/webpreview/");

        // Rewrite <meta http-equiv="refresh" content="0;url=/path"> URLs (PHP redirect pattern)
        html = MetaRefreshRegex().Replace(html, m =>
        {
            var prefix = m.Groups[1].Value;
            var url = m.Groups[2].Value;
            if (url.StartsWith('/') && !url.StartsWith("/webpreview/"))
                return prefix + "/webpreview" + url;
            return m.Value;
        });

        // Rewrite absolute external URLs (https://cdn.example.com/...) to go through _ext proxy.
        // This allows MT to fetch third-party resources server-side, bypassing CORS/ad blockers.
        var targetHost = _service.TargetUri?.Host;
        html = AbsoluteUrlAttrRegex().Replace(html, m => RewriteExternalUrl(m, targetHost));
        html = AbsoluteUrlCssRegex().Replace(html, m => RewriteExternalCssUrl(m, targetHost));

        // Extract the original <base href> value before removing — Blazor and other
        // frameworks rely on precise base URI (e.g., <base href="/kicoach/">).
        // Recomputing from the final URL loses trailing-slash semantics when the server
        // doesn't redirect /path → /path/.
        string? originalBaseHref = null;
        var baseMatch = BaseHrefValueRegex().Match(html);
        if (baseMatch.Success)
        {
            originalBaseHref = baseMatch.Groups[1].Value;
        }

        // Remove any existing <base> tags to avoid duplicates — we inject our own
        html = ExistingBaseTagRegex().Replace(html, "");

        // Strip upstream CSP and X-Frame-Options meta tags — after proxying, 'self' in those
        // directives would resolve to MidTerm's origin instead of the upstream site's origin,
        // causing the proxied page to block framing of external resources.
        html = UpstreamSecurityMetaTagRegex().Replace(html, "");

        // Build proxy-prefixed base href. Trust the upstream's <base href> value — it knows
        // how its assets are served (root vs subpath). Just prefix with /webpreview.
        string baseHref;
        if (originalBaseHref is not null)
        {
            var basePath = originalBaseHref.TrimEnd('/');
            if (basePath.Length == 0 || basePath == "/")
                baseHref = "/webpreview/";
            else
                baseHref = "/webpreview" + (basePath.StartsWith('/') ? basePath : "/" + basePath) + "/";
        }
        else
        {
            baseHref = ComputeBaseHref(finalUrl);
        }

        // Inject <base href> for truly relative URLs, plus a script that patches
        // fetch/XHR to rewrite root-relative URLs at runtime (safer than regex on JS source).
        html = HeadTagRegex().Replace(html, $"$0<base href=\"{baseHref}\">" + UrlRewriteScript, 1);

        // Send uncompressed — strip Content-Encoding and Content-Length for this response
        context.Response.Headers.Remove("Content-Length");
        context.Response.Headers.Remove("Content-Encoding");
        context.Response.ContentType = "text/html; charset=utf-8";
        await context.Response.WriteAsync(html, context.RequestAborted);
    }

    private static string ComputeBaseHref(string? finalUrl)
    {
        if (finalUrl is null || !Uri.TryCreate(finalUrl, UriKind.Absolute, out var finalUri))
            return "/webpreview/";

        var path = finalUri.AbsolutePath;
        var lastSlash = path.LastIndexOf('/');
        var directory = lastSlash > 0 ? path[..(lastSlash + 1)] : "/";
        return "/webpreview" + directory;
    }

    private async Task ProxyCssResponseAsync(HttpContext context, HttpResponseMessage upstreamResponse)
    {
        var css = await DecompressTextAsync(upstreamResponse, context.RequestAborted);

        // Rewrite url(/...) references in CSS to go through the proxy
        css = RootRelativeCssUrlRegex().Replace(css, "url(/webpreview/");

        // Rewrite absolute external url() references
        css = AbsoluteUrlCssRegex().Replace(css, m => RewriteExternalCssUrl(m, null));

        context.Response.Headers.Remove("Content-Length");
        context.Response.Headers.Remove("Content-Encoding");
        context.Response.ContentType = "text/css; charset=utf-8";
        await context.Response.WriteAsync(css, context.RequestAborted);
    }

    private async Task ProxyExternalAsync(HttpContext context)
    {
        var externalUrl = context.Request.Query["u"].FirstOrDefault();
        if (string.IsNullOrEmpty(externalUrl) || !Uri.TryCreate(externalUrl, UriKind.Absolute, out var extUri))
        {
            context.Response.StatusCode = 400;
            context.Response.ContentType = "text/plain";
            await context.Response.WriteAsync("Missing or invalid 'u' parameter.");
            return;
        }

        if (extUri.Scheme is not ("http" or "https"))
        {
            context.Response.StatusCode = 400;
            return;
        }

        var currentUrl = extUri.ToString();
        var originalMethod = new HttpMethod(context.Request.Method);

        byte[]? requestBodyBuffer = null;
        var requestHasBody = context.Request.ContentLength > 0 || context.Request.Headers.ContainsKey("Transfer-Encoding");
        if (requestHasBody && originalMethod != HttpMethod.Get && originalMethod != HttpMethod.Head)
        {
            await using var bodyCopy = new MemoryStream();
            await context.Request.Body.CopyToAsync(bodyCopy, context.RequestAborted);
            requestBodyBuffer = bodyCopy.ToArray();
        }

        HttpRequestMessage BuildRequest(HttpMethod method, string url)
        {
            var requestUri = new Uri(url);
            var upstreamOrigin = $"{requestUri.Scheme}://{requestUri.Authority}";
            var msg = new HttpRequestMessage(method, url);
            ForwardRequestHeaders(context.Request, msg, upstreamOrigin);
            AttachRequestBody(msg, method, requestBodyBuffer, context.Request.ContentType, null);
            return msg;
        }

        var (upstreamResponse, errorCode, finalUrl) = await SendUpstreamAsync(
            context, originalMethod, currentUrl, BuildRequest, context.RequestAborted);

        _service.PersistCookies();

        if (upstreamResponse is null)
        {
            context.Response.StatusCode = errorCode;
            return;
        }

        using (upstreamResponse)
        {
            context.Response.StatusCode = (int)upstreamResponse.StatusCode;
            CopyResponseHeaders(upstreamResponse, context.Response);
            await DispatchResponseBodyAsync(context, upstreamResponse, finalUrl);
        }
    }

    private static void ForwardRequestHeaders(
        HttpRequest source, HttpRequestMessage target, string upstreamOrigin)
    {
        foreach (var header in source.Headers)
        {
            if (BlockedRequestHeaders.Contains(header.Key))
                continue;

            if (header.Key.Equals("Origin", StringComparison.OrdinalIgnoreCase))
            {
                target.Headers.TryAddWithoutValidation(header.Key, upstreamOrigin);
                continue;
            }
            if (header.Key.Equals("Referer", StringComparison.OrdinalIgnoreCase))
            {
                var refValue = header.Value.ToString();
                if (Uri.TryCreate(refValue, UriKind.Absolute, out var refUri))
                {
                    refValue = upstreamOrigin + refUri.PathAndQuery
                        .Replace("/webpreview/", "/").Replace("/webpreview", "/");
                }
                target.Headers.TryAddWithoutValidation(header.Key, refValue);
                continue;
            }

            target.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
        }
    }

    private static void AttachRequestBody(
        HttpRequestMessage request, HttpMethod method,
        byte[]? bodyBuffer, string? contentType, long? contentLength)
    {
        if (bodyBuffer is null || method == HttpMethod.Get || method == HttpMethod.Head)
            return;

        request.Content = new ByteArrayContent(bodyBuffer);
        if (contentType is not null)
        {
            request.Content.Headers.ContentType =
                System.Net.Http.Headers.MediaTypeHeaderValue.Parse(contentType);
        }
        if (contentLength is > 0)
        {
            request.Content.Headers.ContentLength = bodyBuffer.Length;
        }
    }

    private static void CopyResponseHeaders(HttpResponseMessage upstream, HttpResponse downstream)
    {
        foreach (var header in upstream.Headers)
        {
            if (HopByHopHeaders.Contains(header.Key) || StrippedResponseHeaders.Contains(header.Key))
                continue;
            if (header.Key.Equals("Location", StringComparison.OrdinalIgnoreCase))
                continue;
            downstream.Headers[header.Key] = header.Value.ToArray();
        }

        foreach (var header in upstream.Content.Headers)
        {
            if (StrippedResponseHeaders.Contains(header.Key))
                continue;
            downstream.Headers[header.Key] = header.Value.ToArray();
        }
    }

    private async Task<(HttpResponseMessage? Response, int ErrorCode, string? FinalUrl)> SendUpstreamAsync(
        HttpContext context,
        HttpMethod originalMethod,
        string startUrl,
        Func<HttpMethod, string, HttpRequestMessage> buildRequest,
        CancellationToken cancellationToken)
    {
        const int maxRedirects = 10;
        var currentUrl = startUrl;
        var currentMethod = originalMethod;
        HttpResponseMessage? upstreamResponse = null;

        for (var redirect = 0; redirect <= maxRedirects; redirect++)
        {
            var requestMessage = buildRequest(currentMethod, currentUrl);

            try
            {
                upstreamResponse?.Dispose();
                upstreamResponse = await _service.HttpClient.SendAsync(
                    requestMessage, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            }
            catch (HttpRequestException)
            {
                requestMessage.Dispose();
                return (null, 502, null);
            }
            catch (TaskCanceledException)
            {
                requestMessage.Dispose();
                return (null, 504, null);
            }

            var statusCode = (int)upstreamResponse.StatusCode;
            if (statusCode is >= 301 and <= 308)
            {
                var location = upstreamResponse.Headers.Location?.ToString()
                    ?? upstreamResponse.Content.Headers.ContentLocation?.ToString();
                if (location is not null
                    && Uri.TryCreate(new Uri(currentUrl), location, out var resolved))
                {
                    currentUrl = resolved.ToString();
                    currentMethod = statusCode is 307 or 308 ? originalMethod : HttpMethod.Get;
                    requestMessage.Dispose();
                    continue;
                }
            }

            requestMessage.Dispose();
            break;
        }

        return upstreamResponse is not null
            ? (upstreamResponse, 0, currentUrl)
            : (null, 502, null);
    }

    private async Task DispatchResponseBodyAsync(HttpContext context, HttpResponseMessage upstreamResponse, string? finalUrl)
    {
        var contentType = upstreamResponse.Content.Headers.ContentType?.MediaType;
        if (contentType is "text/html")
        {
            await ProxyHtmlResponseAsync(context, upstreamResponse, finalUrl);
        }
        else if (contentType is "text/css")
        {
            await ProxyCssResponseAsync(context, upstreamResponse);
        }
        else
        {
            await using var stream = await upstreamResponse.Content.ReadAsStreamAsync(context.RequestAborted);
            await stream.CopyToAsync(context.Response.Body, context.RequestAborted);
        }
    }

    private async Task ProxyExternalWebSocketAsync(HttpContext context)
    {
        var externalUrl = context.Request.Query["u"].FirstOrDefault();
        if (string.IsNullOrEmpty(externalUrl) || !Uri.TryCreate(externalUrl, UriKind.Absolute, out var extUri))
        {
            context.Response.StatusCode = 400;
            context.Response.ContentType = "text/plain";
            await context.Response.WriteAsync("Missing or invalid 'u' parameter.");
            return;
        }

        if (extUri.Scheme is not ("ws" or "wss" or "http" or "https"))
        {
            context.Response.StatusCode = 400;
            return;
        }

        var wsScheme = extUri.Scheme switch
        {
            "https" => "wss",
            "http" => "ws",
            _ => extUri.Scheme
        };

        var upstreamUri = new UriBuilder(extUri) { Scheme = wsScheme }.Uri;
        var upstreamOriginScheme = wsScheme == "wss" ? "https" : "http";
        var upstreamOrigin = $"{upstreamOriginScheme}://{upstreamUri.Authority}";
        await ProxyWebSocketToUpstreamAsync(context, upstreamUri, upstreamOrigin);
    }

    private async Task HandleCookieBridgeAsync(HttpContext context)
    {
        if (context.Request.Method == HttpMethods.Get)
        {
            var response = _service.GetCookies();
            context.Response.ContentType = "application/json";
            await JsonSerializer.SerializeAsync(
                context.Response.Body,
                response,
                AppJsonContext.Default.WebPreviewCookiesResponse,
                context.RequestAborted);
            return;
        }

        if (context.Request.Method == HttpMethods.Post)
        {
            WebPreviewCookieSetRequest? request;
            try
            {
                request = await JsonSerializer.DeserializeAsync(
                    context.Request.Body,
                    AppJsonContext.Default.WebPreviewCookieSetRequest,
                    context.RequestAborted);
            }
            catch (JsonException)
            {
                context.Response.StatusCode = 400;
                return;
            }

            if (request is null || !_service.SetCookieFromRaw(request.Raw))
            {
                context.Response.StatusCode = 400;
                return;
            }

            var response = _service.GetCookies();
            context.Response.ContentType = "application/json";
            await JsonSerializer.SerializeAsync(
                context.Response.Body,
                response,
                AppJsonContext.Default.WebPreviewCookiesResponse,
                context.RequestAborted);
            return;
        }

        context.Response.StatusCode = 405;
    }

    private static async Task<string> DecompressTextAsync(
        HttpResponseMessage response, CancellationToken cancellationToken)
    {
        var contentEncoding = response.Content.Headers.ContentEncoding.FirstOrDefault();
        await using var rawStream = await response.Content.ReadAsStreamAsync(cancellationToken);

        Stream decompressed = contentEncoding?.ToLowerInvariant() switch
        {
            "gzip" => new GZipStream(rawStream, CompressionMode.Decompress),
            "br" => new BrotliStream(rawStream, CompressionMode.Decompress),
            "deflate" => new DeflateStream(rawStream, CompressionMode.Decompress),
            _ => rawStream
        };

        await using (decompressed)
        {
            using var reader = new StreamReader(decompressed, Encoding.UTF8);
            return await reader.ReadToEndAsync(cancellationToken);
        }
    }

    private async Task ProxyWebSocketAsync(HttpContext context, Uri targetUri, string path)
    {
        var targetBase = targetUri.AbsolutePath.TrimEnd('/');
        var hasSubpath = !string.IsNullOrEmpty(targetBase) && targetBase != "/";

        // Use learned root fallback for WebSocket paths too
        string wsPath;
        if (hasSubpath && ShouldTryRootFirst(path, targetBase))
        {
            wsPath = string.IsNullOrEmpty(path) || path == "/" ? "/" : path;
            if (!wsPath.StartsWith('/'))
                wsPath = "/" + wsPath;
        }
        else
        {
            wsPath = BuildUpstreamPath(targetUri, path);
        }

        var upstreamUrl = BuildUpstreamWsUrlFromPath(targetUri, wsPath, context.Request.QueryString.Value);
        var upstreamUri = new Uri(upstreamUrl);
        var upstreamOrigin = $"{targetUri.Scheme}://{targetUri.Authority}";
        await ProxyWebSocketToUpstreamAsync(context, upstreamUri, upstreamOrigin, targetUri);
    }

    private async Task ProxyWebSocketToUpstreamAsync(
        HttpContext context, Uri upstreamUri, string upstreamOrigin, Uri? targetUri = null)
    {
        using var upstream = new ClientWebSocket();
        // Configure SSL + forward server-side cookie jar (for SignalR session correlation)
        _service.ConfigureWebSocket(upstream, upstreamUri);

        // Forward all request headers except blocked ones (same blocklist as HTTP)
        foreach (var header in context.Request.Headers)
        {
            if (BlockedRequestHeaders.Contains(header.Key))
                continue;
            // Skip WebSocket upgrade headers — ClientWebSocket manages these
            if (header.Key.StartsWith("Sec-WebSocket-", StringComparison.OrdinalIgnoreCase))
                continue;

            var value = header.Value.ToString();

            // Rewrite Origin/Referer to match upstream host — Blazor/SignalR validates
            // these against its own host and rejects connections from foreign origins
            if (header.Key.Equals("Origin", StringComparison.OrdinalIgnoreCase))
            {
                value = upstreamOrigin;
            }
            else if (header.Key.Equals("Referer", StringComparison.OrdinalIgnoreCase))
            {
                // Rewrite referer: replace MidTerm host+/webpreview/ with upstream host
                if (Uri.TryCreate(value, UriKind.Absolute, out var refUri))
                {
                    value = upstreamOrigin + refUri.PathAndQuery.Replace("/webpreview/", "/").Replace("/webpreview", "/");
                }
            }

            try
            {
                upstream.Options.SetRequestHeader(header.Key, value);
            }
            catch (ArgumentException)
            {
                // Some headers can't be set on ClientWebSocket — skip silently
            }
        }

        // Forward WebSocket sub-protocols (critical for SignalR)
        var subProtocols = context.WebSockets.WebSocketRequestedProtocols;
        foreach (var protocol in subProtocols)
        {
            upstream.Options.AddSubProtocol(protocol);
        }

        try
        {
            await upstream.ConnectAsync(upstreamUri, context.RequestAborted);
        }
        catch (WebSocketException)
        {
            context.Response.StatusCode = 502;
            return;
        }
        catch (HttpRequestException)
        {
            context.Response.StatusCode = 502;
            return;
        }

        // Accept downstream with the negotiated sub-protocol from upstream
        var acceptProtocol = upstream.SubProtocol;
        using var downstream = acceptProtocol is not null
            ? await context.WebSockets.AcceptWebSocketAsync(acceptProtocol)
            : await context.WebSockets.AcceptWebSocketAsync();

        // Build URL rewrite functions for Blazor/SignalR compatibility.
        // Blazor sends the browser's location.href (which includes /webpreview/) to the
        // upstream server during circuit init (StartCircuit) and navigation events. The
        // upstream doesn't know about /webpreview/, so we strip it from client→upstream
        // messages and re-add it for upstream→client messages.
        //
        // /webpreview maps to the upstream server root — the full upstream path (including
        // any subpath like /kicoach) follows AFTER /webpreview/. So:
        //   client:   https://proxy/webpreview/kicoach/page
        //   upstream: https://upstream/kicoach/page
        // We rewrite proxy scheme+host+/webpreview → upstream scheme+host (no path).
        //
        // Text rewriting handles JSON-based SignalR protocols. Binary rewriting handles
        // MessagePack-based protocols (like Blazor's "blazorpack") where URLs are embedded
        // as UTF-8 bytes in binary frames with MessagePack string length prefixes.
        Func<string, string>? clientToUpstream = null;
        Func<string, string>? upstreamToClient = null;
        Func<byte[], int, byte[]?>? binaryClientToUpstream = null;
        Func<byte[], int, byte[]?>? binaryUpstreamToClient = null;

        if (targetUri is not null)
        {
            var proxyScheme = context.Request.IsHttps ? "https" : "http";
            var proxyBase = $"{proxyScheme}://{context.Request.Host}/webpreview";
            var upstreamRoot = $"{targetUri.Scheme}://{targetUri.Authority}";

            clientToUpstream = text => text.Replace(proxyBase, upstreamRoot);
            upstreamToClient = text => text.Replace(upstreamRoot, proxyBase);

            var proxyBaseUtf8 = Encoding.UTF8.GetBytes(proxyBase);
            var upstreamRootUtf8 = Encoding.UTF8.GetBytes(upstreamRoot);
            binaryClientToUpstream = (data, len) => RewriteBinaryUrls(data, len, proxyBaseUtf8, upstreamRootUtf8);
            binaryUpstreamToClient = (data, len) => RewriteBinaryUrls(data, len, upstreamRootUtf8, proxyBaseUtf8);
        }

        using var cts = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);

        var downToUp = PipeWebSocketAsync(downstream, upstream, cts, clientToUpstream, binaryClientToUpstream);
        var upToDown = PipeWebSocketAsync(upstream, downstream, cts, upstreamToClient, binaryUpstreamToClient);

        await Task.WhenAny(downToUp, upToDown);
        await cts.CancelAsync();

        await CloseWebSocketSafe(downstream);
        await CloseWebSocketSafe(upstream);
    }

    private static async Task PipeWebSocketAsync(
        WebSocket source, WebSocket destination, CancellationTokenSource cts,
        Func<string, string>? textRewriter = null,
        Func<byte[], int, byte[]?>? binaryRewriter = null)
    {
        var buffer = new byte[WsBufferSize];
        MemoryStream? accumulator = null;
        try
        {
            while (source.State == WebSocketState.Open && !cts.Token.IsCancellationRequested)
            {
                var result = await source.ReceiveAsync(buffer, cts.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    break;
                }

                if (textRewriter is not null && result.MessageType == WebSocketMessageType.Text)
                {
                    accumulator ??= new MemoryStream();
                    accumulator.Write(buffer, 0, result.Count);

                    if (result.EndOfMessage)
                    {
                        var raw = accumulator.GetBuffer();
                        var rawLen = (int)accumulator.Length;
                        byte[]? outBytes = null;

                        try
                        {
                            var text = Encoding.UTF8.GetString(raw, 0, rawLen);
                            var rewritten = textRewriter(text);
                            outBytes = Encoding.UTF8.GetBytes(rewritten);
                        }
                        catch
                        {
                            // Rewrite failed — forward original bytes unchanged
                        }

                        await destination.SendAsync(
                            outBytes is not null
                                ? new ArraySegment<byte>(outBytes)
                                : new ArraySegment<byte>(raw, 0, rawLen),
                            WebSocketMessageType.Text,
                            true,
                            cts.Token);
                        accumulator.SetLength(0);
                    }
                }
                else if (binaryRewriter is not null && result.MessageType == WebSocketMessageType.Binary)
                {
                    accumulator ??= new MemoryStream();
                    accumulator.Write(buffer, 0, result.Count);

                    if (result.EndOfMessage)
                    {
                        var data = accumulator.GetBuffer();
                        var len = (int)accumulator.Length;
                        byte[]? rewritten = null;

                        try
                        {
                            rewritten = binaryRewriter(data, len);
                        }
                        catch
                        {
                            // Rewrite failed — forward original bytes unchanged
                        }

                        await destination.SendAsync(
                            rewritten is not null
                                ? new ArraySegment<byte>(rewritten)
                                : new ArraySegment<byte>(data, 0, len),
                            WebSocketMessageType.Binary,
                            true,
                            cts.Token);
                        accumulator.SetLength(0);
                    }
                }
                else
                {
                    await destination.SendAsync(
                        new ArraySegment<byte>(buffer, 0, result.Count),
                        result.MessageType,
                        result.EndOfMessage,
                        cts.Token);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Expected on shutdown
        }
        catch (WebSocketException)
        {
            // Connection dropped
        }
        finally
        {
            accumulator?.Dispose();
        }
    }

    /// <summary>
    /// Rewrites URL strings embedded in binary MessagePack data.
    /// Finds occurrences of <paramref name="fromUtf8"/> bytes and replaces them with
    /// <paramref name="toUtf8"/> bytes, adjusting MessagePack string length prefixes.
    /// Used for Blazor's "blazorpack" protocol where StartCircuit sends URLs as
    /// MessagePack-encoded strings in binary WebSocket frames.
    /// </summary>
    internal static byte[]? RewriteBinaryUrls(byte[] data, int length, byte[] fromUtf8, byte[] toUtf8)
    {
        if (fromUtf8.Length == 0 || length < fromUtf8.Length + 1)
            return null;

        var span = data.AsSpan(0, length);

        // First pass: find all match positions
        var positions = new List<int>();
        var searchStart = 0;
        while (searchStart <= length - fromUtf8.Length)
        {
            var idx = span[searchStart..].IndexOf(fromUtf8);
            if (idx < 0) break;
            positions.Add(searchStart + idx);
            searchStart += idx + fromUtf8.Length;
        }

        if (positions.Count == 0)
            return null;

        var delta = toUtf8.Length - fromUtf8.Length;
        using var ms = new MemoryStream(length + (Math.Abs(delta) * positions.Count) + 16);
        var copyFrom = 0;

        foreach (var matchPos in positions)
        {
            if (matchPos < copyFrom)
                continue; // Inside a previously rewritten string

            // Try to find the MessagePack string header enclosing this URL.
            // The URL is expected at the START of the MessagePack string value.
            int headerStart = -1;
            int headerLen = 0;
            int oldStrLen = 0;

            if (matchPos >= 2 && data[matchPos - 2] == 0xd9)
            {
                // str 8: [0xd9] [1-byte length] [content...]
                headerStart = matchPos - 2;
                headerLen = 2;
                oldStrLen = data[matchPos - 1];
            }
            else if (matchPos >= 1 && (data[matchPos - 1] & 0xe0) == 0xa0)
            {
                // fixstr: [0xa0-0xbf] [content...]
                headerStart = matchPos - 1;
                headerLen = 1;
                oldStrLen = data[matchPos - 1] & 0x1f;
            }
            else if (matchPos >= 3 && data[matchPos - 3] == 0xda)
            {
                // str 16: [0xda] [2-byte length BE] [content...]
                headerStart = matchPos - 3;
                headerLen = 3;
                oldStrLen = (data[matchPos - 2] << 8) | data[matchPos - 1];
            }

            if (headerStart < 0 || oldStrLen < fromUtf8.Length)
                continue; // No valid header — skip this match, bytes pass through

            // Bail if the header overlaps with a previous replacement region
            if (headerStart < copyFrom)
                continue;

            // Bail if the claimed string extends past the buffer — data is corrupt
            var stringEnd = headerStart + headerLen + oldStrLen;
            if (stringEnd > length)
                return null; // Unsafe to rewrite — pass through entire frame

            var newStrLen = oldStrLen + delta;

            // Write everything before this string header
            ms.Write(data, copyFrom, headerStart - copyFrom);

            // Write new MessagePack string header
            if (newStrLen <= 31)
            {
                ms.WriteByte((byte)(0xa0 | newStrLen));
            }
            else if (newStrLen <= 255)
            {
                ms.WriteByte(0xd9);
                ms.WriteByte((byte)newStrLen);
            }
            else
            {
                ms.WriteByte(0xda);
                ms.WriteByte((byte)(newStrLen >> 8));
                ms.WriteByte((byte)(newStrLen & 0xff));
            }

            // Write replacement URL bytes
            ms.Write(toUtf8);

            // Write the rest of the original string (path/query after the URL prefix)
            var restLen = oldStrLen - fromUtf8.Length;
            if (restLen > 0)
            {
                ms.Write(data, matchPos + fromUtf8.Length, restLen);
            }

            copyFrom = stringEnd;
        }

        if (copyFrom == 0)
            return null; // No successful replacements — pass through

        // Write remaining data after last replacement
        if (copyFrom < length)
        {
            ms.Write(data, copyFrom, length - copyFrom);
        }

        return ms.ToArray();
    }

    private static async Task CloseWebSocketSafe(WebSocket ws)
    {
        try
        {
            if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
            {
                using var timeout = new CancellationTokenSource(WsCloseTimeout);
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, null, timeout.Token);
            }
        }
        catch
        {
            // Best effort
        }
    }

    private static string BuildUpstreamUrl(Uri target, string path, string? queryString)
    {
        var sb = new StringBuilder(256);
        sb.Append(target.Scheme).Append("://").Append(target.Authority);
        sb.Append(BuildUpstreamPath(target, path));
        if (!string.IsNullOrEmpty(queryString))
        {
            sb.Append(queryString);
        }
        return sb.ToString();
    }

    private static string BuildUpstreamWsUrl(Uri target, string path, string? queryString)
    {
        var scheme = target.Scheme == "https" ? "wss" : "ws";
        var sb = new StringBuilder(256);
        sb.Append(scheme).Append("://").Append(target.Authority);
        sb.Append(BuildUpstreamPath(target, path));
        if (!string.IsNullOrEmpty(queryString))
        {
            sb.Append(queryString);
        }
        return sb.ToString();
    }

    internal static string BuildUpstreamPath(Uri target, string path)
    {
        var targetPath = target.AbsolutePath;
        if (string.IsNullOrEmpty(targetPath))
        {
            targetPath = "/";
        }

        var targetHasTrailingSlash = targetPath.Length > 1
            && targetPath.EndsWith("/", StringComparison.Ordinal);

        var targetBase = targetPath.TrimEnd('/');
        if (targetBase == "/")
        {
            targetBase = "";
        }

        var normalizedPath = string.IsNullOrEmpty(path) ? "/" : path;
        if (!normalizedPath.StartsWith('/'))
        {
            normalizedPath = "/" + normalizedPath;
        }

        if (normalizedPath == "/")
        {
            if (string.IsNullOrEmpty(targetBase))
            {
                return "/";
            }

            return targetHasTrailingSlash ? targetBase + "/" : targetBase;
        }

        if (string.IsNullOrEmpty(targetBase))
        {
            return normalizedPath;
        }

        if (normalizedPath.Equals(targetBase, StringComparison.OrdinalIgnoreCase)
            || normalizedPath.StartsWith(targetBase + "/", StringComparison.OrdinalIgnoreCase))
        {
            return normalizedPath;
        }

        return targetBase + normalizedPath;
    }

    private static string BuildUpstreamUrlFromPath(Uri target, string upstreamPath, string? queryString)
    {
        var sb = new StringBuilder(256);
        sb.Append(target.Scheme).Append("://").Append(target.Authority);
        sb.Append(upstreamPath);
        if (!string.IsNullOrEmpty(queryString))
            sb.Append(queryString);
        return sb.ToString();
    }

    private static string BuildUpstreamWsUrlFromPath(Uri target, string upstreamPath, string? queryString)
    {
        var scheme = target.Scheme == "https" ? "wss" : "ws";
        var sb = new StringBuilder(256);
        sb.Append(scheme).Append("://").Append(target.Authority);
        sb.Append(upstreamPath);
        if (!string.IsNullOrEmpty(queryString))
            sb.Append(queryString);
        return sb.ToString();
    }

    private static bool PathAlreadyUnderTarget(string path, string targetBase)
    {
        var normalized = string.IsNullOrEmpty(path) ? "/" : path;
        if (!normalized.StartsWith('/'))
            normalized = "/" + normalized;
        return normalized.StartsWith(targetBase + "/", StringComparison.OrdinalIgnoreCase)
            || normalized.Equals(targetBase, StringComparison.OrdinalIgnoreCase);
    }

    private bool ShouldTryRootFirst(string path, string targetBase)
    {
        ResetFallbackCacheIfTargetChanged();
        var prefix = GetPathPrefix(path);
        return prefix is not null && _rootFallbackPrefixes.TryGetValue(prefix, out var preferRoot) && preferRoot;
    }

    private void LearnRootFallback(string path, string targetUrl)
    {
        ResetFallbackCacheIfTargetChanged();
        _rootFallbackTarget = targetUrl;
        var prefix = GetPathPrefix(path);
        if (prefix is not null)
            _rootFallbackPrefixes[prefix] = true;
    }

    private void UnlearnRootFallback(string path)
    {
        var prefix = GetPathPrefix(path);
        if (prefix is not null)
            _rootFallbackPrefixes.Remove(prefix);
    }

    private void ResetFallbackCacheIfTargetChanged()
    {
        var currentTarget = _service.TargetUri?.ToString();
        if (_rootFallbackTarget != currentTarget)
        {
            _rootFallbackPrefixes.Clear();
            _rootFallbackTarget = currentTarget;
        }
    }

    private static string? GetPathPrefix(string path)
    {
        var normalized = string.IsNullOrEmpty(path) ? "/" : path;
        if (!normalized.StartsWith('/'))
            normalized = "/" + normalized;
        var queryIdx = normalized.IndexOf('?');
        if (queryIdx >= 0)
            normalized = normalized[..queryIdx];
        if (normalized == "/")
            return null;
        var secondSlash = normalized.IndexOf('/', 1);
        return secondSlash > 0 ? normalized[..secondSlash] + "/" : normalized + "/";
    }

    [GeneratedRegex(@"<head(\s[^>]*)?>", RegexOptions.IgnoreCase)]
    private static partial Regex HeadTagRegex();

    // Matches existing <base ...> tags (self-closing or not) to remove before injecting ours
    [GeneratedRegex(@"<base\s[^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex ExistingBaseTagRegex();

    // Extracts the href value from a <base href="..."> tag
    [GeneratedRegex(@"<base\s[^>]*href\s*=\s*[""']([^""']*)[""']", RegexOptions.IgnoreCase)]
    private static partial Regex BaseHrefValueRegex();

    // Matches <meta http-equiv="content-security-policy" ...> and <meta http-equiv="x-frame-options" ...>
    // Upstream CSP/XFO meta tags must be stripped: after proxying, 'self' resolves to MidTerm's origin,
    // which would block framing of the upstream site's own resources.
    [GeneratedRegex(@"<meta\s[^>]*http-equiv\s*=\s*[""']\s*(?:content-security-policy|x-frame-options)\s*[""'][^>]*>", RegexOptions.IgnoreCase)]
    private static partial Regex UpstreamSecurityMetaTagRegex();

    // Matches <meta http-equiv="refresh" content="N;url=/path"> for PHP-style redirects
    [GeneratedRegex(@"(<meta\s[^>]*content\s*=\s*[""']\d+\s*;\s*url\s*=\s*)([^""'>\s]+)", RegexOptions.IgnoreCase)]
    private static partial Regex MetaRefreshRegex();

    // Matches src="/...", href="/...", action="/...", poster="/..." with word boundaries
    // to avoid matching data-src, data-href, metadata, etc.
    // Requires at least one path character after / to avoid matching broken attributes like href="/".
    [GeneratedRegex(@"(\b(?:src|href|action|poster)\s*=\s*[""'])/(?![/""'\s>])", RegexOptions.IgnoreCase)]
    private static partial Regex RootRelativeAttrRegex();

    // Matches root-relative URLs in srcset attributes (e.g., srcset="/img/foo.png 2x")
    [GeneratedRegex(@"(\bsrcset\s*=\s*[""'](?:[^""']*,\s*)?)/(?![/""'\s>])", RegexOptions.IgnoreCase)]
    private static partial Regex RootRelativeSrcsetRegex();

    // Matches url(/...) in inline CSS (with optional quotes)
    [GeneratedRegex(@"url\(\s*[""']?/(?!/)", RegexOptions.IgnoreCase)]
    private static partial Regex RootRelativeCssUrlRegex();

    // Matches absolute http(s) URLs in HTML attributes: src="https://...", href="http://..."
    [GeneratedRegex(@"(\b(?:src|href|action|poster)\s*=\s*[""'])(https?://[^""'\s>]+)", RegexOptions.IgnoreCase)]
    private static partial Regex AbsoluteUrlAttrRegex();

    // Matches absolute http(s) URLs in CSS url(): url(https://...) or url("https://...")
    [GeneratedRegex(@"(url\(\s*[""']?)(https?://[^""')>\s]+)", RegexOptions.IgnoreCase)]
    private static partial Regex AbsoluteUrlCssRegex();

    /// <summary>
    /// Rewrite absolute external URL in an HTML attribute to go through the _ext proxy.
    /// URLs pointing to the target host are rewritten to /webpreview/ (same-origin proxy).
    /// URLs pointing to other hosts go through /webpreview/_ext?u=...
    /// </summary>
    private static string RewriteExternalUrl(Match match, string? targetHost)
    {
        var prefix = match.Groups[1].Value;  // e.g. src="
        var url = match.Groups[2].Value;     // e.g. https://cdn.example.com/script.js

        // Same-host URLs → /webpreview/path (already handled by root-relative rewriting,
        // but absolute same-host URLs need rewriting too)
        if (targetHost is not null && Uri.TryCreate(url, UriKind.Absolute, out var uri)
            && uri.Host.Equals(targetHost, StringComparison.OrdinalIgnoreCase))
        {
            return prefix + "/webpreview" + uri.PathAndQuery;
        }

        // External URLs → /webpreview/_ext?u=encodedUrl
        return prefix + "/webpreview/_ext?u=" + Uri.EscapeDataString(url);
    }

    private static string RewriteExternalCssUrl(Match match, string? targetHost)
    {
        var prefix = match.Groups[1].Value;  // e.g. url(
        var url = match.Groups[2].Value;     // e.g. https://fonts.googleapis.com/css

        if (targetHost is not null && Uri.TryCreate(url, UriKind.Absolute, out var uri)
            && uri.Host.Equals(targetHost, StringComparison.OrdinalIgnoreCase))
        {
            return prefix + "/webpreview" + uri.PathAndQuery;
        }

        return prefix + "/webpreview/_ext?u=" + Uri.EscapeDataString(url);
    }
}
