export const RIVER_SAMPLE_COUNT = 4096;
export const RIVER_SAMPLE_SPACING = 0.125;
export const WORLD_OBJECT_CAPACITY = 64;
export const BRIDGE_GAP_HALF_WIDTH = 2;
export const BRIDGE_ROAD_LENGTH = 4;
export const PLAYER_MAX_SPEED = 12;
export const FUEL_DRAIN_PER_SECOND = 4.8;

export interface RiverSample {
  center: number;
  halfWidth: number;
  islandCenter: number;
  islandHalfWidth: number;
}

export interface WorldGenerator {
  sampleRiver(z: number): RiverSample;
  objectsBetween?(startZ: number, endZ: number): WorldObject[];
}

export enum WorldObjectType {
  Bridge = 1,
  Fuel = 2,
  Projectile = 3,
  BridgeEdge = 4,
  Ship = 5,
  Helicopter = 6,
  Tank = 7,
  Explosion = 8,
  Rock = 9,
  Fighter = 10,
  Balloon = 11,
  AdvancedHelicopter = 12,
  EnemyProjectile = 13,
  Splash = 14,
  Smoke = 15,
}

export interface WorldObject {
  id: string;
  type: WorldObjectType;
  position: [number, number, number];
  halfSize: [number, number, number];
  yaw?: number;
  tankOnBank?: boolean;
  direction?: number;
  aggressive?: boolean;
}

interface GeneratedRiverPoint {
  distance: number;
  center: number;
  halfWidth: number;
}

interface GeneratedBridge {
  index: number;
  distance: number;
}

interface GeneratedFuel {
  id: string;
  distance: number;
  lateral: number;
  channel: number;
}

interface GeneratedEnemy {
  id: string;
  type: WorldObjectType;
  distance: number;
  lateral: number;
  direction: number;
  onBridge: boolean;
  aggressive: boolean;
}

interface GeneratedIsland {
  startDistance: number;
  endDistance: number;
  startCap: number;
  endCap: number;
  waistPosition: number;
  widthProfile: [number, number, number, number, number];
  centerProfile: [number, number, number, number, number];
  minimumChannelWidth: number;
}

function mixUint32(value: number): number {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
}

function seededNoise1d(position: number, seed: number): number {
  const cell = Math.floor(position);
  const local = position - cell;
  const blend = local * local * (3 - 2 * local);
  const first = mixUint32(seed ^ Math.imul(cell, 0x9e3779b9)) / 0x100000000;
  const second = mixUint32(seed ^ Math.imul(cell + 1, 0x9e3779b9)) / 0x100000000;
  return first + (second - first) * blend;
}

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  nextFloat(): number {
    return this.nextUint32() / 0x100000000;
  }

  signed(): number {
    return this.nextFloat() * 2 - 1;
  }
}

export class SeededWorldGenerator implements WorldGenerator {
  readonly seed: number;
  readonly straightRiver: boolean;
  private readonly points: GeneratedRiverPoint[] = [];
  private readonly bridges: GeneratedBridge[] = [];
  private readonly fuels: GeneratedFuel[] = [];
  private readonly enemies: GeneratedEnemy[] = [];
  private readonly islands: GeneratedIsland[] = [];
  private readonly bridgeTankFireLevel: number;

  constructor(seed: number, straightRiver = false, bridgeCount = 100, baseLength = 120) {
    this.seed = seed >>> 0;
    this.straightRiver = straightRiver;
    this.bridgeTankFireLevel = 5 + mixUint32(this.seed ^ 0xa511e9b3) % 4;
    this.generate(Math.max(2, bridgeCount), Math.max(40, baseLength));
  }

  get endZ(): number {
    return -this.bridges[this.bridges.length - 1].distance;
  }

