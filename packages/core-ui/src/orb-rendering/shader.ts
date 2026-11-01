/**
 * One fragment program renders every finish. They share the sphere bulge, the
 * shell, the grain and the colour ramp; they differ in whether the interior is
 * a field (ink), a band (pearl, aurora), discrete bodies (vessel) or lines
 * (plasma).
 *
 * WebGL 1 / GLSL ES 1.00 for reach. No textures: the noise is generated here so
 * the component never fetches anything at runtime.
 */

export const VERTEX_SHADER = /* glsl */ `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

export const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform float uTime;    // wall clock, for grain
uniform float uFlow;    // accumulated interior time, accelerated by output level
uniform float uRing;    // accumulated ring phase, advanced by input level
uniform int   uFinish;  // 0 ink · 1 pearl · 2 vessel · 3 aurora · 4 plasma
uniform int   uState;   // 0 idle · 1 listening · 2 thinking · 3 speaking
uniform float uDark;    // 0 light field, 1 dark field
uniform float uIn;      // 0-1 microphone level
uniform float uOut;     // 0-1 agent speech level
uniform float uGrain;
uniform float uSeed;
uniform float uDetail;  // 0 at avatar sizes, 1 at hero sizes
uniform vec3  uC1;
uniform vec3  uC2;
uniform vec3  uC3;
uniform vec3  uBody;
uniform vec2  uPointer;
uniform float uPtr;

const float PI  = 3.141592653589793;
const float TAU = 6.283185307179586;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.8776, 0.4794, -0.4794, 0.8776);
  for (int i = 0; i < 5; i++) {
    v += a * noise2(p);
    p = rot * p * 2.02 + vec2(37.1, 11.7);
    a *= 0.5;
  }
  return v;
}

vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  return t < 0.5 ? mix(uC1, uC2, t * 2.0) : mix(uC2, uC3, (t - 0.5) * 2.0);
}

void main() {
  // Output swells the orb, input contracts it very slightly. Budget is ±2% (P2).
  float grow = 1.0 + 0.020 * uOut - 0.008 * uIn;
  vec2 p = (vUv - 0.5) * 2.0 / grow;
  float r = length(p);

  float seed = uSeed * 13.77;
  float fl = uFlow + seed;

  float bulge = sqrt(max(1.0 - min(dot(p, p), 1.0), 0.0));
  vec3 n = vec3(p, bulge);

  // sp stays in orb space. The seed offsets only where noise is sampled --
  // adding it to sp itself would slide the band clean off finishes that place
  // features relative to the centre, which reads as a blank orb.
  vec2 sp = p / (bulge * 0.55 + 1.0);
  vec2 sv = vec2(seed, seed * 0.73);

  float warp = 1.0 + 1.15 * uOut;
  vec3 col = vec3(0.0);
  float alpha = 1.0 - smoothstep(0.982, 1.0, r);

  // ---- INK: one pigmented medium, domain-warped -----------------------------
  if (uFinish == 0) {
    vec2 q = vec2(fbm(sp * 1.9 + sv + fl * 0.05), fbm(sp * 1.9 + sv + vec2(5.2, 1.3) - fl * 0.04));
    vec2 w = vec2(
      fbm(sp * 1.9 + sv + q * (2.1 * warp) + vec2(1.7, 9.2) + fl * 0.034),
      fbm(sp * 1.9 + sv + q * (2.1 * warp) + vec2(8.3, 2.8) - fl * 0.027)
    );
    float f = fbm(sp * 2.2 + sv + w * (1.6 * warp));
    col = ramp(f * 1.5 - 0.18);
    col *= 0.72 + 0.5 * bulge;
    col += pow(1.0 - bulge, 3.5) * 0.1;
    col *= 1.0 + 0.22 * uOut;
  }

  // ---- PEARL: opaque pale body, colour in an equatorial band ----------------
  else if (uFinish == 1) {
    float wob = fbm(sp * 1.5 + sv + fl * 0.07);
    float wave = 0.17 * sin(sp.x * 1.9 + fl * 0.36) + 0.14 * (wob - 0.5);
    float width = 0.40 + 0.16 * uOut;
    float band = smoothstep(width, 0.02, abs(sp.y - wave));

    col = mix(uBody, ramp(sp.x * 0.5 + 0.5 + 0.12 * (wob - 0.5)), band * (0.80 + 0.16 * uOut));

    float striate = 0.5 + 0.5 * sin(sp.x * 40.0 + wob * 11.0 + fl * 0.24);
    col *= 1.0 - 0.045 * striate * band * uDetail;
    col *= 0.80 + 0.34 * bulge;

    vec3 L = normalize(vec3(-0.42, 0.58, 0.70));
    col += vec3(1.0) * pow(max(dot(normalize(n), L), 0.0), 34.0) * 0.85;  // the one peak (P5)
    col += vec3(0.9, 0.93, 1.0) * pow(1.0 - bulge, 6.0) * 0.28;
  }

  // ---- VESSEL: fixed shell, contents that drift and merge -------------------
  else if (uFinish == 2) {
    vec3 acc = vec3(0.0);
    float field = 0.0;
    // Contents pressed against the glass read as attention; drawn to the centre
    // they read as idle. Output drives that ratio, which is the whole signal.
    float spread = 0.26 + 0.16 * uOut + 0.04 * sin(fl * 0.3);
    float mass = 0.150 + 0.055 * uOut;

    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float orbit = spread + 0.05 * sin(fl * 0.37 + fi * 1.7);
      vec2 c = vec2(cos(fl * 0.42 + fi * 2.094), sin(fl * 0.35 + fi * 2.094)) * orbit;
      float w = mass / (dot(p - c, p - c) + 0.034);
      vec3 lc = fi < 0.5 ? uC1 : (fi < 1.5 ? uC2 : uC3);
      field += w;
      acc += w * lc;
    }

    vec3 inner = acc / max(field, 0.0001);
    float body = smoothstep(0.80, 2.10, field);
    col = mix(uBody, inner, body * 0.96);

    float rim = smoothstep(0.72, 0.99, r) * smoothstep(1.0, 0.88, r);
    col += mix(vec3(0.55, 0.76, 0.94), vec3(0.52, 0.84, 1.0), uDark) * rim * (0.26 + 0.38 * uDark);
    col += vec3(1.0) * pow(1.0 - bulge, 8.0) * 0.14;

    vec3 L2 = normalize(vec3(-0.40, 0.60, 0.69));
    col += vec3(1.0) * pow(max(dot(normalize(n), L2), 0.0), 46.0) * 0.45;
  }

  // ---- AURORA: transparent body, emissive band, rim light -------------------
  else if (uFinish == 3) {
    float wob = fbm(sp * 1.35 + sv - fl * 0.055);
    float wave = 0.16 * sin(sp.x * 1.7 - fl * 0.29) + 0.16 * (wob - 0.5);
    float width = 0.46 + 0.18 * uOut;
    float band = pow(smoothstep(width, 0.0, abs(sp.y - wave - 0.06)), 1.35);

    col = uBody;
    col += ramp(sp.x * 0.45 + 0.5 + 0.2 * (wob - 0.5)) * band * (1.02 + 0.45 * uOut);

    float rim = smoothstep(0.80, 0.995, r) * smoothstep(1.0, 0.94, r);
    col += mix(uC3, vec3(0.55, 0.76, 0.98), 0.5) * rim * 0.85;
    col += uC1 * pow(1.0 - bulge, 5.0) * 0.16;
  }

  // ---- PLASMA: filaments from a core to the glass ---------------------------
  else {
    float a = atan(p.y, p.x);
    float haze = pow(max(1.0 - r, 0.0), 1.35);
    col = mix(uBody, uC1, haze * 0.92);
    col *= 0.50 + 0.72 * bulge;

    float pAng = atan(uPointer.y, uPointer.x);
    float bolts = 0.0;
    float contact = 0.0;

    for (int i = 0; i < 9; i++) {
      float fi = float(i);
      float s = fi * 17.31 + 3.7 + seed;
      float phase = fi * (TAU / 9.0) + (fbm(vec2(s, fl * 0.09)) - 0.5) * 2.6;

      // A real globe bends its filaments toward whatever touches the glass.
      float pull = uPtr * (0.42 + 0.46 * fract(fi * 0.37));
      float dd = mod(pAng - phase + PI, TAU) - PI;
      phase += dd * pull;

      float slow = (fbm(vec2(s * 0.61 + r * 1.35, fl * 0.40)) - 0.5) * 1.55;
      float fine = (fbm(vec2(s * 1.9 + r * 3.1, fl * 0.62)) - 0.5) * 0.42;
      float wander = (slow + fine) * pow(r, 1.15) * (1.0 - 0.42 * uPtr);

      float d = mod(a - phase - wander + PI, TAU) - PI;
      float arc = abs(d) * max(r, 0.05);
      float width = (0.007 + 0.020 * r) * mix(2.1, 1.0, uDetail);
      float line = smoothstep(width, 0.0, arc);
      float halo = smoothstep(width * 4.5, 0.0, arc) * 0.30;

      // Input makes the filaments reach further out (P10: input owns the boundary).
      float span = 0.80 + 0.20 * fract(s * 0.113) + 0.20 * uIn;
      line *= smoothstep(0.10, 0.28, r) * smoothstep(span + 0.22, span - 0.12, r);
      halo *= smoothstep(0.10, 0.34, r) * smoothstep(span + 0.24, span - 0.14, r);

      float flick = 0.35 + 0.65 * fbm(vec2(s, fl * 2.6));
      line *= flick;
      halo *= flick;

      bolts += line + halo;
      contact += line * smoothstep(span - 0.26, span + 0.04, r);
    }

    bolts = clamp(bolts * (1.0 + 1.05 * uOut), 0.0, 1.8);
    contact = clamp(contact, 0.0, 1.5);

    col += uC3 * bolts * (0.82 + 0.38 * uOut);
    col += mix(uC2, uC3, 0.4) * contact * (0.50 + 2.4 * uIn);

    float coreR = 0.13 + 0.040 * uOut;
    float core = smoothstep(coreR, 0.0, r);
    col += uC2 * pow(smoothstep(0.34, 0.0, r), 2.0) * (0.55 + 0.35 * uOut);
    col += mix(uC2, vec3(1.0, 0.97, 1.0), core) * core * 1.30;

    float grim = smoothstep(0.84, 0.995, r) * smoothstep(1.0, 0.92, r);
    col += mix(uC1, uC2, 0.5) * grim * (0.55 + 0.9 * uIn);
  }

  // ---- Thinking: an orbiting sweep, distinct in form from either voice (P8) --
  if (uState == 2) {
    float ang = atan(p.y, p.x);
    float sweep = 0.5 + 0.5 * cos(ang - fl * 1.5);
    col += mix(uC2, uC3, 0.5) * pow(sweep, 7.0) * 0.40 * smoothstep(0.05, 0.85, r);
  }

  // ---- Input lives on the boundary, never in the body (P10) -----------------
  if (uIn > 0.004 && uFinish != 4) {
    float pd = fract(r * 1.35 - uRing);
    float pulse = smoothstep(0.0, 0.30, pd) - smoothstep(0.30, 0.62, pd);
    vec3 pc = mix(uC3, vec3(0.42, 0.92, 0.99), 0.35 + 0.3 * uDark);
    col += pc * pulse * uIn * 1.15 * smoothstep(0.10, 0.95, r);
    float rim2 = smoothstep(0.74, 0.995, r) * smoothstep(1.0, 0.90, r);
    col += pc * rim2 * uIn * 1.5;
  }

  // ---- Grain: defeats banding and gives the eye something to resolve (P6) ---
  float g = hash21(vUv * 780.0 + fract(uTime) * 91.0);
  col *= 1.0 - uGrain * uDetail * (g - 0.5) * 2.0;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0) * alpha, alpha);
}
`

export const FINISH_INDEX: Record<string, number> = {
  ink: 0,
  pearl: 1,
  vessel: 2,
  aurora: 3,
  plasma: 4,
}

export const STATE_INDEX: Record<string, number> = {
  idle: 0,
  listening: 1,
  thinking: 2,
  speaking: 3,
}
