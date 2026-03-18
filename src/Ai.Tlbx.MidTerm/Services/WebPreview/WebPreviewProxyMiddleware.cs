using System.Diagnostics;
using System.IO.Compression;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Ai.Tlbx.MidTerm.Models.WebPreview;
using Ai.Tlbx.MidTerm.Services;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.AspNetCore.WebUtilities;

namespace Ai.Tlbx.MidTerm.Services.WebPreview;

public sealed partial class WebPreviewProxyMiddleware
{
    private const string ProxyPrefix = "/webpreview";
    private const string InternalProxyRequestHeaderName = "X-MidTerm-Internal-Proxy";
    private const string InternalProxyRequestHeaderValue = "1";
    private const int WsBufferSize = 8192;
    private static readonly TimeSpan WsCloseTimeout = TimeSpan.FromSeconds(5);
    private static readonly FileExtensionContentTypeProvider ContentTypeProvider = new();

    // Injected into proxied HTML to rewrite URLs in fetch/XHR/DOM at runtime.
    // Rewrites root-relative URLs to /webpreview/... and absolute external URLs
    // to /webpreview/_ext?u=... so all requests go through the MT proxy.
    // Patches: fetch, XHR, element .src/.href setters, setAttribute, window.open.
    private const string UrlRewriteScript = """
        <script>(function(){
          if(window.__mtProxy)return;window.__mtProxy=1;
          // Save real parent before cloaking (used for navigation notifications)
          var _realParent=window.parent;
          var mtCtx=null;
          try{mtCtx=window.name?JSON.parse(window.name):null;}catch(e){mtCtx=null;}
          function mtMsg(type,extra){
            if(!mtCtx)return null;
            var msg=extra||{};
            msg.type=type;
            if(mtCtx.sessionId)msg.sessionId=mtCtx.sessionId;
            if(mtCtx.previewId)msg.previewId=mtCtx.previewId;
            if(mtCtx.previewToken)msg.previewToken=mtCtx.previewToken;
            return msg;
          }
          // Iframe cloaking: make the page think it's top-level
          try{Object.defineProperty(window,"top",{get:function(){return window},configurable:true});}catch(e){}
          try{Object.defineProperty(window,"parent",{get:function(){return window},configurable:true});}catch(e){}
          try{Object.defineProperty(window,"frameElement",{get:function(){return null},configurable:true});}catch(e){}
          var P="/webpreview",E=P+"/_ext?u=";
          function dprop(target,name,getter){
            if(!target)return false;
            try{Object.defineProperty(target,name,{configurable:true,get:getter});return true;}catch(e){}
            try{
              var proto=Object.getPrototypeOf(target);
              if(proto){Object.defineProperty(proto,name,{configurable:true,get:getter});return true;}
            }catch(e){}
            return false;
          }
          function mkStore(){
            var data=Object.create(null);
            var api={
              getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(data,k)?data[k]:null;},
              setItem:function(k,v){data[String(k)]=String(v);},
              removeItem:function(k){delete data[String(k)];},
              clear:function(){data=Object.create(null);},
              key:function(i){var keys=Object.keys(data);return i>=0&&i<keys.length?keys[i]:null;}
            };
            try{Object.defineProperty(api,"length",{configurable:true,get:function(){return Object.keys(data).length;}});}catch(e){}
            return api;
          }
          function ensureStore(name){
            try{var existing=window[name];if(existing)return existing;}catch(e){}
            var fallback=mkStore();
            if(!dprop(window,name,function(){return fallback;})){
              try{window[name]=fallback;}catch(e){}
            }
            return fallback;
          }
          function mkSwContainer(){
            var reg={
              scope:(location.origin||"null")+P+"/",
              active:null,installing:null,waiting:null,
              update:function(){return Promise.resolve();},
              unregister:function(){return Promise.resolve(false);},
              addEventListener:function(){},
              removeEventListener:function(){}
            };
            return {
              controller:null,
              ready:Promise.resolve(reg),
              register:function(){return Promise.resolve(reg);},
              getRegistration:function(){return Promise.resolve(undefined);},
              getRegistrations:function(){return Promise.resolve([]);},
              startMessages:function(){},
              addEventListener:function(){},
              removeEventListener:function(){},
              dispatchEvent:function(){return false;}
            };
          }
          function ensureServiceWorker(){
            try{var existing=navigator.serviceWorker;if(existing)return existing;}catch(e){}
            var fallback=mkSwContainer();
            if(!dprop(navigator,"serviceWorker",function(){return fallback;})){
              try{navigator.serviceWorker=fallback;}catch(e){}
            }
            return fallback;
          }
          ensureStore("localStorage");
          ensureStore("sessionStorage");
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
          // === Network APIs ===
          var F=window.fetch;
          function rfq(self,q,o){
            var ru=r(q.url),init={
              method:q.method,headers:q.headers,mode:q.mode,credentials:q.credentials,cache:q.cache,
              redirect:q.redirect,referrer:q.referrer,referrerPolicy:q.referrerPolicy,
              integrity:q.integrity,keepalive:q.keepalive,signal:q.signal
            };
            if(o)for(var k in o)init[k]=o[k];
            if(init.body!==undefined){
              try{if(q.duplex&&init.duplex===undefined)init.duplex=q.duplex;}catch(e){}
              return F.call(self,ru,init);
            }
            if(q.method==="GET"||q.method==="HEAD")return F.call(self,ru,init);
            return q.clone().arrayBuffer().then(function(body){
              init.body=body;
              try{if(q.duplex&&init.duplex===undefined)init.duplex=q.duplex;}catch(e){}
              return F.call(self,ru,init);
            },function(){return F.call(self,ru,init);});
          }
          function wrapCookieRefresh(p){
            if(!p||typeof p.then!=="function"){qrc();return p;}
            return p.then(function(v){qrc();return v;},function(err){qrc();throw err;});
          }
          window.fetch=function(u,o){
            if(typeof u==="string")return wrapCookieRefresh(F.call(this,r(u),o));
            if(u&&typeof u==="object"&&u.url){try{return wrapCookieRefresh(rfq(this,u,o));}catch(e){}}
            return wrapCookieRefresh(F.call(this,u,o));
          };
          var X=XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=r(u);return X.apply(this,a);};
          var XS=XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.send=function(){
            var xhr=this,done=false;
            function onDone(){
              if(done)return;
              done=true;
              qrc();
              try{xhr.removeEventListener("loadend",onDone);}catch(e){}
            }
            try{xhr.addEventListener("loadend",onDone);}catch(e){}
            try{return XS.apply(xhr,arguments);}catch(err){onDone();throw err;}
          };
          if(navigator.sendBeacon){var sb=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){var ok=sb(r(u),d);if(ok)qrc();return ok;};}
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
          var mtsw=ensureServiceWorker();
          if(mtsw&&mtsw.register){
            var swr=mtsw.register.bind(mtsw);
            mtsw.register=function(u,o){return swr(r(u),o);};
          }
          // === Navigation APIs ===
          function curU(){
            if(location.pathname===P+"/_ext"){
              try{
                var ext=new URLSearchParams(location.search).get("u");
                if(ext)return ext;
              }catch(e){}
            }
            var path=location.pathname;
            if(path.indexOf(P+"/")==0)path=path.substring(P.length);
            else if(path===P)path="/";
            return (window.__mtTargetOrigin||"")+path+location.search+location.hash;
          }
          function postMt(type,extra){
            var msg=mtMsg(type,extra);
            if(!msg)return;
            try{_realParent.postMessage(msg,"*");}catch(e){}
          }
          function ntfy(){postMt("mt-navigation",{url:location.href,targetOrigin:window.__mtTargetOrigin||"",upstreamUrl:curU()});}
          var hps=history.pushState.bind(history),hrs=history.replaceState.bind(history);
          history.pushState=function(s,t,u){var x=hps(s,t,u?r(u):u);ntfy();return x;};
          history.replaceState=function(s,t,u){var x=hrs(s,t,u?r(u):u);ntfy();return x;};
          var la=location.assign.bind(location),lr=location.replace.bind(location);
          location.assign=function(u){return la(r(u));};
          location.replace=function(u){return lr(r(u));};
          window.addEventListener("popstate",ntfy);
          window.addEventListener("hashchange",ntfy);
          setTimeout(ntfy,0);
          // === Cookie bridge ===
          var cc="",cookieSeq=0,cookiePending={},cookieRefreshTimer=0;
          window.addEventListener("message",function(ev){
            var d=ev.data;
            if(!d||d.type!=="mt-cookie-response")return;
            if(mtCtx&&((mtCtx.previewId||"")!==(d.previewId||"")||(mtCtx.previewToken||"")!==(d.previewToken||"")))return;
            var done=cookiePending[d.requestId];
            if(!done)return;
            delete cookiePending[d.requestId];
            done(d.error?null:d);
          });
          function reqCookie(action,raw){
            return new Promise(function(resolve){
              var msg=mtMsg("mt-cookie-request",{requestId:"c"+(++cookieSeq),action:action,raw:raw||"",upstreamUrl:curU()});
              if(!msg){resolve(null);return;}
              cookiePending[msg.requestId]=resolve;
              try{_realParent.postMessage(msg,"*");}catch(e){delete cookiePending[msg.requestId];resolve(null);return;}
              setTimeout(function(){
                if(cookiePending[msg.requestId]){
                  delete cookiePending[msg.requestId];
                  resolve(null);
                }
              },5000);
            });
          }
          function rc(){return reqCookie("get").then(function(j){cc=j&&j.header?j.header:"";}).catch(function(){});}
          function qrc(){
            if(cookieRefreshTimer)return;
            cookieRefreshTimer=setTimeout(function(){
              cookieRefreshTimer=0;
              rc();
            },0);
          }
          rc();
          try{
            var d=Object.getOwnPropertyDescriptor(Document.prototype,"cookie")||Object.getOwnPropertyDescriptor(HTMLDocument.prototype,"cookie");
            if(d&&d.configurable){
              Object.defineProperty(document,"cookie",{configurable:true,get:function(){return cc;},set:function(v){
                if(typeof v!=="string")return;
                var n=v.split(";")[0]||"";if(n){var i=n.indexOf("="),k=i>0?n.slice(0,i).trim():"";if(k){var p=cc?cc.split(/;\s*/):[];var nx=[];for(var z=0;z<p.length;z++){if(!p[z].startsWith(k+"="))nx.push(p[z]);}nx.push(n.trim());cc=nx.join("; ");}}
                reqCookie("set",v).then(function(j){if(j&&typeof j.header==="string")cc=j.header;}).catch(function(){});
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
          var bws,bwsReady=false,h2cLoad=null;
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
          function ensureH2c(){
            if(window.html2canvas)return Promise.resolve(window.html2canvas);
            if(h2cLoad)return h2cLoad;
            h2cLoad=F.call(window,"/js/html2canvas.min.js",{credentials:"same-origin"}).then(function(resp){
              if(!resp.ok)throw new Error("failed to fetch html2canvas");
              return resp.text();
            }).then(function(text){
              return new Promise(function(resolve,reject){
                var blob=new Blob([text],{type:"text/javascript"});
                var blobUrl=URL.createObjectURL(blob);
                var scr=document.createElement("script");
                scr.src=blobUrl;
                scr.onload=function(){URL.revokeObjectURL(blobUrl);resolve(window.html2canvas);};
                scr.onerror=function(){URL.revokeObjectURL(blobUrl);reject(new Error("failed to load html2canvas"));};
                document.head.appendChild(scr);
              });
            }).catch(function(err){h2cLoad=null;throw err;});
            return h2cLoad;
          }
          function handleBCmd(msg){
            var res={id:msg.id,success:true,result:null,error:null,matchCount:null,sessionId:mtCtx&&mtCtx.sessionId?mtCtx.sessionId:null,previewId:mtCtx&&mtCtx.previewId?mtCtx.previewId:null};
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
                  ensureH2c().then(function(){
                    return window.html2canvas(document.documentElement,{useCORS:true,logging:false,scale:1});
                  }).then(function(canvas){
                      res.result=canvas.toDataURL("image/png");bws.send(JSON.stringify(res));
                  }).catch(function(e){res.success=false;res.error="screenshot failed: "+e.message;bws.send(JSON.stringify(res));});
                  return;}
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
                case"submit":{
                  var fsel=msg.selector||"form";
                  var f=document.querySelector(fsel);
                  if(!f){res.success=false;res.error="form not found: "+fsel;break;}
                  rc().finally(function(){
                    res.result="submitted";
                    bws.send(JSON.stringify(res));
                    setTimeout(function(){try{f.requestSubmit();}catch(e){f.submit();}},50);
                  });
                  return;}
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
                case"url":{
                  res.result=curU();
                  break;}
                case"clearcookies":{
                  var all=document.cookie.split(";");
                  for(var i=0;i<all.length;i++){var n=all[i].split("=")[0].trim();if(n)document.cookie=n+"=;expires=Thu,01 Jan 1970 00:00:00 GMT;path=/";}
                  cc="";res.result="cleared";
                  break;}
                default:res.success=false;res.error="unknown command: "+msg.command;
              }
            }catch(e){res.success=false;res.error=e.message||String(e);}
            bws.send(JSON.stringify(res));
          }
          function connectBws(){
            try{
              var proto=location.protocol==="https:"?"wss:":"ws:";
              var wsUrl=proto+"//"+location.host+"/ws/browser";
              if(mtCtx&&mtCtx.previewId&&mtCtx.previewToken){
                wsUrl+="?previewId="+encodeURIComponent(mtCtx.previewId)+"&token="+encodeURIComponent(mtCtx.previewToken);
                if(mtCtx.sessionId)wsUrl+="&sessionId="+encodeURIComponent(mtCtx.sessionId);
              }
              bws=new OWS(wsUrl);
              bws.onopen=function(){bwsReady=true;};
              bws.onmessage=function(e){try{handleBCmd(JSON.parse(e.data));}catch(ex){}};
              bws.onclose=function(){bwsReady=false;setTimeout(connectBws,3000);};
              bws.onerror=function(){};
            }catch(e){}
          }
          connectBws();
        })();</script>
        """;

