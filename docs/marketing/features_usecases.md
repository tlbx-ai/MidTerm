# MidTerm: 50 Features & 100 Use Cases

Your terminal, anywhere. No BS edition.

---

## 50 Features

### Core Architecture

1. **Single binary** — ~15MB, just drop it and run
2. **Native AOT compiled** — instant startup, no JIT warmup
3. **Cross-platform** — macOS (ARM64/x64), Windows (x64), Linux (x64)
4. **Zero dependencies** — no Node, no Python, no Docker, no runtime
5. **WebSocket multiplexing** — all terminals over one connection
6. **Binary I/O protocol** — efficient 9-byte header, not JSON bloat
7. **JSON state sync** — sidebar updates without polling
8. **Health check endpoint** — `/api/health` for uptime monitoring

### Security

9. **PBKDF2 password hashing** — 100,000 iterations, SHA256, 32-byte salt
10. **HMAC-SHA256 session tokens** — cryptographically signed, not guessable
11. **3-week sliding expiry** — stay logged in, but with limits
12. **Rate limiting** — 5 fails = 30s lockout, 10 fails = 5min lockout
13. **Mandatory password** — can't skip during install, we're not playing
14. **In-browser password change** — Settings > Security, no CLI needed
15. **Security warning banner** — yells at you if auth is disabled

### Terminal Capabilities

16. **Multi-session** — unlimited terminals, one URL
17. **Any shell** — zsh, bash, PowerShell 7, Windows PowerShell, CMD
18. **Manual resize** — ⤢ button fits terminal to current screen
19. **10,000 line scrollback** — configurable 500-100,000
20. **4 themes** — Dark, Light, Solarized Dark, Solarized Light
21. **3 cursor styles** — bar, block, underline (with optional blink)
22. **Font size 8-24px** — your eyes, your rules
23. **4 font families** — Cascadia Code, Cascadia Code SemiBold, JetBrains Mono, Terminus
24. **Bell options** — desktop notification, sound, visual flash, or off
25. **Copy-on-select** — highlight = copied, like God intended
26. **Right-click paste** — terminal veteran muscle memory respected
27. **Terminal search** — Ctrl+F / Cmd+F, with match count

### UI/UX

28. **Collapsible sidebar** — hide it when you need screen real estate
29. **Mobile responsive** — actually usable on phones, not just "technically works"
30. **Hamburger menu** — mobile nav that doesn't suck
31. **Inline session rename** — click the name, type, done
32. **Connection status indicator** — green = good, red = reconnecting
33. **Tabbed settings panel** — organized, not a wall of checkboxes
34. **Update notification** — amber glow when new version drops
35. **Changelog viewer** — see what's new without leaving the app
36. **Network interfaces display** — shows your IPs for remote access
37. **Empty state with CTA** — "No terminals, click + to start"

### Installation & Updates

38. **One-liner install** — `curl ... | bash` or `irm ... | iex`
39. **System service mode** — auto-start on boot, always-on access
40. **User install** — no admin required, your home dir
41. **Auto-update from UI** — click button, wait, done
42. **Live restart** — page auto-reloads when server comes back
43. **CLI update commands** — `--check-update` and `--update` flags
44. **Password preserved** — updates don't nuke your settings

### Remote Access

45. **HTTP/WebSocket** — works where SSH and VPN don't
46. **Tailscale ready** — install Tailscale, access via `http://your-machine:2000`
47. **Cloudflare Tunnel ready** — free, no port forwarding
48. **Reverse proxy ready** — nginx, Caddy, Traefik, whatever
49. **Configurable bind** — `--bind 0.0.0.0` or `127.0.0.1`
50. **Configurable port** — `--port 2000` or whatever you want

---

## 100 Use Cases

Raw. Real. No corporate personas.

---

### AI Agent Users (1-35)

**1.**
- Claude Code is chewing through a massive refactor
- Meeting starts in 5 minutes, can't just leave it running unattended
- Pull up MidTerm on phone, keep an eye on it, answer questions when it asks

**2.**
- Kicked off Aider to implement a new feature before lunch
- Get to the restaurant, realize you forgot to check if it had questions
- Open iPad, navigate to MidTerm, see it waiting for input, type "yes", eat in peace

**3.**
- Running Claude Code overnight on a complex codebase migration
- Wake up at 3am (you know you will)
- Check from bed on your phone — it's still going, everything's fine, go back to sleep

