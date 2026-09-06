---
layout: default
title: tlbx
---

# tlbx

**Your terminals and coding agents, available in a browser.**

Run coding agents, shells, tests and dev servers on your own computer. Open their sessions from a desktop, tablet or phone. Your work keeps running when you close the browser, while the host stays awake and online.

**Product website:** [tlbx.ai](https://tlbx.ai) — screenshots, architecture, features, and installation.

- normal `Ctrl+V` / `Cmd+V` screenshot paste into terminal CLIs
- multiline prompts, per-session drafts, files, camera input, and scheduled follow-ups
- terminal output, Git changes, agent approvals and app previews in one workspace
- independent tlbx hosts as browser tabs over the network path you choose

Install tlbx:

- macOS/Linux: `curl -fsSL https://get.tlbx.ai/install.sh | bash`
- Windows: `irm https://get.tlbx.ai/install.ps1 | iex`
- Optional prerelease channel: add `--dev` on macOS/Linux or `-Dev` on Windows.
- Source repo: [github.com/tlbx-ai/tlbx](https://github.com/tlbx-ai/tlbx)
- Product website: [tlbx.ai](https://tlbx.ai)
- Product docs: [docs/FEATURES.md](https://github.com/tlbx-ai/tlbx/blob/main/docs/FEATURES.md)

For private remote access, use Tailscale—or an equivalent WireGuard mesh VPN—and open tlbx through the host's private address.

For a temporary local trial, use `npx @tlbx-ai/midterm`. Use the native installer above for a persistent service. The npm launcher is published separately and may lag behind native releases.