    private static string GetUrlRewriteScript(string routePrefix)
    {
        return UrlRewriteScript.Replace(
            "var P=\"/webpreview\",E=P+\"/_ext?u=\";",
            $"var P=\"{routePrefix}\",E=P+\"/_ext?u=\";",
            StringComparison.Ordinal);
    }


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
        // MidTerm owns forwarded headers and must not let them accumulate across self-proxy hops
        "X-Forwarded-For", "X-Forwarded-Proto", "X-Forwarded-Host",
        // Internal loop-prevention header is for server-originated requests only
        InternalProxyRequestHeaderName,
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

    // Learned path prefixes that should bypass subpath-prefixing and go to the
    // upstream server root. Stored per preview route key so unrelated browser
    // contexts do not pollute each other's fallback cache.
    private readonly Dictionary<string, Dictionary<string, bool>> _rootFallbackPrefixesByRoute = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string?> _rootFallbackTargetsByRoute = new(StringComparer.OrdinalIgnoreCase);

    public WebPreviewProxyMiddleware(RequestDelegate next, WebPreviewService service)
    {
        _next = next;
        _service = service;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path;

        if (TryParseProxyRoute(path, out var routeKey, out var remainingPath))
        {
            if (remainingPath.StartsWith("/_ext", StringComparison.Ordinal))
            {
                if (context.WebSockets.IsWebSocketRequest)
                {
                    await ProxyExternalWebSocketAsync(context, routeKey);
                }
                else
                {
                    await ProxyExternalAsync(context, routeKey);
                }
                return;
            }
            if (remainingPath.Equals("/_cookies", StringComparison.Ordinal))
            {
                await HandleCookieBridgeAsync(context, routeKey);
                return;
            }

            _service.TryGetTargetUriByRouteKey(routeKey, out var targetUri);
            if (targetUri is null)
            {
                context.Response.StatusCode = 502;
                context.Response.ContentType = "text/plain";
                await context.Response.WriteAsync("No web preview target configured.");
                return;
            }

            if (context.WebSockets.IsWebSocketRequest)
            {
                if (targetUri.IsFile)
                {
                    context.Response.StatusCode = StatusCodes.Status400BadRequest;
                }
                else
                {
                    await ProxyWebSocketAsync(context, routeKey, targetUri, remainingPath);
                }
            }
            else
            {
                if (targetUri.IsFile)
                {
                    await ProxyFileAsync(context, routeKey, targetUri, remainingPath);
                }
                else
                {
                    await ProxyHttpAsync(context, routeKey, targetUri, remainingPath);
                }
            }

            return;
        }

        // Guard: if web preview is active and a proxied page's JS leaks calls to
        // /api/webpreview/* (e.g. inner MidTerm calling DELETE /api/webpreview/target),
        // proxy those upstream instead of letting them hit our local handlers.
        if (path.StartsWithSegments("/api/webpreview")
            && ShouldProxyWebPreviewApiRequest(context.Request)
            && TryResolvePreviewFromRequest(context.Request, out routeKey, out var apiTargetUri))
        {
            if (context.WebSockets.IsWebSocketRequest)
                await ProxyWebSocketAsync(context, routeKey, apiTargetUri, path.Value ?? "/");
            else
                await ProxyHttpAsync(context, routeKey, apiTargetUri, path.Value ?? "/");
            return;
        }

        // Catch-all: if web preview is active and this isn't a known MidTerm path,
        // it's likely a leaked root-relative URL from the proxied site (e.g. /s/player/...,
        // /youtubei/v1/...). Proxy it to the upstream target directly.
        if (!IsInternalProxyRequest(context.Request)
            && !IsMidTermPath(path.Value ?? "/"))
        {
            if (!TryResolvePreviewFromRequest(context.Request, out routeKey, out var targetUri))
            {
                await _next(context);
                return;
            }

            var proxyPath = path.Value ?? "/";
            if (context.WebSockets.IsWebSocketRequest)
            {
                await ProxyWebSocketAsync(context, routeKey, targetUri, proxyPath);
            }
            else
            {
                await ProxyHttpAsync(context, routeKey, targetUri, proxyPath);
            }

            return;
        }

        await _next(context);
    }

