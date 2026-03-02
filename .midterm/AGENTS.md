<!-- guidance-version: 3 -->
# MidTerm Agent Workflows

Source helpers first: `. .midterm/mtcli.sh`

## Debug a visual bug

mt_outline → mt_css ".element" "color,background,display,margin,padding" → fix code → mt_reload → re-check mt_css

## Fill and submit a form

mt_forms → mt_fill "#user" "val" → mt_fill "#pass" "val" → mt_click "button[type=submit]" → mt_wait ".dashboard"

## Execute JavaScript

mt_exec "JSON.stringify({href: location.href, title: document.title})"
echo 'complex code' | mt_exec

## Debug proxy issues

mt_proxylog 10 — check status codes, upstream URLs, WebSocket connections
mt_log error — check browser console

## Tips

- mt_outline is 10x smaller than mt_query — always start there
- mt_query SEL true returns text-only (no HTML tags)
- Chain commands: mt_fill "#a" "x" && mt_fill "#b" "y" && mt_click "#submit"
- If mt_status shows "disconnected", the web preview panel needs to be open in MidTerm