struct Uniforms {
  resolution: vec2f,
  cameraPosition: vec3f,
  yaw: f32,
  pitch: f32,
  time: f32,
  worldOriginZ: f32,
  riverSampleSpacing: f32,
  objectCount: u32,
  playerPosition: vec3f,
  playerYaw: f32,
  playerBank: f32,
  cameraMode: u32,
  quality: f32,
};

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

@group(0) @binding(1)
var<storage, read> riverSamples: array<vec4f>;

struct WorldObject {
  positionAndType: vec4f,
  halfSize: vec4f,
};

@group(0) @binding(2)
var<storage, read> worldObjects: array<WorldObject>;

@group(0) @binding(3)
var<storage, read> objectChunks: array<vec2u>;

struct VertexOutput {
  @builtin(position) position: vec4f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  // Full-screen triangle.
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );

  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  return output;
}

const MATERIAL_TERRAIN = 1.0;
const MATERIAL_WATER = 2.0;
const MATERIAL_BRIDGE = 3.0;
const MATERIAL_AIRPLANE = 4.0;
const MATERIAL_FUEL = 5.0;
const MATERIAL_PROJECTILE = 6.0;
const MATERIAL_SHIP = 7.0;
const MATERIAL_HELICOPTER = 8.0;
const MATERIAL_TANK = 9.0;
const MATERIAL_EXPLOSION = 10.0;
const MATERIAL_ROCK = 11.0;
const MATERIAL_FIGHTER = 12.0;
const MATERIAL_BALLOON = 13.0;
const MATERIAL_ADVANCED_HELICOPTER = 14.0;
const MATERIAL_ENEMY_PROJECTILE = 15.0;
const MATERIAL_FUEL_LABEL = 16.0;
const MATERIAL_GLASS = 17.0;
const MATERIAL_SPLASH = 18.0;
const MATERIAL_SCORCHED_BRIDGE = 19.0;
const MATERIAL_SMOKE = 20.0;
const WATER_HEIGHT = -0.18;
const FOG_START = 58.0;
const FOG_END = 88.0;
const MAX_VIEW_DISTANCE = 110.0;
const RIVER_SAMPLE_COUNT = 4096u;
const OBJECT_CHUNK_COUNT = 32;
const OBJECT_CHUNK_SIZE = 16.0;

struct SceneSample {
  distance: f32,
  material: f32,
};

fn box_sdf(p: vec3f, halfSize: vec3f) -> f32 {
  let q = abs(p) - halfSize;
  return length(max(q, vec3f(0.0)))
       + min(max(q.x, max(q.y, q.z)), 0.0);
}

fn sphere_sdf(p: vec3f, radius: f32) -> f32 {
  return length(p) - radius;
}

fn hash21(p: vec2f) -> f32 {
  let q = fract(p * vec2f(123.34, 456.21));
  return fract(q.x * q.y * (q.x + q.y + 45.32));
}

fn value_noise(p: vec2f) -> f32 {
  let cell = floor(p);
  let local = fract(p);
  let blend = local * local * (3.0 - 2.0 * local);
  let a = hash21(cell);
  let b = hash21(cell + vec2f(1.0, 0.0));
  let c = hash21(cell + vec2f(0.0, 1.0));
  let d = hash21(cell + vec2f(1.0, 1.0));
  return mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y);
}

fn triplanar_noise(p: vec3f, normal: vec3f, scale: f32) -> f32 {
  var weights = pow(abs(normal), vec3f(4.0));
  weights /= max(weights.x + weights.y + weights.z, 0.0001);
  let xProjection = value_noise(p.yz * scale);
  let yProjection = value_noise(p.xz * scale);
  let zProjection = value_noise(p.xy * scale);
  return dot(vec3f(xProjection, yProjection, zProjection), weights);
}

fn rounded_box_sdf(p: vec3f, halfSize: vec3f, radius: f32) -> f32 {
  let q = abs(p) - halfSize + radius;
  return length(max(q, vec3f(0.0)))
       + min(max(q.x, max(q.y, q.z)), 0.0)
       - radius;
}

fn ellipsoid_sdf(p: vec3f, radius: vec3f) -> f32 {
  let k0 = length(p / radius);
  let k1 = max(length(p / (radius * radius)), 0.0001);
  return k0 * (k0 - 1.0) / k1;
}

fn cylinder_sdf(p: vec3f, radius: f32, halfHeight: f32) -> f32 {
  let d = abs(vec2f(length(p.xz), p.y)) - vec2f(radius, halfHeight);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
}

fn cylinder_x_sdf(p: vec3f, radius: f32, halfLength: f32) -> f32 {
  let d = abs(vec2f(length(p.yz), p.x)) - vec2f(radius, halfLength);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
}

fn capsule_sdf(p: vec3f, a: vec3f, b: vec3f, radius: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - radius;
}

fn airplane_local(p: vec3f) -> vec3f {
  let cy = cos(uniforms.playerYaw);
  let sy = sin(uniforms.playerYaw);
  let delta = p - uniforms.playerPosition;
  let yawLocal = vec3f(
    delta.x * cy + delta.z * sy,
    delta.y,
    -delta.x * sy + delta.z * cy
  );
  let cb = cos(uniforms.playerBank);
  let sb = sin(uniforms.playerBank);
  return vec3f(
    yawLocal.x * cb + yawLocal.y * sb,
    -yawLocal.x * sb + yawLocal.y * cb,
    yawLocal.z
  );
}

fn airplane_sdf(p: vec3f) -> f32 {
  let local = airplane_local(p);
  let bodyTaper = smoothstep(-0.52, -0.12, local.z) * 0.78 + 0.22;
  let bodyLocal = vec3f(
    local.x / bodyTaper,
    local.y / bodyTaper,
    local.z
  );
  let body = ellipsoid_sdf(
    bodyLocal - vec3f(0.0, 0.0, 0.0),
    vec3f(0.105, 0.075, 0.52)
  );
  let wingSpan = clamp(abs(local.x) / 0.5, 0.0, 1.0);
  let wingCenterZ = abs(local.x) * 0.3 - 0.025;
  let wingHalfChord = mix(0.11, 0.018, wingSpan);
  let wingPlan = max(
    abs(local.x) - 0.5,
    abs(local.z - wingCenterZ) - wingHalfChord
  );
  let wings = max(wingPlan, abs(local.y) - 0.012) * 0.72;
  let tailLocal = vec3f(
    local.x,
    local.y,
    local.z - abs(local.x) * 0.2
  );
  let tail = rounded_box_sdf(
    tailLocal - vec3f(0.0, 0.0, 0.34),
    vec3f(0.23, 0.022, 0.065),
    0.007
  );
  let fin = rounded_box_sdf(
    local - vec3f(0.0, 0.085, 0.35),
    vec3f(0.018, 0.105, 0.065),
    0.006
  );
  let cockpit = ellipsoid_sdf(
    local - vec3f(0.0, 0.07, -0.08),
    vec3f(0.065, 0.055, 0.15)
  );
  let engine = capsule_sdf(
    local,
    vec3f(0.0, 0.0, 0.18),
    vec3f(0.0, 0.0, 0.43),
    0.07
  );
  return min(body, min(min(wings, tail), min(fin, min(cockpit, engine))));
}

fn fuel_sdf(p: vec3f, halfSize: vec3f) -> f32 {
  let radialShell = abs(length(p.xy) - halfSize.x) - 0.025;
  let openTube = max(radialShell, abs(p.z) - halfSize.z);
  return max(openTube, p.y + halfSize.x * 0.588);
}

fn label_stroke(p: vec3f, center: vec2f, halfSize: vec2f, height: f32) -> f32 {
  return box_sdf(
    p - vec3f(center.x, height, center.y),
    vec3f(halfSize.x, 0.018, halfSize.y)
  );
}

