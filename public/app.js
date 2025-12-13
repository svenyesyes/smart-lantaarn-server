(function(){
  const popup = document.getElementById('lampPopup');
  const popupTitle = document.getElementById('popupTitle');
  const popupBody = document.getElementById('popupBody');
  const popupActivateBtn = document.getElementById('popupActivateBtn');
  const popupCloseBtn = document.getElementById('popupCloseBtn');
  const canvas = document.getElementById('graphCanvas');
  const ctx = canvas.getContext('2d');

  function resizeCanvas(){
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    render();
  }
  window.addEventListener('resize', resizeCanvas);

  let graph = { nodes: [], edges: [] };
  let states = []; // [{id, state}]
  let positions = new Map(); // id -> {x,y}
  let rects = new Map(); // id -> {x,y,w,h}
  let selectedLampId = null;
  let pan = { x: 0, y: 0 };
  let isPanning = false;
  let drag = { id: null, startX: 0, startY: 0 };
  let dragMode = false;
  const dragModeEl = document.getElementById('dragMode');
  if (dragModeEl) {
    dragModeEl.addEventListener('change', () => {
      dragMode = !!dragModeEl.checked;
      // Close any popup when entering drag mode
      if (dragMode && !popup.classList.contains('hidden')) {
        popup.classList.add('hidden');
        selectedLampId = null;
      }
    });
  }

  async function savePositions(){
    const obj = {};
    positions.forEach((p, id) => { obj[id] = p; });
    try {
      await fetch('/positions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
    } catch {}
  }
  async function loadPositions(){
    try {
      const res = await fetch('/positions');
      if (!res.ok) return false;
      const obj = await res.json();
      if (!obj || typeof obj !== 'object') return false;
      positions = new Map(Object.entries(obj).map(([id, p]) => [id, p]));
      // build rects immediately
      rects = new Map();
      const blockW = 24, blockH = 16;
      positions.forEach((p, id) => {
        rects.set(id, { x: p.x - blockW/2, y: p.y - blockH/2, w: blockW, h: blockH });
      });
      return true;
    } catch { return false; }
  }

  // Force-directed layout to automatically align by connections (simple physics)
  function layoutPositions(){
    const padding = 60;
    const width = canvas.width - padding*2;
    const height = canvas.height - padding*2;

    // Initialize positions deterministically by street grouping, then relax
    const streets = Array.from(new Set(graph.nodes.map(n => n.street)));
    const streetIndex = new Map(streets.map((s,i)=>[s,i]));
    const laneCount = Math.max(1, streets.length);
    const laneY = (i) => padding + (i+0.5) * (height / laneCount);

    positions = new Map();
    const grouped = new Map();
    graph.nodes.forEach(n => {
      const key = n.street;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(n);
    });
    grouped.forEach((list, street) => {
      list.sort((a,b)=>a.id.localeCompare(b.id));
      list.forEach((n, idx) => {
        const x = padding + (idx+1) * (width / (list.length+1));
        const y = laneY(streetIndex.get(street));
        positions.set(n.id, {x,y});
      });
    });

    // Apply a few iterations of force relaxation based on edges
    const iterations = 150;
    const k = 0.02; // spring strength
    const repulsion = 4000; // node repulsion
    for (let it=0; it<iterations; it++) {
      // repulsion between nodes
      for (let i=0; i<graph.nodes.length; i++){
        const a = graph.nodes[i];
        const pa = positions.get(a.id);
        if (!pa) continue;
        let fx = 0, fy = 0;
        for (let j=i+1; j<graph.nodes.length; j++){
          const b = graph.nodes[j];
          const pb = positions.get(b.id);
          if (!pb) continue;
          const dx = pa.x - pb.x; const dy = pa.y - pb.y;
          const d2 = Math.max(1, dx*dx + dy*dy);
          const f = repulsion / d2;
          const dist = Math.sqrt(d2);
          fx += (dx/dist) * f;
          fy += (dy/dist) * f;
          positions.set(b.id, { x: pb.x - (dx/dist) * f, y: pb.y - (dy/dist) * f });
        }
        positions.set(a.id, { x: pa.x + fx, y: pa.y + fy });
      }
      // springs for edges
      graph.edges.forEach(e => {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return;
        const dx = b.x - a.x; const dy = b.y - a.y;
        const fx = dx * k; const fy = dy * k;
        positions.set(e.from, { x: a.x + fx, y: a.y + fy });
        positions.set(e.to, { x: b.x - fx, y: b.y - fy });
      });
      // keep inside padding bounds
      positions.forEach((p, id) => {
        const x = Math.max(padding, Math.min(canvas.width - padding, p.x));
        const y = Math.max(padding, Math.min(canvas.height - padding, p.y));
        positions.set(id, { x, y });
      });
    }

    // rects for hit testing
    rects = new Map();
    const blockW = 24, blockH = 16;
    positions.forEach((p, id) => {
      rects.set(id, { x: p.x - blockW/2, y: p.y - blockH/2, w: blockW, h: blockH });
    });

    return positions;
  }

  function render(){
    if (!ctx) return;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    if (!positions || positions.size !== graph.nodes.length) {
      // Attempt to load shared positions from server
      // Note: render() is sync; we cannot await here, so we optimistically draw,
      // and refreshGraph() triggers render after positions load.
      layoutPositions();
    }

    // draw edges
    ctx.lineWidth = 2;
    graph.edges.forEach(e => {
      const a = positions.get(e.from);
      const b = positions.get(e.to);
      if (!a || !b) return;
      ctx.strokeStyle = e.type === 'same_street' ? '#ff6b6b' : '#2ecc71';
      ctx.beginPath();
      ctx.moveTo(a.x + pan.x, a.y + pan.y);
      ctx.lineTo(b.x + pan.x, b.y + pan.y);
      ctx.stroke();
    });

    // draw nodes as blocks
    graph.nodes.forEach(n => {
      const rect = rects.get(n.id);
      if (!rect) return;
      const state = states.find(s=>s.id===n.id)?.state || { on:false, brightness:0, color:'#888' };
      const isSelected = selectedLampId === n.id;
      ctx.fillStyle = state.on ? state.color : '#cbd5e1';
      ctx.fillRect(rect.x + pan.x, rect.y + pan.y, rect.w, rect.h);
      ctx.strokeStyle = isSelected ? '#2563eb' : '#808080';
      ctx.lineWidth = isSelected ? 3 : 1;
      ctx.strokeRect(rect.x + pan.x, rect.y + pan.y, rect.w, rect.h);

      ctx.fillStyle = '#333';
      ctx.font = '12px system-ui';
      ctx.fillText(n.id, rect.x + pan.x, rect.y - 6 + pan.y);
    });
  }

  async function refreshGraph(){
    const res = await fetch('/graph');
    graph = await res.json();
    // Load shared positions, then render
    await loadPositions();
    render();
  }

  // no depth slider/control: use default depth

  // Mouse interactions: drag nodes, pan canvas, click to open popup
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
        // begin dragging only in drag mode
        drag.id = hitId;
        drag.startX = x - (positions.get(hitId)?.x || 0) - pan.x;
        drag.startY = y - (positions.get(hitId)?.y || 0) - pan.y;
      } else {
        // not in drag mode: open popup immediately
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
      // snap to grid when in drag mode
      const grid = 20;
      const sx = dragMode ? Math.round(nx / grid) * grid : nx;
      const sy = dragMode ? Math.round(ny / grid) * grid : ny;
      positions.set(drag.id, { x: sx, y: sy });
      const b = rects.get(drag.id);
      if (b) {
        const blockW = b.w, blockH = b.h;
        rects.set(drag.id, { x: sx - blockW/2, y: sy - blockH/2, w: blockW, h: blockH });
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
      // Only save positions in drag mode
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

  function showPopupForLamp(lampId){
    const node = graph.nodes.find(n=>n.id===lampId);
    const state = states.find(s=>s.id===lampId)?.state;
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

  // Activate from popup: show preview (no hover required), then trigger activation
  popupActivateBtn.addEventListener('click', async () => {
    if (!selectedLampId) return;
    const street = graph.nodes.find(n=>n.id===selectedLampId)?.street;
    if (!street) return;
    const depth = 1; // default spillover depth without UI control
    const res = await fetch(`/streets/${encodeURIComponent(street)}/preview?depth=${depth}`);
    const data = await res.json();
    const ids = new Set(data.affectedLampIds);
    // Show preview highlight by increasing brightness temporarily
    const backup = states.slice();
    states = states.map(s => ids.has(s.id) ? { id: s.id, state: { ...s.state, brightness: Math.max(s.state.brightness, 70) } } : s);
    render();

    // Immediately perform activation; server will broadcast final states
    const payload = { on: true, brightness: 70, color: '#ffd166', spilloverDepth: depth };
    await fetch(`/streets/${encodeURIComponent(street)}/activate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

    // Restore local state; websocket update will set the new actual states
    states = backup;
  });

  // WebSocket updates
  let ws;
  function connectWS(){
    ws = new WebSocket(`ws://${location.host}`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'init') {
          graph = msg.graph || graph;
          states = msg.states || states;
          // If server provided positions, use them immediately
          if (msg.positions) {
            positions = new Map(Object.entries(msg.positions).map(([id, p]) => [id, p]));
            // rebuild rects
            rects = new Map();
            const blockW = 24, blockH = 16;
            positions.forEach((p, id) => {
              rects.set(id, { x: p.x - blockW/2, y: p.y - blockH/2, w: blockW, h: blockH });
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
          const blockW = 24, blockH = 16;
          positions.forEach((p, id) => {
            rects.set(id, { x: p.x - blockW/2, y: p.y - blockH/2, w: blockW, h: blockH });
          });
          render();
        }
      } catch {}
    };
    ws.onclose = () => setTimeout(connectWS, 1000);
  }

  // initial
  resizeCanvas();
  refreshGraph();
  connectWS();
})();
