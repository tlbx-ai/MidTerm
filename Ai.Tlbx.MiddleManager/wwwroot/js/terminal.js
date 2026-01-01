/**
 * MiddleManager Terminal Client
 *
 * Web-based terminal multiplexer frontend using xterm.js.
 * Communicates with the server via two WebSocket connections:
 * - State WebSocket (/ws/state): Receives session list updates as JSON
 * - Mux WebSocket (/ws/mux): Binary protocol for terminal I/O
 */
(function() {
    'use strict';

    // ========================================================================
    // Constants
    // ========================================================================

    /** Mux protocol: Header size in bytes (1 byte type + 8 byte session ID) */
    var MUX_HEADER_SIZE = 9;

    /** Mux protocol message types */
    var MUX_TYPE_OUTPUT = 0x01;  // Server -> Client: Terminal output
    var MUX_TYPE_INPUT  = 0x02;  // Client -> Server: Terminal input
    var MUX_TYPE_RESIZE = 0x03;  // Client -> Server: Terminal resize
    var MUX_TYPE_INIT   = 0xFF;  // Server -> Client: Client ID assignment

    /** Terminal color themes */
    var THEMES = {
        dark: {
            background: '#1A1B26',
            foreground: '#C0CAF5',
            cursor: '#C0CAF5',
            cursorAccent: '#1A1B26',
            selectionBackground: '#283457'
        },
        light: {
            background: '#D5D6DB',
            foreground: '#343B58',
            cursor: '#343B58',
            cursorAccent: '#D5D6DB',
            selectionBackground: '#9AA5CE'
        },
        solarizedDark: {
            background: '#002b36',
            foreground: '#839496',
            cursor: '#93a1a1',
            cursorAccent: '#002b36',
            selectionBackground: '#073642'
        },
        solarizedLight: {
            background: '#fdf6e3',
            foreground: '#657b83',
            cursor: '#586e75',
            cursorAccent: '#fdf6e3',
            selectionBackground: '#eee8d5'
        }
    };

    // ========================================================================
    // Application State
    // ========================================================================

    var sessions = [];              // List of sessions from server
    var activeSessionId = null;     // Currently displayed session
    var currentSettings = null;     // User settings from server
    var settingsOpen = false;       // Settings panel visibility
    var sidebarOpen = false;        // Mobile sidebar visibility
    var clientId = null;            // This client's unique ID (assigned by server)
    var updateInfo = null;          // Available update info from server

    // WebSocket connections
    var stateWs = null;
    var stateReconnectTimer = null;
    var stateReconnectDelay = 1000;
    var stateWsConnected = false;
    var muxWs = null;
    var muxReconnectTimer = null;
    var muxReconnectDelay = 1000;
    var muxWsConnected = false;

    // Per-session terminal state: { terminal, fitAddon, container, serverCols, serverRows }
    var sessionTerminals = new Map();
    // Track sessions created in this browser session (skip buffer fetch for these)
    var newlyCreatedSessions = new Set();

    // ========================================================================
    // DOM Element References
    // ========================================================================

    var sessionList = null;
    var sessionCount = null;
    var terminalsArea = null;
    var emptyState = null;
    var mobileTitle = null;
    var app = null;
    var sidebarOverlay = null;
    var settingsView = null;
    var settingsBtn = null;

    // ========================================================================
    // Initialization
    // ========================================================================

    // Apply saved theme immediately to prevent flash of unstyled content
    (function() {
        var savedTheme = getCookie('mm-theme');
        if (savedTheme && THEMES[savedTheme]) {
            document.documentElement.style.setProperty('--terminal-bg', THEMES[savedTheme].background);
        }
    })();

    document.addEventListener('DOMContentLoaded', init);

    function init() {
        // Cache DOM elements
        sessionList = document.getElementById('session-list');
        sessionCount = document.getElementById('session-count');
        terminalsArea = document.querySelector('.terminals-area');
        emptyState = document.getElementById('empty-state');
        mobileTitle = document.getElementById('mobile-title');
        app = document.getElementById('app');
        sidebarOverlay = document.getElementById('sidebar-overlay');
        settingsView = document.getElementById('settings-view');
        settingsBtn = document.getElementById('btn-settings');

        // Connect to server
        connectStateWebSocket();
        connectMuxWebSocket();
        checkSystemHealth();

        // Setup UI
        bindEvents();
        setupResizeObserver();
        setupVisualViewport();

        // Load data
        fetchVersion();
        fetchNetworks();
        fetchSettings();
        requestNotificationPermission();
    }

    // ========================================================================
    // Storage Helpers
    // ========================================================================

    function setCookie(name, value, days) {
        days = days || 365;
        var expires = new Date(Date.now() + days * 864e5).toUTCString();
        document.cookie = name + '=' + encodeURIComponent(value) +
            '; expires=' + expires + '; path=/; SameSite=Lax';
    }

    function getCookie(name) {
        var match = document.cookie.split('; ').find(function(row) {
            return row.startsWith(name + '=');
        });
        return match ? decodeURIComponent(match.split('=')[1]) : null;
    }

    function getClipboardStyle() {
        var setting = currentSettings && currentSettings.clipboardShortcuts || 'auto';
        if (setting !== 'auto') return setting;
        var platform = navigator.platform || '';
        return platform.startsWith('Win') ? 'windows' : 'unix';
    }

    // ========================================================================
    // WebSocket: State Channel
    // ========================================================================

    /**
     * Connects to the state WebSocket which provides real-time session list updates.
     * Automatically reconnects with exponential backoff on disconnect.
     */
    function connectStateWebSocket() {
        var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        stateWs = new WebSocket(protocol + '//' + location.host + '/ws/state');

        stateWs.onopen = function() {
            console.log('State WebSocket connected');
            stateReconnectDelay = 1000;
            stateWsConnected = true;
            updateConnectionStatus();
        };

        stateWs.onmessage = function(event) {
            try {
                var data = JSON.parse(event.data);
                var sessionList = data.sessions && data.sessions.sessions ? data.sessions.sessions : [];
                handleStateUpdate(sessionList);
                handleUpdateInfo(data.update);
            } catch (e) {
                console.error('Error parsing state:', e);
            }
        };

        stateWs.onclose = function() {
            console.log('State WebSocket closed, reconnecting...');
            stateWsConnected = false;
            updateConnectionStatus();
            scheduleReconnect('state');
        };

        stateWs.onerror = function(e) {
            console.error('State WebSocket error:', e);
        };
    }

    function handleStateUpdate(newSessions) {
        // Remove terminals for deleted sessions
        var newIds = new Set(newSessions.map(function(s) { return s.id; }));
        sessionTerminals.forEach(function(_, id) {
            if (!newIds.has(id)) {
                destroyTerminalForSession(id);
                newlyCreatedSessions.delete(id);
            }
        });

        // Update server dimensions for existing sessions
        newSessions.forEach(function(session) {
            var state = sessionTerminals.get(session.id);
            if (state && (state.serverCols !== session.cols || state.serverRows !== session.rows)) {
                state.serverCols = session.cols;
                state.serverRows = session.rows;
                state.fitAddon.fit();
            }
        });

        sessions = newSessions;
        renderSessionList();
        updateEmptyState();

        // Auto-select first session if none active
        if (!activeSessionId && sessions.length > 0) {
            selectSession(sessions[0].id);
        }

        // Handle active session being deleted
        if (activeSessionId && !sessions.find(function(s) { return s.id === activeSessionId; })) {
            activeSessionId = null;
            if (sessions.length > 0) {
                selectSession(sessions[0].id);
            }
        }

        updateMobileTitle();
    }

    function handleUpdateInfo(update) {
        var hadUpdate = updateInfo && updateInfo.available;
        updateInfo = update;
        renderUpdatePanel();

        // Show notification when update first becomes available
        if (update && update.available && !hadUpdate) {
            console.log('Update available:', update.currentVersion, '->', update.latestVersion);
        }
    }

    function renderUpdatePanel() {
        var panel = document.getElementById('update-panel');
        if (!panel) return;

        if (!updateInfo || !updateInfo.available) {
            panel.classList.add('hidden');
            return;
        }

        panel.classList.remove('hidden');
        var currentEl = panel.querySelector('.update-current');
        var latestEl = panel.querySelector('.update-latest');
        var noteEl = panel.querySelector('.update-note');
        var headerEl = panel.querySelector('.update-header');

        if (currentEl) currentEl.textContent = updateInfo.currentVersion;
        if (latestEl) latestEl.textContent = updateInfo.latestVersion;

        if (updateInfo.sessionsPreserved) {
            if (headerEl) headerEl.textContent = 'Quick Update';
            if (noteEl) {
                noteEl.textContent = 'Sessions will stay alive';
                noteEl.classList.add('update-note-safe');
                noteEl.classList.remove('update-note-warning');
            }
        } else {
            if (headerEl) headerEl.textContent = 'Update Available';
            if (noteEl) {
                noteEl.textContent = 'Save your work - sessions will restart';
                noteEl.classList.add('update-note-warning');
                noteEl.classList.remove('update-note-safe');
            }
        }
    }

    function applyUpdate() {
        if (!updateInfo || !updateInfo.available) return;

        var panel = document.getElementById('update-panel');
        var btn = panel ? panel.querySelector('.update-btn') : null;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Updating...';
        }

        fetch('/api/update/apply', { method: 'POST' })
            .then(function(r) {
                if (r.ok) {
                    if (btn) btn.textContent = 'Restarting...';
                } else {
                    if (btn) {
                        btn.disabled = false;
                        btn.textContent = 'Update & Restart';
                    }
                    console.error('Update failed');
                }
            })
            .catch(function(e) {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = 'Update & Restart';
                }
                console.error('Update error:', e);
            });
    }

    function checkForUpdates() {
        var btn = document.getElementById('btn-check-updates');
        var statusEl = document.getElementById('update-status');

        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Checking...';
        }

        fetch('/api/update/check')
            .then(function(r) { return r.json(); })
            .then(function(update) {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = 'Check for Updates';
                }

                handleUpdateInfo(update);

                if (statusEl) {
                    statusEl.classList.remove('hidden');
                    if (update && update.available) {
                        statusEl.className = 'update-status update-status-available';
                        var msg = 'Update available: v' + update.latestVersion;
                        if (update.sessionsPreserved) {
                            msg += ' (sessions will stay alive)';
                        } else {
                            msg += ' (sessions will restart)';
                        }
                        statusEl.textContent = msg;
                    } else {
                        statusEl.className = 'update-status update-status-current';
                        statusEl.textContent = 'You are running the latest version';
                    }
                }
            })
            .catch(function(e) {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = 'Check for Updates';
                }
                if (statusEl) {
                    statusEl.classList.remove('hidden');
                    statusEl.className = 'update-status update-status-error';
                    statusEl.textContent = 'Failed to check for updates';
                }
                console.error('Update check error:', e);
            });
    }

    function showChangelog() {
        var modal = document.getElementById('changelog-modal');
        var body = document.getElementById('changelog-body');

        if (modal) modal.classList.remove('hidden');
        if (body) body.innerHTML = '<div class="changelog-loading">Loading changelog...</div>';

        fetch('https://api.github.com/repos/AiTlbx/MiddleManager/releases?per_page=10')
            .then(function(r) { return r.json(); })
            .then(function(releases) {
                if (!body) return;

                if (!releases || releases.length === 0) {
                    body.innerHTML = '<p>No releases found.</p>';
                    return;
                }

                var html = '';
                releases.forEach(function(release) {
                    var version = release.tag_name || 'Unknown';
                    var date = release.published_at ? new Date(release.published_at).toLocaleDateString() : '';
                    var notes = release.body || 'No release notes.';

                    html += '<div class="changelog-release">';
                    html += '<div class="changelog-version">' + escapeHtml(version) + '</div>';
                    if (date) html += '<div class="changelog-date">' + escapeHtml(date) + '</div>';
                    html += '<div class="changelog-notes">' + formatMarkdown(notes) + '</div>';
                    html += '</div>';
                });

                body.innerHTML = html;
            })
            .catch(function(e) {
                if (body) {
                    body.innerHTML = '<p class="changelog-error">Failed to load changelog. <a href="https://github.com/AiTlbx/MiddleManager/releases" target="_blank">View on GitHub</a></p>';
                }
                console.error('Changelog error:', e);
            });
    }

    function closeChangelog() {
        var modal = document.getElementById('changelog-modal');
        if (modal) modal.classList.add('hidden');
    }

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function formatMarkdown(text) {
        // Basic markdown: headers, bold, links, lists
        return escapeHtml(text)
            .replace(/^### (.+)$/gm, '<h4>$1</h4>')
            .replace(/^## (.+)$/gm, '<h3>$1</h3>')
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
            .replace(/^- (.+)$/gm, '<li>$1</li>')
            .replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>')
            .replace(/\n/g, '<br>');
    }

    // ========================================================================
    // WebSocket: Mux Channel (Binary Protocol)
    // ========================================================================

    /**
     * Connects to the mux WebSocket for terminal I/O.
     * Uses a binary protocol with 9-byte header (1 byte type + 8 byte session ID).
     */
    function connectMuxWebSocket() {
        var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        muxWs = new WebSocket(protocol + '//' + location.host + '/ws/mux');
        muxWs.binaryType = 'arraybuffer';

        muxWs.onopen = function() {
            console.log('Mux WebSocket connected');
            muxReconnectDelay = 1000;
            muxWsConnected = true;
            updateConnectionStatus();
        };

        muxWs.onmessage = function(event) {
            if (!(event.data instanceof ArrayBuffer)) return;

            var data = new Uint8Array(event.data);
            if (data.length < MUX_HEADER_SIZE) return;

            var type = data[0];
            var sessionId = decodeSessionId(data, 1);
            var payload = data.slice(MUX_HEADER_SIZE);

            if (type === MUX_TYPE_INIT) {
                clientId = new TextDecoder().decode(payload);
                console.log('Mux client ID:', clientId);
                renderSessionList();
                return;
            }

            if (type === MUX_TYPE_OUTPUT) {
                if (payload.length < 50) {
                    console.log('[OUTPUT] Received:', Array.from(payload).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(' '));
                }
                var state = sessionTerminals.get(sessionId);
                if (state) {
                    state.terminal.write(payload);
                }
            }
        };

        muxWs.onclose = function() {
            console.log('Mux WebSocket closed, reconnecting...');
            muxWsConnected = false;
            updateConnectionStatus();
            scheduleReconnect('mux');
        };

        muxWs.onerror = function(e) {
            console.error('Mux WebSocket error:', e);
        };
    }

    function sendInput(sessionId, data) {
        if (!muxWs || muxWs.readyState !== WebSocket.OPEN) return;

        var payload = new TextEncoder().encode(data);
        console.log('[INPUT] Sending:', Array.from(payload).map(function(b) { return b.toString(16).padStart(2, '0'); }).join(' '));
        var frame = new Uint8Array(MUX_HEADER_SIZE + payload.length);
        frame[0] = MUX_TYPE_INPUT;
        encodeSessionId(frame, 1, sessionId);
        frame.set(payload, MUX_HEADER_SIZE);
        muxWs.send(frame);
    }

    function sendResize(sessionId, terminal) {
        if (!muxWs || muxWs.readyState !== WebSocket.OPEN) return;

        var frame = new Uint8Array(MUX_HEADER_SIZE + 4);
        frame[0] = MUX_TYPE_RESIZE;
        encodeSessionId(frame, 1, sessionId);
        // Encode cols and rows as little-endian 16-bit integers
        frame[MUX_HEADER_SIZE] = terminal.cols & 0xFF;
        frame[MUX_HEADER_SIZE + 1] = (terminal.cols >> 8) & 0xFF;
        frame[MUX_HEADER_SIZE + 2] = terminal.rows & 0xFF;
        frame[MUX_HEADER_SIZE + 3] = (terminal.rows >> 8) & 0xFF;
        muxWs.send(frame);

        // Update local tracking
        var state = sessionTerminals.get(sessionId);
        if (state) {
            state.serverCols = terminal.cols;
            state.serverRows = terminal.rows;
        }
    }

    /** Encode 8-character session ID into buffer at offset */
    function encodeSessionId(buffer, offset, sessionId) {
        for (var i = 0; i < 8; i++) {
            buffer[offset + i] = i < sessionId.length ? sessionId.charCodeAt(i) : 0;
        }
    }

    /** Decode 8-character session ID from buffer at offset */
    function decodeSessionId(buffer, offset) {
        var chars = [];
        for (var i = 0; i < 8; i++) {
            if (buffer[offset + i] !== 0) {
                chars.push(String.fromCharCode(buffer[offset + i]));
            }
        }
        return chars.join('');
    }

    function scheduleReconnect(type) {
        if (type === 'state') {
            clearTimeout(stateReconnectTimer);
            stateReconnectTimer = setTimeout(function() {
                stateReconnectDelay = Math.min(stateReconnectDelay * 1.5, 30000);
                connectStateWebSocket();
            }, stateReconnectDelay);
        } else {
            clearTimeout(muxReconnectTimer);
            muxReconnectTimer = setTimeout(function() {
                muxReconnectDelay = Math.min(muxReconnectDelay * 1.5, 30000);
                connectMuxWebSocket();
            }, muxReconnectDelay);
        }
    }

    function updateConnectionStatus() {
        var indicator = document.getElementById('connection-status');
        if (!indicator) return;

        var status;
        var text;
        if (stateWsConnected && muxWsConnected) {
            status = 'connected';
            text = '';
        } else if (!stateWsConnected && !muxWsConnected) {
            status = 'disconnected';
            text = 'Server disconnected';
        } else {
            status = 'reconnecting';
            text = 'Reconnecting...';
        }

        indicator.className = 'connection-status ' + status;
        indicator.textContent = text;
    }

    function updateHostStatus() {
        // No-op: Host connection tracking removed (always connected in con-host mode)
    }

    function checkSystemHealth() {
        // No-op: Host health check removed (always connected in con-host mode)
    }

    function fetchSystemStatus() {
        var container = document.getElementById('system-status-content');
        if (!container) return;

        fetch('/api/health')
            .then(function(response) { return response.json(); })
            .then(function(health) {
                var statusClass = health.healthy ? 'status-healthy' : 'status-error';
                var statusText = health.healthy ? 'Healthy' : 'Unhealthy';
                var uptimeStr = formatUptime(health.uptimeSeconds);

                container.innerHTML =
                    '<div class="status-grid">' +
                        '<div class="status-item">' +
                            '<span class="status-label">Status</span>' +
                            '<span class="status-value ' + statusClass + '">' + statusText + '</span>' +
                        '</div>' +
                        '<div class="status-item">' +
                            '<span class="status-label">Mode</span>' +
                            '<span class="status-value">' + health.mode + '</span>' +
                        '</div>' +
                        '<div class="status-item">' +
                            '<span class="status-label">Sessions</span>' +
                            '<span class="status-value">' + health.sessionCount + '</span>' +
                        '</div>' +
                        '<div class="status-item">' +
                            '<span class="status-label">Uptime</span>' +
                            '<span class="status-value">' + uptimeStr + '</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="status-details">' +
                        '<div class="status-detail-row">' +
                            '<span class="detail-label">Platform</span>' +
                            '<span class="detail-value">' + health.platform + '</span>' +
                        '</div>' +
                        '<div class="status-detail-row">' +
                            '<span class="detail-label">Process ID</span>' +
                            '<span class="detail-value">' + health.webProcessId + '</span>' +
                        '</div>' +
                    '</div>';
            })
            .catch(function(err) {
                container.innerHTML = '<div class="status-error-msg">Failed to load system status: ' + err.message + '</div>';
            });
    }

    function formatUptime(seconds) {
        if (seconds < 60) return seconds + 's';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
        var hours = Math.floor(seconds / 3600);
        var mins = Math.floor((seconds % 3600) / 60);
        if (hours < 24) return hours + 'h ' + mins + 'm';
        var days = Math.floor(hours / 24);
        return days + 'd ' + (hours % 24) + 'h';
    }

    // ========================================================================
    // Terminal Management
    // ========================================================================

    function getTerminalOptions() {
        var isMobile = window.innerWidth <= 768;
        var baseFontSize = (currentSettings && currentSettings.fontSize) || 14;
        var fontSize = isMobile ? Math.max(baseFontSize - 2, 10) : baseFontSize;
        var themeName = (currentSettings && currentSettings.theme) || 'dark';

        return {
            cursorBlink: currentSettings ? currentSettings.cursorBlink !== false : true,
            cursorStyle: (currentSettings && currentSettings.cursorStyle) || 'bar',
            fontFamily: "'Cascadia Mono NF', Consolas, 'Courier New', monospace",
            fontSize: fontSize,
            scrollback: (currentSettings && currentSettings.scrollbackLines) || 10000,
            allowProposedApi: true,
            theme: THEMES[themeName] || THEMES.dark
        };
    }

    function createTerminalForSession(sessionId) {
        if (sessionTerminals.has(sessionId)) {
            return sessionTerminals.get(sessionId);
        }

        // Create container
        var container = document.createElement('div');
        container.className = 'terminal-container hidden';
        container.id = 'terminal-' + sessionId;
        terminalsArea.appendChild(container);

        // Initialize xterm.js
        var terminal = new Terminal(getTerminalOptions());
        var fitAddon = new FitAddon.FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(container);

        // Wire up events
        terminal.onData(function(data) {
            sendInput(sessionId, data);
        });

        terminal.onBell(function() {
            showBellNotification(sessionId);
        });

        terminal.onSelectionChange(function() {
            if (currentSettings && currentSettings.copyOnSelect && terminal.hasSelection()) {
                navigator.clipboard.writeText(terminal.getSelection()).catch(function() {});
            }
        });

        // Keyboard shortcuts for copy/paste
        terminal.attachCustomKeyEventHandler(function(e) {
            if (e.type !== 'keydown') return true;

            var style = getClipboardStyle();

            if (style === 'windows') {
                // Ctrl+C: copy if selected, else let terminal handle (SIGINT)
                if (e.ctrlKey && !e.shiftKey && e.key === 'c') {
                    if (terminal.hasSelection()) {
                        navigator.clipboard.writeText(terminal.getSelection()).catch(function() {});
                        terminal.clearSelection();
                        return false;
                    }
                    return true;
                }
                // Ctrl+V: paste
                if (e.ctrlKey && !e.shiftKey && e.key === 'v') {
                    navigator.clipboard.readText().then(function(text) {
                        if (text) sendInput(sessionId, text);
                    }).catch(function() {});
                    return false;
                }
            } else {
                // Unix: Ctrl+Shift+C to copy
                if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
                    if (terminal.hasSelection()) {
                        navigator.clipboard.writeText(terminal.getSelection()).catch(function() {});
                        terminal.clearSelection();
                    }
                    return false;
                }
                // Unix: Ctrl+Shift+V to paste
                if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
                    navigator.clipboard.readText().then(function(text) {
                        if (text) sendInput(sessionId, text);
                    }).catch(function() {});
                    return false;
                }
            }
            return true;
        });

        // Right-click paste
        container.addEventListener('contextmenu', function(e) {
            if (!currentSettings || currentSettings.rightClickPaste !== false) {
                e.preventDefault();
                navigator.clipboard.readText().then(function(text) {
                    if (text) sendInput(sessionId, text);
                }).catch(function() {});
            }
        });

        var state = {
            terminal: terminal,
            fitAddon: fitAddon,
            container: container,
            serverCols: 0,
            serverRows: 0
        };

        sessionTerminals.set(sessionId, state);
        // Buffer fetch is deferred to selectSession after fit/resize
        return state;
    }

    function fetchAndWriteBuffer(sessionId, terminal) {
        fetch('/api/sessions/' + sessionId + '/buffer')
            .then(function(response) {
                return response.ok ? response.text() : '';
            })
            .then(function(buffer) {
                if (buffer) terminal.write(buffer);
            })
            .catch(function(e) {
                console.error('Error fetching buffer:', e);
            });
    }

    function destroyTerminalForSession(sessionId) {
        var state = sessionTerminals.get(sessionId);
        if (!state) return;

        state.terminal.dispose();
        state.container.remove();
        sessionTerminals.delete(sessionId);
    }

    function applySettingsToTerminals() {
        var options = getTerminalOptions();
        sessionTerminals.forEach(function(state) {
            state.terminal.options.cursorBlink = options.cursorBlink;
            state.terminal.options.cursorStyle = options.cursorStyle;
            state.terminal.options.fontSize = options.fontSize;
            state.terminal.options.theme = options.theme;
            state.fitAddon.fit();
        });
    }

    // ========================================================================
    // Session Management
    // ========================================================================

    function createSession() {
        // Measure dimensions using explicit pixel sizes from container
        var rect = terminalsArea.getBoundingClientRect();
        var cols = 120;
        var rows = 30;

        // Only measure if container has valid dimensions
        if (rect.width > 100 && rect.height > 100) {
            var tempContainer = document.createElement('div');
            tempContainer.style.cssText = 'position:absolute;left:-9999px;width:' + Math.floor(rect.width) + 'px;height:' + Math.floor(rect.height) + 'px;';
            document.body.appendChild(tempContainer);

            try {
                var tempTerminal = new Terminal(getTerminalOptions());
                var tempFitAddon = new FitAddon.FitAddon();
                tempTerminal.loadAddon(tempFitAddon);
                tempTerminal.open(tempContainer);
                tempFitAddon.fit();

                if (tempTerminal.cols > 10 && tempTerminal.rows > 5) {
                    cols = tempTerminal.cols;
                    rows = tempTerminal.rows;
                }

                tempTerminal.dispose();
            } catch (e) {
                console.warn('Dimension measurement failed:', e);
            }

            tempContainer.remove();
        }

        console.log('Creating session with dimensions:', cols, 'x', rows, '(container:', Math.floor(rect.width), 'x', Math.floor(rect.height), 'px)');

        fetch('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Cols: cols, Rows: rows })
        })
            .then(function(r) { return r.json(); })
            .then(function(session) {
                // Mark as newly created - skip buffer fetch since WebSocket will send all output
                newlyCreatedSessions.add(session.id);
                selectSession(session.id);
                closeSidebar();
            })
            .catch(function(e) {
                console.error('Error creating session:', e);
            });
    }

    function selectSession(sessionId) {
        if (settingsOpen) {
            closeSettings();
        }

        // Hide all terminal containers
        sessionTerminals.forEach(function(state) {
            state.container.classList.add('hidden');
        });

        activeSessionId = sessionId;

        var state = createTerminalForSession(sessionId);
        var isNewTerminal = state.serverCols === 0; // Never been fitted before
        state.container.classList.remove('hidden');

        requestAnimationFrame(function() {
            state.fitAddon.fit();
            sendResize(sessionId, state.terminal);
            state.terminal.focus();

            // Fetch buffer for existing sessions only (not newly created ones)
            // Newly created sessions get all output via WebSocket
            if (isNewTerminal && !newlyCreatedSessions.has(sessionId)) {
                fetchAndWriteBuffer(sessionId, state.terminal);
            }
        });

        renderSessionList();
        updateMobileTitle();
        emptyState.classList.add('hidden');
    }

    function deleteSession(sessionId) {
        fetch('/api/sessions/' + sessionId, { method: 'DELETE' })
            .catch(function(e) {
                console.error('Error deleting session:', e);
            });
    }

    function renameSession(sessionId, newName) {
        var session = sessions.find(function(s) { return s.id === sessionId; });
        if (!session) return;

        var trimmedName = (newName || '').trim();
        var nameToSend = trimmedName === '' || trimmedName === session.shellType ? null : trimmedName;

        fetch('/api/sessions/' + sessionId + '/name', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: nameToSend })
        }).catch(function(e) {
            console.error('Error renaming session:', e);
        });
    }

    function startInlineRename(sessionId) {
        var item = sessionList.querySelector('[data-session-id="' + sessionId + '"]');
        if (!item) return;

        var titleSpan = item.querySelector('.session-title');
        if (!titleSpan) return;

        var session = sessions.find(function(s) { return s.id === sessionId; });
        var currentName = session ? (session.name || session.shellType) : '';

        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'session-rename-input';
        input.value = currentName;

        function finishRename() {
            var newValue = input.value;
            renameSession(sessionId, newValue);
            input.replaceWith(titleSpan);
        }

        input.addEventListener('blur', finishRename);
        input.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                input.blur();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                input.replaceWith(titleSpan);
            }
        });

        titleSpan.replaceWith(input);
        input.focus();
        input.select();
    }

    function getSessionDisplayName(session) {
        return session.name || session.shellType;
    }

    // ========================================================================
    // UI Rendering
    // ========================================================================

    function renderSessionList() {
        if (!sessionList) return;

        sessionList.innerHTML = '';
        var activeSession = sessions.find(function(s) { return s.id === activeSessionId; });

        sessions.forEach(function(session) {
            var item = document.createElement('div');
            item.className = 'session-item' + (session.id === activeSessionId ? ' active' : '');
            item.dataset.sessionId = session.id;

            // Session info (clickable)
            var info = document.createElement('div');
            info.className = 'session-info';
            info.addEventListener('click', function() {
                selectSession(session.id);
                closeSidebar();
            });

            var title = document.createElement('span');
            title.className = 'session-title';
            title.textContent = getSessionDisplayName(session);

            var details = document.createElement('span');
            details.className = 'session-details';

            // Show passive indicator if another viewer controls this session
            var isPassive = clientId &&
                session.lastActiveViewerId &&
                session.lastActiveViewerId !== clientId;
            if (isPassive) {
                details.innerHTML = '<span class="passive-indicator" title="Another viewer controls this session">👁️</span>';
            }

            info.appendChild(title);
            info.appendChild(details);

            // Action buttons
            var actions = document.createElement('div');
            actions.className = 'session-actions';

            var renameBtn = document.createElement('button');
            renameBtn.className = 'session-rename';
            renameBtn.innerHTML = '✏️';
            renameBtn.title = 'Rename session';
            renameBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                startInlineRename(session.id);
            });

            var closeBtn = document.createElement('button');
            closeBtn.className = 'session-close';
            closeBtn.innerHTML = '&times;';
            closeBtn.title = 'Close session';
            closeBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                deleteSession(session.id);
            });

            actions.appendChild(renameBtn);
            actions.appendChild(closeBtn);

            item.appendChild(info);
            item.appendChild(actions);
            sessionList.appendChild(item);
        });

        if (sessionCount) {
            sessionCount.textContent = sessions.length;
        }
    }

    function updateEmptyState() {
        if (!emptyState) return;

        if (sessions.length === 0) {
            emptyState.classList.remove('hidden');
            if (settingsView) settingsView.classList.add('hidden');
        } else if (!settingsOpen) {
            emptyState.classList.add('hidden');
        }
    }

    function updateMobileTitle() {
        if (!mobileTitle) return;

        var session = sessions.find(function(s) { return s.id === activeSessionId; });
        mobileTitle.textContent = session ? getSessionDisplayName(session) : 'MiddleManager';
    }

    // ========================================================================
    // Notifications
    // ========================================================================

    function requestNotificationPermission() {
        if (!('Notification' in window)) return;
        if (Notification.permission === 'default') {
            Notification.requestPermission().catch(function() {});
        }
    }

    function showBellNotification(sessionId) {
        if (!currentSettings) return;

        var bellStyle = currentSettings.bellStyle || 'notification';
        var session = sessions.find(function(s) { return s.id === sessionId; });
        var title = session ? getSessionDisplayName(session) : 'Terminal';

        // System notification (when tab is hidden)
        if ((bellStyle === 'notification' || bellStyle === 'both') &&
            Notification.permission === 'granted' && document.hidden) {
            new Notification('Bell: ' + title, {
                body: 'Terminal bell triggered',
                icon: '/favicon.ico'
            });
        }

        // Visual flash
        if (bellStyle === 'visual' || bellStyle === 'both') {
            var state = sessionTerminals.get(sessionId);
            if (state) {
                state.container.classList.add('bell-flash');
                setTimeout(function() {
                    state.container.classList.remove('bell-flash');
                }, 200);
            }
        }
    }

    // ========================================================================
    // Sidebar & Settings
    // ========================================================================

    function toggleSidebar() {
        sidebarOpen = !sidebarOpen;
        if (app) app.classList.toggle('sidebar-open', sidebarOpen);
    }

    function closeSidebar() {
        sidebarOpen = false;
        if (app) app.classList.remove('sidebar-open');
    }

    function toggleSettings() {
        if (settingsOpen) {
            closeSettings();
        } else {
            openSettings();
        }
    }

    function openSettings() {
        settingsOpen = true;
        if (settingsBtn) settingsBtn.classList.add('active');

        // Hide active terminal
        if (activeSessionId) {
            var state = sessionTerminals.get(activeSessionId);
            if (state) state.container.classList.add('hidden');
        }

        if (emptyState) emptyState.classList.add('hidden');
        if (settingsView) settingsView.classList.remove('hidden');
        fetchSettings();
        fetchSystemStatus();
    }

    function closeSettings() {
        settingsOpen = false;
        if (settingsBtn) settingsBtn.classList.remove('active');
        if (settingsView) settingsView.classList.add('hidden');

        // Show active terminal
        if (activeSessionId) {
            var state = sessionTerminals.get(activeSessionId);
            if (state) {
                state.container.classList.remove('hidden');
                requestAnimationFrame(function() {
                    state.fitAddon.fit();
                    state.terminal.focus();
                });
            }
        } else if (sessions.length === 0 && emptyState) {
            emptyState.classList.remove('hidden');
        }
    }

    function fetchSettings() {
        Promise.all([
            fetch('/api/settings').then(function(r) { return r.json(); }),
            fetch('/api/users').then(function(r) { return r.json(); }).catch(function() { return []; }),
            fetch('/api/version/details').then(function(r) { return r.json(); }).catch(function() { return null; })
        ])
        .then(function(results) {
            var settings = results[0];
            var users = results[1];
            var versionDetails = results[2];
            currentSettings = settings;
            populateUserDropdown(users, settings.runAsUser);
            populateSettingsForm(settings);
            populateVersionInfo(versionDetails);
        })
        .catch(function(e) {
            console.error('Error fetching settings:', e);
        });
    }

    function populateVersionInfo(details) {
        var webEl = document.getElementById('version-web');
        if (webEl) {
            webEl.textContent = details?.web || '-';
        }
    }

    function populateUserDropdown(users, selectedUser) {
        var select = document.getElementById('setting-run-as-user');
        if (!select) return;

        // Keep the default option
        select.innerHTML = '<option value="">Process Owner (default)</option>';

        // Add user options
        users.forEach(function(user) {
            var option = document.createElement('option');
            option.value = user.username;
            option.textContent = user.username;
            if (user.username === selectedUser) {
                option.selected = true;
            }
            select.appendChild(option);
        });
    }

    function populateSettingsForm(settings) {
        setElementValue('setting-default-shell', settings.defaultShell || 'Pwsh');
        setElementValue('setting-working-dir', settings.defaultWorkingDirectory || '');
        setElementValue('setting-font-size', settings.fontSize || 14);
        setElementValue('setting-cursor-style', settings.cursorStyle || 'bar');
        setElementChecked('setting-cursor-blink', settings.cursorBlink !== false);
        setElementValue('setting-theme', settings.theme || 'dark');
        setElementValue('setting-scrollback', settings.scrollbackLines || 10000);
        setElementValue('setting-bell-style', settings.bellStyle || 'notification');
        setElementChecked('setting-copy-on-select', settings.copyOnSelect === true);
        setElementChecked('setting-right-click-paste', settings.rightClickPaste !== false);
        setElementValue('setting-clipboard-shortcuts', settings.clipboardShortcuts || 'auto');
        setElementValue('setting-run-as-user', settings.runAsUser || '');
        setElementChecked('setting-debug-logging', settings.debugLogging === true);
    }

    function setElementValue(id, value) {
        var el = document.getElementById(id);
        if (el) el.value = value;
    }

    function setElementChecked(id, checked) {
        var el = document.getElementById(id);
        if (el) el.checked = checked;
    }

    function getElementValue(id, defaultValue) {
        var el = document.getElementById(id);
        return el ? el.value : defaultValue;
    }

    function getElementChecked(id) {
        var el = document.getElementById(id);
        return el ? el.checked : false;
    }

    function saveAllSettings() {
        var runAsUserValue = getElementValue('setting-run-as-user', '');
        var settings = {
            defaultShell: getElementValue('setting-default-shell', 'Pwsh'),
            defaultWorkingDirectory: getElementValue('setting-working-dir', ''),
            fontSize: parseInt(getElementValue('setting-font-size', '14'), 10) || 14,
            cursorStyle: getElementValue('setting-cursor-style', 'bar'),
            cursorBlink: getElementChecked('setting-cursor-blink'),
            theme: getElementValue('setting-theme', 'dark'),
            scrollbackLines: parseInt(getElementValue('setting-scrollback', '10000'), 10) || 10000,
            bellStyle: getElementValue('setting-bell-style', 'notification'),
            copyOnSelect: getElementChecked('setting-copy-on-select'),
            rightClickPaste: getElementChecked('setting-right-click-paste'),
            clipboardShortcuts: getElementValue('setting-clipboard-shortcuts', 'auto'),
            runAsUser: runAsUserValue || null,
            debugLogging: getElementChecked('setting-debug-logging')
        };

        // Persist theme to cookie for flash-free page load
        setCookie('mm-theme', settings.theme);

        fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        })
        .then(function(r) {
            if (r.ok) {
                currentSettings = settings;
                var theme = THEMES[settings.theme] || THEMES.dark;
                document.documentElement.style.setProperty('--terminal-bg', theme.background);
                applySettingsToTerminals();
            }
        })
        .catch(function(e) {
            console.error('Error saving settings:', e);
        });
    }

    // ========================================================================
    // Event Binding
    // ========================================================================

    function bindEvents() {
        // New session buttons
        bindClick('btn-new-session', createSession);
        bindClick('btn-new-session-mobile', createSession);
        bindClick('btn-create-terminal', createSession);

        // Sidebar
        bindClick('btn-hamburger', toggleSidebar);
        if (sidebarOverlay) {
            sidebarOverlay.addEventListener('click', closeSidebar);
        }

        // Settings
        if (settingsBtn) {
            settingsBtn.addEventListener('click', toggleSettings);
        }

        // Update button
        bindClick('update-btn', applyUpdate);

        // About & Updates
        bindClick('btn-check-updates', checkForUpdates);
        bindClick('btn-show-changelog', showChangelog);
        bindClick('btn-close-changelog', closeChangelog);
        var changelogBackdrop = document.querySelector('#changelog-modal .modal-backdrop');
        if (changelogBackdrop) {
            changelogBackdrop.addEventListener('click', closeChangelog);
        }

        bindSettingsAutoSave();
    }

    function bindClick(id, handler) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    }

    function bindSettingsAutoSave() {
        if (!settingsView) return;

        // Auto-save on select/checkbox change
        settingsView.querySelectorAll('select, input[type="checkbox"]').forEach(function(el) {
            el.addEventListener('change', saveAllSettings);
        });

        // Inline save for text inputs
        settingsView.querySelectorAll('.text-input-wrapper').forEach(function(wrapper) {
            var input = wrapper.querySelector('input');
            var saveBtn = wrapper.querySelector('.inline-save-btn');
            if (!input || !saveBtn) return;

            var originalValue = '';

            input.addEventListener('focus', function() {
                originalValue = input.value;
            });

            input.addEventListener('input', function() {
                wrapper.classList.toggle('unsaved', input.value !== originalValue);
            });

            saveBtn.addEventListener('click', function() {
                saveAllSettings();
                wrapper.classList.remove('unsaved');
                originalValue = input.value;
            });

            input.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    saveAllSettings();
                    wrapper.classList.remove('unsaved');
                    originalValue = input.value;
                }
            });
        });
    }

    // ========================================================================
    // Viewport & Resize Handling
    // ========================================================================

    function setupResizeObserver() {
        if (typeof ResizeObserver === 'undefined' || !terminalsArea) return;

        var observer = new ResizeObserver(function() {
            requestAnimationFrame(function() {
                if (!activeSessionId) return;
                var state = sessionTerminals.get(activeSessionId);
                if (state && state.container.offsetWidth > 0) {
                    state.fitAddon.fit();
                    sendResize(activeSessionId, state.terminal);
                }
            });
        });
        observer.observe(terminalsArea);
    }

    function setupVisualViewport() {
        if (!window.visualViewport || !terminalsArea) return;

        var lastHeight = 0;

        function updateViewportHeight() {
            var vh = window.visualViewport.height;
            if (Math.abs(vh - lastHeight) < 1) return;
            lastHeight = vh;

            document.documentElement.style.setProperty('--visual-vh', vh + 'px');

            var mobileHeader = document.querySelector('.mobile-header');
            var headerHeight = 0;
            if (mobileHeader && window.getComputedStyle(mobileHeader).display !== 'none') {
                headerHeight = mobileHeader.offsetHeight;
            }

            var availableHeight = Math.floor((vh - headerHeight) * 0.99);
            terminalsArea.style.height = availableHeight + 'px';

            if (activeSessionId) {
                var state = sessionTerminals.get(activeSessionId);
                if (state && state.container.offsetWidth > 0) {
                    requestAnimationFrame(function() {
                        state.fitAddon.fit();
                        sendResize(activeSessionId, state.terminal);
                    });
                }
            }
        }

        window.visualViewport.addEventListener('resize', updateViewportHeight);
        updateViewportHeight();
    }

    // ========================================================================
    // API Helpers
    // ========================================================================

    function fetchVersion() {
        fetch('/api/version')
            .then(function(r) { return r.text(); })
            .then(function(v) {
                var shortVersion = v.split(/[+-]/)[0].split('.').slice(0, 3).join('.');
                var el = document.getElementById('app-version');
                if (el) el.textContent = 'v' + shortVersion;
            })
            .catch(function() {});
    }

    function fetchNetworks() {
        fetch('/api/networks')
            .then(function(r) { return r.json(); })
            .then(function(networks) {
                var list = document.getElementById('network-list');
                if (!list) return;

                list.innerHTML = networks.map(function(n) {
                    return '<div class="network-item">' +
                        '<span class="network-name" title="' + escapeHtml(n.name) + '">' +
                        escapeHtml(n.name) + '</span>' +
                        '<span class="network-ip">' + escapeHtml(n.ip) + ':' + location.port + '</span>' +
                        '</div>';
                }).join('');
            })
            .catch(function() {});
    }

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

})();
