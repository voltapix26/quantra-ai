/* ============================================================
   Quantra AI — animated network globe (original, canvas 2D)
   Rotating point-sphere + glowing data arcs. Drag to rotate.
   Auto-initialises every <canvas class="globe"> / #globe.
   ============================================================ */
(function () {
  'use strict';
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stops = [[52, 211, 153], [34, 211, 238], [129, 140, 248]];
  function ramp(t) {
    t = Math.max(0, Math.min(1, t));
    const seg = t * (stops.length - 1), i = Math.floor(seg), f = seg - i;
    const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  const rgba = (c, al) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${al})`;

  function makeGlobe(canvas) {
    const ctx = canvas.getContext('2d');
    const N = Math.max(120, parseInt(canvas.dataset.density || '760', 10));
    const NARC = Math.max(0, parseInt(canvas.dataset.arcs || '7', 10));

    const pts = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2, r = Math.sqrt(1 - y * y), phi = i * Math.PI * (3 - Math.sqrt(5));
      pts.push({ x: Math.cos(phi) * r, y, z: Math.sin(phi) * r, c: ramp((1 - y) / 2) });
    }
    const ARCS = [];
    for (let i = 0; i < NARC; i++) ARCS.push({ a: pts[(i * 137 + 11) % N], b: pts[(i * 311 + 200) % N], phase: i / Math.max(1, NARC) });

    function arcPoints(a, b, steps) {
      const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
      const om = Math.acos(dot), so = Math.sin(om) || 1e-6, out = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, s1 = Math.sin((1 - t) * om) / so, s2 = Math.sin(t * om) / so;
        const lift = 1 + 0.16 * Math.sin(Math.PI * t);
        out.push({ x: (a.x * s1 + b.x * s2) * lift, y: (a.y * s1 + b.y * s2) * lift, z: (a.z * s1 + b.z * s2) * lift });
      }
      return out;
    }

    let W = 0, H = 0, R = 0, cx = 0, cy = 0, dpr = 1;
    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = rect.width; H = rect.height;
      canvas.width = Math.max(1, W * dpr); canvas.height = Math.max(1, H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      R = Math.min(W, H) * 0.42; cx = W * 0.5; cy = H * 0.5;
    }
    resize();
    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
    else window.addEventListener('resize', resize);

    // --- interaction state ---
    const AUTO = reduce ? 0 : 0.00018;     // rad per ms
    let rotY = 0.4, tilt = -0.45, vx = 0, dragging = false, lx = 0, ly = 0, prev = 0;

    function project(p) {
      const sa = Math.sin(rotY), ca = Math.cos(rotY), cT = Math.cos(tilt), sT = Math.sin(tilt);
      let x = p.x * ca + p.z * sa, z = -p.x * sa + p.z * ca, y = p.y * cT - z * sT;
      z = p.y * sT + z * cT;
      const persp = 2.4 / (2.4 - z);
      return { sx: cx + x * R * persp, sy: cy + y * R * persp, z, persp };
    }

    function frame(now) {
      const dt = Math.min(60, now - prev || 16); prev = now;
      if (!dragging) { rotY += AUTO * dt + vx; vx *= 0.94; if (Math.abs(vx) < 1e-5) vx = 0; }
      ctx.clearRect(0, 0, W, H);

      const halo = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.5);
      halo.addColorStop(0, 'rgba(52,211,153,0.10)'); halo.addColorStop(0.5, 'rgba(129,140,248,0.05)'); halo.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = halo; ctx.fillRect(0, 0, W, H);

      const proj = pts.map((p) => ({ p, q: project(p) })).sort((m, n) => m.q.z - n.q.z);
      for (const { p, q } of proj) {
        const depth = (q.z + 1) / 2, al = 0.12 + depth * 0.78, size = (0.5 + depth * 1.6) * q.persp;
        if (depth > 0.55) { ctx.shadowColor = rgba(p.c, 0.6); ctx.shadowBlur = 6 * depth; } else ctx.shadowBlur = 0;
        ctx.beginPath(); ctx.arc(q.sx, q.sy, size, 0, Math.PI * 2); ctx.fillStyle = rgba(p.c, al); ctx.fill();
      }
      ctx.shadowBlur = 0;

      const t = now * 0.0004;
      for (const arc of ARCS) {
        const path = arcPoints(arc.a, arc.b, 48).map(project);
        ctx.lineWidth = 1.2;
        for (let i = 1; i < path.length; i++) {
          const p0 = path[i - 1], p1 = path[i], d = ((p0.z + p1.z) / 2 + 1) / 2;
          ctx.strokeStyle = rgba(arc.a.c, 0.05 + d * 0.28);
          ctx.beginPath(); ctx.moveTo(p0.sx, p0.sy); ctx.lineTo(p1.sx, p1.sy); ctx.stroke();
        }
        const tp = (t + arc.phase) % 1, idx = Math.min(path.length - 1, Math.floor(tp * (path.length - 1)));
        const g = path[idx], d = (g.z + 1) / 2;
        if (d > 0.25) {
          ctx.shadowColor = rgba(arc.b.c, 0.9); ctx.shadowBlur = 14 * d;
          ctx.beginPath(); ctx.arc(g.sx, g.sy, 2.4 * g.persp, 0, Math.PI * 2); ctx.fillStyle = rgba(arc.b.c, 0.95); ctx.fill(); ctx.shadowBlur = 0;
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // --- drag to rotate (mouse + touch) ---
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'grab';
    const down = (e) => { dragging = true; vx = 0; canvas.style.cursor = 'grabbing'; const p = pt(e); lx = p.x; ly = p.y; if (canvas.setPointerCapture && e.pointerId != null) try { canvas.setPointerCapture(e.pointerId); } catch (_) {} };
    const move = (e) => {
      if (!dragging) return;
      const p = pt(e), dx = p.x - lx, dy = p.y - ly;
      rotY += dx * 0.006; vx = dx * 0.006 * 0.5;
      tilt = Math.max(-1.2, Math.min(0.5, tilt - dy * 0.005));
      lx = p.x; ly = p.y; e.preventDefault();
    };
    const up = () => { dragging = false; canvas.style.cursor = 'grab'; };
    const pt = (e) => { const r = canvas.getBoundingClientRect(); const s = e.touches ? e.touches[0] : e; return { x: s.clientX - r.left, y: s.clientY - r.top }; };

    if (window.PointerEvent) {
      canvas.addEventListener('pointerdown', down);
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', up);
    } else {
      canvas.addEventListener('mousedown', down); window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
      canvas.addEventListener('touchstart', down, { passive: false }); canvas.addEventListener('touchmove', move, { passive: false }); window.addEventListener('touchend', up);
    }
  }

  const seen = new Set();
  document.querySelectorAll('canvas#globe, canvas.globe').forEach((c) => { if (!seen.has(c)) { seen.add(c); makeGlobe(c); } });
})();