fn fuel_label_sdf(p: vec3f, halfSize: vec3f) -> f32 {
  let h = -halfSize.x + 0.05;
  let w = 0.035;
  let x = p.x;
  let z = p.z;
  let f = min(
    label_stroke(vec3f(x, p.y, z + 0.66), vec2f(-0.14, 0.0), vec2f(w, 0.18), h),
    min(
      label_stroke(vec3f(x, p.y, z + 0.66), vec2f(0.0, -0.145), vec2f(0.14, w), h),
      label_stroke(vec3f(x, p.y, z + 0.66), vec2f(-0.02, 0.0), vec2f(0.12, w), h)
    )
  );
  let u = min(
    label_stroke(vec3f(x, p.y, z + 0.22), vec2f(-0.14, -0.02), vec2f(w, 0.16), h),
    min(
      label_stroke(vec3f(x, p.y, z + 0.22), vec2f(0.14, -0.02), vec2f(w, 0.16), h),
      label_stroke(vec3f(x, p.y, z + 0.22), vec2f(0.0, 0.14), vec2f(0.14, w), h)
    )
  );
  let e = min(
    label_stroke(vec3f(x, p.y, z - 0.22), vec2f(-0.14, 0.0), vec2f(w, 0.18), h),
    min(
      label_stroke(vec3f(x, p.y, z - 0.22), vec2f(0.0, -0.145), vec2f(0.14, w), h),
      min(
        label_stroke(vec3f(x, p.y, z - 0.22), vec2f(-0.02, 0.0), vec2f(0.12, w), h),
        label_stroke(vec3f(x, p.y, z - 0.22), vec2f(0.0, 0.145), vec2f(0.14, w), h)
      )
    )
  );
  let l = min(
    label_stroke(vec3f(x, p.y, z - 0.66), vec2f(-0.14, 0.0), vec2f(w, 0.18), h),
    label_stroke(vec3f(x, p.y, z - 0.66), vec2f(0.0, 0.145), vec2f(0.14, w), h)
  );
  return min(min(f, u), min(e, l));
}

fn rotate_y(p: vec3f, yaw: f32) -> vec3f {
  let cy = cos(yaw);
  let sy = sin(yaw);
  return vec3f(
    p.x * cy + p.z * sy,
    p.y,
    -p.x * sy + p.z * cy
  );
}

fn ship_sdf(p: vec3f, halfSize: vec3f, yaw: f32) -> f32 {
  let local = rotate_y(p, yaw);
  let hullTaper = mix(0.58, 1.0, smoothstep(-halfSize.z, -halfSize.z * 0.15, local.z));
  let taperedLocal = vec3f(local.x / hullTaper, local.y, local.z);
  let hullShape = ellipsoid_sdf(
    taperedLocal - vec3f(0.0, -0.015, 0.0),
    vec3f(halfSize.x, halfSize.y * 1.2, halfSize.z)
  );
  let hull = max(hullShape, local.y - halfSize.y * 0.72);
  let deck = rounded_box_sdf(
    local - vec3f(0.0, halfSize.y * 0.68, 0.05),
    vec3f(halfSize.x * 0.78, 0.035, halfSize.z * 0.62),
    0.025
  );
  let cabin = rounded_box_sdf(
    local - vec3f(0.0, halfSize.y + 0.105, 0.12),
    vec3f(halfSize.x * 0.52, 0.105, halfSize.z * 0.25),
    0.035
  );
  let wheelhouse = rounded_box_sdf(
    local - vec3f(0.0, halfSize.y + 0.235, 0.07),
    vec3f(halfSize.x * 0.38, 0.055, halfSize.z * 0.15),
    0.025
  );
  let mast = cylinder_sdf(
    local - vec3f(0.0, halfSize.y + 0.36, 0.05),
    0.018,
    0.15
  );
  let chimney = rounded_box_sdf(
    local - vec3f(0.0, halfSize.y + 0.29, 0.27),
    vec3f(0.055, 0.12, 0.065),
    0.025
  );
  let bowRail = capsule_sdf(
    local,
    vec3f(-halfSize.x * 0.55, halfSize.y + 0.12, -halfSize.z * 0.48),
    vec3f(halfSize.x * 0.55, halfSize.y + 0.12, -halfSize.z * 0.48),
    0.014
  );
  return min(min(hull, deck), min(cabin, min(wheelhouse, min(mast, min(chimney, bowRail)))));
}

fn helicopter_glass_sdf(p: vec3f, halfSize: vec3f, yaw: f32) -> f32 {
  let local = rotate_y(p, yaw);
  let glass = ellipsoid_sdf(
    local - vec3f(0.0, 0.075, -0.285),
    vec3f(0.205, halfSize.y * 0.7, 0.19)
  );
  return max(glass, local.z + 0.12);
}

fn helicopter_sdf(p: vec3f, halfSize: vec3f, yaw: f32) -> f32 {
  let local = rotate_y(p, yaw);
  let cabin = ellipsoid_sdf(
    local - vec3f(0.0, 0.01, -0.13),
    vec3f(0.25, halfSize.y, 0.34)
  );
  let lowerBody = rounded_box_sdf(
    local - vec3f(0.0, -0.08, 0.02),
    vec3f(0.19, 0.09, 0.3),
    0.07
  );
  let tailBoom = capsule_sdf(
    local,
    vec3f(0.0, 0.03, 0.12),
    vec3f(0.0, 0.08, 0.73),
    0.055
  );
  let tailFin = rounded_box_sdf(
    local - vec3f(0.0, 0.16, 0.69),
    vec3f(0.035, 0.13, 0.08),
    0.02
  );
  let rotorAngle = uniforms.time * 28.0 + p.z * 0.3;
  let rotorCenter = local - vec3f(0.0, halfSize.y + 0.055, -0.06);
  let rotorLocal = vec3f(
    rotorCenter.x * cos(rotorAngle) - rotorCenter.z * sin(rotorAngle),
    rotorCenter.y,
    rotorCenter.x * sin(rotorAngle) + rotorCenter.z * cos(rotorAngle)
  );
  let rotor = rounded_box_sdf(
    rotorLocal,
    vec3f(halfSize.x, 0.018, 0.035),
    0.015
  );
  let leftSkid = capsule_sdf(
    local,
    vec3f(-0.17, -halfSize.y - 0.07, -0.24),
    vec3f(-0.17, -halfSize.y - 0.07, 0.25),
    0.018
  );
  let rightSkid = capsule_sdf(
    local,
    vec3f(0.17, -halfSize.y - 0.07, -0.24),
    vec3f(0.17, -halfSize.y - 0.07, 0.25),
    0.018
  );
  let tailRotorAngle = uniforms.time * 35.0 + p.x * 0.2;
  let tailRotorCenter = local - vec3f(0.045, 0.13, 0.72);
  let tailRotorLocal = vec3f(
    tailRotorCenter.x,
    tailRotorCenter.y * cos(tailRotorAngle) - tailRotorCenter.z * sin(tailRotorAngle),
    tailRotorCenter.y * sin(tailRotorAngle) + tailRotorCenter.z * cos(tailRotorAngle)
  );
  let tailRotor = rounded_box_sdf(
    tailRotorLocal,
    vec3f(0.012, 0.15, 0.022),
    0.01
  );
  let leftStrut = capsule_sdf(
    local,
    vec3f(-0.12, -halfSize.y * 0.55, -0.12),
    vec3f(-0.17, -halfSize.y - 0.07, -0.08),
    0.014
  );
  let rightStrut = capsule_sdf(
    local,
    vec3f(0.12, -halfSize.y * 0.55, -0.12),
    vec3f(0.17, -halfSize.y - 0.07, -0.08),
    0.014
  );
  let body = min(cabin, lowerBody);
  let tail = min(tailBoom, min(tailFin, tailRotor));
  let skids = min(min(leftSkid, rightSkid), min(leftStrut, rightStrut));
  return min(min(body, tail), min(rotor, skids));
}

fn tank_sdf(p: vec3f, halfSize: vec3f, yaw: f32) -> f32 {
  let local = rotate_y(p, yaw);
  let armorLocal = vec3f(local.x, local.y, local.z + abs(local.x) * 0.08);
  let chassis = rounded_box_sdf(
    armorLocal,
    vec3f(halfSize.x * 0.72, halfSize.y, halfSize.z * 0.92),
    0.07
  );
  let leftTrack = rounded_box_sdf(
    local - vec3f(-halfSize.x * 0.78, -0.015, 0.0),
    vec3f(halfSize.x * 0.2, halfSize.y * 0.85, halfSize.z),
    0.055
  );
  let rightTrack = rounded_box_sdf(
    local - vec3f(halfSize.x * 0.78, -0.015, 0.0),
    vec3f(halfSize.x * 0.2, halfSize.y * 0.85, halfSize.z),
    0.055
  );
  let turretCenter = vec3f(0.0, halfSize.y + 0.105, -0.02);
  let turret = cylinder_sdf(local - turretCenter, 0.22, 0.085);
  let hatch = cylinder_sdf(
    local - turretCenter - vec3f(0.0, 0.105, 0.0),
    0.1,
    0.025
  );
  let barrel = capsule_sdf(
    local,
    turretCenter + vec3f(0.0, 0.015, -0.12),
    turretCenter + vec3f(0.0, 0.015, -0.68),
    0.035
  );
  var wheels = 100000.0;
  for (var index = 0; index < 4; index++) {
    let wheelZ = -halfSize.z * 0.72 + f32(index) * halfSize.z * 0.48;
    let leftWheel = cylinder_x_sdf(
      local - vec3f(-halfSize.x * 0.82, -halfSize.y * 0.35, wheelZ),
      halfSize.y * 0.42,
      halfSize.x * 0.12
    );
    let rightWheel = cylinder_x_sdf(
      local - vec3f(halfSize.x * 0.82, -halfSize.y * 0.35, wheelZ),
      halfSize.y * 0.42,
      halfSize.x * 0.12
    );
    wheels = min(wheels, min(leftWheel, rightWheel));
  }
  let armor = min(chassis, min(leftTrack, rightTrack));
  return min(min(armor, wheels), min(turret, min(hatch, barrel)));
}