    private static bool ShouldProxyWebPreviewApiRequest(HttpRequest request)
    {
        if (!request.Headers.TryGetValue("Referer", out var refererValues))
        {
            return false;
        }

        if (!Uri.TryCreate(refererValues.ToString(), UriKind.Absolute, out var refererUri))
        {
            return false;
        }

        var refererPath = refererUri.AbsolutePath;
        return refererPath.Equals(ProxyPrefix, StringComparison.OrdinalIgnoreCase)
            || refererPath.StartsWith(ProxyPrefix + "/", StringComparison.OrdinalIgnoreCase);
    }

    private bool TryResolvePreviewFromRequest(HttpRequest request, out string routeKey, out Uri targetUri)
    {
        routeKey = "";
        targetUri = null!;

        if (TryParseProxyRoute(request.Path, out var directRouteKey, out _)
            && _service.TryGetTargetUriByRouteKey(directRouteKey, out var directTargetUri)
            && directTargetUri is not null)
        {
            routeKey = directRouteKey;
            targetUri = directTargetUri;
            return true;
        }

        if (!request.Headers.TryGetValue("Referer", out var refererValues))
        {
            return false;
        }

        if (!Uri.TryCreate(refererValues.ToString(), UriKind.Absolute, out var refererUri))
        {
            return false;
        }

        if (!TryParseProxyRoute(refererUri.AbsolutePath, out routeKey, out _))
        {
            return false;
        }

        if (!_service.TryGetTargetUriByRouteKey(routeKey, out var refererTargetUri) || refererTargetUri is null)
        {
            routeKey = "";
            return false;
        }

        targetUri = refererTargetUri;
        return true;
    }

    internal static bool TryParseProxyRoute(PathString path, out string routeKey, out string remainingPath)
    {
        routeKey = "";
        remainingPath = "/";

        if (!path.StartsWithSegments(ProxyPrefix, out var remaining))
        {
            return false;
        }

        var value = remaining.Value ?? "";
        if (string.IsNullOrEmpty(value) || value == "/")
        {
            return false;
        }

        var normalized = value.StartsWith('/') ? value : "/" + value;
        var nextSlash = normalized.IndexOf('/', 1);
        if (nextSlash < 0)
        {
            routeKey = normalized[1..];
            remainingPath = "/";
            return !string.IsNullOrWhiteSpace(routeKey);
        }

        routeKey = normalized[1..nextSlash];
        remainingPath = normalized[nextSlash..];
        return !string.IsNullOrWhiteSpace(routeKey);
    }

