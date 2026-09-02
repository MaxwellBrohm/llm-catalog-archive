/**
 * The browser module that mounts the 3D front door, as one string.
 *
 * It lives here as a string for the same reason the stylesheet does: the render
 * layer is pure, buildSite returns bytes, and an asset read off disk at render
 * time would put `node:fs` inside a module the tests rely on being a function
 * of its arguments. Written to `wall.js` at the site root.
 *
 * IT IS A MODULE, so a browser too old to understand `type="module"` never
 * executes a line of it and gets the list. The `import()` of three.js is inside
 * the gates rather than at the top, so a phone, a browser without WebGL2, and a
 * window under 880px never fetch three quarters of a megabyte they cannot use.
 *
 * Nothing in it is required for the page to be a complete index. See wall.ts.
 */
export const WALL_JS = `/*
 * llm-catalog-archive: the 3D front door.
 *
 * A LOCKED CAMERA. There is no orbit, no dolly, no scroll hijack and no reset
 * button, because there is nothing to navigate to: every tab is already in
 * frame. The camera answers a pointer with about a degree of parallax and
 * nothing else. A 3D index a reader has to fly around is a worse index than a
 * list, and the list is right below this.
 *
 * NOTHING HERE IS LOAD-BEARING. index.html is a complete index before this file
 * runs, and stays one if it never does. Every early return below leaves the
 * page exactly as the server rendered it, and the tab list is un-hidden again
 * if the WebGL context is ever lost. three.js is imported dynamically, AFTER
 * the gates, so a phone never downloads it.
 */

const wrap = document.querySelector('[data-wall]');
const stage = document.querySelector('[data-wall-stage]');
const list = document.querySelector('[data-wall-list]');
const island = document.querySelector('[data-wall-tabs]');

/* ---- geometry of the wall, in world units ---------------------------- */
const COLS = 4;
const ROWS = 3;
const CELL_W = 640;
const CELL_H = 320;
const ATLAS_COLS = 3;
const TAB_W = 3.2;
const TAB_H = 1.6;
const PITCH_X = 3.72;
const PITCH_Y = 1.98;
/*
 * The arc and the lens are one decision, not two. A wide lens makes the
 * outermost slabs into trapezoids: at 40 degrees vertical on a stage this
 * panoramic the horizontal field is 84 degrees, and the corner tabs shear hard
 * enough that a reader notices the distortion before the type. Thirty degrees
 * is a longer lens with far less shear, and the arc is tightened from 14 to 11
 * to put the curve back that the longer lens takes out.
 */
const RADIUS = 11;
const FOV = 30;

/* ---- the palette, the same values style.css uses --------------------- */
const PANEL = '#0b0b0d';
const PANEL_HI = '#141418';
const LINE = '#232329';
const TEXT = '#f6f1ea';
const DIM = '#9a958f';
const ORANGE_HOT = '#ff8c2e';

const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

let tabs = null;
try {
  tabs = JSON.parse(island && island.textContent ? island.textContent : 'null');
} catch (err) {
  tabs = null;
}

/*
 * EACH SCENE GATES ITSELF. This condition used to require the WALL's three
 * elements, so on any page without a wall the module loaded, resolved nothing
 * and returned: the changelog's capture graph never got the chance to run,
 * which is exactly what it did on its first build. The shared prerequisites are
 * a wide enough window and a working WebGL context; which scenes then exist is
 * each scene's own question.
 */
const hasWall = Boolean(wrap && stage && list && Array.isArray(tabs) && tabs.length > 0);
const hasWire = Boolean(document.querySelector('.wire'));
const hasGraph = Boolean(document.querySelector('[data-graph-stage]'));

if ((hasWall || hasWire || hasGraph) && wide() && webgl()) {
  boot();
}

/*
 * The size gate. A phone gets the list, full stop: 12 slabs at phone width are
 * 90 pixels across, which is a picture of an index rather than an index, and
 * most links to this site are opened on one.
 *
 * THE HEIGHT IS 600 AND NOT 560 BECAUSE 560 WAS A PROMISE THE WALL COULD NOT
 * KEEP. About 253px of header and hero sit above the stage, and the wall needs
 * 300px of its own to seat four rows without cropping, so 560 left it 113px
 * short and the bottom row fell past the fold with a locked camera and no way
 * to reach it. A gate should describe what actually happens at that size, so it
 * now names the height at which a COMPLETE wall fits. Below it the list stands,
 * which was always the better of the two outcomes.
 */
function wide() {
  return window.matchMedia('(min-width: 880px) and (min-height: 600px)').matches;
}

/* A probe, not an assumption. The context is released immediately. */
function webgl() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return true;
  } catch (err) {
    return false;
  }
}

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}


/* ===========================================================================
 * THE WIRE, IN THREE DIMENSIONS
 *
 * The stream below the front door is drawn as a conductor with the archive's
 * CAPTURES as nodes on it, and until now that conductor was a CSS gradient with
 * shadows arranged to imply depth. This replaces it with real geometry: an
 * extruded conductor, a stud per capture, and two lights.
 *
 * IT COSTS NOTHING TO DOWNLOAD. three.js is already vendored and already
 * imported by the wall above, so this scene reuses a module the reader has
 * fetched and parsed. The earlier decision not to build it was justified in a
 * commit message on a 700 KB figure that was simply wrong.
 *
 * ORTHOGRAPHIC, AT ONE UNIT PER CSS PIXEL. This object has to line up with HTML
 * rows, and under a perspective camera a stud's screen position depends on its
 * depth, so alignment would drift with any change to the scene. With an
 * orthographic camera scaled to the viewport, scene Y IS document Y minus
 * scroll, and a stud sits on its capture by construction rather than by
 * tuning.
 *
 * FIXED CANVAS, NOT A TALL ONE. The document is 27,000px; a canvas that tall
 * exceeds texture limits on real hardware and would allocate hundreds of
 * megabytes. So the canvas is viewport height, pinned, and the scene translates
 * by the scroll offset.
 *
 * PROGRESSIVE ENHANCEMENT, THE SAME CONTRACT AS THE WALL. The CSS conductor is
 * the real one. This draws over it and only once a frame is actually on screen,
 * and it puts the CSS one back if the context is ever lost.
 * =========================================================================== */

var WIRE_GUTTER = 34; /* matches .wire padding-left in the stylesheet */

function wireHosts() {
  return Array.prototype.slice.call(document.querySelectorAll('.wire'));
}

function mountWire(THREE) {
  var hosts = wireHosts();
  if (hosts.length === 0) return;

  var canvas = document.createElement('canvas');
  canvas.className = 'wire-3d';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.appendChild(canvas);

  var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  var scene = new THREE.Scene();
  var camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -400, 400);
  camera.position.z = 120;

  /*
   * One warm key from the upper left and a cool fill, which is the whole rig.
   * The palette is a single live colour on near-black, so a third light would
   * only wash the conductor toward grey.
   */
  scene.add(new THREE.AmbientLight(0x1a1a20, 2.2));
  var key = new THREE.DirectionalLight(0xff8a3a, 3.1);
  key.position.set(-0.7, 0.9, 1);
  scene.add(key);
  var rim = new THREE.DirectionalLight(0x4a5a7a, 1.5);
  rim.position.set(0.9, -0.4, 0.6);
  scene.add(rim);

  /*
   * METALNESS WITHOUT AN ENVIRONMENT MAP IS A BLACK MATERIAL.
   *
   * The first version of this shipped the conductor at metalness 0.85 with no
   * env map, which kills the diffuse term and leaves only two directional
   * specular hits on a very dark albedo. Measured on the built page: the
   * brightest pixel in the conductor's column was (31,7,1) against a (5,5,5)
   * ground, a contrast ratio of 1.06 to 1, while the CSS conductor it SUPPRESSES
   * measured (182,79,7). The enhancement was three to seven times dimmer than
   * the fallback it replaced, which makes it a regression rather than an
   * enhancement, whatever the geometry underneath is doing.
   *
   * So the conductor is mostly dielectric now and carries its own emissive
   * floor, which is what a lit filament actually is, and it no longer depends
   * on a reflection that this scene has nothing to reflect.
   */
  var conductorMat = new THREE.MeshStandardMaterial({
    color: 0x963d08,
    roughness: 0.42,
    metalness: 0.2,
    emissive: 0xff6a00,
    emissiveIntensity: 0.34,
  });
  var studMat = new THREE.MeshStandardMaterial({
    color: 0xff6a00,
    roughness: 0.28,
    metalness: 0.25,
    emissive: 0xff6a00,
    emissiveIntensity: 0.5,
  });

  var group = new THREE.Group();
  scene.add(group);

  /*
   * A CYLINDER OF HEIGHT EXACTLY 1, so scaling Y by a pixel length gives that
   * many pixels. The first build used a capsule, whose total height is its
   * length PLUS two radii: at radius 2.6 that is 6.2 units, so every conductor
   * rendered 6.2 times too long and, being centred on its midpoint, overshot
   * its wire by 300px at each end. It was drawing through the lab filter above
   * the stream, which is how it was spotted.
   */
  var conductorGeo = new THREE.CylinderGeometry(2.6, 2.6, 1, 20, 1);
  var studGeo = new THREE.SphereGeometry(6.2, 28, 20);

  var conductors = [];
  var studs = [];

  function clear() {
    for (var i = 0; i < conductors.length; i++) group.remove(conductors[i]);
    for (var j = 0; j < studs.length; j++) group.remove(studs[j]);
    conductors = [];
    studs = [];
  }

  /* Document coordinates for every conductor run and every stud on it. */
  var runs = [];
  var nodes = [];

  function measure() {
    runs = [];
    nodes = [];
    var scrollY = window.scrollY || window.pageYOffset || 0;
    var list = wireHosts();
    for (var i = 0; i < list.length; i++) {
      var host = list[i];
      var hb = host.getBoundingClientRect();
      var x = hb.left + WIRE_GUTTER - 25;
      runs.push({ x: x, top: hb.top + scrollY + 6, bottom: hb.bottom + scrollY - 6 });
      var caps = host.querySelectorAll('.capture');
      for (var c = 0; c < caps.length; c++) {
        var cb = caps[c].getBoundingClientRect();
        var w = parseInt(caps[c].getAttribute('data-weight') || '1', 10);
        nodes.push({ x: x, y: cb.top + scrollY + 12, weight: isFinite(w) ? w : 1 });
      }
    }
    clear();
    for (var r = 0; r < runs.length; r++) {
      var m = new THREE.Mesh(conductorGeo, conductorMat);
      group.add(m);
      conductors.push(m);
    }
    /*
     * A STUD IS SIZED AND LIT BY WHAT ITS CAPTURE ACTUALLY CHANGED.
     *
     * Every stud used to be identical, which made the wire a decoration: it
     * marked that a commit happened and said nothing about it. The weight is
     * the capture's uncapped item count, and it drives radius and emissive
     * together, so scanning the conductor tells a reader where the archive
     * moved before they read a word.
     *
     * The curve is a cube root, not linear. Counts run from 1 to about 40 in
     * this archive and a linear map would make the median node a speck beside
     * the busiest one; the compression keeps a single price change visible
     * while still ranking it clearly below a 27-value capture. Each stud gets
     * its own material because emissiveIntensity is per material, not per mesh.
     */
    var maxWeight = 1;
    for (var w = 0; w < nodes.length; w++) maxWeight = Math.max(maxWeight, nodes[w].weight);
    for (var n = 0; n < nodes.length; n++) {
      var t = Math.pow(nodes[n].weight / maxWeight, 1 / 3);
      var m = studMat.clone();
      m.emissiveIntensity = 0.34 + 0.5 * t;
      var st = new THREE.Mesh(studGeo, m);
      st.scale.setScalar(0.62 + 0.68 * t);
      group.add(st);
      studs.push(st);
    }
  }

  function size() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.left = 0;
    camera.right = w;
    camera.top = 0;
    camera.bottom = -h;
    camera.updateProjectionMatrix();
  }

  function draw() {
    var scrollY = window.scrollY || window.pageYOffset || 0;
    var h = window.innerHeight;
    for (var i = 0; i < conductors.length; i++) {
      var run = runs[i];
      var top = Math.max(run.top, scrollY - 200);
      var bottom = Math.min(run.bottom, scrollY + h + 200);
      var len = Math.max(bottom - top, 0);
      var m = conductors[i];
      m.visible = len > 0;
      if (!m.visible) continue;
      m.scale.set(1, len, 1);
      m.position.set(run.x, -(top + len / 2 - scrollY), 0);
    }
    for (var n = 0; n < studs.length; n++) {
      var node = nodes[n];
      var y = node.y - scrollY;
      var st = studs[n];
      /* Off-screen studs are skipped rather than drawn behind the viewport. */
      st.visible = y > -80 && y < h + 80;
      if (!st.visible) continue;
      st.position.set(node.x, -y, 14);
    }
    renderer.render(scene, camera);
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      draw();
    });
  }

  function relayout() {
    size();
    measure();
    draw();
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', relayout);
  /*
   * The wall changes the stage's height on resize, which moves every capture in
   * the document. Both listeners fire on the same event and the ordering
   * between them is not guaranteed, so the wall calls this AFTER it has resized
   * the stage rather than relying on being second.
   */
  window.__lcaWireRelayout = relayout;

  canvas.addEventListener('webglcontextlost', function (ev) {
    ev.preventDefault();
    window.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', relayout);
    document.documentElement.classList.remove('wire-3d-on');
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  });

  relayout();
  /* Only after a frame is genuinely on screen does the CSS conductor stand down. */
  document.documentElement.classList.add('wire-3d-on');
}


/* ===========================================================================
 * THE CAPTURE GRAPH
 *
 * The changelog is the archive's own history: one commit per accepted capture,
 * across thirty sources, over weeks. As a table that is true and flat. As a
 * graph it is the shape of the thing: one LANE per source running back into
 * depth, one node per capture along it, sized by how large that diff was.
 *
 * It is the only page where a git-shaped object is the honest illustration,
 * because this page IS the git log. The tables underneath are the page; this
 * draws above them and never replaces them.
 * =========================================================================== */

function mountGraph(THREE) {
  var stage = document.querySelector('[data-graph-stage]');
  var island = document.querySelector('[data-graph-nodes]');
  if (!stage || !island) return;

  var nodes;
  try {
    nodes = JSON.parse(island.textContent || '[]');
  } catch (err) {
    return;
  }
  if (!nodes.length) return;

  /* Lanes in first-seen order, so the busiest sources are not shuffled per build. */
  var lanes = [];
  var laneOf = {};
  for (var i = 0; i < nodes.length; i++) {
    var srcName = nodes[i].source;
    if (!(srcName in laneOf)) {
      laneOf[srcName] = lanes.length;
      lanes.push(srcName);
    }
  }

  var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(new THREE.Color(0.019, 0.019, 0.021), 1);
  var canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.setAttribute('tabindex', '-1');
  stage.appendChild(canvas);

  var scene = new THREE.Scene();
  /*
   * A WIDE LENS AND FOG, because the point is that these lanes RECEDE. At 38
   * degrees from far enough away to fit 31 lanes, the projection is nearly
   * orthographic and the graph reads as a flat scatter plot: correct geometry,
   * no depth. A wide lens close in gives real convergence, and fog tinted to
   * the ground makes distance legible rather than merely implied.
   */
  var camera = new THREE.PerspectiveCamera(58, 2, 0.1, 400);
  scene.fog = new THREE.Fog(0x121215, 6, 46);

  scene.add(new THREE.AmbientLight(0x20202a, 2.4));
  var key = new THREE.DirectionalLight(0xff8a3a, 2.6);
  key.position.set(-0.6, 1, 0.8);
  scene.add(key);
  var fill = new THREE.DirectionalLight(0x44507a, 1.2);
  fill.position.set(0.8, -0.3, 0.5);
  scene.add(fill);

  var LANE_GAP = 1.15;
  var STEP = 1.15;
  var spanX = (lanes.length - 1) * LANE_GAP;

  /* One rail per source. */
  var railGeo = new THREE.CylinderGeometry(0.035, 0.035, 1, 8, 1);
  /* Bright enough to read as a lane. At 0.08 the rails were invisible and the
   * graph looked like scattered dots rather than thirty-one histories. */
  var railMat = new THREE.MeshStandardMaterial({
    color: 0x6b3410,
    roughness: 0.5,
    metalness: 0.15,
    emissive: 0xff6a00,
    emissiveIntensity: 0.22,
  });

  /* Per-source counts decide each rail's length, so a lane stops where its
   * source stops rather than every lane spanning the whole window. */
  var perLane = [];
  for (var l = 0; l < lanes.length; l++) perLane.push(0);
  for (var j = 0; j < nodes.length; j++) perLane[laneOf[nodes[j].source]] += 1;

  for (var r = 0; r < lanes.length; r++) {
    if (perLane[r] < 2) continue;
    var len = (perLane[r] - 1) * STEP;
    var rail = new THREE.Mesh(railGeo, railMat);
    rail.scale.set(1, len, 1);
    rail.rotation.x = Math.PI / 2;
    rail.position.set(r * LANE_GAP - spanX / 2, 0, -len / 2);
    scene.add(rail);
  }

  /*
   * The nodes, instanced. Size is the diff's size on a cube root, for the same
   * reason the wire's studs use one: this archive's diffs run from 2 lines to
   * several hundred, and a linear map would make everything except the largest
   * invisible.
   */
  var maxSize = 1;
  for (var m = 0; m < nodes.length; m++) maxSize = Math.max(maxSize, nodes[m].size || 1);

  var nodeGeo = new THREE.SphereGeometry(0.13, 18, 14);
  var nodeMat = new THREE.MeshStandardMaterial({
    color: 0xff6a00,
    roughness: 0.3,
    metalness: 0.2,
    emissive: 0xff6a00,
    emissiveIntensity: 0.42,
  });
  var mesh = new THREE.InstancedMesh(nodeGeo, nodeMat, nodes.length);
  mesh.frustumCulled = false;
  var dummy = new THREE.Object3D();
  /* The real extent of what is drawn, so the camera is FITTED rather than
   * guessed. The first build placed the camera from the lane span with hand
   * picked multipliers, which centred nothing: at a wide viewport the whole
   * graph sat in the bottom left with half the stage empty. */
  var bounds = new THREE.Box3();
  var seen = [];
  for (var q = 0; q < lanes.length; q++) seen.push(0);
  for (var k = 0; k < nodes.length; k++) {
    var lane = laneOf[nodes[k].source];
    var along = seen[lane];
    seen[lane] += 1;
    var t = Math.pow((nodes[k].size || 1) / maxSize, 1 / 3);
    dummy.position.set(lane * LANE_GAP - spanX / 2, 0, -along * STEP);
    dummy.scale.setScalar(0.55 + 1.5 * t);
    dummy.updateMatrix();
    mesh.setMatrixAt(k, dummy.matrix);
    bounds.expandByPoint(dummy.position);
  }
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);

  var deepest = 0;
  for (var d = 0; d < perLane.length; d++) deepest = Math.max(deepest, perLane[d]);

  function fit() {
    /*
     * MEASURED FROM THE PARENT, NOT FROM THE STAGE.
     *
     * The stage is display:none until is-mounted lands, and is-mounted lands
     * only after a frame is drawn, so measuring the stage itself is a deadlock:
     * clientWidth is 0, fit() refuses, the class never arrives and the graph
     * never appears. That is exactly what the first build did. The panel around
     * it is in flow and has a width whatever the stage is doing, and the height
     * is the same clamp the stylesheet applies.
     */
    var host = stage.parentElement;
    var w = host ? host.clientWidth : 0;
    /*
     * THE STAGE IS SHAPED LIKE THE DATA, not like the viewport. This field is
     * 31 lanes wide by a dozen captures deep, and viewed from above at 30
     * degrees the depth foreshortens to roughly a fifth of the width: the
     * content's natural aspect is about 5 to 1. Forcing that into a 1.9 to 1
     * box leaves half the stage empty whatever the camera does, which is what a
     * viewport-height stage was doing. Bounded at both ends so a narrow window
     * does not produce a letterbox slit and a wide one does not produce a wall.
     */
    var h = Math.round(Math.max(240, Math.min(430, w / 3.1)));
    if (!w || !h) return false;
    stage.style.height = h + 'px';
    renderer.setSize(w, h, false);
    camera.aspect = w / h;

    /*
     * FRAMED FROM THE CONTENT'S BOUNDING BOX, not from a guessed distance. The
     * first version placed the camera from spanX alone and looked down at a
     * steep angle, which flattened the lanes into a thin band across the middle
     * of an otherwise empty stage: thirty-one histories reading as a scatter of
     * dots. Solving the box against both frustum planes fills the frame and
     * keeps the depth legible as depth.
     */
    /*
     * FITTED BY PROJECTING THE BOX, NOT BY A CLOSED FORM OVER A SPHERE.
     *
     * The content is 31 lanes wide and a dozen captures deep: a wide, shallow,
     * flat field. A bounding sphere around that is dominated by its width, and
     * fitting a sphere satisfies BOTH half-angles, so the narrower one wins and
     * the camera retreats far enough to waste most of the frame. Measured: the
     * sphere solution put the camera at 39.6 units when the horizontal extent
     * only needed about 19, and the graph rendered as a smudge in the middle of
     * an empty stage.
     *
     * So the eight corners are actually projected and the distance is searched.
     * Twenty iterations of a bisection is nothing once per layout, and it is
     * correct for any box, any view angle and any aspect, which the closed form
     * was not.
     */
    var centre = bounds.getCenter(new THREE.Vector3());
    /*
     * STRAIGHT ON AND ABOVE, with no sideways component. An off-axis direction
     * skews the lane axis across the frame, so a wide shallow field lands as a
     * diagonal band with two corners of the stage empty. Square to the lanes,
     * their width maps to the frame width and the depth recedes upward, which
     * is the arrangement a 16:9 stage is shaped for.
     */
    var dir = new THREE.Vector3(0, 0.5, 0.866).normalize();
    var corners = [];
    var mins = [bounds.min.x - 0.5, bounds.min.y - 0.5, bounds.min.z - 0.5];
    var maxs = [bounds.max.x + 0.5, bounds.max.y + 0.5, bounds.max.z + 0.5];
    for (var cx = 0; cx < 2; cx++) {
      for (var cy = 0; cy < 2; cy++) {
        for (var cz = 0; cz < 2; cz++) {
          corners.push(new THREE.Vector3(cx ? maxs[0] : mins[0], cy ? maxs[1] : mins[1], cz ? maxs[2] : mins[2]));
        }
      }
    }

    /* The largest |NDC| any corner reaches at this distance. Under 1 fits. */
    function worstAt(d) {
      camera.position.copy(centre).addScaledVector(dir, d);
      camera.lookAt(centre);
      camera.near = 0.1;
      camera.far = d * 4 + 40;
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      var worst = 0;
      for (var i = 0; i < corners.length; i++) {
        var v = corners[i].clone().project(camera);
        worst = Math.max(worst, Math.abs(v.x), Math.abs(v.y));
      }
      return worst;
    }

    var lo = 1;
    var hi = 400;
    for (var it = 0; it < 22; it++) {
      var mid = (lo + hi) / 2;
      if (worstAt(mid) > 0.97) lo = mid;
      else hi = mid;
    }
    var dist = hi;
    worstAt(dist);
    /* Fog tied to the fitted distance rather than to fixed world units, or it
     * either does nothing or swallows the whole graph as the box changes. */
    scene.fog.near = dist * 0.55;
    scene.fog.far = dist * 1.75;
    return true;
  }

  function draw() {
    renderer.render(scene, camera);
  }

  var queued = false;
  function onResize() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      if (fit()) draw();
      else stage.classList.remove('is-mounted');
    });
  }
  window.addEventListener('resize', onResize);

  canvas.addEventListener('webglcontextlost', function (ev) {
    ev.preventDefault();
    window.removeEventListener('resize', onResize);
    stage.classList.remove('is-mounted');
    if (canvas.parentNode === stage) stage.removeChild(canvas);
  });

  if (!fit()) return;
  draw();
  stage.classList.add('is-mounted');
}

function boot() {
  Promise.all([import('./vendor/three.module.min.js'), faces()]).then(function (parts) {
    try {
      if (hasWall) mount(parts[0]);
    } catch (err) {
      /* The list is still in the DOM and still visible. Nothing to undo. */
    }
    try {
      mountWire(parts[0]);
    } catch (err) {
      /* The CSS conductor is still the one being drawn. Nothing to undo. */
    }
    try {
      mountGraph(parts[0]);
    } catch (err) {
      /* The changelog's tables are untouched and are the page. */
    }
  }, function () {});
}

/*
 * The atlas is drawn with the page's own mono face, so the type on a tab is the
 * type in the changelog table. Canvas does not pull a webfont down by using it,
 * so each size is requested explicitly first; if the request fails, or the font
 * host is blocked, this still resolves and the atlas is drawn in the fallback
 * stack rather than not drawn at all.
 */
function faces() {
  if (!document.fonts || !document.fonts.load) return Promise.resolve();
  const want = ['500 24px ' + MONO, '500 34px ' + MONO, '400 22px ' + MONO];
  return Promise.all(want.map(function (f) {
    return document.fonts.load(f).catch(function () {});
  })).then(function () {
    return document.fonts.ready;
  }).catch(function () {});
}

/* ---- the label atlas ------------------------------------------------- */

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  g.lineTo(x + r, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - r);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.closePath();
}

/*
 * A hard character wrap, on purpose. A catalogue id is slashes and hyphens
 * rather than words, so a word wrap would leave a 70-character documentation
 * path as one unbreakable run and there is nothing useful to do with it but
 * break it. Truncation past the last line is marked with an ellipsis, never
 * silent: a tab that quietly shortened an id would be printing an id that is
 * not the entity's.
 */
function backUp(line) {
  for (let i = line.length - 1; i >= line.length - 12 && i > 0; i--) {
    const ch = line[i];
    if (ch === '/' || ch === '-' || ch === ':' || ch === '.' || ch === '_') return i + 1;
  }
  return line.length;
}

function wrapLabel(g, text, maxWidth, maxLines) {
  const out = [];
  let line = '';
  let taken = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = line + ch;
    if (g.measureText(next).width > maxWidth && line !== '') {
      /* Break after the nearest separator rather than mid-token, so a
       * catalogue id splits at a slash or a hyphen and not one letter from
       * the end. Only the last dozen characters are searched: further back
       * than that and the line loses more than the break is worth. */
      const cut = backUp(line);
      out.push(line.slice(0, cut));
      taken += cut;
      line = line.slice(cut) + ch;
      if (out.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (out.length < maxLines && line !== '') {
    out.push(line);
    taken += line.length;
  }
  if (out.length === maxLines) {
    if (taken < text.length) {
      const last = out[maxLines - 1];
      out[maxLines - 1] = last.slice(0, Math.max(1, last.length - 1)) + '…';
    }
  }
  return out;
}

function drawTab(g, ox, oy, tab) {
  const pad = 30;
  g.save();
  g.translate(ox, oy);
  /*
   * Clipped to its own cell, always. Every string drawn below is data read out
   * of the archive and none of it has a bounded length, so an id or a stamp
   * that ran long would otherwise paint itself across the neighbouring tab in
   * the atlas and show up as a second entity's name on the wrong slab. A hard
   * clip makes the worst case a truncated line instead of a false one.
   */
  g.beginPath();
  g.rect(0, 0, CELL_W, CELL_H);
  g.clip();

  /* body */
  roundRect(g, 6, 6, CELL_W - 12, CELL_H - 12, 16);
  const body = g.createLinearGradient(0, 6, 0, CELL_H - 6);
  body.addColorStop(0, PANEL_HI);
  body.addColorStop(1, PANEL);
  g.fillStyle = body;
  g.fill();

  /*
   * The edge light. One hue, brightest along the top edge and falling to almost
   * nothing at the bottom, so the slab reads as lit from above rather than
   * outlined. This is the only colour in the scene that is not a grey.
   */
  g.save();
  g.shadowColor = 'rgba(255, 106, 0, 0.5)';
  g.shadowBlur = 22;
  const edge = g.createLinearGradient(0, 6, 0, CELL_H - 6);
  edge.addColorStop(0, 'rgba(255, 140, 46, 0.92)');
  edge.addColorStop(0.3, 'rgba(255, 106, 0, 0.34)');
  edge.addColorStop(1, 'rgba(255, 106, 0, 0.12)');
  g.strokeStyle = edge;
  g.lineWidth = 3;
  roundRect(g, 6, 6, CELL_W - 12, CELL_H - 12, 16);
  g.stroke();
  g.restore();

  /* the kind, as an eyebrow */
  g.textBaseline = 'alphabetic';
  if ('letterSpacing' in g) g.letterSpacing = '3px';
  g.font = '500 24px ' + MONO;
  g.fillStyle = ORANGE_HOT;
  g.fillText(String(tab.kind).toUpperCase(), pad, pad + 22);
  if ('letterSpacing' in g) g.letterSpacing = '0px';

  /* the entity's own label */
  g.font = '500 34px ' + MONO;
  g.fillStyle = TEXT;
  const lines = wrapLabel(g, String(tab.label), CELL_W - pad * 2, 3);
  for (let i = 0; i < lines.length; i++) {
    g.fillText(lines[i], pad, pad + 86 + i * 42);
  }

  /*
   * How many items attach to the thread, and the stamp of the newest one.
   *
   * TWO LINES, and the label of the stamp is on the second one in the one live
   * colour, exactly as the badge beside every other timestamp in the
   * publication is. Origin and observed are not interchangeable: one captured
   * response carried an origin fourteen hours before the fetch that saw it, so
   * a stamp printed without which of the two it is would be a number the reader
   * cannot use.
   */
  const n = tab.items === 1 ? '1 item' : tab.items + ' items';
  g.font = '400 22px ' + MONO;
  g.fillStyle = DIM;
  g.fillText(n, pad, CELL_H - pad - 32);
  if (tab.when === null) {
    g.fillStyle = ORANGE_HOT;
    g.fillText('no sidecar', pad, CELL_H - pad);
  } else {
    g.fillText(tab.when, pad, CELL_H - pad);
    const stampWidth = g.measureText(tab.when).width;
    g.font = '500 18px ' + MONO;
    g.fillStyle = ORANGE_HOT;
    if ('letterSpacing' in g) g.letterSpacing = '2px';
    g.fillText(String(tab.whenKind).toUpperCase(), pad + stampWidth + 16, CELL_H - pad);
    if ('letterSpacing' in g) g.letterSpacing = '0px';
  }

  /* the hairline under the eyebrow, so the block has a spine */
  g.strokeStyle = LINE;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(pad, pad + 42.5);
  g.lineTo(CELL_W - pad, pad + 42.5);
  g.stroke();

  g.restore();
}

function buildAtlas(items) {
  const rows = Math.ceil(items.length / ATLAS_COLS);
  const cv = document.createElement('canvas');
  cv.width = CELL_W * ATLAS_COLS;
  cv.height = CELL_H * rows;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  for (let i = 0; i < items.length; i++) {
    drawTab(g, (i % ATLAS_COLS) * CELL_W, Math.floor(i / ATLAS_COLS) * CELL_H, items[i]);
  }
  return cv;
}

/* ---- the scene ------------------------------------------------------- */

/*
 * THE TABS ARE SLABS, NOT DECALS.
 *
 * They were PlaneGeometry: flat quads with the tab artwork printed on them,
 * billboarded on an arc. That reads as 3D from straight on and as paper the
 * moment a tab turns. The geometry is a box now, so the outer columns show a
 * lit edge, which is the whole reason for arranging them on an arc.
 *
 * vFace carries which face a fragment is on, computed once in the vertex stage
 * from the object-space normal, because the atlas belongs to the front and
 * nowhere else. vLight is a lambert term for the edges against a fixed key,
 * which is what makes the extrusion legible rather than a black rim.
 */
const VERT = [
  'attribute vec4 aRect;',
  'attribute float aGlow;',
  'varying vec2 vUv;',
  'varying float vGlow;',
  'varying float vDepth;',
  'varying float vFace;',
  'varying float vLight;',
  'void main() {',
  '  vUv = aRect.xy + uv * aRect.zw;',
  '  vGlow = aGlow;',
  '  vFace = step(0.5, normal.z);',
  '  vec3 key = normalize(vec3(-0.45, 0.72, 0.52));',
  '  vLight = 0.28 + 0.72 * max(dot(normalize(normal), key), 0.0);',
  '  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);',
  '  vDepth = -mv.z;',
  '  gl_Position = projectionMatrix * mv;',
  '}',
].join('\\n');

const FRAG = [
  'uniform sampler2D uAtlas;',
  'uniform vec3 uVoid;',
  'uniform vec3 uEdge;',
  'uniform float uNear;',
  'uniform float uFar;',
  'varying vec2 vUv;',
  'varying float vGlow;',
  'varying float vDepth;',
  'varying float vFace;',
  'varying float vLight;',
  'void main() {',
  /*
   * The slab is OPAQUE. The atlas is composited onto the face rather than
   * cutting through it, because a transparent front face on a solid box shows
   * the inside of the box, and the tab artwork has rounded corners.
   */
  '  vec3 edge = uEdge * vLight;',
  '  vec4 texel = texture2D(uAtlas, vUv);',
  '  vec3 face = mix(edge, texel.rgb, texel.a * vFace);',
  '  vec3 col = mix(edge, face, vFace) * (0.66 + 0.34 * vGlow);',
  '  col = mix(col, uVoid, smoothstep(uNear, uFar, vDepth));',
  '  gl_FragColor = vec4(col, 1.0);',
  '}',
].join('\\n');

const BACK_VERT = ['varying vec2 vUv;', 'void main() {', '  vUv = uv;', '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);', '}'].join('\\n');

const BACK_FRAG = [
  'uniform vec3 uVoid;',
  'uniform vec3 uBloom;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec2 p = vUv - vec2(0.5, 0.44);',
  '  p.x *= 1.7;',
  '  gl_FragColor = vec4(uVoid + uBloom * smoothstep(0.62, 0.0, length(p)), 1.0);',
  '}',
].join('\\n');

function mount(THREE) {
  const items = tabs.slice(0, COLS * ROWS);
  const n = items.length;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  /* DPR capped at 2. A 3x phone-class panel would quadruple the fill for no
   * visible gain on type this size, and this is a hero, not a viewer. */
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  /*
   * Linear output, deliberately. Every colour in the scene is a hex value lifted
   * straight out of style.css and every texel comes from a 2D canvas that
   * already holds finished sRGB bytes. Converting on output would brighten the
   * wall away from the palette the rest of the page is painted in.
   */
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(new THREE.Color(0.019, 0.019, 0.021), 1);

  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  canvas.setAttribute('tabindex', '-1');

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 2, 0.1, 100);
  const home = new THREE.Vector3(0, 0, 12);
  const still = reducedMotion();

  /* the void, with one faint bloom in it */
  const backUniforms = {
    uVoid: { value: new THREE.Color(0.019, 0.019, 0.021) },
    uBloom: { value: new THREE.Color(0.105, 0.036, 0.004) },
  };
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShaderMaterial({ vertexShader: BACK_VERT, fragmentShader: BACK_FRAG, uniforms: backUniforms, depthWrite: false }),
  );
  back.position.z = -13;
  back.renderOrder = -1;
  scene.add(back);

  /* the tabs: one geometry, one texture, one draw call */
  const atlas = new THREE.CanvasTexture(buildAtlas(items));
  atlas.colorSpace = THREE.NoColorSpace;
  atlas.anisotropy = renderer.capabilities.getMaxAnisotropy();
  atlas.minFilter = THREE.LinearMipmapLinearFilter;
  atlas.magFilter = THREE.LinearFilter;
  atlas.generateMipmaps = true;

  const atlasRows = Math.ceil(n / ATLAS_COLS);
  const rect = new Float32Array(n * 4);
  const glow = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = i % ATLAS_COLS;
    const r = Math.floor(i / ATLAS_COLS);
    rect[i * 4] = c / ATLAS_COLS;
    rect[i * 4 + 1] = 1 - (r + 1) / atlasRows;
    rect[i * 4 + 2] = 1 / ATLAS_COLS;
    rect[i * 4 + 3] = 1 / atlasRows;
  }

  /*
   * Deep enough that the turn is visible. At 0.13 the edge was a hairline and
   * the arc read as slightly skewed cards; the point of putting them on an arc
   * is that the outer ones show a side.
   */
  const geo = new THREE.BoxGeometry(1, 1, 0.3);
  geo.setAttribute('aRect', new THREE.InstancedBufferAttribute(rect, 4));
  const glowAttr = new THREE.InstancedBufferAttribute(glow, 1);
  glowAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aGlow', glowAttr);

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uAtlas: { value: atlas },
      uVoid: { value: new THREE.Color(0.019, 0.019, 0.021) },
      /* The cut edge of the slab: the panel colour, not the live orange. The
       * accent belongs to the type on the face, and an orange edge on twelve
       * tabs would out-shout it. */
      uEdge: { value: new THREE.Color(0.055, 0.05, 0.048) },
      uNear: { value: 9 },
      uFar: { value: 26 },
    },
    /* Opaque now: the slab is a solid and needs real depth, or its own back
     * face draws over its front. */
    transparent: false,
    depthWrite: true,
  });

  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.frustumCulled = false;
  scene.add(mesh);

  /*
   * Billboarded, and computed once per layout rather than once per frame. The
   * camera is locked: the only thing that moves it is a degree of pointer
   * parallax, over which the difference between facing the camera's home and
   * facing it exactly is far under a pixel. Re-solving 12 lookAts every frame
   * to chase that would be work nobody can see.
   */
  const dummy = new THREE.Object3D();
  function place() {
    for (let i = 0; i < n; i++) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const a = (col - (COLS - 1) / 2) * (PITCH_X / RADIUS);
      dummy.position.set(RADIUS * Math.sin(a), ((ROWS - 1) / 2 - row) * PITCH_Y, RADIUS * (1 - Math.cos(a)));
      dummy.scale.set(TAB_W, TAB_H, 1);
      dummy.lookAt(home.x, home.y, home.z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /*
   * The camera is solved from the content, not typed in. Both the half-width
   * and the half-height of the wall have to fit whatever box the hero turns out
   * to be, so the distance is the larger of the two solutions. That is what
   * keeps all twelve tabs in frame at any window this mounts at, which is the
   * only reason a locked camera is defensible.
   */
  const HALF_W = ((COLS - 1) / 2) * PITCH_X + TAB_W / 2;
  const HALF_H = ((ROWS - 1) / 2) * PITCH_Y + TAB_H / 2;
  /*
   * How far the outermost column stands in front of the middle one. The fit
   * below is solved against THAT plane rather than against z = 0, because the
   * widest tabs are also the nearest ones and a fit measured at the centre of
   * the arc would push them off both edges.
   */
  const Z_NEAR = RADIUS * (1 - Math.cos(((COLS - 1) / 2) * (PITCH_X / RADIUS)));
  /*
   * THE STAGE SIZES ITSELF TO THE SPACE THAT IS ACTUALLY LEFT.
   *
   * The stylesheet asked for clamp(420px, 62vh, 640px), and at the gate's own
   * minimum of 880x560 that clamp resolves to its 420px FLOOR: 62vh is 347px,
   * so the floor wins exactly when space is tightest. With 253px of header and
   * hero above it the stage then ended 113px below the fold, and the bottom row
   * of tabs was unreachable, because the camera is locked and there is no
   * orbit, dolly or scroll to recover it. The comment above claiming all twelve
   * are in frame was false at the one size the gate guarantees.
   *
   * CSS cannot fix this, because the height that matters is the viewport minus
   * this element's own top, and only layout knows that. So it is measured here,
   * where the camera is already refitted on every resize.
   */
  const STAGE_MAX = 640;
  const STAGE_MIN = 300;
  const STAGE_GUTTER = 16;

  function sizeStage() {
    /*
     * DOCUMENT-RELATIVE, not viewport-relative. The question is how much room
     * the stage has where it SITS IN THE PAGE, which does not change when the
     * reader scrolls. getBoundingClientRect().top is measured from the
     * viewport, so scrolled 5,000px down it is about -5,000, the available
     * height came out enormous, and the stage was resized to its maximum
     * whatever the window was actually doing. Adding the scroll offset back
     * gives the stage's fixed position in the document, which is the quantity
     * this wants.
     */
    const scrollY = window.scrollY || window.pageYOffset || 0;
    const documentTop = stage.getBoundingClientRect().top + scrollY;
    const available = window.innerHeight - documentTop - STAGE_GUTTER;
    if (available < STAGE_MIN) return 0;
    const height = Math.min(STAGE_MAX, available);
    stage.style.height = height + 'px';
    return height;
  }

  function fit() {
    /*
     * Zero means the space left is too small for a wall that would be complete.
     * Returning false here unmounts, which is the correct outcome: the list
     * below is the whole content, uncapped, and a truncated wall is strictly
     * worse than the list it was drawn over.
     */
    if (sizeStage() === 0) return false;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (w === 0 || h === 0) return false;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    const t = Math.tan((FOV * Math.PI) / 360);
    const dist = Math.max((HALF_H * 1.1) / t, (HALF_W * 1.04) / (t * aspect));
    camera.aspect = aspect;
    camera.position.set(0, 0, dist + Z_NEAR);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    home.copy(camera.position);
    place();
    /* the backdrop, sized to fill the frustum at its own depth */
    const bd = camera.position.z - back.position.z;
    back.scale.set(2 * t * bd * aspect, 2 * t * bd, 1);
    /*
     * A short fade, tuned to the depth the arc actually has. The wall is
     * concave, so the middle column is the FAR one and the outer columns stand
     * in front of it; a fog range wider than that separation would be a fade
     * nobody can see. This one is about two world units deep, which is what
     * makes the curve read as a curve rather than as a flat sheet.
     */
    mat.uniforms.uNear.value = dist + 0.15;
    mat.uniforms.uFar.value = dist + 6.5;
    return true;
  }

  /*
   * The stage is display:none in the stylesheet, so it has no measurable box
   * until this line. A no-JS reader must not be given an empty 600-pixel hole
   * where a wall would have been, so the hole is opened here and closed again
   * on any failure below.
   */
  stage.style.display = 'block';
  if (!fit()) {
    stage.style.display = '';
    return;
  }
  stage.appendChild(canvas);

  /* ---- picking ------------------------------------------------------- */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hover = -1;
  const pointer = { x: 0, y: 0 };
  let havePointer = false;
  let frame = 0;
  let onScreen = true;
  const target = new Float32Array(n);
  const cam = { x: 0, y: 0 };

  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return -1;
    ndc.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    ndc.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    pointer.x = ndc.x;
    pointer.y = ndc.y;
    havePointer = true;
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(mesh, false);
    for (let i = 0; i < hits.length; i++) {
      if (typeof hits[i].instanceId === 'number') return hits[i].instanceId;
    }
    return -1;
  }

  function setHover(id) {
    if (id === hover) return;
    hover = id;
    canvas.style.cursor = id === -1 ? 'default' : 'pointer';
    if (still) draw();
  }

  canvas.addEventListener('pointermove', function (ev) {
    setHover(pick(ev));
    if (still) return;
    wake();
  });
  canvas.addEventListener('pointerleave', function () {
    havePointer = false;
    setHover(-1);
  });
  canvas.addEventListener('click', function (ev) {
    const id = pick(ev);
    if (id !== -1 && items[id] && items[id].href) window.location.assign(items[id].href);
  });

  /* ---- the loop, which does not run when nobody is looking ----------- */

  function draw() {
    renderer.render(scene, camera);
  }

  function step(t) {
    frame = 0;
    let moving = false;
    for (let i = 0; i < n; i++) {
      target[i] = i === hover ? 1 : 0;
      const d = target[i] - glow[i];
      if (Math.abs(d) > 0.002) {
        glow[i] += d * 0.18;
        moving = true;
      } else if (glow[i] !== target[i]) {
        glow[i] = target[i];
        moving = true;
      }
    }
    if (moving) glowAttr.needsUpdate = true;

    /*
     * ENOUGH PARALLAX TO SEE. This was 0.34 world units at a camera distance of
     * about fourteen, which is a degree: technically motion, invisible in
     * practice, and the reason a reader looking straight at a working 3D scene
     * reported seeing no 3D at all. Depth is only legible when something moves
     * against something else, so the pointer now swings the camera about four
     * degrees and the idle drift is large enough to read as drift rather than
     * as noise. Both still ride the same damping, so nothing snaps, and the
     * reduced-motion flag keeps the whole loop off entirely.
     */
    const px = havePointer ? pointer.x : 0;
    const py = havePointer ? pointer.y : 0;
    const dx = px * 1.5 + Math.sin(t / 5200) * 0.45 - cam.x;
    const dy = py * 0.9 + Math.cos(t / 6100) * 0.28 - cam.y;
    cam.x += dx * 0.05;
    cam.y += dy * 0.05;
    camera.position.x = cam.x;
    camera.position.y = cam.y;
    camera.lookAt(0, 0, 0);

    draw();
    if (onScreen) frame = requestAnimationFrame(step);
  }

  function wake() {
    if (still || !onScreen || frame !== 0) return;
    frame = requestAnimationFrame(step);
  }
  function sleep() {
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
  }

  /*
   * Offscreen is not animated, and neither is a hidden tab. A front door that
   * kept a render loop alive while the reader was three screens down reading a
   * thread would be spending their battery on a picture nobody is looking at.
   */
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      onScreen = entries[0] ? entries[0].isIntersecting : true;
      if (onScreen) wake();
      else sleep();
    }, { threshold: 0 }).observe(stage);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) sleep();
    else wake();
  });

  /*
   * REFIT, AND HONOUR THE REFUSAL.
   *
   * Two failures lived here. The ResizeObserver watches the STAGE, whose width
   * is viewport-driven but whose height this file pins inline, so a HEIGHT-ONLY
   * viewport change was structurally invisible to it: dragging a window shorter
   * left a 631px stage sitting 264px below the fold, still mounted, with the
   * fallback list at opacity 0 underneath. And when the observer did fire into
   * too little space, fit() returned false and the callback ignored it, so the
   * browser's already-resized CSS box stretched a stale drawing buffer: a
   * 1398px buffer squeezed into 966px, with the tabs visibly condensed.
   *
   * The code's own comment above fit() says returning false unmounts. It now
   * does. A window resize listener covers the height-only case the stage
   * observer cannot see.
   */
  function unmount() {
    sleep();
    wrap.classList.remove('is-mounted');
    stage.style.display = '';
    stage.style.height = '';
  }

  function refit() {
    if (!wide() || !fit()) {
      unmount();
      return;
    }
    if (!wrap.classList.contains('is-mounted')) wrap.classList.add('is-mounted');
    if (still) draw();
    else wake();
    /*
     * The wire measured its studs against the OLD stage height. Resizing moves
     * every capture in the document by the stage's height delta, so without
     * this every stud lands on empty space: measured at 206px low after one
     * 1440x1000 to 1200x700 change, with the capture heading left bare.
     */
    if (typeof window.__lcaWireRelayout === 'function') window.__lcaWireRelayout();
  }

  window.addEventListener('resize', refit);
  if ('ResizeObserver' in window) new ResizeObserver(refit).observe(stage);

  /*
   * A lost context is not a black rectangle. The list comes back and the page
   * is the page it was before this file ran.
   */
  canvas.addEventListener('webglcontextlost', function (ev) {
    ev.preventDefault();
    sleep();
    wrap.classList.remove('is-mounted');
    stage.style.display = '';
    if (canvas.parentNode === stage) stage.removeChild(canvas);
  });

  /*
   * The class goes on AFTER the first frame is on screen, never before. It is
   * what hides the tab list, and hiding the list on the strength of an intent
   * to draw rather than a drawing that happened is exactly how a front door
   * ends up empty.
   */
  draw();
  wrap.classList.add('is-mounted');
  if (!still) wake();
}
`;