**4.**
- At the airport, 2 hour delay, laptop battery dying
- Agent is running on your home workstation
- Use the airport's crappy WiFi and your phone to monitor progress

**5.**
- Codex CLI is generating tests for an entire module
- Kid needs to be picked up from school
- Glance at your watch... wait no, glance at MidTerm on your phone in the school parking lot

**6.**
- Pair programming with Claude Code, going back and forth
- Need to step away for a coffee
- Come back and the session is exactly where you left it, not crashed, not timed out

**7.**
- Old iPad Pro collecting dust in a drawer
- Prop it up next to your monitor as a dedicated Claude Code watcher
- Main screen for actual coding, iPad for agent supervision

**8.**
- SSH to your dev machine from coffee shop
- Corporate firewall blocks it
- MidTerm over HTTP works fine, Claude Code still running

**9.**
- Hotel WiFi in Vegas during a conference
- SSH? Blocked. VPN? Blocked. Tailscale? Somehow blocked.
- MidTerm on port 443 with Cloudflare Tunnel? Works.

**10.**
- Aider mid-refactor when your laptop decides to restart for updates
- Panic mode: did I lose everything?
- No. Aider's still running on your desktop. Open browser. There it is.

**11.**
- Context window compression hit your Claude Code session
- It started rewriting code you already fixed together
- At least you can see it happening from your phone and abort before it commits

**12.**
- Running multiple Claude Code sessions across different projects
- Switch between them in one browser window
- No alt-tabbing through terminal windows

**13.**
- Demo-ing AI-assisted coding to your team
- Share your screen, show MidTerm, create a terminal
- Everyone watches Claude Code work in real-time

**14.**
- It's 11pm, you're in bed, Claude Code should be finishing up
- Check from phone: 87% through the files
- Close eyes, check again in 20 min, done

**15.**
- Aider asked a clarification question 45 minutes ago
- You were in a meeting, had no idea
- With MidTerm push notifications (bell setting), you would've known

**16.**
- Partner asks "are you still working?"
- "No, I'm watching Claude work"
- Show them the iPad. They still don't get it but at least you're not typing.

**17.**
- Two monitors at work: code editor on one, MidTerm on the other
- Claude Code is your third pair of eyes
- You're basically managing an AI employee now

**18.**
- Flying cross-country, agent running at home
- Airplane WiFi is barely functional
- MidTerm's WebSocket reconnects gracefully when packets drop

**19.**
- Gym session, phone mounted on treadmill
- Glance over between sets
- Claude Code just finished, no errors, nice

**20.**
- Shower thought: "wait, did I tell it to skip the tests?"
- Grab phone, still dripping
- Check MidTerm. Phew, tests are running.

**21.**
- Waiting room at the doctor's office
- Bored. Check Claude Code.
- It's asking about a design decision. Type response. Feel productive.

**22.**
- Date night, but you kicked off a huge migration
- "Just need to check one thing" — 5 seconds on phone
- "All good, where were we?"

**23.**
- Claude Code has been running for 6 hours
- You've moved from desk → lunch → meeting → home
- Same session, never interrupted

**24.**
- IDE extension crashed (again)
- Good thing you started Claude Code in MidTerm instead
- Session survives because it's not tied to VS Code's lifecycle

**25.**
- Multiple people asking you to check something for them
- Show them MidTerm URL instead
- "Here, watch Claude work, I'll be back"

**26.**
- Codex is writing database migrations
- You want to see each one before it runs
- Check in periodically from anywhere, approve/reject as needed

**27.**
- Pair programming with someone remote
- They don't have Claude Code set up
- Share MidTerm URL, they watch, you drive

**28.**
- Running Aider with voice mode
- Walk around your apartment giving it instructions
- Check visual output on tablet across the room

**29.**
- It's Saturday, you promised no work
- But Claude Code is finishing a week's worth of tests
- Technically you're not working, the AI is. You're just... supervising.

**30.**
- MacBook Pro sleeping to save battery
- Claude Code running on always-on Linux server
- Access it from anything with a browser

**31.**
- Power outage at home
- But your MidTerm server is on a UPS and LTE backup
- Check from phone on cell data, agent still churning

**32.**
- Chromebook at a family member's house
- No dev tools installed
- MidTerm URL, password, boom — there's your agent