    internal static bool TryParseProxyRoute(string path, out string routeKey, out string remainingPath)
    {
        return TryParseProxyRoute(new PathString(path), out routeKey, out remainingPath);
    }

    private static bool IsInternalProxyRequest(HttpRequest request)
    {
        return request.Headers.TryGetValue(InternalProxyRequestHeaderName, out var values)
            && values.Count > 0
            && string.Equals(values[0], InternalProxyRequestHeaderValue, StringComparison.Ordinal);
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

        // Root-level MidTerm files (only pages/assets that MidTerm itself needs).
        // Do NOT include /favicon.ico, /site.webmanifest, or other root-level assets
        // that proxied sites commonly reference — those should go to upstream.
        return path is "/"
            or "/index.html"
            or "/login.html"
            or "/trust.html"
            or "/web-preview-popup.html"
            or "/THIRD-PARTY-LICENSES.txt"
            or "/midFont-style.css";
    }

    private async Task ProxyHttpAsync(HttpContext context, string routeKey, Uri targetUri, string path)
    {
        SyncSelfTargetAuthCookie(routeKey, context.Request, targetUri);
        var upstreamOrigin = $"{targetUri.Scheme}://{targetUri.Authority}";
        var targetBase = targetUri.AbsolutePath.TrimEnd('/');
        var hasSubpath = !string.IsNullOrEmpty(targetBase) && targetBase != "/";

        // Determine primary URL (may use root fallback if previously learned)
        var primaryPath = BuildUpstreamPath(targetUri, path);
        var useRootFirst = hasSubpath && ShouldTryRootFirst(routeKey, path, targetBase);
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
            ForwardRequestHeaders(context.Request, msg, routeKey, targetUri, upstreamOrigin);
            msg.Headers.TryAddWithoutValidation("X-Forwarded-For",
                context.Connection.RemoteIpAddress?.ToString() ?? "127.0.0.1");
            msg.Headers.TryAddWithoutValidation("X-Forwarded-Proto", "https");
            msg.Headers.TryAddWithoutValidation("X-Forwarded-Host", context.Request.Host.ToString());
            if (_service.IsSelfTarget(msg.RequestUri!))
            {
                msg.Headers.TryAddWithoutValidation(
                    InternalProxyRequestHeaderName,
                    InternalProxyRequestHeaderValue);
            }
            AttachRequestBody(msg, method, requestBodyBuffer, context.Request.ContentType, context.Request.ContentLength);
            return msg;
        }

