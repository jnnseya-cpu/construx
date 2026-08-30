/**
 * The site in three dimensions, drawn by the browser and nothing else.
 *
 * WebGL is in every browser this console supports. A 3D library would be a
 * runtime dependency — the one thing this platform has decided it does not take
 * — to draw a ground mesh and some extruded polygons, which is a few hundred
 * lines of matrix arithmetic and two shaders. So it is a few hundred lines of
 * matrix arithmetic and two shaders.
 *
 * ---
 *
 * **It draws what was captured and nothing it invents.** Where there is no
 * surface the ground is not drawn at all rather than shown as a flat plane: a
 * plane is a measurement nobody made, and on a screen it reads as a level site.
 * The caller is told to say so in words instead.
 *
 * **Zones are extruded to a token height, not a modelled one.** A compound is a
 * polygon on the ground; nothing captured its cabins. Half a metre is enough to
 * separate it from the terrain and read as an area rather than a building, and
 * the code makes no claim it is a building.
 *
 * **Site north is +y and up is +z**, which is what the geometry module uses, so
 * nothing is transposed on the way in. The camera orbits; the site does not.
 */

const VERTEX = `
attribute vec3 position;
attribute vec3 colour;
uniform mat4 mvp;
varying vec3 vColour;
varying float vHeight;
void main() {
  vColour = colour;
  vHeight = position.z;
  gl_Position = mvp * vec4(position, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
varying vec3 vColour;
varying float vHeight;
void main() {
  // A cheap height cue so the terrain reads as terrain rather than as a flat
  // wash. No lighting model: there is no captured normal worth lighting.
  float shade = 0.78 + clamp(vHeight * 0.02, -0.18, 0.22);
  gl_FragColor = vec4(vColour * shade, 1.0);
}`;

