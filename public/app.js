(function () {
    const popup = document.getElementById('lampPopup');
    const popupTitle = document.getElementById('popupTitle');
    const popupBody = document.getElementById('popupBody');
    const popupActivateBtn = document.getElementById('popupActivateBtn');
    const popupCloseBtn = document.getElementById('popupCloseBtn');
    const canvas = document.getElementById('graphCanvas');
    const ctx = canvas.getContext('2d');

    function resizeCanvas() {
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
        render();
    }
    window.addEventListener('resize', resizeCanvas);

    let graph = { nodes: [], edges: [] };
    let states = [];
    let positions = new Map();
    let rects = new Map();
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
            positions = new Map(Object.entries(obj).map(([id, p]) => [id, p]));
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
        const streets = Array.from(new Set(graph.nodes.map(n => n.street)));
        const streetIndex = new Map(streets.map((s, i) => [s, i]));
        const laneCount = Math.max(1, streets.length);
        const laneY = (i) => padding + (i + 0.5) * (height / laneCount);

        positions = new Map();
        const grouped = new Map();
        graph.nodes.forEach(n => {
            const key = n.street;
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
            layoutPositions();
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
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            // base stroke style
            let stroke = isSelected ? '#60a5fa' : '#9ca3af';
            if (window.__simPulseIds && window.__simPulseIds.has(n.id)) {
                const a = window.__simPulseColorA || '#60a5fa';
                const b = window.__simPulseColorB || a;
                stroke = window.__simPulseToggle ? b : a;
            }
            ctx.strokeStyle = stroke;
            ctx.lineWidth = isSelected ? 3 : 1.5;
            ctx.stroke();

            // label inside node
            ctx.fillStyle = '#333';
            ctx.font = '12px system-ui';
            const text = n.id;
            const metrics = ctx.measureText(text);
            const tx = x + (rect.w - metrics.width) / 2;
            const ty = y + (rect.h + 12) / 2 - 2;
            ctx.fillText(text, tx, ty);
        });
    }

    async function refreshGraph() {
        const res = await fetch('/graph');
        graph = await res.json();
        // Load positions, then render
        await loadPositions();
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

        // Pulse border color only for 5s (use settings pulseColor)
        const PULSE_MS = 5000;
        const STEP_MS = 200;
        window.__simPulseIds = ids;
        window.__simPulseToggle = false;
        // fetch pulseColor from settings
        let pulseColor = '#60a5fa';
        try {
            const s = await (await fetch('/settings')).json();
            if (s && typeof s.pulseColor === 'string') pulseColor = s.pulseColor;
        } catch {}
        // compute a darker variant
        function darken(hex, factor = 0.8) {
            const m = hex.startsWith('#') ? hex.slice(1) : hex;
            if (m.length !== 6) return hex;
            const r = Math.max(0, Math.min(255, Math.floor(parseInt(m.slice(0,2),16) * factor)));
            const g = Math.max(0, Math.min(255, Math.floor(parseInt(m.slice(2,4),16) * factor)));
            const b = Math.max(0, Math.min(255, Math.floor(parseInt(m.slice(4,6),16) * factor)));
            const toHex = (n) => n.toString(16).padStart(2,'0');
            return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
        }
        window.__simPulseColorA = pulseColor;
        window.__simPulseColorB = darken(pulseColor, 0.75);

        // Clear existing timers
        if (window.__lampPulseTimer) { clearInterval(window.__lampPulseTimer); window.__lampPulseTimer = null; }
        if (window.__lampPulseTimeout) { clearTimeout(window.__lampPulseTimeout); window.__lampPulseTimeout = null; }

        window.__lampPulseTimer = setInterval(() => {
            window.__simPulseToggle = !window.__simPulseToggle;
            render();
        }, STEP_MS);

        window.__lampPulseTimeout = setTimeout(() => {
            if (window.__lampPulseTimer) { clearInterval(window.__lampPulseTimer); window.__lampPulseTimer = null; }
            window.__simPulseIds = null;
            window.__simPulseToggle = false;
            render();
        }, PULSE_MS);
    });

    // WebSocket
    let ws;
    function connectWS() {
        ws = new WebSocket(`ws://${location.host}`);
        ws.onmessage = (ev) => {
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
                    states = msg.states || states;
                    render();
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
            } catch { }
        };
        ws.onclose = () => setTimeout(connectWS, 1000);
    }

    // init
    resizeCanvas();
    refreshGraph();
    connectWS();
})();