**33.**
- Running Claude Code in a container
- SSH into the container? Annoying.
- MidTerm inside the container, port-forward 2000, done.

**34.**
- Refactor taking longer than expected
- Need to give ETA to PM
- Check MidTerm progress, count remaining files, give realistic answer

**35.**
- First time using an AI coding agent
- Terrified of leaving it alone
- MidTerm lets you check in constantly without being chained to desk

---

### Long-Running Tasks (36-55)

**36.**
- `npm install` in a legacy project with 2000 deps
- Takes 15 minutes, you've got other things to do
- Check progress from anywhere, no surprises

**37.**
- Test suite running for 3 hours
- Don't want to wait at desk
- MidTerm lets you cook dinner and still know when tests fail

**38.**
- Docker build with 50 layers
- Each one takes forever
- Monitor from couch, get notified when it's pushing to registry

**39.**
- Watching CI/CD logs in real-time
- Your CI provider's web UI is sluggish
- Tail logs in terminal via MidTerm instead, faster

**40.**
- Database migration on prod
- You're sweating, it's been 2 hours
- Watch from the calm of another room, stress-eating chips

**41.**
- Data import job processing 10 million rows
- Progress bar crawling
- Leave desk, come back, progress bar slightly less awful

**42.**
- `cargo build` on a large Rust project
- First time? See you in 30 minutes.
- MidTerm lets you exist somewhere else during that time

**43.**
- ML model training on local GPU
- 12 hours estimated
- Check validation loss from bed at midnight

**44.**
- Webpack build that somehow takes 4 minutes every time
- You've tried everything
- At least now you can make coffee while it runs

**45.**
- Production deploy script with 20 steps
- Each one could fail
- Watch from phone, ready to rollback if needed

**46.**
- `git clone` of a massive monorepo
- 10GB of history
- Go get lunch, check when you're back

**47.**
- Package publishing to npm
- 2FA prompts, confirmations, waiting for propagation
- Handle it from wherever you are

**48.**
- Running benchmarks overnight
- Results ready in the morning
- Check from phone before even getting out of bed

**49.**
- Log aggregation script churning through TB of data
- "Processing file 47382 of 183921"
- You don't need to physically witness this

**50.**
- Backup script running for hours
- Paranoid it'll fail silently
- Keep a MidTerm tab open, glance occasionally

**51.**
- Running migrations on a sharded database
- Shard 7 of 24, 2 hours elapsed
- Grab dinner, the terminal will still be there

**52.**
- `terraform apply` touching 500 resources
- Each one takes time
- Watch the carnage unfold from anywhere

**53.**
- Video encoding job for 4K footage
- 8 hours, no exaggeration
- Check on it from your phone before bed

**54.**
- Reindexing Elasticsearch
- "Approximately 6 hours remaining"
- Cool, I'll be back next year

**55.**
- Ansible playbook provisioning 50 servers
- Tasks complete one by one
- Watch the progress on your tablet while pretending to pay attention in a meeting

---

### TUI Apps (56-70)

**56.**
- htop on your home server
- CPU spikes while you're at work
- Quick check from phone: it's ffmpeg transcoding, all good

**57.**
- vim session with 15 files open
- Laptop dies unexpectedly
- Session still there when you open MidTerm from another device

**58.**
- lazygit is life
- Need to push that hotfix from your phone
- It's clunky on mobile but it works

**59.**
- k9s watching your Kubernetes cluster
- Pod restarts happening
- See it live from anywhere

**60.**
- btop because htop wasn't pretty enough
- Flex on yourself from multiple devices
- Your server looks good in orange

**61.**
- ranger for file management
- Copying 100GB between directories
- Check progress from phone

**62.**
- nnn for that minimalist file browsing
- Navigate directories from anywhere
- Directories don't care where you are

**63.**
- ncdu finding what's eating disk space
- Takes forever to scan
- Let it run, check results later

**64.**
- tmux inside MidTerm (inception?)
- Your tmux session now accessible via browser
- SSH not required anymore

**65.**
- tig for git history browsing
- Scroll through commits from tablet
- Touch scrolling actually works

**66.**
- mc (Midnight Commander) because you're that kind of dev
- Dual pane file management from your couch
- The 90s called, they want their browser back

**67.**
- nvim with full plugin setup
- Your whole dev environment in a terminal
- Access from any device, same config