/** Column-major 4×4, because that is what WebGL wants. */
function multiply(a, b) {
  const out = new Float32Array(16);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function perspective(fovRadians, aspect, near, far) {
  const f = 1 / Math.tan(fovRadians / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

function lookAt(eye, target, up) {
  const z = normalise([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = normalise(cross(up, z));
  const y = cross(z, x);
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalise(v) {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function hexToRgb(hex) {
  const value = Number.parseInt(String(hex).replace('#', ''), 16);
  if (Number.isNaN(value)) return [0.5, 0.5, 0.5];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/**
 * Ear clipping, again, in the browser.
 *
 * The same algorithm as `domain/geometry.ts` and deliberately a second copy:
 * the server module is TypeScript with `.ts` imports that the browser does not
 * load, and shipping a build step to share thirty lines would be a larger
 * change to this platform than the duplication. Kept small and marked, so that
 * if a shared bundle ever exists this is the first thing to move into it.
 */
function triangulate(ring) {
  const points = signedArea(ring) < 0 ? [...ring].reverse() : [...ring];
  if (points.length < 3) return [];
  const indices = points.map((_, i) => i);
  const out = [];
  let guard = points.length * points.length;

  while (indices.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let i = 0; i < indices.length; i += 1) {
      const prev = points[indices[(i - 1 + indices.length) % indices.length]];
      const ear = points[indices[i]];
      const next = points[indices[(i + 1) % indices.length]];
      if (cross2(prev, ear, next) <= 0) continue;
      const contains = indices.some((index) => {
        const p = points[index];
        return p !== prev && p !== ear && p !== next && inTriangle(p, prev, ear, next);
      });
      if (contains) continue;
      out.push([prev, ear, next]);
      indices.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (indices.length === 3) out.push([points[indices[0]], points[indices[1]], points[indices[2]]]);
  return out;
}

function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

const cross2 = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
function inTriangle(p, a, b, c) {
  const d1 = cross2(a, b, p);
  const d2 = cross2(b, c, p);
  const d3 = cross2(c, a, p);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/**
 * Build the vertex buffer.
 *
 * One interleaved array of position and colour, because two buffers for a scene
 * this size is two allocations to save nothing.
 */
function buildGeometry({ surface, zones, boundary }) {
  const data = [];
  const push = (x, y, z, rgb) => data.push(x, y, z, rgb[0], rgb[1], rgb[2]);

  // The ground, exactly as captured. Not drawn at all when absent.
  const ground = [0.82, 0.82, 0.8];
  for (const triangle of surface?.triangles ?? []) {
    for (const p of triangle) push(p.x, p.y, p.z, ground);
  }

  // Zones, extruded to a token height so they read as areas on the ground —
  // and sat on the ground rather than at zero. See groundAt: on a site that
  // rises, zones pinned to zero are buried by the terrain.
  const HEIGHT = 0.5;
  const at = (p) => groundAt(surface, p.x, p.y);
  for (const zone of zones ?? []) {
    if (!zone.ring || zone.ring.length < 3) continue;
    const rgb = hexToRgb(zone.colour);
    const top = rgb.map((c) => Math.min(1, c + 0.12));

    for (const [a, b, c] of triangulate(zone.ring)) {
      push(a.x, a.y, at(a) + HEIGHT, top);
      push(b.x, b.y, at(b) + HEIGHT, top);
      push(c.x, c.y, at(c) + HEIGHT, top);
    }
    // Sides, so a zone has a visible edge rather than floating.
    for (let i = 0; i < zone.ring.length; i += 1) {
      const a = zone.ring[i];
      const b = zone.ring[(i + 1) % zone.ring.length];
      const za = at(a);
      const zb = at(b);
      push(a.x, a.y, za, rgb);
      push(b.x, b.y, zb, rgb);
      push(b.x, b.y, zb + HEIGHT, rgb);
      push(a.x, a.y, za, rgb);
      push(b.x, b.y, zb + HEIGHT, rgb);
      push(a.x, a.y, za + HEIGHT, rgb);
    }
  }

  // The boundary as a low wall, which is what a hoarding is. It follows the
  // ground too — a wall at a constant level runs underground at one end of a
  // sloping site and floats at the other.
  if (boundary && boundary.length >= 3) {
    const rgb = [0.16, 0.18, 0.2];
    for (let i = 0; i < boundary.length; i += 1) {
      const a = boundary[i];
      const b = boundary[(i + 1) % boundary.length];
      const za = at(a);
      const zb = at(b);
      push(a.x, a.y, za, rgb);
      push(b.x, b.y, zb, rgb);
      push(b.x, b.y, zb + 2, rgb);
      push(a.x, a.y, za, rgb);
      push(b.x, b.y, zb + 2, rgb);
      push(a.x, a.y, za + 2, rgb);
    }
  }

  return new Float32Array(data);
}

/**
 * The captured ground level under a point.
 *
 * Zones sat at zero until a sloping site was rendered and seven of the nine
 * vanished: the ground rose three metres from one side to the other and buried
 * everything on the high half. Nothing in the vertex-count tests could see it —
 * every triangle was present and correct, and simply behind the terrain. So
 * each corner is draped onto the surface beneath it.
 *
 * Returns 0 where nothing was captured, which is right: no ground is drawn
 * either, so the zones sit together on the same empty plane. Where a point
 * falls outside the captured mesh the nearest captured level is used — the
 * capture stopped short of it, and zero would bury it again.
 */
function groundAt(surface, x, y) {
  const triangles = surface?.triangles ?? [];
  if (triangles.length === 0) return 0;

  let nearest = { distance: Infinity, z: 0 };
  for (const [a, b, c] of triangles) {
    // Barycentric, so the level is interpolated across the triangle rather
    // than stepped at its edges — a stepped surface reads as terracing.
    const denominator = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (denominator !== 0) {
      const u = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / denominator;
      const v = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / denominator;
      const w = 1 - u - v;
      if (u >= 0 && v >= 0 && w >= 0) return u * a.z + v * b.z + w * c.z;
    }
    for (const p of [a, b, c]) {
      const distance = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (distance < nearest.distance) nearest = { distance, z: p.z };
    }
  }
  return nearest.z;
}

/** Centre and radius of everything drawn, so the camera frames it. */
function frameOf({ surface, zones, boundary }) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const consider = (p) => {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  };
  for (const t of surface?.triangles ?? []) for (const p of t) consider(p);
  for (const zone of zones ?? []) for (const p of zone.ring ?? []) consider(p);
  for (const p of boundary ?? []) consider(p);
  if (!Number.isFinite(minX)) return { centre: [0, 0, 0], radius: 50 };
  return {
    centre: [(minX + maxX) / 2, (minY + maxY) / 2, 0],
    radius: Math.max(10, Math.hypot(maxX - minX, maxY - minY) / 2),
  };
}

/**
 * Draw the site into a canvas, and let the user orbit it.
 *
 * Returns a disposer. The console re-renders whole pages, so a viewer that kept
 * a render loop running against a detached canvas would leak one per visit.
 */
export function mountSiteTwin(canvas, scene) {
  const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
  if (!gl) return { ok: false, reason: 'This browser has no WebGL, so the three-dimensional view cannot be drawn.' };

  const vertices = buildGeometry(scene);
  if (vertices.length === 0) {
    return { ok: false, reason: 'Nothing has been captured with geometry yet, so there is nothing to draw.' };
  }

  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
  };
  const vs = compile(gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
  if (!vs || !fs) return { ok: false, reason: 'The graphics driver refused the shader, so the view cannot be drawn.' };

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return { ok: false, reason: 'The graphics driver refused the shader program.' };
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  const stride = 6 * 4;
  const positionLoc = gl.getAttribLocation(program, 'position');
  const colourLoc = gl.getAttribLocation(program, 'colour');
  gl.enableVertexAttribArray(positionLoc);
  gl.vertexAttribPointer(positionLoc, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(colourLoc);
  gl.vertexAttribPointer(colourLoc, 3, gl.FLOAT, false, stride, 3 * 4);

  const mvpLoc = gl.getUniformLocation(program, 'mvp');
  gl.enable(gl.DEPTH_TEST);
  gl.clearColor(0.98, 0.98, 0.98, 1);

  const { centre, radius } = frameOf(scene);
  // Looking north-east and down, which is how a site plan is read.
  const camera = { azimuth: -Math.PI / 4, elevation: 0.62, distance: radius * 2.6 };
  let frame = 0;
  let disposed = false;

  const draw = () => {
    if (disposed) return;
    const width = canvas.clientWidth || 640;
    const height = canvas.clientHeight || 380;
    const scale = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const eye = [
      centre[0] + camera.distance * Math.cos(camera.elevation) * Math.cos(camera.azimuth),
      centre[1] + camera.distance * Math.cos(camera.elevation) * Math.sin(camera.azimuth),
      centre[2] + camera.distance * Math.sin(camera.elevation),
    ];
    const view = lookAt(eye, centre, [0, 0, 1]);
    const projection = perspective(Math.PI / 4, width / height, Math.max(0.5, radius / 100), radius * 20);
    gl.uniformMatrix4fv(mvpLoc, false, multiply(projection, view));
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 6);
  };

  // Orbit and zoom. Pointer events cover mouse and touch in one path.
  let dragging = null;
  const onDown = (event) => {
    dragging = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture?.(event.pointerId);
  };
  const onMove = (event) => {
    if (!dragging) return;
    camera.azimuth -= (event.clientX - dragging.x) * 0.008;
    // Clamped short of vertical: at exactly overhead the up vector and the view
    // direction are parallel and the matrix degenerates.
    camera.elevation = Math.max(0.08, Math.min(1.5, camera.elevation + (event.clientY - dragging.y) * 0.006));
    dragging = { x: event.clientX, y: event.clientY };
    draw();
  };
  const onUp = () => {
    dragging = null;
  };
  const onWheel = (event) => {
    event.preventDefault();
    camera.distance = Math.max(radius * 0.4, Math.min(radius * 12, camera.distance * (1 + event.deltaY * 0.0012)));
    draw();
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  const onResize = () => draw();
  globalThis.addEventListener('resize', onResize);

  draw();

  return {
    ok: true,
    triangles: vertices.length / 18,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      globalThis.removeEventListener('resize', onResize);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}

/** Exported for tests: the geometry builder is the part with arithmetic in it. */
export const _internals = { buildGeometry, frameOf, triangulate, signedArea, groundAt };