  sampleRiver(z: number): RiverSample {
    const distance = Math.max(0, -z);
    const last = this.points.length - 1;

    if (distance >= this.points[last].distance) {
      const sample = this.toRiverSample(this.points[last]);
      if (this.straightRiver) {
        sample.center = 0;
        sample.islandCenter = 0;
      }
      return sample;
    }

    let low = 0;
    let high = last;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.points[middle].distance <= distance) low = middle;
      else high = middle;
    }

    const first = this.points[low];
    const second = this.points[high];
    const t = (distance - first.distance) / (second.distance - first.distance);
    const smooth = t * t * (3 - 2 * t);
    const baseCenter = first.center + (second.center - first.center) * smooth;
    const baseHalfWidth = first.halfWidth + (second.halfWidth - first.halfWidth) * smooth;
    const difficulty = Math.min(1, distance / 12000);
    const broadCenter = seededNoise1d(distance * 0.22, this.seed ^ 0x43a17b21) - 0.5;
    const fineCenter = seededNoise1d(distance * 0.82, this.seed ^ 0x91e10da5) - 0.5;
    const broadWidth = seededNoise1d(distance * 0.19, this.seed ^ 0xc2b2ae35) - 0.5;
    const fineWidth = seededNoise1d(distance * 0.75, this.seed ^ 0x27d4eb2f) - 0.5;
    const centerDetail = broadCenter * (0.42 + difficulty * 0.2) + fineCenter * 0.16;
    const widthDetail = broadWidth * (0.58 + difficulty * 0.28) + fineWidth * 0.22;
    const firstPhase = mixUint32(this.seed ^ 0x68bc21eb) / 0x100000000 * Math.PI * 2;
    const secondPhase = mixUint32(this.seed ^ 0x02e5be93) / 0x100000000 * Math.PI * 2;
    const broadMeander = (Math.sin(distance * 0.014 + firstPhase) - Math.sin(firstPhase)) * 18
      + (Math.sin(distance * 0.006 + secondPhase) - Math.sin(secondPhase)) * 28;
    const center = this.straightRiver ? 0 : baseCenter + centerDetail + broadMeander;
    const earlyBridge = this.bridges[Math.min(4, this.bridges.length - 1)];
    const minimumHalfWidth = distance < earlyBridge.distance ? 3 : 1.5;
    const halfWidth = this.bridgeHalfWidth(distance, Math.max(minimumHalfWidth, baseHalfWidth + widthDetail));
    const island = this.sampleIsland(distance, center, halfWidth);
    return {
      center: island.riverCenter,
      halfWidth: island.riverHalfWidth,
      islandCenter: island.center,
      islandHalfWidth: island.halfWidth,
    };
  }

  objectsBetween(startZ: number, endZ: number): WorldObject[] {
    const objects: WorldObject[] = [];

    for (const bridge of this.bridges) {
      const z = -bridge.distance;
      if (z < startZ - 1 || z > endZ + 1) continue;
      this.addBridge(objects, bridge.index, z);
    }

    for (const fuel of this.fuels) {
      const z = -fuel.distance;
      if (z < startZ - 2 || z > endZ + 2) continue;
      const river = this.sampleRiver(z);
      objects.push({
        id: fuel.id,
        type: WorldObjectType.Fuel,
        position: [this.fuelPosition(river, fuel, 0.75), 0.72, z],
        halfSize: [0.58, 0.58, 1.6],
      });
    }

    for (const enemy of this.enemies) {
      const z = -enemy.distance;
      if (z < startZ - 3 || z > endZ + 3) continue;
      const river = this.sampleRiver(z);
      const waterX = this.waterPosition(river, enemy.lateral, 0.9);

      if (enemy.type === WorldObjectType.Tank) {
        if (enemy.onBridge) {
          objects.push({
            id: enemy.id,
            type: enemy.type,
            position: [
              river.center + (enemy.lateral * 2 - 1) * (river.halfWidth + BRIDGE_ROAD_LENGTH - 0.5),
              0.96,
              z,
            ],
            halfSize: [0.55, 0.16, 0.42],
            yaw: enemy.direction * Math.PI * 0.5,
            tankOnBank: false,
            direction: enemy.direction,
            aggressive: enemy.aggressive,
          });
          continue;
        }

        const side = enemy.lateral < 0.5 ? -1 : 1;
        objects.push({
          id: enemy.id,
          type: enemy.type,
          position: [river.center + side * (river.halfWidth + 0.55), 0.84, z],
          halfSize: [0.55, 0.16, 0.42],
          yaw: -side * Math.PI * 0.5,
          tankOnBank: true,
          direction: enemy.direction,
          aggressive: enemy.aggressive,
        });
        continue;
      }

      const properties = this.enemyProperties(enemy.type);
      objects.push({
        id: enemy.id,
        type: enemy.type,
        position: [waterX, properties.y, z],
        halfSize: properties.halfSize,
        yaw: enemy.direction * Math.PI * 0.5,
        direction: enemy.direction,
      });
    }

    this.addRocks(objects, startZ, endZ);

    return objects;
  }

  private addRocks(objects: WorldObject[], startZ: number, endZ: number): void {
    const spacing = 9;
    const firstSlot = Math.max(0, Math.floor(-endZ / spacing));
    const lastSlot = Math.max(firstSlot, Math.ceil(-startZ / spacing));

    for (let slot = firstSlot; slot <= lastSlot; slot += 1) {
      const hash = mixUint32(this.seed ^ Math.imul(slot + 1, 0x6d2b79f5));
      if ((hash & 0xffff) / 0x10000 > 0.55) continue;
      const distance = slot * spacing + ((hash >>> 16) / 0x10000 - 0.5) * spacing * 0.55;
      const z = -Math.max(0, distance);
      if (z < startZ || z > endZ) continue;
      if (this.bridges.some((bridge) => Math.abs(bridge.distance - distance) < 8)) continue;

      const river = this.sampleRiver(z);
      const secondHash = mixUint32(hash ^ 0xa511e9b3);
      const thirdHash = mixUint32(hash ^ 0x63d83595);
      const firstRandom = (secondHash & 0xffff) / 0x10000;
      const secondRandom = (secondHash >>> 16) / 0x10000;
      const onIsland = river.islandHalfWidth > 0.65 && firstRandom < 0.58;
      let x: number;
      if (onIsland) {
        const usableWidth = Math.max(0, river.islandHalfWidth - 0.35);
        x = river.islandCenter + (secondRandom * 2 - 1) * usableWidth;
      } else {
        const side = firstRandom < 0.5 ? -1 : 1;
        x = river.center + side * (river.halfWidth + 0.45 + secondRandom * 2.4);
      }

      const scale = 0.2 + (thirdHash & 0xffff) / 0x10000 * 0.28;
      const halfHeight = scale * (0.72 + (thirdHash >>> 16) / 0x10000 * 0.48);
      objects.push({
        id: `rock:${slot}`,
        type: WorldObjectType.Rock,
        position: [x, terrainHeight(x, z) + halfHeight * 0.82, z],
        halfSize: [scale, halfHeight, scale * (0.8 + secondRandom * 0.35)],
        yaw: firstRandom * Math.PI * 2,
      });
    }
  }

  private generate(bridgeCount: number, baseLength: number): void {
    let distance = 0;
    let center = 0;
    let slope = 0;
    let halfWidth = 8;
    let bankCenterOffset = 0;
    let bankWidthOffset = 0;
    let targetBankCenter = 0;
    let targetBankWidth = 0;
    let bankControlDistance = 0;
    let previousRiverStyle = 0;
    this.points.push({ distance, center, halfWidth });
    this.bridges.push({ index: 0, distance });

    for (let section = 0; section < bridgeCount - 1; section += 1) {
      const difficulty = section / Math.max(1, bridgeCount - 2);
      const length = baseLength + section;
      const rng = new SeededRandom(mixUint32(this.seed ^ Math.imul(section + 1, 0x9e3779b9)));
      const endDistance = distance + length;

      let islandCount = 0;
      if (section === 3) islandCount = 1;
      else if (section > 3) {
        if (rng.nextFloat() < 0.32 + difficulty * 0.48) islandCount += 1;
        if (rng.nextFloat() < 0.04 + difficulty * 0.32) islandCount += 1;
        if (rng.nextFloat() < difficulty * 0.12) islandCount += 1;
      }

      for (let islandIndex = 0; islandIndex < islandCount; islandIndex += 1) {
        const slotLength = length / islandCount;
        const islandMargin = Math.min(14, slotLength * 0.2);
        const maxLength = Math.max(16, slotLength - islandMargin * 2);
        const islandLength = Math.min(maxLength, 20 + rng.nextFloat() * (16 + difficulty * 18));
        const slotStart = distance + islandIndex * slotLength;
        const available = Math.max(0, slotLength - islandLength - islandMargin * 2);
        const islandStart = slotStart + islandMargin + rng.nextFloat() * available;
        const maxIslandWidth = 1.5 + rng.nextFloat() * (2.5 + difficulty * 2.5);
        const waistSide = rng.nextFloat() < 0.5 ? -1 : 1;
        this.islands.push({
          startDistance: islandStart,
          endDistance: islandStart + islandLength,
          startCap: 0.06 + rng.nextFloat() * 0.1,
          endCap: 0.06 + rng.nextFloat() * 0.1,
          waistPosition: 0.3 + rng.nextFloat() * 0.4,
          widthProfile: [
            maxIslandWidth * (0.18 + rng.nextFloat() * 0.62),
            maxIslandWidth * (0.62 + rng.nextFloat() * 0.38),
            maxIslandWidth * (0.08 + rng.nextFloat() * 0.3),
            maxIslandWidth * (0.62 + rng.nextFloat() * 0.38),
            maxIslandWidth * (0.18 + rng.nextFloat() * 0.62),
          ],
          centerProfile: [
            rng.signed() * 0.35,
            rng.signed() * 0.55,
            waistSide * (0.45 + rng.nextFloat() * 0.85),
            rng.signed() * 0.55,
            rng.signed() * 0.35,
          ],
          minimumChannelWidth: section < 4 ? 6 : 3,
        });
      }

      let targetSlope = 0;
      let targetWidth = halfWidth;
      let controlDistance = 0;
      let turnControlDistance = 0;
      let widthControlIndex = 0;
      let widthResponse = 0.14;
      let previousExtreme = false;
      const styleRoll = rng.nextFloat();
      let riverStyle = section < 4
        ? 0
        : section % 5 === 0 ? 1 : styleRoll < 0.24 ? 1 : styleRoll < 0.62 ? 0 : 2;
      if (section >= 4 && riverStyle === 0 && previousRiverStyle === 0) riverStyle = 2;
      previousRiverStyle = riverStyle;

      while (distance < endDistance) {
        const step = Math.min(2, endDistance - distance);
        if (turnControlDistance <= 0) {
          const sharpTurn = rng.nextFloat() < 0.12 + difficulty * 0.12;
          const maxSlope = (0.15 + difficulty * 0.08) * (sharpTurn ? 1.55 : 1);
          const direction = rng.nextFloat() < 0.5 ? -1 : 1;
          const magnitude = maxSlope * (0.4 + rng.nextFloat() * 0.5);
          const returnSlope = Math.max(-maxSlope, Math.min(maxSlope, -center * 0.006));
          targetSlope = Math.max(
            -maxSlope,
            Math.min(maxSlope, direction * magnitude + returnSlope),
          );
          turnControlDistance = 40 + rng.nextFloat() * (28 + difficulty * 16);
        }

        if (controlDistance <= 0) {
          const styleNarrow = riverStyle === 1 && widthControlIndex % 2 === 0;
          const variedNarrow = riverStyle === 2
            && (widthControlIndex % 3 === 1 || rng.nextFloat() < 0.18);
          const extremeNarrow: boolean = section >= 4
            && !previousExtreme
            && (styleNarrow || variedNarrow)
            && rng.nextFloat() < 0.3 + difficulty * 0.3;
          if (extremeNarrow) targetWidth = 1.5 + rng.nextFloat() * 0.35;
          else if (styleNarrow) {
            targetWidth = 3 + rng.nextFloat() * 1.4;
          } else if (variedNarrow) {
            targetWidth = 3 + rng.nextFloat() * 1.4;
          }
          else targetWidth = 6.8 - difficulty * 1.4 + rng.nextFloat() * (5.2 - difficulty);
          widthResponse = extremeNarrow ? 0.42 : widthResponse > 0.2 ? 0.32 : 0.14;
          previousExtreme = extremeNarrow;
          controlDistance = extremeNarrow
            ? 10 + rng.nextFloat() * 6
            : styleNarrow || variedNarrow
            ? 16 + rng.nextFloat() * 12
            : 16 + rng.nextFloat() * 18;
          widthControlIndex += 1;
        }

        slope += (targetSlope - slope) * (0.08 + difficulty * 0.02);
        center += slope * step;
        halfWidth += (targetWidth - halfWidth) * widthResponse;
        if (bankControlDistance <= 0) {
          targetBankCenter = rng.signed() * (0.12 + difficulty * 0.16);
          targetBankWidth = rng.signed() * (0.16 + difficulty * 0.24);
          bankControlDistance = 7 + rng.nextFloat() * 8;
        }

        bankCenterOffset += (targetBankCenter - bankCenterOffset) * 0.24;
        bankWidthOffset += (targetBankWidth - bankWidthOffset) * 0.24;
        distance += step;
        controlDistance -= step;
        turnControlDistance -= step;
        bankControlDistance -= step;
        this.points.push({
          distance,
          center: center + bankCenterOffset,
          halfWidth: Math.max(section < 4 ? 3 : 1.5, halfWidth + bankWidthOffset),
        });
      }

      this.bridges.push({ index: section + 1, distance });
      this.generateEnemies(section, difficulty, length, endDistance - length, rng);
      const direction = rng.nextFloat() < 0.5 ? -1 : 1;
      this.enemies.push({
        id: `bridge-tank:${section + 1}`,
        type: WorldObjectType.Tank,
        distance: endDistance,
        lateral: rng.nextFloat(),
        direction,
        onBridge: true,
        aggressive: section + 1 >= this.bridgeTankFireLevel,
      });
    }

    this.generateFuels(distance);
  }

  private generateEnemies(
    section: number,
    difficulty: number,
    length: number,
    startDistance: number,
    rng: SeededRandom,
  ): void {
    const baseCount = section === 0
      ? 16
      : Math.max(12, 15 + difficulty * 6 + rng.signed() * 2.5) * length / 120;
    const count = Math.floor(baseCount) + Number(rng.nextFloat() < baseCount % 1);
    const safeStart = section === 0 ? 16 : 0;
    const slotLength = (length - safeStart) / count;

    for (let index = 0; index < count; index += 1) {
      const margin = Math.min(10, slotLength * 0.22);
      const distance = startDistance + safeStart + index * slotLength + margin
        + rng.nextFloat() * Math.max(0, slotLength - margin * 2);
      let type = this.randomEnemyType(rng, difficulty);
      const lateral = rng.nextFloat();
      if (type === WorldObjectType.Tank) {
        const river = this.sampleRiver(-distance);
        if (river.islandHalfWidth > 0) {
          const leftBank = river.center - river.halfWidth;
          const rightBank = river.center + river.halfWidth;
          const islandLeft = river.islandCenter - river.islandHalfWidth;
          const islandRight = river.islandCenter + river.islandHalfWidth;
          const channelWidth = lateral < 0.5
            ? islandLeft - leftBank
            : rightBank - islandRight;
          if (channelWidth < 4.5) {
            type = lateral < 0.25 || lateral >= 0.75
              ? WorldObjectType.Ship
              : WorldObjectType.Helicopter;
          }
        }
      }
      this.enemies.push({
        id: `enemy:${section}:${index}`,
        type,
        distance,
        lateral,
        direction: rng.nextFloat() < 0.5 ? -1 : 1,
        onBridge: false,
        aggressive: true,
      });
    }
  }

  private randomEnemyType(rng: SeededRandom, difficulty: number): WorldObjectType {
    const roll = rng.nextFloat();
    if (difficulty < 0.02) {
      return roll < 0.6 ? WorldObjectType.Ship : WorldObjectType.Helicopter;
    }
    const advanced = difficulty * 0.16;
    const fighter = difficulty * 0.12;
    const tank = 0.08 + difficulty * 0.14;
    const balloon = 0.12;
    const ship = 0.3 - difficulty * 0.08;

    if (roll < advanced) return WorldObjectType.AdvancedHelicopter;
    if (roll < advanced + fighter) return WorldObjectType.Fighter;
    if (roll < advanced + fighter + tank) return WorldObjectType.Tank;
    if (roll < advanced + fighter + tank + balloon) return WorldObjectType.Balloon;
    if (roll < advanced + fighter + tank + balloon + ship) return WorldObjectType.Ship;
    return WorldObjectType.Helicopter;
  }

  private waterPosition(river: RiverSample, lateral: number, margin: number): number {
    const leftBank = river.center - river.halfWidth;
    const rightBank = river.center + river.halfWidth;
    if (river.islandHalfWidth <= 0) {
      return leftBank + margin + lateral * (rightBank - leftBank - margin * 2);
    }

    const islandLeft = river.islandCenter - river.islandHalfWidth;
    const islandRight = river.islandCenter + river.islandHalfWidth;
    const leftWidth = Math.max(0, islandLeft - leftBank - margin * 2);
    const rightWidth = Math.max(0, rightBank - islandRight - margin * 2);
    const waterPosition = lateral * (leftWidth + rightWidth);
    return waterPosition < leftWidth
      ? leftBank + margin + waterPosition
      : islandRight + margin + waterPosition - leftWidth;
  }

  private fuelPosition(river: RiverSample, fuel: GeneratedFuel, margin: number): number {
    if (river.islandHalfWidth <= 0 || fuel.channel === 0) {
      return this.waterPosition(river, fuel.lateral, margin);
    }

    const leftBank = river.center - river.halfWidth;
    const rightBank = river.center + river.halfWidth;
    const islandLeft = river.islandCenter - river.islandHalfWidth;
    const islandRight = river.islandCenter + river.islandHalfWidth;
    const start = fuel.channel < 0 ? leftBank + margin : islandRight + margin;
    const end = fuel.channel < 0 ? islandLeft - margin : rightBank - margin;
    return start + fuel.lateral * Math.max(0, end - start);
  }

  private enemyProperties(type: WorldObjectType): {
    y: number;
    halfSize: [number, number, number];
  } {
    switch (type) {
      case WorldObjectType.Ship:
        return { y: -0.03, halfSize: [0.46, 0.12, 0.72] };
      case WorldObjectType.Balloon:
        return { y: 0.66, halfSize: [0.43, 0.52, 0.43] };
      case WorldObjectType.Fighter:
        return { y: 0.78, halfSize: [0.58, 0.08, 0.36] };
      default:
        return { y: 0.72, halfSize: [0.68, 0.2, 0.52] };
    }
  }

  private generateFuels(totalDistance: number): void {
    const rng = new SeededRandom(this.seed ^ 0xf4e1c3a7);
    const fullRange = PLAYER_MAX_SPEED * 100 / FUEL_DRAIN_PER_SECOND;
    const maximumGap = 55;
    let previousDistance = 0;
    let index = 0;

    while (previousDistance < totalDistance) {
      const difficulty = Math.min(1, previousDistance / totalDistance);
      const minimumGap = fullRange * (0.03 + difficulty * 0.09);
      const difficultyMaximum = fullRange * (0.09 + difficulty * 0.13);
      const randomMaximum = Math.min(maximumGap, difficultyMaximum);
      let distance = previousDistance + minimumGap + rng.nextFloat() * (randomMaximum - minimumGap);
      if (distance >= totalDistance) break;

      for (const bridge of this.bridges) {
        if (Math.abs(distance - bridge.distance) >= 8) continue;
        const afterBridge = bridge.distance + 9;
        distance = afterBridge - previousDistance <= maximumGap
          ? afterBridge
          : bridge.distance - 9;
        break;
      }

      const river = this.sampleRiver(-distance);
      const firstChannel = river.islandHalfWidth > 0
        ? (rng.nextFloat() < 0.5 ? -1 : 1)
        : 0;
      this.fuels.push({
        id: `fuel:${index}`,
        distance,
        lateral: rng.nextFloat(),
        channel: firstChannel,
      });
      if (firstChannel !== 0 && rng.nextFloat() < 0.6) {
        this.fuels.push({
          id: `fuel:${index}:pair`,
          distance,
          lateral: rng.nextFloat(),
          channel: -firstChannel,
        });
      }
      previousDistance = distance;
      index += 1;
    }
  }

  private toRiverSample(point: GeneratedRiverPoint): RiverSample {
    return {
      center: point.center,
      halfWidth: this.bridgeHalfWidth(point.distance, point.halfWidth),
      islandCenter: point.center,
      islandHalfWidth: 0,
    };
  }

  private bridgeHalfWidth(distance: number, halfWidth: number): number {
    let low = 0;
    let high = this.bridges.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.bridges[middle].distance <= distance) low = middle;
      else high = middle;
    }

    const bridgeDistance = Math.min(
      Math.abs(distance - this.bridges[low].distance),
      Math.abs(distance - this.bridges[high].distance),
    );
    if (bridgeDistance >= 8 || halfWidth <= 4) return halfWidth;
    const local = Math.max(0, Math.min(1, (bridgeDistance - 4) / 4));
    const blend = local * local * (3 - 2 * local);
    return 4 + (halfWidth - 4) * blend;
  }

  private sampleIsland(
    distance: number,
    riverCenter: number,
    riverHalfWidth: number,
  ): {
    center: number;
    halfWidth: number;
    riverCenter: number;
    riverHalfWidth: number;
  } {
    for (const island of this.islands) {
      if (distance < island.startDistance) break;
      if (distance > island.endDistance) continue;
      const progress = (distance - island.startDistance)
        / (island.endDistance - island.startDistance);
      const positions = [
        0,
        island.waistPosition * 0.5,
        island.waistPosition,
        island.waistPosition + (1 - island.waistPosition) * 0.5,
        1,
      ];
      let segment = 0;
      while (segment < positions.length - 2 && progress > positions[segment + 1]) segment += 1;
      const local = (progress - positions[segment]) / (positions[segment + 1] - positions[segment]);
      const blend = local * local * (3 - 2 * local);
      const startT = Math.min(1, progress / island.startCap);
      const endT = Math.min(1, (1 - progress) / island.endCap);
      const startBlend = startT * startT * (3 - 2 * startT);
      const endBlend = endT * endT * (3 - 2 * endT);
      const cap = Math.sqrt(startBlend * endBlend);
      const profileWidth = island.widthProfile[segment]
        + (island.widthProfile[segment + 1] - island.widthProfile[segment]) * blend;
      const edgeDistance = Math.min(
        distance - island.startDistance,
        island.endDistance - distance,
      );
      const halfWidth = Math.min(profileWidth * cap, edgeDistance * 0.55);
      const minimumChannelWidth = island.minimumChannelWidth;
      const profileOffset = island.centerProfile[segment]
        + (island.centerProfile[segment + 1] - island.centerProfile[segment]) * blend;
      const offsetLimit = halfWidth * 0.25;
      const offset = Math.max(-offsetLimit, Math.min(offsetLimit, profileOffset * cap));
      const center = riverCenter + offset;
      const leftBank = riverCenter - riverHalfWidth;
      const rightBank = riverCenter + riverHalfWidth;
      const leftGap = center - halfWidth - leftBank;
      const rightGap = rightBank - center - halfWidth;
      const leftExpansion = Math.max(0, minimumChannelWidth - leftGap);
      const rightExpansion = Math.max(0, minimumChannelWidth - rightGap);
      const expandedLeft = leftBank - leftExpansion;
      const expandedRight = rightBank + rightExpansion;
      return {
        center,
        halfWidth,
        riverCenter: (expandedLeft + expandedRight) * 0.5,
        riverHalfWidth: (expandedRight - expandedLeft) * 0.5,
      };
    }

    return {
      center: riverCenter,
      halfWidth: 0,
      riverCenter,
      riverHalfWidth,
    };
  }

  private addBridge(objects: WorldObject[], index: number, z: number): void {
    const river = this.sampleRiver(z);
    const bridgeHalfWidth = river.halfWidth + 0.8;
    const edgeHalfWidth = (bridgeHalfWidth - BRIDGE_GAP_HALF_WIDTH) * 0.5;
    const edgeOffset = BRIDGE_GAP_HALF_WIDTH + edgeHalfWidth;
    const id = `bridge:${index}`;

    objects.push(
      {
        id: `${id}:left`,
        type: WorldObjectType.BridgeEdge,
        position: [river.center - edgeOffset, 0.68, z],
        halfSize: [edgeHalfWidth + 0.01, 0.12, 0.55],
        yaw: 1,
      },
      {
        id: `${id}:center`,
        type: WorldObjectType.Bridge,
        position: [river.center, 0.68, z],
        halfSize: [BRIDGE_GAP_HALF_WIDTH + 0.01, 0.12, 0.55],
      },
      {
        id: `${id}:right`,
        type: WorldObjectType.BridgeEdge,
        position: [river.center + edgeOffset, 0.68, z],
        halfSize: [edgeHalfWidth + 0.01, 0.12, 0.55],
        yaw: -1,
      },
    );
  }
}