fn missile_sdf(p: vec3f, halfSize: vec3f, yaw: f32) -> f32 {
  let local = rotate_y(p, yaw);
  let body = capsule_sdf(
    local,
    vec3f(0.0, 0.0, -halfSize.z * 0.62),
    vec3f(0.0, 0.0, halfSize.z * 0.7),
    halfSize.x
  );
  let nose = ellipsoid_sdf(
    local - vec3f(0.0, 0.0, -halfSize.z * 0.78),
    vec3f(halfSize.x * 0.8, halfSize.y * 0.8, halfSize.z * 0.32)
  );
  let fins = rounded_box_sdf(
    local - vec3f(0.0, 0.0, halfSize.z * 0.58),
    vec3f(halfSize.x * 1.8, halfSize.y * 0.28, halfSize.z * 0.18),
    halfSize.x * 0.18
  );
  let flame = capsule_sdf(
    local,
    vec3f(0.0, 0.0, halfSize.z * 0.68),
    vec3f(0.0, 0.0, halfSize.z * 1.7),
    halfSize.x * 0.48
  );
  return min(min(body, nose), min(fins, flame));
}

fn enemy_projectile_sdf(p: vec3f, halfSize: vec3f, yaw: f32) -> f32 {
  let local = rotate_y(p, yaw);
  let shell = ellipsoid_sdf(
    local,
    vec3f(halfSize.x, halfSize.y, max(halfSize.z, halfSize.x * 1.7))
  );
  let trail = capsule_sdf(
    local,
    vec3f(0.0, 0.0, halfSize.z * 0.45),
    vec3f(0.0, 0.0, halfSize.z * 2.4),
    halfSize.x * 0.38
  );
  return min(shell, trail);
}

fn bridge_deck_sdf(p: vec3f, halfSize: vec3f) -> f32 {
  let deck = rounded_box_sdf(
    p - vec3f(0.0, 0.015, 0.0),
    vec3f(halfSize.x, 0.065, halfSize.z),
    0.025
  );
  let lowerBeam = rounded_box_sdf(
    p + vec3f(0.0, 0.1, 0.0),
    vec3f(halfSize.x, 0.045, halfSize.z * 0.72),
    0.018
  );
  let leftRail = rounded_box_sdf(
    p - vec3f(0.0, 0.17, -halfSize.z * 0.82),
    vec3f(halfSize.x, 0.022, 0.022),
    0.01
  );
  let rightRail = rounded_box_sdf(
    p - vec3f(0.0, 0.17, halfSize.z * 0.82),
    vec3f(halfSize.x, 0.022, 0.022),
    0.01
  );
  let repeatedX = (fract((p.x + halfSize.x) / 0.42) - 0.5) * 0.42;
  let postShape = box_sdf(
    vec3f(repeatedX, p.y - 0.105, abs(p.z) - halfSize.z * 0.82),
    vec3f(0.018, 0.09, 0.018)
  );
  let posts = max(postShape, abs(p.x) - halfSize.x);
  let trussX = (fract((p.x + halfSize.x) / 0.42) - 0.5) * 0.42;
  let trussZ = abs(p.z) - halfSize.z * 0.82;
  let risingBrace = abs(p.y - 0.12 - trussX * 0.62) - 0.014;
  let fallingBrace = abs(p.y - 0.12 + trussX * 0.62) - 0.014;
  let braceShape = max(
    max(min(risingBrace, fallingBrace), abs(trussZ) - 0.018),
    abs(p.x) - halfSize.x
  );
  return min(min(deck, lowerBeam), min(min(leftRail, rightRail), min(posts, braceShape)));
}

fn bridge_edge_sdf(p: vec3f, halfSize: vec3f, side: f32) -> f32 {
  var bridge = bridge_deck_sdf(p, halfSize);
  let edgeSide = select(-1.0, 1.0, side >= 0.0);
  let road = box_sdf(
    p - vec3f(-edgeSide * (halfSize.x + 2.0), -halfSize.y * 0.35, 0.0),
    vec3f(2.0, halfSize.y * 0.45, halfSize.z * 0.82)
  );
  bridge = min(bridge, road);
  if (abs(side) > 1.5) {
    let innerX = edgeSide * halfSize.x;
    let chip1 = sphere_sdf(p - vec3f(innerX, 0.055, -0.3), 0.14);
    let chip2 = sphere_sdf(p - vec3f(innerX - edgeSide * 0.06, 0.03, 0.02), 0.11);
    let chip3 = sphere_sdf(p - vec3f(innerX, 0.06, 0.31), 0.13);
    bridge = max(bridge, -min(chip1, min(chip2, chip3)));
  }
  let pierY = -0.43;
  let firstPier = cylinder_sdf(
    p - vec3f(0.0, pierY, -halfSize.z * 0.5),
    0.09,
    0.43
  );
  let secondPier = cylinder_sdf(
    p - vec3f(0.0, pierY, halfSize.z * 0.5),
    0.09,
    0.43
  );
  return min(bridge, min(firstPier, secondPier));
}

fn explosion_sdf(p: vec3f, radius: f32, seed: f32) -> f32 {
  var distance = 100000.0;

  for (var index = 0; index < 16; index++) {
    let value = f32(index) + seed * 7.31;
    let random = fract(
      sin(vec3f(value, value + 2.17, value + 5.43)) * 43758.5453
    ) * 2.0 - 1.0;
    let direction = normalize(vec3f(random.x, abs(random.y) * 1.15 - 0.2, random.z));
    let spread = radius * (0.5 + fract(sin(value * 9.13) * 73.17) * 0.7);
    let size = max(
      0.006,
      radius * (0.04 + fract(sin(value * 4.71) * 91.53) * 0.07)
    );
    distance = min(distance, sphere_sdf(p - direction * spread, size));
  }

  return distance;
}

fn splash_sdf(p: vec3f, radius: f32, seed: f32) -> f32 {
  var distance = 100000.0;

  for (var index = 0; index < 36; index++) {
    let value = f32(index) + seed * 5.17;
    let random = fract(
      sin(vec3f(value + 1.3, value + 4.7, value + 8.9)) * 43758.5453
    ) * 2.0 - 1.0;
    let direction = normalize(vec3f(random.x, abs(random.y) * 1.8 + 0.25, random.z));
    let spread = radius * (0.35 + fract(sin(value * 7.11) * 81.7) * 0.8);
    let size = max(0.008, radius * (0.025 + fract(sin(value * 3.91) * 63.4) * 0.045));
    distance = min(distance, sphere_sdf(p - direction * spread, size));
  }

  return distance;
}

fn smoke_sdf(p: vec3f, radius: f32, seed: f32) -> f32 {
  var distance = 100000.0;

  for (var index = 0; index < 14; index++) {
    let value = f32(index) + seed * 3.73;
    let random = fract(sin(vec3f(value, value + 3.1, value + 7.7)) * 43758.5453) * 2.0 - 1.0;
    let offset = vec3f(random.x, abs(random.y) * 1.35, random.z) * radius * 0.65;
    let size = radius * (0.16 + fract(sin(value * 5.17) * 71.3) * 0.16);
    distance = min(distance, sphere_sdf(p - offset, size));
  }

  return distance;
}

fn rock_sdf(p: vec3f, halfSize: vec3f, yaw: f32) -> f32 {
  let local = rotate_y(p, yaw);
  let warp = vec3f(
    sin(local.y * 8.1 + yaw) * halfSize.x * 0.08,
    sin(local.x * 7.3 - local.z * 5.1) * halfSize.y * 0.06,
    sin(local.y * 6.7 - yaw) * halfSize.z * 0.07
  );
  let warped = local + warp;
  let lower = ellipsoid_sdf(
    warped + vec3f(halfSize.x * 0.08, halfSize.y * 0.12, 0.0),
    halfSize * vec3f(1.0, 0.82, 0.94)
  );
  let upper = ellipsoid_sdf(
    warped - vec3f(halfSize.x * 0.15, halfSize.y * 0.62, -halfSize.z * 0.08),
    halfSize * vec3f(0.62, 0.58, 0.67)
  );
  let shoulder = ellipsoid_sdf(
    warped - vec3f(-halfSize.x * 0.34, halfSize.y * 0.22, halfSize.z * 0.14),
    halfSize * vec3f(0.54, 0.48, 0.52)
  );
  let rock = min(lower, min(upper, shoulder));
  return max(rock * 0.82, -local.y - halfSize.y * 0.94);
}