        var (upstreamResponse, errorCode, finalUrl) = await SendUpstreamAsync(
            context, routeKey, originalMethod, currentUrl, BuildRequest, context.RequestAborted);

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
                    context, routeKey, originalMethod, fallbackUrl, BuildRequest, context.RequestAborted);

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
                        LearnRootFallback(routeKey, path, targetUri.ToString());
                    }
                }
                else
                {
                    fallbackResponse?.Dispose();
                    // Learn: if subpath worked from root-first attempt, un-learn
                    if (useRootFirst && fallbackResponse?.StatusCode != System.Net.HttpStatusCode.NotFound)
                    {
                        UnlearnRootFallback(routeKey, path);
                    }
                }
            }
        }

        _service.PersistCookies(routeKey);

        if (upstreamResponse is not null
            && ShouldAdoptCanonicalTarget(context.Request, upstreamResponse, finalUrl, targetUri.Authority, out var canonicalUri))
        {
            var canonicalTarget = canonicalUri.GetLeftPart(UriPartial.Authority) + targetUri.AbsolutePath;
            if (_service.GetPreviewSessionByRouteKey(routeKey) is { SessionId: var sessionId, PreviewName: var previewName })
            {
                _service.SetTarget(sessionId, previewName, canonicalTarget, preserveCookies: true);
            }
        }

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
            await DispatchResponseBodyAsync(context, routeKey, upstreamResponse, finalUrl);
        }
    }

    private async Task ProxyHtmlResponseAsync(HttpContext context, string routeKey, Uri targetUri, HttpResponseMessage upstreamResponse, string? finalUrl)
    {
        var html = await DecompressTextAsync(upstreamResponse, context.RequestAborted);

        // Rewrite root-relative URLs to go through the proxy.
        // <base href> only handles truly relative URLs (foo/bar.js),
        // but root-relative URLs (/path/to/file) need explicit rewriting.
        var routePrefix = _service.BuildProxyPrefix(routeKey);
        html = RootRelativeAttrRegex().Replace(html, $"$1{routePrefix}/");
        html = RootRelativeSrcsetRegex().Replace(html, $"$1{routePrefix}/");
        html = RootRelativeCssUrlRegex().Replace(html, $"url({routePrefix}/");

        // Rewrite <meta http-equiv="refresh" content="0;url=/path"> URLs (PHP redirect pattern)
        html = MetaRefreshRegex().Replace(html, m =>
        {
            var prefix = m.Groups[1].Value;
            var url = m.Groups[2].Value;
            if (url.StartsWith('/') && !url.StartsWith(routePrefix + "/", StringComparison.Ordinal))
                return prefix + routePrefix + url;
            return m.Value;
        });

        // Rewrite absolute external URLs (https://cdn.example.com/...) to go through _ext proxy.
        // This allows MT to fetch third-party resources server-side, bypassing CORS/ad blockers.
        var targetAuthority = targetUri.Authority;
        html = AbsoluteUrlAttrRegex().Replace(html, m => RewriteExternalUrl(m, routePrefix, targetAuthority));
        html = AbsoluteUrlCssRegex().Replace(html, m => RewriteExternalCssUrl(m, routePrefix, targetAuthority));

        // Prime the root-fallback cache from rewritten HTML before the browser starts
        // requesting assets. This avoids the first-wave 404s on deep document targets
        // whose HTML points at server-root assets like /_astro/*.
        PrimeRootFallbacksFromHtml(routeKey, html);

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
                baseHref = routePrefix + "/";
            else
                baseHref = routePrefix + (basePath.StartsWith('/') ? basePath : "/" + basePath) + "/";
        }
        else
        {
            baseHref = ComputeBaseHref(routePrefix, finalUrl);
        }

        // Inject <base href> for truly relative URLs, plus a script that patches
        // fetch/XHR to rewrite root-relative URLs at runtime (safer than regex on JS source).
        var targetOrigin = targetUri.GetLeftPart(UriPartial.Authority);
        var originScript = $"<script>window.__mtTargetOrigin=\"{targetOrigin}\";</script>";
        html = HeadTagRegex().Replace(html, $"$0<base href=\"{baseHref}\">{originScript}" + GetUrlRewriteScript(routePrefix), 1);

        // Send uncompressed — strip Content-Encoding and Content-Length for this response
        context.Response.Headers.Remove("Content-Length");
        context.Response.Headers.Remove("Content-Encoding");
        context.Response.ContentType = "text/html; charset=utf-8";
        await context.Response.WriteAsync(html, context.RequestAborted);
    }

    private static string ComputeBaseHref(string routePrefix, string? finalUrl)
    {
        if (finalUrl is null || !Uri.TryCreate(finalUrl, UriKind.Absolute, out var finalUri))
            return routePrefix + "/";

        var path = finalUri.AbsolutePath;
        var lastSlash = path.LastIndexOf('/');
        var directory = lastSlash > 0 ? path[..(lastSlash + 1)] : "/";
        return routePrefix + directory;
    }

    private static Uri BuildRequestedFileUri(Uri targetUri, string requestPath)
    {
        if (string.IsNullOrEmpty(requestPath) || requestPath == "/")
        {
            return targetUri;
        }

        var decodedPath = Uri.UnescapeDataString(requestPath);
        if (decodedPath.StartsWith('/')
            && decodedPath.Length >= 4
            && char.IsLetter(decodedPath[1])
            && decodedPath[2] == ':'
            && decodedPath[3] == '/')
        {
            return new Uri($"file://{decodedPath}");
        }

        return new Uri(targetUri, decodedPath.TrimStart('/'));
    }

    private static string GetContentType(string localPath)
    {
        return ContentTypeProvider.TryGetContentType(localPath, out var contentType)
            ? contentType
            : "application/octet-stream";
    }

    internal void PrimeRootFallbacksFromHtml(string routeKey, string html)
    {
        _service.TryGetTargetUriByRouteKey(routeKey, out var targetUri);
        if (targetUri is null)
        {
            return;
        }

        var targetBase = targetUri.AbsolutePath.TrimEnd('/');
        if (string.IsNullOrEmpty(targetBase) || targetBase == "/")
        {
            return;
        }

        ResetFallbackCacheIfTargetChanged(routeKey, targetUri.ToString());
        var routeCache = GetOrCreateRootFallbackCache(routeKey);

        foreach (var prefix in CollectProxyPathPrefixes(_service.BuildProxyPrefix(routeKey), html))
        {
            routeCache[prefix] = true;
        }
    }

    internal static string[] CollectProxyPathPrefixes(string routePrefix, string html)
    {
        if (string.IsNullOrEmpty(html))
        {
            return Array.Empty<string>();
        }

        var prefixes = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match match in ProxiedPathRegex().Matches(html))
        {
            var proxiedPath = match.Groups[1].Value;
            if (!proxiedPath.StartsWith(routePrefix, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var upstreamPath = proxiedPath[routePrefix.Length..];
            var prefix = GetPathPrefix(upstreamPath);
            if (prefix is null || prefix.Equals("/_ext/", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            prefixes.Add(prefix);
        }

        return prefixes.Count == 0 ? Array.Empty<string>() : [.. prefixes];
    }

    private async Task ProxyCssResponseAsync(HttpContext context, string routeKey, HttpResponseMessage upstreamResponse)
    {
        var css = await DecompressTextAsync(upstreamResponse, context.RequestAborted);
        var routePrefix = _service.BuildProxyPrefix(routeKey);

        // Rewrite url(/...) references in CSS to go through the proxy
        css = RootRelativeCssUrlRegex().Replace(css, $"url({routePrefix}/");

        // Rewrite absolute external url() references
        css = AbsoluteUrlCssRegex().Replace(css, m => RewriteExternalCssUrl(m, routePrefix, null));

        context.Response.Headers.Remove("Content-Length");
        context.Response.Headers.Remove("Content-Encoding");
        context.Response.ContentType = "text/css; charset=utf-8";
        await context.Response.WriteAsync(css, context.RequestAborted);
    }

    private async Task ProxyExternalAsync(HttpContext context, string routeKey)
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
            ForwardRequestHeaders(context.Request, msg, routeKey, requestUri, upstreamOrigin);
            AttachRequestBody(msg, method, requestBodyBuffer, context.Request.ContentType, null);
            return msg;
        }

        var (upstreamResponse, errorCode, finalUrl) = await SendUpstreamAsync(
            context, routeKey, originalMethod, currentUrl, BuildRequest, context.RequestAborted, "ext-http");

        _service.PersistCookies(routeKey);

        if (upstreamResponse is null)
        {
            context.Response.StatusCode = errorCode;
            return;
        }

        using (upstreamResponse)
        {
            if (ShouldAdoptCanonicalTarget(context.Request, upstreamResponse, finalUrl, _service.GetTargetUriByRouteKey(routeKey)?.Authority, out var canonicalUri))
            {
                var canonicalTarget = canonicalUri.GetLeftPart(UriPartial.Authority) + "/";
                if (_service.GetPreviewSessionByRouteKey(routeKey) is { SessionId: var sessionId, PreviewName: var previewName })
                {
                    _service.SetTarget(sessionId, previewName, canonicalTarget, preserveCookies: true);
                }
            }

            context.Response.StatusCode = (int)upstreamResponse.StatusCode;
            CopyResponseHeaders(upstreamResponse, context.Response);
            await DispatchResponseBodyAsync(context, routeKey, upstreamResponse, finalUrl);
        }
    }

    private void ForwardRequestHeaders(
        HttpRequest source,
        HttpRequestMessage target,
        string routeKey,
        Uri currentTargetUri,
        string upstreamOrigin)
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
                var refValue = RewriteRefererForUpstream(header.Value.ToString(), routeKey, currentTargetUri);
                target.Headers.TryAddWithoutValidation(header.Key, refValue);
                continue;
            }

            target.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
        }
    }

    internal string RewriteRefererForUpstream(string refererValue, string currentRouteKey, Uri currentTargetUri)
    {
        if (!Uri.TryCreate(refererValue, UriKind.Absolute, out var refererUri))
        {
            return refererValue;
        }

        if (!TryParseProxyRoute(refererUri.AbsolutePath, out var refererRouteKey, out var refererRemainingPath))
        {
            return refererValue;
        }

        if (string.Equals(refererRemainingPath, "/_ext", StringComparison.OrdinalIgnoreCase))
        {
            var externalUrl = QueryHelpers.ParseQuery(refererUri.Query)["u"].FirstOrDefault();
            return !string.IsNullOrWhiteSpace(externalUrl)
                && Uri.TryCreate(externalUrl, UriKind.Absolute, out var externalUri)
                ? externalUri.ToString()
                : refererValue;
        }

        var refererTarget = _service.GetTargetUriByRouteKey(refererRouteKey);
        if (refererTarget is null
            && string.Equals(refererRouteKey, currentRouteKey, StringComparison.Ordinal))
        {
            refererTarget = currentTargetUri;
        }

        if (refererTarget is null)
        {
            return refererValue;
        }

        var upstreamPath = BuildUpstreamPath(refererTarget, refererRemainingPath);
        return BuildUpstreamUrlFromPath(refererTarget, upstreamPath, refererUri.Query);
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
        string routeKey,
        HttpMethod originalMethod,
        string startUrl,
        Func<HttpMethod, string, HttpRequestMessage> buildRequest,
        CancellationToken cancellationToken,
        string? logType = null)
    {
        const int maxRedirects = 10;
        var currentUrl = startUrl;
        var currentMethod = originalMethod;
        HttpResponseMessage? upstreamResponse = null;
        var sw = Stopwatch.StartNew();

        for (var redirect = 0; redirect <= maxRedirects; redirect++)
        {
            var requestMessage = buildRequest(currentMethod, currentUrl);

            try
            {
                upstreamResponse?.Dispose();
                upstreamResponse = await _service.GetHttpClient(routeKey).SendAsync(
                    requestMessage, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            }
            catch (HttpRequestException ex)
            {
                sw.Stop();
                LogHttpRequest(context, routeKey, logType ?? "http", originalMethod.Method, startUrl, currentUrl, 502, sw.ElapsedMilliseconds, requestMessage, null, ex.Message);
                requestMessage.Dispose();
                return (null, 502, null);
            }
            catch (TaskCanceledException ex)
            {
                sw.Stop();
                LogHttpRequest(context, routeKey, logType ?? "http", originalMethod.Method, startUrl, currentUrl, 504, sw.ElapsedMilliseconds, requestMessage, null, ex.Message);
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

            sw.Stop();
            LogHttpRequest(context, routeKey, logType ?? "http", originalMethod.Method, startUrl, currentUrl, statusCode, sw.ElapsedMilliseconds, requestMessage, upstreamResponse, null);
            requestMessage.Dispose();
            break;
        }

        return upstreamResponse is not null
            ? (upstreamResponse, 0, currentUrl)
            : (null, 502, null);
    }

    private void LogHttpRequest(
        HttpContext context, string routeKey, string type, string method,
        string startUrl, string finalUrl, int statusCode, long durationMs,
        HttpRequestMessage? request, HttpResponseMessage? response, string? error)
    {
        var entry = new WebPreviewProxyLogEntry
        {
            Type = type,
            Method = method,
            RequestUrl = context.Request.Path + context.Request.QueryString,
            UpstreamUrl = finalUrl,
            StatusCode = statusCode,
            DurationMs = durationMs,
            Error = error
        };

        if (request is not null)
        {
            foreach (var h in request.Headers)
                entry.RequestHeaders[h.Key] = string.Join(", ", h.Value);
            var cookieHeader = request.RequestUri is not null
                ? _service.GetForwardedCookieHeader(routeKey, request.RequestUri)
                : null;
            if (string.IsNullOrWhiteSpace(cookieHeader)
                && request.Headers.TryGetValues("Cookie", out var cookies))
            {
                cookieHeader = string.Join("; ", cookies);
            }

            entry.RequestCookies = cookieHeader;
        }

        if (response is not null)
        {
            foreach (var h in response.Headers)
                entry.ResponseHeaders[h.Key] = string.Join(", ", h.Value);
            foreach (var h in response.Content.Headers)
                entry.ResponseHeaders[h.Key] = string.Join(", ", h.Value);
            entry.ContentType = response.Content.Headers.ContentType?.ToString();
            entry.ContentLength = response.Content.Headers.ContentLength;

            var setCookies = response.Headers.TryGetValues("Set-Cookie", out var sc)
                ? string.Join(" | ", sc) : null;
            entry.ResponseCookies = setCookies;
        }

        _service.AddLogEntry(routeKey, entry);
    }

    private void LogWebSocket(
        HttpContext context, string routeKey, string type, string upstreamUrl,
        IList<string> requestedProtocols, string? negotiatedProtocol,
        long durationMs, int statusCode, string? error)
    {
        var entry = new WebPreviewProxyLogEntry
        {
            Type = type,
            Method = "WS-UPGRADE",
            RequestUrl = context.Request.Path + context.Request.QueryString,
            UpstreamUrl = upstreamUrl,
            StatusCode = statusCode,
            DurationMs = durationMs,
            Error = error,
            SubProtocols = requestedProtocols.Count > 0 ? string.Join(", ", requestedProtocols) : null,
            NegotiatedProtocol = negotiatedProtocol
        };

        foreach (var h in context.Request.Headers)
        {
            entry.RequestHeaders[h.Key] = h.Value.ToString();
        }

        if (Uri.TryCreate(upstreamUrl, UriKind.Absolute, out var upstreamUri))
        {
            var httpScheme = upstreamUri.Scheme == "wss" ? "https" : "http";
            var cookieLookupUri = new UriBuilder(upstreamUri) { Scheme = httpScheme }.Uri;
            entry.RequestCookies = _service.GetForwardedCookieHeader(routeKey, cookieLookupUri)
                ?? context.Request.Headers.Cookie.ToString();
        }

        _service.AddLogEntry(routeKey, entry);
    }

    private async Task DispatchResponseBodyAsync(HttpContext context, string routeKey, HttpResponseMessage upstreamResponse, string? finalUrl)
    {
        var contentType = upstreamResponse.Content.Headers.ContentType?.MediaType;
        if (IsFontResponse(contentType, context.Request.Path.Value))
        {
            context.Response.Headers["Access-Control-Allow-Origin"] = "*";
        }

        if (contentType is "text/html")
        {
            var targetUri = _service.GetTargetUriByRouteKey(routeKey);
            if (targetUri is null)
            {
                context.Response.StatusCode = 502;
                return;
            }

            await ProxyHtmlResponseAsync(context, routeKey, targetUri, upstreamResponse, finalUrl);
        }
        else if (contentType is "text/css")
        {
            await ProxyCssResponseAsync(context, routeKey, upstreamResponse);
        }
        else
        {
            await using var stream = await upstreamResponse.Content.ReadAsStreamAsync(context.RequestAborted);
            await stream.CopyToAsync(context.Response.Body, context.RequestAborted);
        }
    }

    private async Task ProxyFileAsync(HttpContext context, string routeKey, Uri targetUri, string path)
    {
        if (!HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method))
        {
            context.Response.StatusCode = StatusCodes.Status405MethodNotAllowed;
            return;
        }

        var requestedFileUri = BuildRequestedFileUri(targetUri, path);
        if (!requestedFileUri.IsFile)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        var localPath = requestedFileUri.LocalPath;
        if (Directory.Exists(localPath))
        {
            localPath = Path.Combine(localPath, "index.html");
        }

        if (!File.Exists(localPath))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            context.Response.ContentType = "text/plain";
            await context.Response.WriteAsync("File not found.", context.RequestAborted);
            return;
        }

        var contentType = GetContentType(localPath);
        context.Response.StatusCode = StatusCodes.Status200OK;
        context.Response.ContentType = contentType;
        context.Response.ContentLength = new FileInfo(localPath).Length;

        if (HttpMethods.IsHead(context.Request.Method))
        {
            return;
        }

        if (contentType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase))
        {
            await ProxyLocalHtmlResponseAsync(context, routeKey, requestedFileUri, localPath);
            return;
        }

        await using var stream = File.OpenRead(localPath);
        await stream.CopyToAsync(context.Response.Body, context.RequestAborted);
    }

    private async Task ProxyLocalHtmlResponseAsync(HttpContext context, string routeKey, Uri requestedFileUri, string localPath)
    {
        var html = await File.ReadAllTextAsync(localPath, context.RequestAborted);

        var routePrefix = _service.BuildProxyPrefix(routeKey);
        html = RootRelativeAttrRegex().Replace(html, $"$1{routePrefix}/");
        html = RootRelativeSrcsetRegex().Replace(html, $"$1{routePrefix}/");
        html = RootRelativeCssUrlRegex().Replace(html, $"url({routePrefix}/");

        html = MetaRefreshRegex().Replace(html, m =>
        {
            var prefix = m.Groups[1].Value;
            var url = m.Groups[2].Value;
            if (url.StartsWith('/') && !url.StartsWith(routePrefix + "/", StringComparison.Ordinal))
                return prefix + routePrefix + url;
            return m.Value;
        });

        html = ExistingBaseTagRegex().Replace(html, "");
        html = UpstreamSecurityMetaTagRegex().Replace(html, "");

        var baseHref = ComputeBaseHref(routePrefix, requestedFileUri.ToString());
        var targetOrigin = $"{context.Request.Scheme}://{context.Request.Host}";
        var originScript = $"<script>window.__mtTargetOrigin=\"{targetOrigin}\";</script>";
        html = HeadTagRegex().Replace(html, $"$0<base href=\"{baseHref}\">{originScript}" + GetUrlRewriteScript(routePrefix), 1);

        context.Response.Headers.Remove("Content-Length");
        context.Response.ContentType = "text/html; charset=utf-8";
        await context.Response.WriteAsync(html, context.RequestAborted);
    }

    private async Task ProxyExternalWebSocketAsync(HttpContext context, string routeKey)
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
        await ProxyWebSocketToUpstreamAsync(context, routeKey, upstreamUri, upstreamOrigin);
    }

    private async Task HandleCookieBridgeAsync(HttpContext context, string routeKey)
    {
        var cookieRequestUri = ResolveCookieBridgeRequestUri(context.Request);
        if (context.Request.Method == HttpMethods.Get)
        {
            var response = _service.GetBrowserCookies(routeKey, cookieRequestUri);
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

            if (request is null || !_service.SetCookieFromRaw(routeKey, request.Raw, cookieRequestUri, allowHttpOnly: false))
            {
                context.Response.StatusCode = 400;
                return;
            }

            var response = _service.GetBrowserCookies(routeKey, cookieRequestUri);
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

    private Uri? ResolveCookieBridgeRequestUri(HttpRequest request)
    {
        if (!TryResolvePreviewFromRequest(request, out _, out var targetUri))
            return null;

        if (targetUri is null)
            return null;

        var requestedUrl = request.Query["u"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(requestedUrl)
            && Uri.TryCreate(requestedUrl, UriKind.Absolute, out var explicitUri))
        {
            return explicitUri;
        }

        if (!request.Headers.TryGetValue("Referer", out var refererValues))
            return targetUri;

        if (!Uri.TryCreate(refererValues.ToString(), UriKind.Absolute, out var refererUri))
            return targetUri;

        if (!TryParseProxyRoute(refererUri.AbsolutePath, out _, out _))
            return targetUri;

        if (TryParseProxyRoute(refererUri.AbsolutePath, out _, out var refererRemainingPath)
            && string.Equals(refererRemainingPath, "/_ext", StringComparison.OrdinalIgnoreCase))
        {
            var externalUrl = QueryHelpers.ParseQuery(refererUri.Query)["u"].FirstOrDefault();
            if (!string.IsNullOrWhiteSpace(externalUrl)
                && Uri.TryCreate(externalUrl, UriKind.Absolute, out var externalUri))
            {
                return externalUri;
            }

            return targetUri;
        }

        TryParseProxyRoute(refererUri.AbsolutePath, out _, out var upstreamPath);

        var upstreamUrl = BuildUpstreamUrlFromPath(targetUri, upstreamPath, refererUri.Query);
        return Uri.TryCreate(upstreamUrl, UriKind.Absolute, out var upstreamUri)
            ? upstreamUri
            : targetUri;
    }

    private static bool ShouldAdoptCanonicalTarget(
        HttpRequest request,
        HttpResponseMessage upstreamResponse,
        string? finalUrl,
        string? currentAuthority,
        out Uri canonicalUri)
    {
        canonicalUri = null!;

        if (string.IsNullOrWhiteSpace(finalUrl))
            return false;

        if (!HttpMethods.IsGet(request.Method))
            return false;

        var mediaType = upstreamResponse.Content.Headers.ContentType?.MediaType;
        if (!string.Equals(mediaType, "text/html", StringComparison.OrdinalIgnoreCase))
            return false;

        if (request.Headers.TryGetValue("Sec-Fetch-Mode", out var mode)
            && !string.Equals(mode.ToString(), "navigate", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (request.Headers.TryGetValue("Sec-Fetch-Dest", out var destination))
        {
            var destValue = destination.ToString();
            if (!string.Equals(destValue, "document", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(destValue, "iframe", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }
        }

        if (!Uri.TryCreate(finalUrl, UriKind.Absolute, out var finalUri))
            return false;

        if (string.IsNullOrWhiteSpace(currentAuthority)
            || finalUri.Authority.Equals(currentAuthority, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        canonicalUri = finalUri;
        return true;
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

    private async Task ProxyWebSocketAsync(HttpContext context, string routeKey, Uri targetUri, string path)
    {
        SyncSelfTargetAuthCookie(routeKey, context.Request, targetUri);
        var targetBase = targetUri.AbsolutePath.TrimEnd('/');
        var hasSubpath = !string.IsNullOrEmpty(targetBase) && targetBase != "/";

        // Use learned root fallback for WebSocket paths too
        string wsPath;
        if (hasSubpath && ShouldTryRootFirst(routeKey, path, targetBase))
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
        await ProxyWebSocketToUpstreamAsync(context, routeKey, upstreamUri, upstreamOrigin, targetUri);
    }

    private async Task ProxyWebSocketToUpstreamAsync(
        HttpContext context, string routeKey, Uri upstreamUri, string upstreamOrigin, Uri? targetUri = null)
    {
        using var upstream = new ClientWebSocket();
        // Configure SSL + forward server-side cookie jar (for SignalR session correlation)
        _service.ConfigureWebSocket(routeKey, upstream, upstreamUri);

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
                value = RewriteRefererForUpstream(value, routeKey, targetUri ?? new Uri(upstreamOrigin));
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

        var wsType = context.Request.Path.Value?.Contains("/_ext") == true ? "ext-ws" : "ws";
        var wsSw = Stopwatch.StartNew();

        try
        {
            await upstream.ConnectAsync(upstreamUri, context.RequestAborted);
        }
        catch (WebSocketException ex)
        {
            wsSw.Stop();
            LogWebSocket(context, routeKey, wsType, upstreamUri.ToString(), subProtocols, null, wsSw.ElapsedMilliseconds, 502, ex.Message);
            context.Response.StatusCode = 502;
            return;
        }
        catch (HttpRequestException ex)
        {
            wsSw.Stop();
            LogWebSocket(context, routeKey, wsType, upstreamUri.ToString(), subProtocols, null, wsSw.ElapsedMilliseconds, 502, ex.Message);
            context.Response.StatusCode = 502;
            return;
        }

        wsSw.Stop();
        LogWebSocket(context, routeKey, wsType, upstreamUri.ToString(), subProtocols, upstream.SubProtocol, wsSw.ElapsedMilliseconds, 101, null);

        // Accept downstream with the negotiated sub-protocol from upstream
        var acceptProtocol = upstream.SubProtocol;
        using var downstream = acceptProtocol is not null
            ? await context.WebSockets.AcceptWebSocketAsync(acceptProtocol)
            : await context.WebSockets.AcceptWebSocketAsync();

        // WebSocket messages are relayed without content rewriting. The page lives
        // under /webpreview/ and JS sees proxy URLs in location.href and document.baseURI.
        // Frameworks like Blazor store client-provided URLs (proxy URLs) in their state
        // and use relative paths for routing — the absolute origin doesn't matter.
        // When the server echoes URLs back, they're already proxy URLs. No rewriting needed.
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);

        var downToUp = RelayWebSocketAsync(downstream, upstream, cts);
        var upToDown = RelayWebSocketAsync(upstream, downstream, cts);

        await Task.WhenAny(downToUp, upToDown);
        await cts.CancelAsync();

        await CloseWebSocketSafe(downstream);
        await CloseWebSocketSafe(upstream);
    }

    private static async Task RelayWebSocketAsync(
        WebSocket source, WebSocket destination, CancellationTokenSource cts)
    {
        var buffer = new byte[WsBufferSize];
        try
        {
            while (source.State == WebSocketState.Open && !cts.Token.IsCancellationRequested)
            {
                var result = await source.ReceiveAsync(buffer, cts.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                    break;

                await destination.SendAsync(
                    new ArraySegment<byte>(buffer, 0, result.Count),
                    result.MessageType,
                    result.EndOfMessage,
                    cts.Token);
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

    private void SyncSelfTargetAuthCookie(string routeKey, HttpRequest request, Uri targetUri)
    {
        if (!_service.IsSelfTarget(targetUri))
        {
            return;
        }

        if (request.Cookies.TryGetValue(AuthService.SessionCookieName, out var token))
        {
            _service.SyncSessionCookieForSelfTarget(routeKey, token, targetUri);
        }
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

    private bool ShouldTryRootFirst(string routeKey, string path, string targetBase)
    {
        ResetFallbackCacheIfTargetChanged(routeKey, _service.GetTargetUriByRouteKey(routeKey)?.ToString());
        var prefix = GetPathPrefix(path);
        var routeCache = GetOrCreateRootFallbackCache(routeKey);
        return prefix is not null && routeCache.TryGetValue(prefix, out var preferRoot) && preferRoot;
    }

    private void LearnRootFallback(string routeKey, string path, string targetUrl)
    {
        ResetFallbackCacheIfTargetChanged(routeKey, targetUrl);
        var prefix = GetPathPrefix(path);
        if (prefix is not null)
            GetOrCreateRootFallbackCache(routeKey)[prefix] = true;
    }

    private void UnlearnRootFallback(string routeKey, string path)
    {
        var prefix = GetPathPrefix(path);
        if (prefix is not null && _rootFallbackPrefixesByRoute.TryGetValue(routeKey, out var routeCache))
            routeCache.Remove(prefix);
    }

    private void ResetFallbackCacheIfTargetChanged(string routeKey, string? currentTarget)
    {
        _rootFallbackTargetsByRoute.TryGetValue(routeKey, out var previousTarget);
        if (previousTarget != currentTarget)
        {
            GetOrCreateRootFallbackCache(routeKey).Clear();
            _rootFallbackTargetsByRoute[routeKey] = currentTarget;
        }
    }

    private Dictionary<string, bool> GetOrCreateRootFallbackCache(string routeKey)
    {
        if (_rootFallbackPrefixesByRoute.TryGetValue(routeKey, out var existing))
        {
            return existing;
        }

        var created = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        _rootFallbackPrefixesByRoute[routeKey] = created;
        return created;
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

    // Matches rewritten proxy paths in HTML/CSS attributes so we can prime root
    // fallback prefixes before the browser requests them.
    [GeneratedRegex(@"[""'(=]\s*(/webpreview/[^""')\s,>]+)", RegexOptions.IgnoreCase)]
    private static partial Regex ProxiedPathRegex();

    /// <summary>
    /// Rewrite absolute external URL in an HTML attribute to go through the _ext proxy.
    /// URLs pointing to the target authority are rewritten to /webpreview/ (same-origin proxy).
    /// URLs pointing to other hosts go through /webpreview/_ext?u=...
    /// </summary>
    private static string RewriteExternalUrl(Match match, string routePrefix, string? targetAuthority)
    {
        var prefix = match.Groups[1].Value;  // e.g. src="
        var url = match.Groups[2].Value;     // e.g. https://cdn.example.com/script.js

        // Same-authority URLs → /webpreview/path (already handled by root-relative rewriting,
        // but absolute same-authority URLs need rewriting too)
        if (targetAuthority is not null && Uri.TryCreate(url, UriKind.Absolute, out var uri)
            && uri.Authority.Equals(targetAuthority, StringComparison.OrdinalIgnoreCase))
        {
            return prefix + routePrefix + uri.PathAndQuery;
        }

        return prefix + routePrefix + "/_ext?u=" + Uri.EscapeDataString(url);
    }

    private static string RewriteExternalCssUrl(Match match, string routePrefix, string? targetAuthority)
    {
        var prefix = match.Groups[1].Value;  // e.g. url(
        var url = match.Groups[2].Value;     // e.g. https://fonts.googleapis.com/css

        if (targetAuthority is not null && Uri.TryCreate(url, UriKind.Absolute, out var uri)
            && uri.Authority.Equals(targetAuthority, StringComparison.OrdinalIgnoreCase))
        {
            return prefix + routePrefix + uri.PathAndQuery;
        }

        return prefix + routePrefix + "/_ext?u=" + Uri.EscapeDataString(url);
    }

    private static bool IsFontResponse(string? contentType, string? path)
    {
        if (!string.IsNullOrEmpty(contentType)
            && (contentType.StartsWith("font/", StringComparison.OrdinalIgnoreCase)
                || contentType.Contains("font", StringComparison.OrdinalIgnoreCase)))
        {
            return true;
        }

        if (string.IsNullOrEmpty(path))
        {
            return false;
        }

        return path.EndsWith(".woff", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".woff2", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".ttf", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".otf", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith(".eot", StringComparison.OrdinalIgnoreCase);
    }
}
