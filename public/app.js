(function () {
    const popup = document.getElementById('lampPopup');
    const popupTitle = document.getElementById('popupTitle');
    const popupBody = document.getElementById('popupBody');
    const popupActivateBtn = document.getElementById('popupActivateBtn');
    const popupIdentifyBtn = document.getElementById('popupIdentifyBtn');
    const popupCloseBtn = document.getElementById('popupCloseBtn');
    const canvas = document.getElementById('graphCanvas');
    const ctx = canvas.getContext('2d');
    const configureBtn = document.getElementById('configureBtn');
    const configOverlay = document.getElementById('configOverlay');
    const cfgId = document.getElementById('cfgId');
    const cfgStreet = document.getElementById('cfgStreet');
    const cfgName = document.getElementById('cfgName');
    const cfgRegisterBtn = document.getElementById('cfgRegisterBtn');
    const cfgCloseBtn = document.getElementById('cfgCloseBtn');
    const cfgStatus = document.getElementById('cfgStatus');
    const cfgList = document.getElementById('cfgList');
    const streetSelect = document.getElementById('streetSelect');
    const activateStreetBtn = document.getElementById('activateStreetBtn');

    function resizeCanvas() {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
        render();
    }
    window.addEventListener('resize', resizeCanvas);
    // Lamp configuration overlay
    if (configureBtn) configureBtn.addEventListener('click', () => {
        if (configOverlay) configOverlay.classList.remove('hidden');
        // prefill id with random hex 8
        if (cfgId) cfgId.value = generateHexId();
        renderLampList();
    });
    if (cfgCloseBtn) cfgCloseBtn.addEventListener('click', () => {
        if (configOverlay) configOverlay.classList.add('hidden');
    });
    let lampWS;
    function ensureLampWS() {
        if (lampWS && lampWS.readyState === WebSocket.OPEN) return;
        lampWS = new WebSocket(`ws://${location.hostname}:3090`);
        lampWS.onopen = () => { /* ready */ };
        lampWS.onmessage = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.type === 'registered') {
                    cfgStatus.textContent = `Registered lamp ${msg.id}`;
                }
            } catch { }
        };
        lampWS.onclose = () => { /* reconnect on next action */ };
    }
    if (cfgRegisterBtn) cfgRegisterBtn.addEventListener('click', () => {
        ensureLampWS();
        const id = (cfgId && cfgId.value || '').trim();
        const name = (cfgName && cfgName.value || '').trim();
        const street = (cfgStreet && cfgStreet.value || '').trim();
        if (!id) { cfgStatus.textContent = 'ID is required'; return; }
        // send register to lamp WS
        const payload = { type: 'register', id, name };
        try { lampWS.send(JSON.stringify(payload)); } catch { }
        // optionally add to server-side model (future: endpoint to add new lamp)
        cfgStatus.textContent = `Sent register for ${id}`;
        renderLampList();
    });

    function generateHexId() {
        let s = '';
        for (let i = 0; i < 8; i++) { s += Math.floor(Math.random() * 16).toString(16); }
        return s;
    }

    async function renderLampList() {
        if (!cfgList) return;
        cfgList.innerHTML = 'Loading lamps…';
        try {
            const res = await fetch('/lamps');
            const lamps = await res.json();
            const assigned = lamps.filter(l => l.street && l.street.length);
            const unassigned = lamps.filter(l => !l.street || !l.street.length);
            const renderRows = (list) => list.map(l => {
                const connStr = (l.connections || []).join(', ');
                const rowId = `row-${l.id}`;
                return `<div class="lamp-row" id="${rowId}">
                    <div><strong>${l.name || '(no name)'}<br/><span style="color:#666;font-size:12px;">${l.id}</span></strong></div>
                    <div><input data-id="${l.id}" class="inp-street" value="${l.street || ''}" placeholder="Street"/></div>
                    <div><input data-id="${l.id}" class="inp-connections" value="${connStr}" placeholder="conn1, conn2"/></div>
                    <div style="display:flex;align-items:center;gap:6px;">
                        <input data-id="${l.id}" class="inp-name" value="${l.name || ''}" placeholder="Name" style="width:120px;"/>
                        <button class="btn-save" data-id="${l.id}">Save</button>
                    </div>
                </div>`;
            }).join('');
            cfgList.innerHTML = `
                <h3 style="margin:8px 0;">Unassigned</h3>
                <div class="lamp-row" style="font-weight:600;">
                    <div>Name / ID</div><div>Street</div><div>Connections</div><div>Actions</div>
                </div>
                ${renderRows(unassigned)}
                <h3 style="margin:16px 0 8px;">Assigned</h3>
                <div class="lamp-row" style="font-weight:600;">
                    <div>Name / ID</div><div>Street</div><div>Connections</div><div>Actions</div>
                </div>
                ${renderRows(assigned)}
            `;

            // bind save buttons
            cfgList.querySelectorAll('.btn-save').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const id = btn.getAttribute('data-id');
                    const street = cfgList.querySelector(`.inp-street[data-id="${id}"]`).value.trim();
                    const name = cfgList.querySelector(`.inp-name[data-id="${id}"]`).value.trim();
                    const conns = cfgList.querySelector(`.inp-connections[data-id="${id}"]`).value.trim();
                    const connections = conns ? conns.split(',').map(s => s.trim()).filter(Boolean) : [];
                    try {
                        const res = await fetch(`/lamps/${encodeURIComponent(id)}/update`, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name, street, connections })
                        });
                        if (res.ok) {
                            cfgStatus.textContent = `Saved ${id}`;
                            renderLampList();
                        } else {
                            cfgStatus.textContent = `Failed to save ${id}`;
                        }
                    } catch {
                        cfgStatus.textContent = `Error saving ${id}`;
                    }
                });
            });
        } catch {
            cfgList.innerHTML = 'Failed to load lamps';
        }
    }

    let graph = { nodes: [], edges: [] };
    let states = [];
    let positions = new Map();
    let rects = new Map();
    let connectedIds = new Set();
    let lampNames = new Map();
    let selectedLampId = null;
    let pan = { x: 0, y: 0 };
    let isPanning = false;
    let drag = { id: null, startX: 0, startY: 0 };
    let dragMode = false;
    const dragModeEl = document.getElementById('dragMode');
    if (dragModeEl) {
        dragModeEl.addEventListener('change', () => {
            dragMode = !!dragModeEl.checked;
            // Close popup when entering drag mode
            if (dragMode && !popup.classList.contains('hidden')) {
                popup.classList.add('hidden');
                selectedLampId = null;
            }
        });
    }

    async function savePositions() {
        const obj = {};
        positions.forEach((p, id) => { obj[id] = p; });
        try {
            await fetch('/positions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
        } catch { }
    }
    async function loadPositions() {
        try {
            const res = await fetch('/positions');
            if (!res.ok) return false;
            const obj = await res.json();
            if (!obj || typeof obj !== 'object') return false;
            // If positions are keyed by old names, map them to current hex IDs
            const entries = Object.entries(obj);
            const idsInGraph = new Set(graph.nodes.map(n => n.id));
            const looksLikeHexId = (s) => typeof s === 'string' && /^[0-9a-f]{8}$/i.test(s);
            let needNameMapping = entries.some(([k]) => !looksLikeHexId(k) || !idsInGraph.has(k));
            let mapped = new Map();
            if (needNameMapping) {
                try {
                    const lamps = await (await fetch('/lamps')).json();
                    const nameToId = new Map(lamps.filter(l => l.name).map(l => [l.name, l.id]));
                    entries.forEach(([k, p]) => {
                        const id = nameToId.get(k) || k;
                        mapped.set(id, p);
                    });
                } catch {
                    mapped = new Map(entries.map(([id, p]) => [id, p]));
                }
            } else {
                mapped = new Map(entries.map(([id, p]) => [id, p]));
            }
            positions = mapped;
            // build rects
            rects = new Map();
            const blockW = 48, blockH = 32;
            positions.forEach((p, id) => {
                rects.set(id, { x: p.x - blockW / 2, y: p.y - blockH / 2, w: blockW, h: blockH });
            });
            return true;
        } catch { return false; }
    }

    // Simple force-directed layout
    function layoutPositions() {
        const padding = 60;
        const width = canvas.width - padding * 2;
        const height = canvas.height - padding * 2;

        // Initialize by street grouping, then relax
        const streets = Array.from(new Set(graph.nodes.map(n => n.street && n.street.length ? n.street : '(unassigned)')));
        const streetIndex = new Map(streets.map((s, i) => [s, i]));
        const laneCount = Math.max(1, streets.length);
        const laneY = (i) => padding + (i + 0.5) * (height / laneCount);

        positions = new Map();
        const grouped = new Map();
        graph.nodes.forEach(n => {
            const key = (n.street && n.street.length) ? n.street : '(unassigned)';
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(n);
        });
        grouped.forEach((list, street) => {
            list.sort((a, b) => a.id.localeCompare(b.id));
            list.forEach((n, idx) => {
                const x = padding + (idx + 1) * (width / (list.length + 1));
                const y = laneY(streetIndex.get(street));
                positions.set(n.id, { x, y });
            });
        });

        // Relax positions based on edges
        const iterations = 150;
        const k = 0.02;
        const repulsion = 4000;
        for (let it = 0; it < iterations; it++) {
            // node repulsion
            for (let i = 0; i < graph.nodes.length; i++) {
                const a = graph.nodes[i];
                const pa = positions.get(a.id);
                if (!pa) continue;
                let fx = 0, fy = 0;
                for (let j = i + 1; j < graph.nodes.length; j++) {
                    const b = graph.nodes[j];
                    const pb = positions.get(b.id);
                    if (!pb) continue;
                    const dx = pa.x - pb.x; const dy = pa.y - pb.y;
                    const d2 = Math.max(1, dx * dx + dy * dy);
                    const f = repulsion / d2;
                    const dist = Math.sqrt(d2);
                    fx += (dx / dist) * f;
                    fy += (dy / dist) * f;
                    positions.set(b.id, { x: pb.x - (dx / dist) * f, y: pb.y - (dy / dist) * f });
                }
                positions.set(a.id, { x: pa.x + fx, y: pa.y + fy });
            }
            // edge springs
            graph.edges.forEach(e => {
                const a = positions.get(e.from);
                const b = positions.get(e.to);
                if (!a || !b) return;
                const dx = b.x - a.x; const dy = b.y - a.y;
                const fx = dx * k; const fy = dy * k;
                positions.set(e.from, { x: a.x + fx, y: a.y + fy });
                positions.set(e.to, { x: b.x - fx, y: b.y - fy });
            });
            // keep within bounds
            positions.forEach((p, id) => {
                const x = Math.max(padding, Math.min(canvas.width - padding, p.x));
                const y = Math.max(padding, Math.min(canvas.height - padding, p.y));
                positions.set(id, { x, y });
            });
        }

        // rects
        rects = new Map();
        const blockW = 48, blockH = 32;
        positions.forEach((p, id) => {
            rects.set(id, { x: p.x - blockW / 2, y: p.y - blockH / 2, w: blockW, h: blockH });
        });

        return positions;
    }

    function render() {
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // Move dots grid with pan
        try {
            canvas.style.backgroundPosition = `${pan.x}px ${pan.y}px`;
        } catch { }
        if (!positions || positions.size !== graph.nodes.length) {
            // Try loading positions from server if missing
            // Do not auto-layout here; respect loaded/saved positions.
        }

        // edges
        ctx.lineWidth = 2;
        graph.edges.forEach(e => {
            const a = positions.get(e.from);
            const b = positions.get(e.to);
            if (!a || !b) return;
            ctx.strokeStyle = e.type === 'same_street' ? '#747474ff' : '#398ed3ff';
            ctx.beginPath();
            ctx.moveTo(a.x + pan.x, a.y + pan.y);
            ctx.lineTo(b.x + pan.x, b.y + pan.y);
            ctx.stroke();
        });

        // nodes
        function drawRoundedRectPath(x, y, w, h, r) {
            ctx.beginPath();
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + w - r, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + r);
            ctx.lineTo(x + w, y + h - r);
            ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
            ctx.lineTo(x + r, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - r);
            ctx.lineTo(x, y + r);
            ctx.quadraticCurveTo(x, y, x + r, y);
            ctx.closePath();
        }

        graph.nodes.forEach(n => {
            const rect = rects.get(n.id);
            if (!rect) return;
            const isSelected = selectedLampId === n.id;
            const x = rect.x + pan.x, y = rect.y + pan.y;
            const radius = 6;
            drawRoundedRectPath(x, y, rect.w, rect.h, radius);
            // fill node based on current lamp state
            const state = states.find(s => s.id === n.id)?.state;
            if (state && state.on) {
                ctx.fillStyle = state.color || '#ffffff';
            } else {
                // visually off: neutral fill regardless of last color
                ctx.fillStyle = '#ffffff';
            }
            ctx.fill();
            // base stroke style
            let stroke = isSelected ? '#60a5fa' : '#9ca3af';
            try {
                const now = Date.now();
                if (window.__pulseUntil && window.__pulseUntil.get(n.id) > now) {
                    const a = window.__simPulseColorA || '#60a5fa';
                    const b = window.__simPulseColorB || a;
                    stroke = window.__simPulseToggle ? b : a;
                } else if (window.__pulseUntil && window.__pulseUntil.has(n.id)) {
                    window.__pulseUntil.delete(n.id);
                }
            } catch {}
            ctx.strokeStyle = stroke;
            ctx.lineWidth = isSelected ? 3 : 1.5;
            ctx.stroke();

            // connection status dot (green if connected, red if not)
            const dotR = 4;
            const dotX = x + 4;
            const dotY = y + 4;
            ctx.beginPath();
            ctx.arc(dotX, dotY, dotR, 0, Math.PI * 2);
            ctx.fillStyle = connectedIds.has(n.id) ? '#10b981' : '#ef4444';
            ctx.fill();

            // label inside node
            ctx.fillStyle = '#333';
            ctx.font = '12px system-ui';
            const text = lampNames.get(n.id) || n.id;
            const metrics = ctx.measureText(text);
            const tx = x + (rect.w - metrics.width) / 2;
            const ty = y + (rect.h + 12) / 2 - 2;
            ctx.fillText(text, tx, ty);
        });
    }

    async function refreshGraph() {
        const res = await fetch('/graph');
        graph = await res.json();
        // Populate streets dropdown
        try {
            const streets = Array.from(new Set(graph.nodes.map(n => (n.street && n.street.length) ? n.street : null).filter(Boolean))).sort();
            if (streetSelect) {
                streetSelect.innerHTML = streets.map(s => `<option value="${s}">${s}</option>`).join('');
            }
        } catch {}
        // load names for display
        try {
            const lamps = await (await fetch('/lamps')).json();
            lampNames = new Map(lamps.map(l => [l.id, l.name || '']));
        } catch { lampNames = new Map(); }
        // Load positions, then render
        const ok = await loadPositions();
        if (!ok || positions.size === 0) {
            layoutPositions();
        } else {
            // Fill in any missing nodes without positions
            const missing = graph.nodes.filter(n => !positions.has(n.id));
            if (missing.length) layoutPositions();
        }
        render();
    }

    // default depth

    // Mouse: drag, pan, click
    canvas.addEventListener('mousedown', (ev) => {
        const rect = canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        let hitId = null;
        graph.nodes.some(n => {
            const r = rects.get(n.id);
            if (!r) return false;
            const rx = r.x + pan.x, ry = r.y + pan.y;
            if (x >= rx && x <= rx + r.w && y >= ry && y <= ry + r.h) { hitId = n.id; return true; }
            return false;
        });
        if (hitId) {
            if (dragMode) {
                // begin dragging in drag mode
                drag.id = hitId;
                drag.startX = x - (positions.get(hitId)?.x || 0) - pan.x;
                drag.startY = y - (positions.get(hitId)?.y || 0) - pan.y;
            } else {
                // open popup
                selectedLampId = hitId;
                showPopupForLamp(hitId);
                render();
            }
        } else {
            isPanning = true;
        }
    });

    canvas.addEventListener('mousemove', (ev) => {
        const rect = canvas.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        if (drag.id) {
            const nx = x - drag.startX - pan.x;
            const ny = y - drag.startY - pan.y;
            // grid snap in drag mode
            const grid = 20;
            const sx = dragMode ? Math.round(nx / grid) * grid : nx;
            const sy = dragMode ? Math.round(ny / grid) * grid : ny;
            positions.set(drag.id, { x: sx, y: sy });
            const b = rects.get(drag.id);
            if (b) {
                const blockW = b.w, blockH = b.h;
                rects.set(drag.id, { x: sx - blockW / 2, y: sy - blockH / 2, w: blockW, h: blockH });
            }
            render();
        } else if (isPanning) {
            pan.x += ev.movementX;
            pan.y += ev.movementY;
            render();
        }
    });

    canvas.addEventListener('mouseup', () => {
        if (drag.id) {
            // Save only in drag mode
            if (dragMode) {
                savePositions();
            }
        }
        drag.id = null;
        isPanning = false;
    });

    canvas.addEventListener('mouseleave', () => {
        drag.id = null;
        isPanning = false;
    });

    function showPopupForLamp(lampId) {
        const node = graph.nodes.find(n => n.id === lampId);
        const state = states.find(s => s.id === lampId)?.state;
        popupTitle.textContent = `Lamp ${lampId}`;
        popupBody.innerHTML = `
      <div><strong>Street:</strong> ${node?.street || '-'}</div>
      <div><strong>On:</strong> ${state?.on ? 'true' : 'false'}</div>
      <div><strong>Brightness:</strong> ${state?.brightness ?? 0}</div>
      <div><strong>Color:</strong> ${state?.color || '#888'}</div>
    `;
        popup.classList.remove('hidden');
    }

    popupCloseBtn.addEventListener('click', () => {
        popup.classList.add('hidden');
        selectedLampId = null;
        render();
    });

    // Simulate locally using preview (pulse border only)
    popupActivateBtn.addEventListener('click', async () => {
        if (!selectedLampId) return;
        const street = graph.nodes.find(n => n.id === selectedLampId)?.street;
        if (!street) return;
        // touch settings for consistency
        try { await fetch('/settings'); } catch { }
        const res = await fetch(`/streets/${encodeURIComponent(street)}/preview`);
        const data = await res.json();
        const ids = new Set(data.affectedLampIds);
        let pulseColor = '#60a5fa';
        try {
            const s = await (await fetch('/settings')).json();
            if (s && typeof s.pulseColor === 'string') pulseColor = s.pulseColor;
        } catch {}
        const darker = (hex, factor = 0.75) => {
            const m = hex.startsWith('#') ? hex.slice(1) : hex;
            if (m.length !== 6) return hex;
            const r = Math.max(0, Math.min(255, Math.floor(parseInt(m.slice(0,2),16) * factor)));
            const g = Math.max(0, Math.min(255, Math.floor(parseInt(m.slice(2,4),16) * factor)));
            const b = Math.max(0, Math.min(255, Math.floor(parseInt(m.slice(4,6),16) * factor)));
            const toHex = (n) => n.toString(16).padStart(2,'0');
            return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
        };
        startPulse(ids, pulseColor, darker(pulseColor, 0.75), 5000);
        return;
    });

    // Identify: instruct device to flash violently for a few seconds
    if (popupIdentifyBtn) popupIdentifyBtn.addEventListener('click', async () => {
        if (!selectedLampId) return;
        try {
            const res = await fetch(`/lamps/${encodeURIComponent(selectedLampId)}/device/identify`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ durationMs: 3000 })
            });
            if (!res.ok) throw new Error('identify failed');
        } catch { }
    });

    function startPulse(idSet, colorA, colorB, durationMs){
        window.__simPulseColorA = colorA || '#60a5fa';
        window.__simPulseColorB = colorB || window.__simPulseColorA;
        if (!window.__pulseUntil) window.__pulseUntil = new Map();
        const now = Date.now();
        idSet.forEach(id => window.__pulseUntil.set(id, now + (durationMs||3000)));
        if (window.__lampPulseTimer) { clearInterval(window.__lampPulseTimer); window.__lampPulseTimer = null; }
        window.__lampPulseTimer = setInterval(() => { window.__simPulseToggle = !window.__simPulseToggle; render(); }, 180);
        render();
    }

    // WebSocket
    let ws;
    function connectWS() {
        ws = new WebSocket(`ws://${location.host}`);
        ws.onmessage = async (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.type === 'init') {
                    graph = msg.graph || graph;
                    states = msg.states || states;
                    // Use server positions if provided
                    if (msg.positions) {
                        positions = new Map(Object.entries(msg.positions).map(([id, p]) => [id, p]));
                        // rebuild rects
                        rects = new Map();
                        const blockW = 48, blockH = 32;
                        positions.forEach((p, id) => {
                            rects.set(id, { x: p.x - blockW / 2, y: p.y - blockH / 2, w: blockW, h: blockH });
                        });
                    }
                    refreshGraph();
                }
                if (msg.type === 'update') {
                    if (msg.graph) { graph = msg.graph; }
                    states = msg.states || states;
                    // Pulse when street activation event included; use affectedLampIds to include spillover
                    if (Array.isArray(msg.events)) {
                        const ev = msg.events.find(e => e && e.type === 'street_activated' && Array.isArray(e.affectedLampIds));
                        if (ev) {
                            startPulse(new Set(ev.affectedLampIds), '#34d399', '#059669', 3000);
                        }
                    }
                    render();
                }
                if (msg.type === 'street_activated' && typeof msg.street === 'string') {
                    const ids = new Set(graph.nodes.filter(n => n.street === msg.street).map(n => n.id));
                    startPulse(ids, '#34d399', '#059669', 3000);
                }
                if (msg.type === 'positions' && msg.positions) {
                    positions = new Map(Object.entries(msg.positions).map(([id, p]) => [id, p]));
                    // rebuild rects
                    rects = new Map();
                    const blockW = 48, blockH = 32;
                    positions.forEach((p, id) => {
                        rects.set(id, { x: p.x - blockW / 2, y: p.y - blockH / 2, w: blockW, h: blockH });
                    });
                    render();
                }
                if (msg.type === 'device_status' && Array.isArray(msg.connectedIds)) {
                    connectedIds = new Set(msg.connectedIds);
                    render();
                }
                // Device-level activation for individual lamps: pulse that lamp briefly
                if (msg.type === 'activated' && typeof msg.id === 'string') {
                    const ids = new Set([msg.id]);
                    let pulseColor = '#34d399';
                    try {
                        const s = await (await fetch('/settings')).json();
                        if (s && typeof s.pulseColor === 'string') pulseColor = s.pulseColor;
                    } catch { }
                    const darker = (hex, factor = 0.75) => {
                        const m = hex.startsWith('#') ? hex.slice(1) : hex;
                        if (m.length !== 6) return hex;
                        const r = Math.max(0, Math.min(255, Math.floor(parseInt(m.slice(0, 2), 16) * factor)));
                        const g = Math.max(0, Math.min(255, Math.floor(parseInt(m.slice(2, 4), 16) * factor)));
                        const b = Math.max(0, Math.min(255, Math.floor(parseInt(m.slice(4, 6), 16) * factor)));
                        const toHex = (n) => n.toString(16).padStart(2, '0');
                        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
                    };
                    startPulse(ids, pulseColor, darker(pulseColor, 0.75), 3000);
                }
            } catch { }
        };
        ws.onclose = () => setTimeout(connectWS, 1000);
    }

    // init
    resizeCanvas();
    refreshGraph();
    connectWS();

    // Activate selected street via server API (simulate device-origin activation semantics)
    if (activateStreetBtn) activateStreetBtn.addEventListener('click', async () => {
        const street = streetSelect && streetSelect.value;
        if (!street) return;
        try {
            const res = await fetch(`/streets/${encodeURIComponent(street)}/activate?spillover=true`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ on: true })
            });
            if (!res.ok) throw new Error('activate failed');
        } catch {}
    });
})();