fn fighter_sdf(p: vec3f, halfSize: vec3f, yaw: f32) -> f32 {
  let local = rotate_y(p, yaw);
  let body = ellipsoid_sdf(
    local - vec3f(0.0, 0.0, 0.015),
    vec3f(halfSize.x * 0.16, halfSize.y, halfSize.z)
  );
  let nose = ellipsoid_sdf(
    local - vec3f(0.0, -0.006, -halfSize.z * 0.83),
    vec3f(halfSize.x * 0.1, halfSize.y * 0.68, halfSize.z * 0.25)
  );
  let wingLocal = vec3f(
    local.x,
    local.y,
    local.z - abs(local.x) * 0.34 + halfSize.z * 0.04
  );
  let wings = rounded_box_sdf(
    wingLocal,
    vec3f(halfSize.x, halfSize.y * 0.24, halfSize.z * 0.27),
    0.018
  );
  let tailLocal = vec3f(
    local.x,
    local.y,
    local.z - abs(local.x) * 0.2
  );
  let tail = rounded_box_sdf(
    tailLocal - vec3f(0.0, 0.0, halfSize.z * 0.68),
    vec3f(halfSize.x * 0.38, halfSize.y * 0.27, halfSize.z * 0.15),
    0.014
  );
  let fin = rounded_box_sdf(
    local - vec3f(0.0, halfSize.y * 0.72, halfSize.z * 0.64),
    vec3f(halfSize.x * 0.035, halfSize.y * 0.72, halfSize.z * 0.14),
    0.012
  );
  let cockpit = ellipsoid_sdf(
    local - vec3f(0.0, halfSize.y * 0.68, -halfSize.z * 0.23),
    vec3f(halfSize.x * 0.1, halfSize.y * 0.58, halfSize.z * 0.22)
  );
  let leftEngine = capsule_sdf(
    local,
    vec3f(-halfSize.x * 0.19, 0.0, halfSize.z * 0.15),
    vec3f(-halfSize.x * 0.19, 0.0, halfSize.z * 0.68),
    halfSize.y * 0.42
  );
  let rightEngine = capsule_sdf(
    local,
    vec3f(halfSize.x * 0.19, 0.0, halfSize.z * 0.15),
    vec3f(halfSize.x * 0.19, 0.0, halfSize.z * 0.68),
    halfSize.y * 0.42
  );
  let engines = min(leftEngine, rightEngine);
  return min(min(body, nose), min(min(wings, tail), min(fin, min(cockpit, engines))));
}

fn balloon_sdf(p: vec3f, halfSize: vec3f) -> f32 {
  let envelopePosition = p - vec3f(0.0, halfSize.y * 0.25, 0.0);
  let envelopeScale = vec3f(halfSize.x, halfSize.y * 0.72, halfSize.z);
  let envelope = ellipsoid_sdf(envelopePosition, envelopeScale);
  let neck = cylinder_sdf(
    p + vec3f(0.0, halfSize.y * 0.42, 0.0),
    0.09,
    0.08
  );
  let basket = rounded_box_sdf(
    p + vec3f(0.0, halfSize.y * 0.72, 0.0),
    vec3f(0.13, 0.11, 0.13),
    0.025
  );
  let leftRope = capsule_sdf(
    p,
    vec3f(-0.12, -halfSize.y * 0.34, -0.08),
    vec3f(-0.1, -halfSize.y * 0.62, -0.08),
    0.012
  );
  let rightRope = capsule_sdf(
    p,
    vec3f(0.12, -halfSize.y * 0.34, -0.08),
    vec3f(0.1, -halfSize.y * 0.62, -0.08),
    0.012
  );
  return min(min(envelope, neck), min(basket, min(leftRope, rightRope)));
}

fn balloon_color(p: vec3f) -> vec3f {
  var closestDistance = 100000.0;
  var local = vec3f(0.0);
  var halfSize = vec3f(1.0);

  let pointChunk = i32(floor((p.z - uniforms.worldOriginZ) / OBJECT_CHUNK_SIZE));
  for (var chunkOffset = -1; chunkOffset <= 1; chunkOffset++) {
    let chunkIndex = u32(clamp(pointChunk + chunkOffset, 0, OBJECT_CHUNK_COUNT - 1));
    let chunkRange = objectChunks[chunkIndex];
    let chunkEnd = min(chunkRange.x + chunkRange.y, uniforms.objectCount);
    for (var index = chunkRange.x; index < chunkEnd; index += 1u) {
    let object = worldObjects[index];
    if (object.positionAndType.w != 11.0) {
      continue;
    }

    let delta = p - object.positionAndType.xyz;
    let distance = dot(delta, delta);
    if (distance < closestDistance) {
      closestDistance = distance;
      local = delta;
      halfSize = object.halfSize.xyz;
    }
    }
  }

  if (local.y < -halfSize.y * 0.42) {
    return vec3f(0.28, 0.12, 0.035);
  }

  let longitude = atan2(local.z, local.x);
  let column = floor((longitude + radians(180.0)) / radians(45.0));
  let row = floor((local.y / halfSize.y + 0.7) * 4.0);
  let checker = fract((column + row) * 0.5) < 0.5;
  return select(vec3f(0.88, 0.16, 0.08), vec3f(1.0, 0.78, 0.08), checker);
}

fn helicopter_local(p: vec3f, objectType: f32) -> vec3f {
  var closestDistance = 100000.0;
  var local = vec3f(0.0);

  let pointChunk = i32(floor((p.z - uniforms.worldOriginZ) / OBJECT_CHUNK_SIZE));
  for (var chunkOffset = -1; chunkOffset <= 1; chunkOffset++) {
    let chunkIndex = u32(clamp(pointChunk + chunkOffset, 0, OBJECT_CHUNK_COUNT - 1));
    let chunkRange = objectChunks[chunkIndex];
    let chunkEnd = min(chunkRange.x + chunkRange.y, uniforms.objectCount);
    for (var index = chunkRange.x; index < chunkEnd; index += 1u) {
    let object = worldObjects[index];
    if (object.positionAndType.w != objectType) {
      continue;
    }

    let delta = p - object.positionAndType.xyz;
    let distance = dot(delta, delta);
    if (distance < closestDistance) {
      closestDistance = distance;
      local = rotate_y(delta, object.halfSize.w);
    }
    }
  }

  return local;
}

// xy = river, zw = island.
fn river_sample(z: f32) -> vec4f {
  let samplePosition = clamp(
    (z - uniforms.worldOriginZ) / uniforms.riverSampleSpacing,
    0.0,
    f32(RIVER_SAMPLE_COUNT - 1u)
  );
  let firstIndex = u32(floor(samplePosition));
  let secondIndex = min(firstIndex + 1u, RIVER_SAMPLE_COUNT - 1u);
  let t = fract(samplePosition);
  let first = riverSamples[firstIndex];
  let second = riverSamples[secondIndex];
  return mix(first, second, t);
}

// Negative in water.
fn river_distance_xz(p: vec3f) -> f32 {
  let river = river_sample(p.z);
  let outerDistance = abs(p.x - river.x) - river.y;

  if (river.w < 0.01) {
    return outerDistance;
  }

  let islandDistance = abs(p.x - river.z) - river.w;
  return max(outerDistance, -islandDistance);
}

fn segment_distance_2d(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let segment = b - a;
  let lengthSquared = max(dot(segment, segment), 0.000001);
  let t = clamp(dot(p - a, segment) / lengthSquared, 0.0, 1.0);
  return length(p - (a + segment * t));
}

