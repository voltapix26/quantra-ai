/* ============================================================
   Quantra AI — premium hero: Three.js 3D centerpiece + counters
   Reduced-motion aware · DPR-capped · pauses off-screen/hidden.
   Degrades gracefully (CSS orb remains) if WebGL/THREE unavailable.
   ============================================================ */
(function () {
  'use strict';
  var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  var noMotion = mq.matches;
  if (mq.addEventListener) mq.addEventListener('change', function (e) { noMotion = e.matches; });

  /* ---- animated stat counters ---- */
  function runCounters() {
    document.querySelectorAll('.gstat b[data-count]').forEach(function (el) {
      var target = +el.dataset.count, suf = el.dataset.suffix || '';
      if (noMotion) { el.textContent = target + suf; return; }
      var dur = 1300, t0 = performance.now();
      (function step(t) {
        var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(e * target) + suf;
        if (p < 1) requestAnimationFrame(step);
      })(t0);
    });
  }
  var hero = document.querySelector('.hero'), counted = false;
  if (hero && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting && !counted) { counted = true; runCounters(); } });
    }, { threshold: 0.3 });
    io.observe(hero);
  } else { runCounters(); }

  /* ---- Three.js 3D centerpiece ---- */
  function initGL() {
    var canvas = document.getElementById('heroGL');
    if (!canvas || typeof THREE === 'undefined') return;
    var renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true }); }
    catch (e) { return; }                          // no WebGL → CSS orb stays
    renderer.setClearColor(0x000000, 0);

    var scene = new THREE.Scene();
    var cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100); cam.position.z = 4.2;
    var grp = new THREE.Group(); scene.add(grp);

    // wireframe icosahedron (mint) — hero object, higher detail
    var ico = new THREE.IcosahedronGeometry(1.35, 1);
    grp.add(new THREE.LineSegments(
      new THREE.WireframeGeometry(ico),
      new THREE.LineBasicMaterial({ color: 0x34D399, transparent: true, opacity: 0.55 })
    ));
    // faint inner shell for depth
    grp.add(new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.32, 1),
      new THREE.MeshBasicMaterial({ color: 0x0B2C2A, transparent: true, opacity: 0.32 })
    ));
    // glowing nodes at vertices (cyan)
    var nodeGeo = new THREE.BufferGeometry();
    nodeGeo.setAttribute('position', ico.attributes.position.clone());
    grp.add(new THREE.Points(nodeGeo, new THREE.PointsMaterial({
      color: 0x22D3EE, size: 0.075, transparent: true, opacity: 0.95
    })));

    // particle halo (indigo, additive glow) — background detail, low cost
    var N = 520, arr = new Float32Array(N * 3);
    for (var i = 0; i < N; i++) {
      var r = 2.0 + Math.random() * 1.9, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
      arr[i * 3] = r * Math.sin(ph) * Math.cos(th);
      arr[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      arr[i * 3 + 2] = r * Math.cos(ph);
    }
    var pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    var particles = new THREE.Points(pgeo, new THREE.PointsMaterial({
      color: 0x818CF8, size: 0.026, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false
    }));
    scene.add(particles);

    function resize() {
      var rect = canvas.getBoundingClientRect();
      var w = Math.max(1, rect.width), h = Math.max(1, rect.height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      cam.aspect = w / h; cam.updateProjectionMatrix();
    }
    resize(); window.addEventListener('resize', resize);

    // pointer parallax (desktop) — gated on motion preference
    var tx = 0, ty = 0, mx = 0, my = 0;
    window.addEventListener('pointermove', function (e) {
      tx = e.clientX / window.innerWidth - 0.5;
      ty = e.clientY / window.innerHeight - 0.5;
    }, { passive: true });

    var running = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { es.forEach(function (e) { running = e.isIntersecting; }); })
        .observe(canvas);
    }

    var last = performance.now();
    function loop(t) {
      requestAnimationFrame(loop);
      if (!running || document.hidden) { last = t; return; }
      var dt = Math.min(0.05, (t - last) / 1000); last = t;
      if (!noMotion) {
        grp.rotation.y += dt * 0.28; grp.rotation.x += dt * 0.06;
        particles.rotation.y -= dt * 0.05;
        mx += (tx - mx) * 0.05; my += (ty - my) * 0.05;
        cam.position.x = mx * 0.6; cam.position.y = -my * 0.4; cam.lookAt(0, 0, 0);
      }
      renderer.render(scene, cam);
    }
    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGL);
  else initGL();
})();