function fract(value: number): number {
  return value - Math.floor(value);
}

function terrainHash(x: number, z: number): number {
  const qx = fract(x * 123.34);
  const qz = fract(z * 456.21);
  return fract(qx * qz * (qx + qz + 45.32));
}

function terrainNoise(x: number, z: number): number {
  const cellX = Math.floor(x);
  const cellZ = Math.floor(z);
  const localX = fract(x);
  const localZ = fract(z);
  const blendX = localX * localX * (3 - 2 * localX);
  const blendZ = localZ * localZ * (3 - 2 * localZ);
  const bottom = terrainHash(cellX, cellZ) * (1 - blendX)
    + terrainHash(cellX + 1, cellZ) * blendX;
  const top = terrainHash(cellX, cellZ + 1) * (1 - blendX)
    + terrainHash(cellX + 1, cellZ + 1) * blendX;
  return bottom * (1 - blendZ) + top * blendZ;
}

function terrainHeight(x: number, z: number): number {
  let pointX = x * 0.08;
  let pointZ = z * 0.08;
  let amplitude = 0.5;
  let fbm = 0;

  for (let octave = 0; octave < 4; octave += 1) {
    fbm += (terrainNoise(pointX, pointZ) - 0.5) * amplitude;
    const nextX = (pointX * 0.8 + pointZ * 0.6) * 2;
    pointZ = (-pointX * 0.6 + pointZ * 0.8) * 2;
    pointX = nextX;
    amplitude *= 0.5;
  }

  const broad = Math.sin(x * 0.19 + z * 0.07) * 0.09
    + Math.sin(x * 0.47 - z * 0.11) * 0.035;
  return 0.62 + broad + fbm * 0.12;
}