fn river_metric_distance_xz(p: vec3f, rawDistance: f32) -> f32 {
  if (abs(rawDistance) > 2.5 || p.y > 2.0) {
    return rawDistance;
  }

  let samplePosition = clamp(
    (p.z - uniforms.worldOriginZ) / uniforms.riverSampleSpacing,
    0.0,
    f32(RIVER_SAMPLE_COUNT - 1u)
  );
  let centerIndex = i32(floor(samplePosition));
  var nearest = 100000.0;

  for (var offset = -6; offset <= 5; offset++) {
    let firstIndex = u32(clamp(centerIndex + offset, 0, i32(RIVER_SAMPLE_COUNT) - 1));
    let secondIndex = min(firstIndex + 1u, RIVER_SAMPLE_COUNT - 1u);
    if (firstIndex == secondIndex) {
      continue;
    }

    let first = riverSamples[firstIndex];
    let second = riverSamples[secondIndex];
    let firstZ = uniforms.worldOriginZ + f32(firstIndex) * uniforms.riverSampleSpacing;
    let secondZ = firstZ + uniforms.riverSampleSpacing;
    let point = p.xz;
    nearest = min(nearest, segment_distance_2d(
      point,
      vec2f(first.x - first.y, firstZ),
      vec2f(second.x - second.y, secondZ)
    ));
    nearest = min(nearest, segment_distance_2d(
      point,
      vec2f(first.x + first.y, firstZ),
      vec2f(second.x + second.y, secondZ)
    ));

    if (offset >= -4 && offset <= 3 && max(first.w, second.w) > 0.0001) {
      nearest = min(nearest, segment_distance_2d(
        point,
        vec2f(first.z - first.w, firstZ),
        vec2f(second.z - second.w, secondZ)
      ));
      nearest = min(nearest, segment_distance_2d(
        point,
        vec2f(first.z + first.w, firstZ),
        vec2f(second.z + second.w, secondZ)
      ));
    }
  }

  return select(-nearest, nearest, rawDistance >= 0.0);
}

fn terrain_fbm(p: vec2f) -> f32 {
  var point = p * 0.08;
  var amplitude = 0.5;
  var total = 0.0;

  for (var octave = 0; octave < 4; octave++) {
    total += (value_noise(point) - 0.5) * amplitude;
    point = vec2f(
      point.x * 0.8 + point.y * 0.6,
      -point.x * 0.6 + point.y * 0.8
    ) * 2.0;
    amplitude *= 0.5;
  }

  return total;
}

fn terrain_top_height(p: vec3f) -> f32 {
  let broadVariation = sin(p.x * 0.19 + p.z * 0.07) * 0.09
                     + sin(p.x * 0.47 - p.z * 0.11) * 0.035;
  return 0.62 + broadVariation + terrain_fbm(p.xz) * 0.12;
}

fn terrain_sdf(p: vec3f, riverDistance: f32) -> f32 {
  let horizontal = -riverDistance;
  let vertical = p.y - terrain_top_height(p);
  return max(horizontal, vertical) * 0.58;
}

fn scene_query(p: vec3f, skipFuel: bool, skipLandscape: bool) -> SceneSample {
  var nearest = SceneSample(100000.0, 0.0);
  if (!skipLandscape) {
    let rawRiverDistance = river_distance_xz(p);
    let riverDistance = river_metric_distance_xz(p, rawRiverDistance);
    let terrainDistance = terrain_sdf(p, riverDistance);
    let waterDistance = max(p.y - WATER_HEIGHT, riverDistance);
    nearest = SceneSample(terrainDistance, MATERIAL_TERRAIN);
    if (waterDistance < nearest.distance) {
      nearest = SceneSample(waterDistance, MATERIAL_WATER);
    }
  }

  let pointChunk = i32(floor((p.z - uniforms.worldOriginZ) / OBJECT_CHUNK_SIZE));
  for (var chunkOffset = -1; chunkOffset <= 1; chunkOffset++) {
    let chunkIndex = u32(clamp(pointChunk + chunkOffset, 0, OBJECT_CHUNK_COUNT - 1));
    let chunkRange = objectChunks[chunkIndex];
    let chunkEnd = min(chunkRange.x + chunkRange.y, uniforms.objectCount);
    for (var index = chunkRange.x; index < chunkEnd; index += 1u) {
    let object = worldObjects[index];
    let position = object.positionAndType.xyz;
    let objectType = object.positionAndType.w;
    let halfSize = object.halfSize.xyz;
    let yaw = object.halfSize.w;

    if (skipFuel && (objectType == 8.0 || objectType == 14.0 || objectType == 15.0)) {
      continue;
    }

    var boundRadius = length(halfSize) + max(0.42, halfSize.x * 0.72);
    if (objectType == 4.0) {
      boundRadius += 4.0;
    }
    let boundDistance = length(p - position) - boundRadius;
    if (boundDistance > nearest.distance) {
      continue;
    }

    var distance = box_sdf(p - position, halfSize);
    var material = MATERIAL_BRIDGE;

    if (objectType == 1.0) {
      distance = bridge_deck_sdf(p - position, halfSize);
    } else if (objectType == 2.0) {
      let labelDistance = fuel_label_sdf(p - position, halfSize);
      if (skipFuel) {
        distance = labelDistance;
        material = MATERIAL_FUEL_LABEL;
      } else {
        distance = fuel_sdf(p - position, halfSize);
        material = MATERIAL_FUEL;
        if (labelDistance < distance) {
          distance = labelDistance;
          material = MATERIAL_FUEL_LABEL;
        }
      }
    } else if (objectType == 3.0) {
      distance = missile_sdf(p - position, halfSize, yaw);
      material = MATERIAL_PROJECTILE;
    } else if (objectType == 4.0) {
      distance = bridge_edge_sdf(p - position, halfSize, yaw);
      if (abs(yaw) > 1.5) {
        material = MATERIAL_SCORCHED_BRIDGE;
      }
    } else if (objectType == 5.0) {
      distance = ship_sdf(p - position, halfSize, yaw);
      material = MATERIAL_SHIP;
    } else if (objectType == 6.0) {
      distance = helicopter_sdf(p - position, halfSize, yaw);
      material = MATERIAL_HELICOPTER;
      let glassDistance = helicopter_glass_sdf(p - position, halfSize, yaw);
      if (glassDistance < distance) {
        distance = glassDistance;
        material = MATERIAL_GLASS;
      }
    } else if (objectType == 7.0) {
      distance = tank_sdf(p - position, halfSize, yaw);
      material = MATERIAL_TANK;
    } else if (objectType == 8.0) {
      distance = explosion_sdf(p - position, halfSize.x, position.x + position.z);
      material = MATERIAL_EXPLOSION;
    } else if (objectType == 9.0) {
      distance = rock_sdf(p - position, halfSize, yaw);
      material = MATERIAL_ROCK;
    } else if (objectType == 10.0) {
      distance = fighter_sdf(p - position, halfSize, yaw);
      material = MATERIAL_FIGHTER;
    } else if (objectType == 11.0) {
      distance = balloon_sdf(p - position, halfSize);
      material = MATERIAL_BALLOON;
    } else if (objectType == 12.0) {
      distance = helicopter_sdf(p - position, halfSize, yaw);
      material = MATERIAL_ADVANCED_HELICOPTER;
      let glassDistance = helicopter_glass_sdf(p - position, halfSize, yaw);
      if (glassDistance < distance) {
        distance = glassDistance;
        material = MATERIAL_GLASS;
      }
    } else if (objectType == 13.0) {
      distance = enemy_projectile_sdf(p - position, halfSize, yaw);
      material = MATERIAL_ENEMY_PROJECTILE;
    } else if (objectType == 14.0) {
      distance = splash_sdf(p - position, halfSize.x, position.x + position.z);
      material = MATERIAL_SPLASH;
    } else if (objectType == 15.0) {
      distance = smoke_sdf(p - position, halfSize.x, position.x + position.z);
      material = MATERIAL_SMOKE;
    }

      if (distance < nearest.distance) {
        nearest = SceneSample(distance, material);
      }
    }
  }

  let playerBound = length(p - uniforms.playerPosition) - 0.72;
  if (playerBound < nearest.distance) {
    let airplaneDistance = airplane_sdf(p);
    if (airplaneDistance < nearest.distance) {
      nearest = SceneSample(airplaneDistance, MATERIAL_AIRPLANE);
    }
  }

  return nearest;
}

fn scene_sdf(p: vec3f) -> f32 {
  return scene_query(p, false, false).distance;
}

fn terrain_scene_sdf(p: vec3f) -> f32 {
  let rawRiverDistance = river_distance_xz(p);
  let riverDistance = river_metric_distance_xz(p, rawRiverDistance);
  return terrain_sdf(p, riverDistance);
}

fn terrain_normal(p: vec3f) -> vec3f {
  let edgeDistance = abs(river_distance_xz(p));
  let e = mix(0.12, 0.0015, smoothstep(0.08, 0.42, edgeDistance));
  let x = terrain_scene_sdf(p + vec3f(e, 0.0, 0.0))
        - terrain_scene_sdf(p - vec3f(e, 0.0, 0.0));
  let y = terrain_scene_sdf(p + vec3f(0.0, e, 0.0))
        - terrain_scene_sdf(p - vec3f(0.0, e, 0.0));
  let z = terrain_scene_sdf(p + vec3f(0.0, 0.0, e))
        - terrain_scene_sdf(p - vec3f(0.0, 0.0, e));
  return normalize(vec3f(x, y, z));
}

