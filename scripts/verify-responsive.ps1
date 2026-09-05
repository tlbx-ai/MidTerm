<#
.SYNOPSIS
Checks an already-open tlbx preview using desktop browser geometry.
.DESCRIPTION
Open a source tlbx with a disposable Terminal session and Command Bay first.
Uses the ordinary tlbx CLI, with no mobile user agent or touch emulation.
CSS widths already account for screen density.
#>
param(
    [string]$HelperPath = (Join-Path $PSScriptRoot '../.tlbx/tlbx_cli.ps1'),
    [string]$PreviewName = 'responsive',
    [int[]]$Widths = @(320, 390, 430, 768, 769, 1024, 1440),
    [int]$Height = 844,
    [string]$OutputPath = (Join-Path $PSScriptRoot '../.dev/responsive-validation.json')
)
$ErrorActionPreference = 'Stop'
. $HelperPath
mt_preview $PreviewName | Out-Null
$prepare = @'
(() => {
 const root = document.documentElement;
 const names = ['top','right','bottom','left'];
 const toggle = document.querySelector('.smart-input-tools-toggle');
 if (!toggle || !document.querySelector('.terminal-container')) throw new Error('Open a Terminal with Command Bay before running the responsive check.');
 if (!window.__responsiveCheckRestore) window.__responsiveCheckRestore = {
   insets: names.map(s => root.style.getPropertyValue('--safe-area-inset-' + s)),
   tools: toggle.getAttribute('aria-expanded') === 'true',
   keys: document.querySelector('.smart-input-mobile-touch-toggle')?.getAttribute('aria-pressed') === 'true'
 };
 for (const [side,n] of Object.entries({top:24,right:16,bottom:34,left:16})) root.style.setProperty('--safe-area-inset-'+side,n+'px');
 if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
 const keys = document.querySelector('.smart-input-mobile-touch-toggle');
 if (innerWidth <= 768 && keys?.getAttribute('aria-pressed') !== 'true') keys?.click();
 return 'prepared';
})()
'@
$measure = @'
(() => {
 const rect = e => e.getBoundingClientRect();
 const visible = e => rect(e).width > 0 && rect(e).height > 0;
 const dock = document.querySelector('.adaptive-footer-dock');
 const errors = [];
 const compact = innerWidth <= 768;
 if (document.documentElement.scrollWidth > innerWidth) errors.push('Horizontal document overflow');
 if (dock.dataset.device !== (compact ? 'mobile' : 'desktop')) errors.push('Incorrect footer layout');
 if (compact) {
   for (const e of [dock,document.querySelector('.terminals-area'),document.querySelector('.mobile-topbar')]) {
     const r = rect(e);
     if (r.left < 15.5 || r.right > innerWidth-15.5 || r.top < 23.5 || r.bottom > innerHeight-33.5) errors.push('Safe-area violation: '+e.className);
   }
   for (const e of [...document.querySelectorAll('.smart-input-tools-surface button')].filter(visible)) {
     const r = rect(e);
     if (r.width < 43.5 || r.height < 43.5) errors.push('Small control: '+e.textContent.trim());
     if (r.left < 15.5 || r.right > innerWidth-15.5) errors.push('Control overflow: '+e.textContent.trim());
   }
   for (const group of document.querySelectorAll('.touch-group')) {
     const tops = [...group.querySelectorAll('button')].filter(visible).map(e=>rect(e).top);
     if (new Set(tops).size > 1) errors.push('Split key group: '+group.className);
   }
   const send = rect(document.querySelector('.smart-input-send-btn'));
   const field = rect(document.querySelector('.smart-input-textarea'));
   if (Math.abs(send.bottom-field.bottom) > 1) errors.push('Send button not aligned with prompt');
 }
 return JSON.stringify({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,coarse:matchMedia('(pointer:coarse)').matches,hover:matchMedia('(hover:hover)').matches,layout:dock.dataset.device,errors});
})()
'@
$rows = @()
try {
    foreach ($width in $Widths) {
        mt_viewport -Width $width -Height $Height | Out-Null
        mt_exec $prepare | Out-Null
        $row = mt_exec $measure | ConvertFrom-Json
        if ($row.width -ne $width -or $row.height -ne $Height) { throw "Viewport request was not applied: requested ${width}x${Height}, got $($row.width)x$($row.height)." }
        $rows += $row
    }
    New-Item -ItemType Directory -Force (Split-Path $OutputPath) | Out-Null
    $rows | ConvertTo-Json -Depth 6 | Set-Content $OutputPath
    $failures = @($rows | Where-Object { $_.errors.Count -gt 0 })
    if ($failures.Count -gt 0) { throw ($failures | ConvertTo-Json -Depth 6) }
    Write-Host "Responsive checks passed: $($rows.Count) viewports. Evidence: $OutputPath"
}
finally {
    mt_exec @'
(() => {
 const s = window.__responsiveCheckRestore;
 if (!s) return 'nothing to restore';
 ['top','right','bottom','left'].forEach((side,i)=>{
   const key='--safe-area-inset-'+side;
   if(s.insets[i]) document.documentElement.style.setProperty(key,s.insets[i]); else document.documentElement.style.removeProperty(key);
 });
 const toggle=document.querySelector('.smart-input-tools-toggle');
 const keys=document.querySelector('.smart-input-mobile-touch-toggle');
 if(keys && (keys.getAttribute('aria-pressed')==='true')!==s.keys) keys.click();
 if(toggle && (toggle.getAttribute('aria-expanded')==='true')!==s.tools) toggle.click();
 delete window.__responsiveCheckRestore;
 return 'restored';
})()
'@ | Out-Null
    mt_viewport -Width 0 -Height 0 | Out-Null
}