**68.**
- glances for that extra system monitoring bling
- Docker stats, network, everything
- Dashboard on your secondary screen (iPad)

**69.**
- bmon watching network bandwidth
- Something downloading at 900Mbps
- Probably Windows Update. Again.

**70.**
- w3m or lynx for text-mode browsing
- You're either a purist or broken inside
- Either way, MidTerm supports your lifestyle

---

### Remote Work Scenarios (71-85)

**71.**
- Monday: home office
- Tuesday: coffee shop
- Same terminal session, no VPN drama

**72.**
- Desk for deep work
- Couch for emails
- Phone for quick checks
- All accessing the same terminals

**73.**
- Work laptop at office
- Personal laptop at home
- Zero sync needed, it's just a URL

**74.**
- Main display for code
- iPad as terminal monitor
- One brain, two screens

**75.**
- Standing desk getting tiring
- Move to couch for a bit
- Take your terminals with you (via phone)

**76.**
- Partner using the office
- Relocate to bedroom
- Terminals don't care about real estate disputes

**77.**
- Internet outage at home
- Tether to phone
- MidTerm reconnects automatically

**78.**
- Corporate VPN times out every 30 minutes
- SSH sessions die
- MidTerm doesn't care, HTTP stays up

**79.**
- Working from parents' house over holidays
- Their network is weird, everything's blocked
- MidTerm over HTTPS still works

**80.**
- Coworking space with aggressive firewall
- SSH? Nope. VPN? Nope.
- MidTerm with Cloudflare Tunnel? Yep.

**81.**
- Train with spotty WiFi
- Session keeps reconnecting
- Never lose state, just temporarily blind

**82.**
- Library computer, can't install anything
- Browser works though
- MidTerm requires nothing installed locally

**83.**
- Friend's laptop, need to check something quick
- Don't want to SSH and leave keys
- MidTerm, incognito tab, logout when done

**84.**
- Multiple client projects, multiple machines
- Each has its own MidTerm instance
- Bookmark them all, switch contexts via browser tabs

**85.**
- "I'll just work from the beach"
- Beach WiFi is somehow good enough
- Postcard-worthy coding session

---

### DevOps/SRE (86-95)

**86.**
- Prod is on fire
- You're at the grocery store
- Pull up logs in MidTerm, assess damage, coordinate via Slack

**87.**
- 3am PagerDuty alert
- Don't even need to get out of bed
- Phone, MidTerm, `kubectl`, back to sleep

**88.**
- tail -f production logs
- Leave it running in a MidTerm tab
- Check whenever paranoia strikes

**89.**
- SSH bastion host is a pain
- Put MidTerm behind the bastion instead
- One less hop to manage

**90.**
- Container keeps restarting
- `docker logs -f` in MidTerm
- Watch it fail repeatedly from anywhere

**91.**
- Need to SSH to 10 servers
- MidTerm tab per server
- All accessible from one browser

**92.**
- On-call week
- MidTerm on phone means you can actually leave the house
- The pager follows you anyway, might as well have terminals too

**93.**
- SSL cert expiring
- Need to renew from wherever you are
- MidTerm + certbot = renewed

**94.**
- Database locked up
- Need to kill a query
- Phone, MidTerm, psql, `SELECT pg_cancel_backend(...)`, done

**95.**
- Capacity planning review
- htop showing historical peak usage
- Present from tablet in meeting room

---

### Edge Cases & Delighters (96-100)

**96.**
- Local meetup demo
- "How do you manage terminals remotely?"
- Open MidTerm on your phone, jaws drop

**97.**
- Teaching a junior dev
- Share MidTerm URL, let them watch you work
- No screen sharing lag, no Zoom, just terminal

**98.**
- Client wants to see progress
- "Here's a read-only view of the build"
- (Note: MidTerm isn't read-only but you can just... not tell them the password)

**99.**
- Shower, brilliant idea strikes
- Run out, still wet, grab phone
- Quick terminal command before the idea evaporates

**100.**
- You built something cool
- Want to access it from a smart fridge (it has a browser)
- MidTerm doesn't judge

---

## The Vibe

You're not chained to a desk anymore.

Your terminals run where your power is. You access them from wherever you are.

HTTP goes where SSH fears to tread.

**15MB. Zero dependencies. Any browser.**

That's it. That's the pitch.