fn scene_normal(p: vec3f) -> vec3f {
  let edgeDistance = abs(river_distance_xz(p));
  let e = mix(0.12, 0.0015, smoothstep(0.08, 0.42, edgeDistance));

  let x = scene_sdf(p + vec3f(e, 0.0, 0.0))
        - scene_sdf(p - vec3f(e, 0.0, 0.0));

  let y = scene_sdf(p + vec3f(0.0, e, 0.0))
        - scene_sdf(p - vec3f(0.0, e, 0.0));

  let z = scene_sdf(p + vec3f(0.0, 0.0, e))
        - scene_sdf(p - vec3f(0.0, 0.0, e));

  return normalize(vec3f(x, y, z));
}

fn rotate_camera(v: vec3f, yaw: f32, pitch: f32) -> vec3f {
  let cp = cos(pitch);
  let sp = sin(pitch);
  let cy = cos(yaw);
  let sy = sin(yaw);

  let yawed = vec3f(
    v.x * cy - v.z * sy,
    v.y,
    v.x * sy + v.z * cy
  );

  return vec3f(
    yawed.x,
    yawed.y * cp - yawed.z * sp,
    yawed.y * sp + yawed.z * cp
  );
}

fn ray_direction(uv: vec2f) -> vec3f {
  if (uniforms.cameraMode == 1u) {
    return vec3f(0.0, -1.0, 0.0);
  }

  let aspect = uniforms.resolution.x / uniforms.resolution.y;
  let fov = radians(70.0);

  let scale = tan(fov * 0.5);
  let cameraSpace = vec3f(
    uv.x * aspect * scale,
    uv.y * scale,
    -1.0
  );

  return normalize(
    rotate_camera(cameraSpace, uniforms.yaw, uniforms.pitch)
  );
}

fn ray_origin(uv: vec2f) -> vec3f {
  if (uniforms.cameraMode == 1u) {
    return uniforms.cameraPosition + vec3f(uv.x * 24.0, 0.0, -uv.y * 24.0);
  }

  return uniforms.cameraPosition;
}

fn sky_color(rd: vec3f) -> vec3f {
  let t = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  var color = mix(
    vec3f(0.11, 0.18, 0.28),
    vec3f(0.5, 0.7, 0.96),
    t
  );
  let horizon = exp(-abs(rd.y) * 9.0);
  color = mix(color, vec3f(0.62, 0.72, 0.78), horizon * 0.58);
  let cloudPlane = rd.xz / max(rd.y + 0.3, 0.18);
  let cloudMotion = vec2f(uniforms.time * 0.006, uniforms.time * -0.003);
  let broadCloud = value_noise(cloudPlane * 0.19 + cloudMotion);
  let cloudDetail = value_noise(cloudPlane * 0.43 - cloudMotion * 1.7);
  let cloudShape = smoothstep(0.56, 0.76, broadCloud * 0.72 + cloudDetail * 0.28);
  let cloudHeight = smoothstep(0.02, 0.22, rd.y) * (1.0 - smoothstep(0.72, 0.96, rd.y));
  color = mix(color, vec3f(0.82, 0.88, 0.94), cloudShape * cloudHeight * 0.34);

  let sunDirection = normalize(vec3f(-0.5, 0.78, -0.4));
  let sunFacing = max(dot(rd, sunDirection), 0.0);
  let sunDisk = smoothstep(0.9985, 0.9994, sunFacing);
  let sunHalo = pow(sunFacing, 28.0) * 0.22;
  color += vec3f(1.0, 0.82, 0.52) * (sunDisk * 0.85 + sunHalo);
  return color;
}

fn fog_color(rd: vec3f) -> vec3f {
  let heightBlend = smoothstep(0.06, 0.34, rd.y);
  return mix(vec3f(0.46, 0.56, 0.58), sky_color(rd), heightBlend * 0.72);
}

fn water_normal(p: vec3f, viewDistance: f32) -> vec3f {
  let firstPhase = p.x * 1.7 + p.z * 0.9 + uniforms.time * 1.4;
  let secondPhase = p.x * -0.8 + p.z * 2.2 - uniforms.time * 1.1;
  let thirdPhase = p.x * 3.4 - p.z * 2.7 + uniforms.time * 1.8;
  let detailFade = 1.0 - smoothstep(18.0, 62.0, viewDistance);
  let broadFade = mix(0.28, 1.0, detailFade);
  let dx = cos(firstPhase) * 0.043 * broadFade
         - cos(secondPhase) * 0.012 * broadFade
         + cos(thirdPhase) * 0.007 * detailFade;
  let dz = cos(firstPhase) * 0.023 * broadFade
         + cos(secondPhase) * 0.033 * broadFade
         - cos(thirdPhase) * 0.006 * detailFade;
  return normalize(vec3f(-dx, 1.0, -dz));
}

fn analytic_water_hit(ro: vec3f, rd: vec3f) -> f32 {
  if (abs(rd.y) < 0.0001) {
    return -1.0;
  }

  let distance = (WATER_HEIGHT - ro.y) / rd.y;
  if (distance <= 0.0 || distance > MAX_VIEW_DISTANCE * 2.0) {
    return -1.0;
  }

  let p = ro + rd * distance;
  if (river_distance_xz(p) >= 0.0) {
    return -1.0;
  }

  return distance;
}

fn analytic_land_hit(ro: vec3f, rd: vec3f) -> f32 {
  if (rd.y >= -0.0001) {
    return -1.0;
  }

  var distance = (0.62 - ro.y) / rd.y;
  for (var step = 0; step < 4; step++) {
    let p = ro + rd * distance;
    distance = (terrain_top_height(p) - ro.y) / rd.y;
  }

  if (distance <= 0.0 || distance > MAX_VIEW_DISTANCE * 2.0) {
    return -1.0;
  }

  let p = ro + rd * distance;
  if (river_distance_xz(p) <= 0.0) {
    return -1.0;
  }

  return distance;
}

fn metal_shade(
  baseColor: vec3f,
  p: vec3f,
  normal: vec3f,
  rd: vec3f,
  lightDirection: vec3f,
  shadow: f32,
  metallic: f32,
  roughness: f32
) -> vec3f {
  let micro = triplanar_noise(p, normal, 17.0);
  let paintVariation = mix(0.88, 1.1, micro);
  let surfaceRoughness = clamp(roughness + (micro - 0.5) * 0.18, 0.08, 0.95);
  let viewDirection = normalize(-rd);
  let halfDirection = normalize(lightDirection + viewDirection);
  let light = max(dot(normal, lightDirection), 0.0) * shadow;
  let facing = max(dot(normal, viewDirection), 0.0);
  let highlight = max(dot(normal, halfDirection), 0.0);
  let power = mix(110.0, 9.0, surfaceRoughness);
  let variedColor = baseColor * paintVariation;
  let f0 = mix(vec3f(0.045), variedColor, metallic);
  let fresnel = f0 + (vec3f(1.0) - f0) * pow(1.0 - facing, 5.0);
  let specular = fresnel * pow(highlight, power) * mix(1.25, 0.28, surfaceRoughness) * shadow;
  let reflectedSky = sky_color(reflect(rd, normal));
  let edgeReflection = 0.42 + facing * 0.58;
  let environment = reflectedSky * fresnel * mix(0.045, 0.15, metallic) * edgeReflection;
  let diffuseColor = variedColor * (0.2 + light * 0.8) * (1.0 - metallic * 0.38);
  return diffuseColor + specular + environment;
}

fn soft_shadow(ro: vec3f, rd: vec3f, skipLandscape: bool) -> f32 {
  var distance = 0.06;
  var shadow = 1.0;
  let stepLimit = i32(mix(10.0, 18.0, uniforms.quality));

  for (var step = 0; step < 18; step++) {
    if (step >= stepLimit) {
      break;
    }
    let samplePosition = ro + rd * distance;
    let sample = scene_query(samplePosition, true, skipLandscape);
    var sampleDistance = sample.distance;

    if (sampleDistance < 0.002) {
      return 0.0;
    }

    shadow = min(shadow, 9.0 * sampleDistance / distance);
    distance += clamp(sampleDistance, 0.07, 0.9);

    if (distance > 10.0 || shadow < 0.03) {
      break;
    }
  }

  return clamp(shadow, 0.0, 1.0);
}