export interface RiverSampleWindow {
  originZ: number;
  data: Float32Array<ArrayBuffer>;
  objectData: Float32Array<ArrayBuffer>;
  objects: WorldObject[];
}

export function generateRiverSampleWindow(
  generator: WorldGenerator,
  cameraZ: number,
): RiverSampleWindow {
  const windowLength = RIVER_SAMPLE_COUNT * RIVER_SAMPLE_SPACING;
  const anchorZ = Math.floor(cameraZ / 32) * 32;
  const originZ = anchorZ - windowLength * 0.5;
  const data = new Float32Array(RIVER_SAMPLE_COUNT * 4);
  const objectData = new Float32Array(WORLD_OBJECT_CAPACITY * 8);
  const objects: WorldObject[] = [];

  for (let index = 0; index < RIVER_SAMPLE_COUNT; index += 1) {
    const sample = generator.sampleRiver(
      originZ + index * RIVER_SAMPLE_SPACING,
    );
    const offset = index * 4;
    data[offset] = sample.center;
    data[offset + 1] = sample.halfWidth;
    data[offset + 2] = sample.islandCenter;
    data[offset + 3] = sample.islandHalfWidth;
  }

  const objectStartZ = cameraZ - 120;
  const objectEndZ = cameraZ + 20;
  const generatedObjects = generator.objectsBetween?.(
    objectStartZ,
    objectEndZ,
  );

  if (generatedObjects) {
    objects.push(...generatedObjects);
  }

  if (!generatedObjects) {
  let bridgeZ = Math.ceil((objectStartZ + 55) / 120) * 120 - 55;

  while (bridgeZ < objectEndZ && objects.length < WORLD_OBJECT_CAPACITY) {
    const river = generator.sampleRiver(bridgeZ);
    const bridgeHalfWidth = river.halfWidth + 0.8;
    const gapHalfWidth = BRIDGE_GAP_HALF_WIDTH;
    const edgeHalfWidth = (bridgeHalfWidth - gapHalfWidth) * 0.5;
    const edgeOffset = gapHalfWidth + edgeHalfWidth;

    objects.push(
      {
        id: `bridge:${bridgeZ}:left`,
        type: WorldObjectType.BridgeEdge,
        position: [river.center - edgeOffset, 0.68, bridgeZ],
        halfSize: [edgeHalfWidth + 0.01, 0.12, 0.55],
        yaw: 1,
      },
      {
        id: `bridge:${bridgeZ}:center`,
        type: WorldObjectType.Bridge,
        position: [river.center, 0.68, bridgeZ],
        halfSize: [gapHalfWidth + 0.01, 0.12, 0.55],
      },
      {
        id: `bridge:${bridgeZ}:right`,
        type: WorldObjectType.BridgeEdge,
        position: [river.center + edgeOffset, 0.68, bridgeZ],
        halfSize: [edgeHalfWidth + 0.01, 0.12, 0.55],
        yaw: -1,
      },
    );
    bridgeZ += 120;
  }

  let fuelZ = Math.ceil((objectStartZ + 30) / 120) * 120 - 30;

  while (fuelZ < objectEndZ && objects.length < WORLD_OBJECT_CAPACITY) {
    const river = generator.sampleRiver(fuelZ);
    objects.push({
      id: `fuel:${fuelZ}`,
      type: WorldObjectType.Fuel,
      position: [river.center + river.halfWidth * 0.52, 0.72, fuelZ],
      halfSize: [0.58, 0.58, 1.6],
    });
    fuelZ += 120;
  }

  let shipZ = Math.ceil((objectStartZ + 15) / 120) * 120 - 15;

  while (shipZ < objectEndZ && objects.length < WORLD_OBJECT_CAPACITY) {
    const river = generator.sampleRiver(shipZ);
    objects.push({
      id: `ship:${shipZ}`,
      type: WorldObjectType.Ship,
      position: [river.center - river.halfWidth * 0.55, -0.03, shipZ],
      halfSize: [0.46, 0.12, 0.72],
    });
    shipZ += 120;
  }

  let helicopterZ = Math.ceil((objectStartZ + 42) / 120) * 120 - 42;

  while (
    helicopterZ < objectEndZ
    && objects.length < WORLD_OBJECT_CAPACITY
  ) {
    const river = generator.sampleRiver(helicopterZ);
    objects.push({
      id: `helicopter:${helicopterZ}`,
      type: WorldObjectType.Helicopter,
      position: [river.center, 0.72, helicopterZ],
      halfSize: [0.68, 0.2, 0.52],
    });
    helicopterZ += 120;
  }

  let tankZ = Math.ceil((objectStartZ + 72) / 120) * 120 - 72;

  while (tankZ < objectEndZ && objects.length < WORLD_OBJECT_CAPACITY) {
    const river = generator.sampleRiver(tankZ);
    const cycle = Math.round((tankZ + 72) / 120);
    const side = cycle % 2 === 0 ? 1 : -1;
    objects.push({
      id: `tank:${tankZ}`,
      type: WorldObjectType.Tank,
      position: [river.center + side * (river.halfWidth + 0.1), 0.84, tankZ],
      halfSize: [0.55, 0.16, 0.42],
      yaw: -side * Math.PI * 0.5,
      tankOnBank: true,
      direction: -side,
    });
    tankZ += 120;
  }
  }

  objectData.set(packWorldObjects(objects));

  return { originZ, data, objectData, objects };
}

export function packWorldObjects(objects: WorldObject[]): Float32Array<ArrayBuffer> {
  const data = new Float32Array(WORLD_OBJECT_CAPACITY * 8);

  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    const offset = index * 8;
    data.set(object.position, offset);
    data[offset + 3] = object.type;
    data.set(object.halfSize, offset + 4);
    data[offset + 7] = object.yaw ?? 0;
  }

  return data;
}