fn raymarch(ro: vec3f, rd: vec3f, skipFuel: bool) -> vec2f {
  var t = 0.0;
  var previousT = 0.0;
  let stepLimit = i32(mix(160.0, 240.0, uniforms.quality));

  for (var i = 0; i < 240; i++) {
    if (i >= stepLimit) {
      break;
    }
    let p = ro + rd * t;
    let sample = scene_query(p, skipFuel, false);

    if (abs(sample.distance) < 0.0015) {
      return vec2f(t, sample.material);
    }

    if (sample.distance < 0.0) {
      var outsideT = previousT;
      var insideT = t;
      var hitMaterial = sample.material;
      for (var refinement = 0; refinement < 7; refinement++) {
        let middleT = (outsideT + insideT) * 0.5;
        let middleSample = scene_query(ro + rd * middleT, skipFuel, false);
        if (middleSample.distance > 0.0) {
          outsideT = middleT;
        } else {
          insideT = middleT;
          hitMaterial = middleSample.material;
        }
      }
      return vec2f((outsideT + insideT) * 0.5, hitMaterial);
    }

    var marchStep = max(sample.distance * 0.65, 0.001);
    let shoreMaterial = sample.material == MATERIAL_TERRAIN
      || sample.material == MATERIAL_WATER;
    if (shoreMaterial && p.y < 1.5 && sample.distance < 3.0) {
      marchStep = min(marchStep, 0.22);
    }
    if (p.y < 1.5 && sample.distance < 3.0) {
      let islandNear = max(
        river_sample(p.z - 1.0).w,
        river_sample(p.z + 1.0).w
      ) > 0.005;
      if (islandNear) {
        marchStep = min(marchStep, 0.12);
      }
    }
    previousT = t;
    t += marchStep;

    if (t > MAX_VIEW_DISTANCE) {
      break;
    }
  }

  return vec2f(-1.0, 0.0);
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  var uv = (
    fragCoord.xy - 0.5 * uniforms.resolution
  ) / uniforms.resolution.y;
  // Screen Y points down.
  uv.y = -uv.y;

  let ro = ray_origin(uv);
  let rd = ray_direction(uv);

  var hit = raymarch(ro, rd, false);
  let landHit = analytic_land_hit(ro, rd);
  if (landHit > 0.0 && (hit.x < 0.0 || landHit < hit.x)) {
    hit = vec2f(landHit, MATERIAL_TERRAIN);
  }
  let waterHit = analytic_water_hit(ro, rd);
  if (waterHit > 0.0 && (hit.x < 0.0 || waterHit < hit.x)) {
    hit = vec2f(waterHit, MATERIAL_WATER);
  }

  if (hit.x < 0.0) {
    let missColor = select(fog_color(rd), sky_color(rd), rd.y > 0.16);
    return vec4f(missColor, 1.0);
  }

  let p = ro + rd * hit.x;
  var normal = vec3f(0.0, 1.0, 0.0);
  if (hit.y == MATERIAL_TERRAIN) {
    normal = terrain_normal(p);
  } else if (hit.y != MATERIAL_WATER) {
    normal = scene_normal(p);
  }

  let lightDirection = normalize(vec3f(-0.5, 1.0, -0.4));
  var shadow = 1.0;
  if (uniforms.cameraMode != 1u && hit.x < 42.0) {
    let waterSurface = hit.y == MATERIAL_WATER;
    let shadowNormal = select(normal, vec3f(0.0, 1.0, 0.0), waterSurface);
    let rawShadow = soft_shadow(
      p + shadowNormal * 0.035,
      lightDirection,
      true
    );
    let edgeShadowMask = smoothstep(0.08, 0.34, abs(river_distance_xz(p)));
    let distanceFade = 1.0 - smoothstep(28.0, 42.0, hit.x);
    shadow = mix(1.0, rawShadow, edgeShadowMask * distanceFade);
  }
  let diffuse = max(dot(normal, lightDirection), 0.0) * shadow;

  var color: vec3f;
  if (hit.y == MATERIAL_WATER) {
    let waterViewDistance = length(p.xz - ro.xz);
    let shore = 0.0;
    let rawWaterNormal = water_normal(p, waterViewDistance);
    let waterNormal = normalize(mix(rawWaterNormal, vec3f(0.0, 1.0, 0.0), shore * 0.9));
    let reflectionDirection = reflect(rd, waterNormal);
    let reflectedColor = sky_color(reflectionDirection);
    let rawFresnel = pow(1.0 - max(dot(-rd, waterNormal), 0.0), 5.0);
    let fresnel = rawFresnel * mix(1.0, 0.18, shore);
    let shallowColor = vec3f(0.045, 0.235, 0.27);
    let deepColor = vec3f(0.018, 0.13, 0.2);
    var baseWater = mix(deepColor, shallowColor, shore * 0.62);
    let localRipple = value_noise(p.xz * 2.4 + vec2f(uniforms.time * 0.04, 0.0));
    let rippleStrength = (1.0 - shore) * (1.0 - smoothstep(25.0, 55.0, waterViewDistance));
    baseWater *= mix(0.92, 1.07, localRipple * rippleStrength);
    let halfDirection = normalize(lightDirection - rd);
    let sparkle = pow(max(dot(waterNormal, halfDirection), 0.0), 120.0) * shadow;
    let foamPattern = smoothstep(0.63, 0.82, value_noise(p.xz * 3.2));
    let foam = shore * foamPattern * 0.07;
    color = mix(baseWater, reflectedColor, 0.18 + fresnel * 0.46);
    color += vec3f(1.0, 0.9, 0.67) * sparkle * 0.85;
    color = mix(color, vec3f(0.72, 0.87, 0.86), foam);
    color *= 0.78 + 0.22 * shadow;
  } else if (hit.y == MATERIAL_BRIDGE) {
    let rust = 0.5 + 0.5 * value_noise(p.xz * 3.5);
    let baseColor = mix(vec3f(0.19, 0.16, 0.13), vec3f(0.38, 0.17, 0.065), rust * 0.55);
    color = metal_shade(baseColor, p, normal, rd, lightDirection, shadow, 0.48, 0.72);
  } else if (hit.y == MATERIAL_SCORCHED_BRIDGE) {
    let ash = value_noise(p.xz * 9.0);
    let baseColor = mix(vec3f(0.025, 0.022, 0.02), vec3f(0.16, 0.065, 0.025), ash);
    color = metal_shade(baseColor, p, normal, rd, lightDirection, shadow, 0.25, 0.9);
  } else if (hit.y == MATERIAL_AIRPLANE) {
    let local = airplane_local(p);
    let camoPatch = value_noise(vec2f(local.x * 3.2 + local.z * 1.2, local.y * 5.0));
    let baseColor = mix(vec3f(0.43, 0.29, 0.13), vec3f(0.78, 0.61, 0.32), camoPatch);
    color = metal_shade(baseColor, local, normal, rd, lightDirection, shadow, 0.18, 0.62);
  } else if (hit.y == MATERIAL_FUEL) {
    let fresnel = pow(1.0 - max(dot(-rd, normal), 0.0), 3.0);
    let glass = vec3f(0.82, 0.12, 0.62);
    let behindHit = raymarch(p + rd * 0.06, rd, true);
    var behindColor = sky_color(rd);

    if (behindHit.x >= 0.0) {
      let behindP = p + rd * (0.06 + behindHit.x);
      if (behindHit.y == MATERIAL_WATER) {
        behindColor = vec3f(0.025, 0.17, 0.22);
      } else if (behindHit.y == MATERIAL_AIRPLANE) {
        behindColor = vec3f(0.82, 0.12, 0.06);
      } else if (behindHit.y == MATERIAL_FUEL_LABEL) {
        behindColor = vec3f(1.0, 0.52, 0.82);
      } else if (behindHit.y == MATERIAL_TERRAIN) {
        let variation = 0.04 * sin(behindP.x * 1.7 + behindP.z * 1.1);
        behindColor = vec3f(0.20, 0.32 + variation, 0.12);
      } else {
        behindColor = vec3f(0.34, 0.30, 0.20);
      }
    }

    let glassGrain = value_noise(p.xz * 13.0);
    let opacity = 0.16 + fresnel * 0.42 + glassGrain * 0.035;
    let glassHighlight = pow(max(dot(normal, normalize(lightDirection - rd)), 0.0), 90.0);
    color = mix(behindColor, glass * (0.55 + 0.45 * diffuse), opacity);
    color += vec3f(1.0, 0.72, 0.9) * glassHighlight * 0.3;
  } else if (hit.y == MATERIAL_FUEL_LABEL) {
    color = vec3f(1.0, 0.52, 0.82) * (0.55 + 0.45 * diffuse);
  } else if (hit.y == MATERIAL_PROJECTILE) {
    color = vec3f(1.0, 0.72, 0.12);
  } else if (hit.y == MATERIAL_SHIP) {
    let waterline = 1.0 - smoothstep(0.04, 0.3, abs(p.y - WATER_HEIGHT));
    let salt = value_noise(vec2f(p.x * 9.0, p.z * 4.0));
    var baseColor = vec3f(0.16, 0.195, 0.215) * mix(0.9, 1.08, salt);
    baseColor = mix(baseColor, vec3f(0.24, 0.105, 0.045), waterline * 0.42);
    color = metal_shade(baseColor, p, normal, rd, lightDirection, shadow, 0.68, 0.5);
  } else if (hit.y == MATERIAL_HELICOPTER) {
    let paint = value_noise(vec2f(p.x * 5.0 + p.z, p.y * 9.0));
    let local = helicopter_local(p, 6.0);
    let stripe = (1.0 - smoothstep(0.045, 0.085, abs(local.x)))
      * smoothstep(-0.07, 0.015, local.y);
    var baseColor = mix(vec3f(0.48, 0.52, 0.54), vec3f(0.76, 0.79, 0.8), paint);
    baseColor = mix(baseColor, vec3f(0.025, 0.22, 0.72), stripe);
    color = metal_shade(baseColor, p, normal, rd, lightDirection, shadow, 0.5, 0.42);
  } else if (hit.y == MATERIAL_TANK) {
    let camouflage = smoothstep(0.42, 0.62, value_noise(p.xz * 1.9));
    let dirt = value_noise(p.xz * 7.2) * 0.045;
    var baseColor = mix(vec3f(0.19, 0.225, 0.065), vec3f(0.29, 0.27, 0.1), camouflage);
    baseColor += vec3f(dirt, dirt * 0.82, dirt * 0.38);
    color = metal_shade(baseColor, p, normal, rd, lightDirection, shadow, 0.3, 0.78);
  } else if (hit.y == MATERIAL_EXPLOSION) {
    let flicker = 0.5 + 0.5 * sin(uniforms.time * 38.0 + dot(p, vec3f(9.0, 13.0, 7.0)));
    let debris = smoothstep(0.66, 0.82, value_noise(p.xz * 21.0 + vec2f(p.y * 8.0)));
    let fireColor = mix(vec3f(1.0, 0.08, 0.01), vec3f(1.0, 0.88, 0.18), flicker);
    color = mix(fireColor, vec3f(0.045, 0.035, 0.025), debris);
  } else if (hit.y == MATERIAL_ROCK) {
    let coarse = triplanar_noise(p, normal, 2.8);
    let grain = triplanar_noise(p, normal, 13.0);
    let strata = 0.5 + 0.5 * sin(p.y * 19.0 + coarse * 4.5);
    var baseColor = mix(vec3f(0.19, 0.165, 0.13), vec3f(0.4, 0.355, 0.28), coarse);
    baseColor *= mix(0.82, 1.12, strata * 0.65 + grain * 0.35);
    color = baseColor * (0.25 + 0.75 * diffuse);
  } else if (hit.y == MATERIAL_FIGHTER) {
    let panelTone = value_noise(vec2f(p.x * 10.0 - p.z * 2.0, p.y * 16.0));
    let baseColor = vec3f(0.5, 0.06, 0.025) * mix(0.88, 1.12, panelTone);
    color = metal_shade(baseColor, p, normal, rd, lightDirection, shadow, 0.58, 0.3);
  } else if (hit.y == MATERIAL_BALLOON) {
    let weave = sin(p.y * 46.0) * sin((p.x + p.z) * 38.0) * 0.035;
    let baseColor = balloon_color(p) * (1.0 + weave);
    color = baseColor * (0.3 + 0.7 * diffuse);
  } else if (hit.y == MATERIAL_ADVANCED_HELICOPTER) {
    let paint = value_noise(vec2f(p.x * 6.0 - p.z, p.y * 11.0));
    let local = helicopter_local(p, 12.0);
    let stripe = (1.0 - smoothstep(0.045, 0.085, abs(local.x)))
      * smoothstep(-0.07, 0.015, local.y);
    var baseColor = mix(vec3f(0.36, 0.035, 0.018), vec3f(0.62, 0.075, 0.025), paint);
    baseColor = mix(baseColor, vec3f(1.0, 0.31, 0.025), stripe);
    color = metal_shade(baseColor, p, normal, rd, lightDirection, shadow, 0.44, 0.5);
  } else if (hit.y == MATERIAL_ENEMY_PROJECTILE) {
    let pulse = 0.72 + 0.28 * sin(uniforms.time * 42.0);
    color = vec3f(1.0, 0.1, 0.015) * pulse + vec3f(0.5, 0.08, 0.0);
  } else if (hit.y == MATERIAL_GLASS) {
    let fresnel = pow(1.0 - max(dot(-rd, normal), 0.0), 3.0);
    let reflectedSky = sky_color(reflect(rd, normal));
    let tint = mix(vec3f(0.025, 0.09, 0.115), vec3f(0.055, 0.17, 0.19), value_noise(p.xz * 9.0));
    color = mix(tint, reflectedSky, 0.3 + fresnel * 0.55);
  } else if (hit.y == MATERIAL_SPLASH) {
    let shimmer = 0.75 + 0.25 * sin(uniforms.time * 34.0 + dot(p, vec3f(8.0, 13.0, 6.0)));
    color = mix(vec3f(0.28, 0.68, 0.78), vec3f(0.88, 0.97, 1.0), shimmer);
  } else if (hit.y == MATERIAL_SMOKE) {
    let smokeNoise = value_noise(p.xz * 7.0 + vec2f(p.y * 2.0));
    let behindHit = raymarch(p + rd * 0.08, rd, true);
    var behindColor = sky_color(rd);
    if (behindHit.x >= 0.0) {
      if (behindHit.y == MATERIAL_WATER) {
        behindColor = vec3f(0.035, 0.19, 0.24);
      } else if (behindHit.y == MATERIAL_TERRAIN) {
        behindColor = vec3f(0.2, 0.3, 0.11);
      } else {
        behindColor = vec3f(0.24, 0.22, 0.19);
      }
    }
    let smokeColor = mix(vec3f(0.07, 0.065, 0.06), vec3f(0.36, 0.34, 0.32), smokeNoise);
    let opacity = mix(0.2, 0.48, smokeNoise);
    color = mix(behindColor, smokeColor * (0.5 + diffuse * 0.25), opacity);
  } else {
    let riverDistance = abs(river_distance_xz(p));
    let broadTexture = triplanar_noise(p, normal, 1.7);
    let detailTexture = triplanar_noise(p, normal, 6.5);
    let macroTexture = clamp(0.5 + terrain_fbm(p.xz), 0.0, 1.0);
    let grassColor = mix(
      vec3f(0.13, 0.25, 0.075),
      vec3f(0.29, 0.42, 0.14),
      broadTexture * 0.56 + detailTexture * 0.2 + macroTexture * 0.24
    );
    let rockLayers = 0.5 + 0.5 * sin(p.y * 16.0 + broadTexture * 3.5);
    let rockColor = mix(
      vec3f(0.22, 0.145, 0.085),
      vec3f(0.39, 0.29, 0.18),
      rockLayers * 0.65 + detailTexture * 0.35
    );
    let wetColor = mix(
      vec3f(0.09, 0.075, 0.06),
      vec3f(0.18, 0.135, 0.085),
      detailTexture
    );
    let slope = 1.0 - normal.y;
    let rockMix = smoothstep(0.18, 0.62, slope);
    let shoreMix = 1.0 - smoothstep(0.04, 0.3, riverDistance);
    let strata = smoothstep(0.42, 0.58, 0.5 + 0.5 * sin(p.y * 27.0 + broadTexture * 4.0));
    var baseColor = mix(grassColor, rockColor, rockMix);
    baseColor = mix(baseColor, rockColor * mix(0.72, 1.12, strata), rockMix * 0.42);
    baseColor = mix(baseColor, wetColor, shoreMix * 0.72);
    color = baseColor * (0.22 + 0.78 * diffuse);
  }

  var fogDistance = length(p.xz - ro.xz);
  if (hit.y == MATERIAL_WATER && rd.y < -0.0001) {
    let terrainPlaneT = (0.62 - ro.y) / rd.y;
    if (terrainPlaneT > 0.0) {
      let terrainPlaneP = ro + rd * terrainPlaneT;
      let terrainPlaneDistance = length(terrainPlaneP.xz - ro.xz);
      let shoreFogFix = 1.0 - smoothstep(0.15, 1.5, abs(river_distance_xz(p)));
      fogDistance = mix(
        fogDistance,
        min(fogDistance, terrainPlaneDistance),
        shoreFogFix
      );
    }
  }
  let fog = smoothstep(FOG_START, FOG_END, fogDistance);
  color = mix(color, fog_color(rd), fog);
  color = vec3f(1.0) - exp(-color * 1.35);
  color = pow(max(color, vec3f(0.0)), vec3f(0.84));

  return vec4f(color, 1.0);
}
