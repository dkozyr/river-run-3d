import shaderCode from "./shaders/raymarch.wgsl?raw";
import { ProceduralAudio } from "./audio";
import {
  BRIDGE_GAP_HALF_WIDTH,
  BRIDGE_ROAD_LENGTH,
  FUEL_DRAIN_PER_SECOND,
  generateRiverSampleWindow,
  packWorldObjects,
  PLAYER_MAX_SPEED,
  RIVER_SAMPLE_COUNT,
  RIVER_SAMPLE_SPACING,
  type RiverSample,
  SeededWorldGenerator,
  type WorldObject,
  WorldObjectType,
  WORLD_OBJECT_CAPACITY,
} from "./world";

// Matches WGSL layout, including vec3 padding.
const FRAME_UNIFORM_SIZE = 96;
const INITIAL_LIVES = 4;
const FUEL_INTAKE_PER_SECOND = 78.4;
const TANK_SHELL_FLIGHT_TIME = 8 / 50;
const EXTRA_LIFE_SCORE = 8192;
const WATER_HEIGHT = -0.18;
const HIGH_SCORE_KEY = "river-raid-3d-high-score";
const FIXED_STEP = 1 / 60;
const MAX_FRAME_TIME = 0.1;
const RENDER_INTERVAL = 1000 / 30;
const RENDER_EARLY_MARGIN = 0.5;
const OBJECT_CHUNK_COUNT = 32;
const OBJECT_CHUNK_SIZE = 16;

function readWorldSeed(): number {
  const value = new URLSearchParams(window.location.search).get("seed");
  if (value === null || value.trim() === "") return 0x52414944;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) >>> 0 : 0x52414944;
}

function readStraightRiver(): boolean {
  return new URLSearchParams(window.location.search).get("straight") === "1";
}

interface MotionState {
  position: [number, number, number];
  yaw: number;
}

export class Renderer {
  private readonly audio = new ProceduralAudio();
  private readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly uniformBuffer: GPUBuffer;
  private readonly riverSampleBuffer: GPUBuffer;
  private readonly worldObjectBuffer: GPUBuffer;
  private readonly objectChunkBuffer: GPUBuffer;
  private readonly bindGroup: GPUBindGroup;
  private readonly format: GPUTextureFormat;
  private readonly fuelElement: HTMLDivElement;
  private readonly livesElement: HTMLDivElement;
  private readonly scoreElement: HTMLDivElement;
  private readonly bridgeElement: HTMLDivElement;
  private readonly highScoreElement: HTMLDivElement;
  private readonly pauseElement: HTMLDivElement;
  private readonly messageElement: HTMLDivElement;
  private readonly debugElement: HTMLDivElement;
  private readonly worldGenerator = new SeededWorldGenerator(readWorldSeed(), readStraightRiver());
  private worldObjects: WorldObject[] = [];
  private worldOriginZ = Number.NaN;
  private worldObjectCount = 0;
  private cameraMode = 0;
  private fuel = 100;
  private lives = INITIAL_LIVES;
  private score = 0;
  private nextExtraLifeScore = EXTRA_LIFE_SCORE;
  private highScore = 0;
  private bridgeNumber = 1;
  private playerSpeed = 6;
  private gameOver = false;
  private gameOverCameraZ = 0;
  private paused = false;
  private waitingForStart = true;
  private initialBridgePending = true;
  private respawnTimer = 0;
  private projectileId = 0;
  private projectiles: Array<{
    object: WorldObject;
    yaw: number;
    life: number;
  }> = [];
  private enemyProjectiles: Array<{
    object: WorldObject;
    velocity: [number, number, number];
    gravity: number;
    life: number;
    sourceId?: string;
    impactOnExpiry?: boolean;
    tankShell?: boolean;
  }> = [];
  private enemyFireTimes = new Map<string, number>();
  private tankStates = new Map<string, {
    x: number;
    y: number;
    yaw: number;
    tankOnBank: boolean;
    direction: number;
  }>();
  private explosions: Array<{
    object: WorldObject;
    life: number;
    scale: number;
    damaging: boolean;
  }> = [];
  private splashes: Array<{
    object: WorldObject;
    life: number;
  }> = [];
  private smokeClouds: Array<{
    object: WorldObject;
    life: number;
    scale: number;
  }> = [];
  private destroyedObjects = new Set<string>();
  private checkpointBridgeZ = 0;
  private checkpoint = {
    position: [0, 0.72, 0] as [number, number, number],
    yaw: 0,
  };

  private player = {
    position: [0, 0.72, 0] as [number, number, number],
    yaw: 0,
    bank: 0,
  };

  private camera = {
    position: [0, 1.5, 5] as [number, number, number],
    yaw: 0,
    pitch: -0.12,
  };

  private keys = new Set<string>();
  private cameraOrbitYaw = 0;
  private cameraOrbitPitch = 0;
  private lastTime = performance.now();
  private accumulator = 0;
  private gameTime = 0;
  private animationFrameId: number | null = null;
  private frameTimeAverage = 1 / 60;
  private debugUpdateTimer = 0;
  private debugVisible = false;
  private quality = 0;
  private qualityMode: "low" | "medium" | "high" = "low";
  private failed = false;
  private gpuBusy = false;
  private failureMessage: string | null = null;
  private failureHandler: ((message: string) => void) | null = null;

  set onFailure(handler: ((message: string) => void) | null) {
    this.failureHandler = handler;
    if (handler && this.failureMessage) handler(this.failureMessage);
  }

  get hasFailed(): boolean { return this.failed; }
  private previousPlayer: MotionState = {
    position: [...this.player.position],
    yaw: this.player.yaw,
  };
  private previousBank = this.player.bank;
  private previousCamera: MotionState = {
    position: [...this.camera.position],
    yaw: this.camera.yaw,
  };
  private previousObjects = new Map<string, MotionState>();

  private constructor(
    canvas: HTMLCanvasElement,
    context: GPUCanvasContext,
    device: GPUDevice,
    pipeline: GPURenderPipeline,
    uniformBuffer: GPUBuffer,
    riverSampleBuffer: GPUBuffer,
    worldObjectBuffer: GPUBuffer,
    objectChunkBuffer: GPUBuffer,
    bindGroup: GPUBindGroup,
    format: GPUTextureFormat,
    fuelElement: HTMLDivElement,
    livesElement: HTMLDivElement,
    scoreElement: HTMLDivElement,
    bridgeElement: HTMLDivElement,
    highScoreElement: HTMLDivElement,
    pauseElement: HTMLDivElement,
  ) {
    this.canvas = canvas;
    this.context = context;
    this.device = device;
    this.pipeline = pipeline;
    this.uniformBuffer = uniformBuffer;
    this.riverSampleBuffer = riverSampleBuffer;
    this.worldObjectBuffer = worldObjectBuffer;
    this.objectChunkBuffer = objectChunkBuffer;
    this.bindGroup = bindGroup;
    this.format = format;
    this.fuelElement = fuelElement;
    this.livesElement = livesElement;
    this.scoreElement = scoreElement;
    this.bridgeElement = bridgeElement;
    this.highScoreElement = highScoreElement;
    this.pauseElement = pauseElement;
    this.messageElement = document.createElement("div");
    this.messageElement.id = "message";
    this.canvas.parentElement?.append(this.messageElement);
    this.debugElement = document.createElement("div");
    this.debugElement.id = "debug";
    this.canvas.parentElement?.append(this.debugElement);
    this.highScore = this.loadHighScore();
    this.highScoreElement.textContent = `HI ${this.highScore}`;
    this.renderLives();
    this.pauseElement.textContent = "ARROWS / TAP TO START";
    this.pauseElement.classList.add("visible");

    void device.lost.then((info) => {
      console.error("WebGPU device lost", { reason: info.reason, message: info.message, adapter: device.adapterInfo });
      this.fail(`Graphics device lost (${info.reason}). ${info.message || "The browser provided no further details."}`);
    });
    device.addEventListener("uncapturederror", (event) => {
      console.error("WebGPU error", event.error);
      this.fail(`Graphics error: ${event.error.message}`);
    });
    this.installInput();
    this.installRenderingPause();
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }

  static async create(
    canvas: HTMLCanvasElement,
    fuelElement: HTMLDivElement,
    livesElement: HTMLDivElement,
    scoreElement: HTMLDivElement,
    bridgeElement: HTMLDivElement,
    highScoreElement: HTMLDivElement,
    pauseElement: HTMLDivElement,
    adapter: GPUAdapter,
  ): Promise<Renderer> {

    if (!adapter) {
      throw new Error("No suitable WebGPU adapter found.");
    }

    const device = await adapter.requestDevice();
    try {
      const context = canvas.getContext("webgpu");

      if (!context) {
        throw new Error("Could not create WebGPU canvas context.");
      }

      const format = navigator.gpu.getPreferredCanvasFormat();

      context.configure({
        device,
        format,
        alphaMode: "opaque",
      });

      const module = device.createShaderModule({
        label: "Ray marching shader",
        code: shaderCode,
      });

      const uniformBuffer = device.createBuffer({
        label: "Frame uniforms",
        size: FRAME_UNIFORM_SIZE,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      const riverSampleBuffer = device.createBuffer({
        label: "River world samples",
        size: RIVER_SAMPLE_COUNT * 4 * Float32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      const worldObjectBuffer = device.createBuffer({
        label: "World objects",
        size: WORLD_OBJECT_CAPACITY * 8 * Float32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      const objectChunkBuffer = device.createBuffer({
        label: "Object chunks",
        size: OBJECT_CHUNK_COUNT * 2 * Uint32Array.BYTES_PER_ELEMENT,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });

      const bindGroupLayout = device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "read-only-storage" },
          },
          {
            binding: 2,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "read-only-storage" },
          },
          {
            binding: 3,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "read-only-storage" },
          },
        ],
      });

      const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
      });

      const pipeline = await device.createRenderPipelineAsync({
        label: "Ray marching pipeline",
        layout: pipelineLayout,
        vertex: {
          module,
          entryPoint: "vs_main",
        },
        fragment: {
          module,
          entryPoint: "fs_main",
          targets: [{ format }],
        },
        primitive: {
          topology: "triangle-list",
        },
      });

      const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: uniformBuffer },
          },
          {
            binding: 1,
            resource: { buffer: riverSampleBuffer },
          },
          {
            binding: 2,
            resource: { buffer: worldObjectBuffer },
          },
          {
            binding: 3,
            resource: { buffer: objectChunkBuffer },
          },
        ],
      });

      await device.queue.onSubmittedWorkDone();
      return new Renderer(
        canvas,
        context,
        device,
        pipeline,
        uniformBuffer,
        riverSampleBuffer,
        worldObjectBuffer,
        objectChunkBuffer,
        bindGroup,
        format,
        fuelElement,
        livesElement,
        scoreElement,
        bridgeElement,
        highScoreElement,
        pauseElement,
      );
    } catch (error) {
      device.destroy();
      throw error;
    }
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.failureMessage = message;
    this.audio.setEnabled(false);
    if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId);
    this.animationFrameId = null;
    this.pauseElement.classList.remove("visible");
    this.device.destroy();
    this.failureHandler?.(message);
  }

  start(): void {
    this.resumeRendering();
  }

  private frame = (now: number): void => {
    this.animationFrameId = null;

    if (this.failed || document.hidden || !document.hasFocus()) {
      return;
    }

    if (this.gpuBusy) {
      this.animationFrameId = requestAnimationFrame(this.frame);
      return;
    }

    const elapsed = now - this.lastTime;
    if (elapsed + RENDER_EARLY_MARGIN < RENDER_INTERVAL) {
      this.animationFrameId = requestAnimationFrame(this.frame);
      return;
    }

    const dt = Math.min(elapsed / 1000, MAX_FRAME_TIME);
    this.lastTime = now;
    this.updateAdaptiveQuality(dt);
    this.accumulator += dt;

    while (this.accumulator >= FIXED_STEP) {
      this.captureMotionState();
      this.simulate(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
    }

    const alpha = this.accumulator / FIXED_STEP;
    const renderPlayer = this.interpolatePlayer(alpha);
    const renderCamera = this.interpolateCamera(alpha, renderPlayer.position);
    const renderGameTime = Math.max(0, this.gameTime - FIXED_STEP + alpha * FIXED_STEP);
    this.syncGpuObjects(alpha);

    const engineActive = !this.waitingForStart && !this.gameOver && this.respawnTimer === 0;
    this.audio.setEngine(this.playerSpeed, engineActive);
    if (!engineActive) this.audio.setRefueling(false);

    const width = this.canvas.width;
    const height = this.canvas.height;

    const data = new ArrayBuffer(FRAME_UNIFORM_SIZE);
    const f32 = new Float32Array(data);
    const u32 = new Uint32Array(data);

    f32[0] = width;
    f32[1] = height;
    // Padding before vec3.
    f32[4] = renderCamera.position[0];
    f32[5] = renderCamera.position[1];
    f32[6] = renderCamera.position[2];
    f32[7] = renderCamera.yaw;
    f32[8] = renderCamera.pitch;
    f32[9] = renderGameTime;
    f32[10] = this.worldOriginZ;
    f32[11] = RIVER_SAMPLE_SPACING;
    u32[12] = this.worldObjectCount;
    f32[16] = renderPlayer.position[0];
    f32[17] = this.respawnTimer > 0 || this.gameOver
      ? -100
      : renderPlayer.position[1];
    f32[18] = renderPlayer.position[2];
    f32[19] = renderPlayer.yaw;
    f32[20] = renderPlayer.bank;
    u32[21] = this.cameraMode;
    f32[22] = this.quality;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();

    this.device.queue.submit([encoder.finish()]);
    this.gpuBusy = true;
    void this.device.queue.onSubmittedWorkDone().then(
      () => { this.gpuBusy = false; },
      () => this.fail("Graphics processing failed. The game has stopped."),
    );
    this.animationFrameId = requestAnimationFrame(this.frame);
  };

  private simulate(dt: number): void {
    this.updateCamera(dt);
    this.updateRespawn(dt);
    this.updateWorldSamples();

    if (this.waitingForStart) return;

    this.gameTime += dt;
    this.updateEnemies(this.gameTime, dt);
    this.updateEnemyProjectiles(dt);
    this.updateExplosions(dt);
    this.updateSplashes(dt);
    this.updateSmoke(dt);
    this.updateProjectiles(dt);
    this.updateFuel(dt);
    this.updateCheckpoint();
    this.updateCollisions();
  }

  private captureMotionState(): void {
    this.previousPlayer = { position: [...this.player.position], yaw: this.player.yaw };
    this.previousBank = this.player.bank;
    this.previousCamera = { position: [...this.camera.position], yaw: this.camera.yaw };
    this.previousObjects.clear();

    for (const object of this.allObjects()) {
      this.previousObjects.set(object.id, {
        position: [...object.position],
        yaw: object.yaw ?? 0,
      });
    }
  }

  private interpolatePlayer(alpha: number): MotionState & { bank: number } {
    return {
      position: this.lerpPosition(this.previousPlayer.position, this.player.position, alpha),
      yaw: this.lerpAngle(this.previousPlayer.yaw, this.player.yaw, alpha),
      bank: this.lerp(this.previousBank, this.player.bank, alpha),
    };
  }

  private interpolateCamera(
    alpha: number,
    playerPosition: [number, number, number],
  ): MotionState & { pitch: number } {
    const position = this.lerpPosition(this.previousCamera.position, this.camera.position, alpha);

    if (this.gameOver) {
      return {
        position,
        yaw: this.lerpAngle(this.previousCamera.yaw, this.camera.yaw, alpha),
        pitch: this.camera.pitch,
      };
    }

    if (this.cameraMode === 1) {
      return { position, yaw: 0, pitch: -Math.PI * 0.5 };
    }

    const lookX = playerPosition[0] - position[0];
    const lookY = playerPosition[1] + 1.2 - position[1];
    const lookZ = playerPosition[2] - position[2];

    return {
      position,
      yaw: Math.atan2(lookX, -lookZ),
      pitch: Math.atan2(lookY, Math.hypot(lookX, lookZ)),
    };
  }

  private installRenderingPause(): void {
    document.addEventListener("visibilitychange", this.updateRenderingState);
    window.addEventListener("focus", this.updateRenderingState);
    window.addEventListener("blur", this.updateRenderingState);
  }

  private updateRenderingState = (): void => {
    if (document.hidden || !document.hasFocus() || this.paused) {
      this.audio.silenceLoops();
      if (this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      return;
    }

    this.resumeRendering();
  };

  private resumeRendering(): void {
    if (
      this.failed
      || this.animationFrameId !== null
      || document.hidden
      || !document.hasFocus()
      || this.paused
    ) {
      return;
    }

    this.lastTime = performance.now();
    this.accumulator = 0;
    this.captureMotionState();
    this.animationFrameId = requestAnimationFrame(this.frame);
  }

  private updateWorldSamples(): void {
    const window = generateRiverSampleWindow(
      this.worldGenerator,
      this.camera.position[2],
    );

    if (window.originZ === this.worldOriginZ) {
      return;
    }

    this.worldOriginZ = window.originZ;

    if (this.initialBridgePending) {
      const firstBridge = window.objects
        .filter((object) => object.type === WorldObjectType.Bridge && object.position[2] <= 0)
        .sort((first, second) => second.position[2] - first.position[2])[0];

      if (firstBridge) {
        const z = firstBridge.position[2];
        const river = this.worldGenerator.sampleRiver(z);
        const riverAhead = this.worldGenerator.sampleRiver(z - 2);
        const yaw = Math.atan2(riverAhead.center - river.center, 2);
        this.destroyedObjects.add(firstBridge.id);
        this.checkpointBridgeZ = z;
        this.checkpoint = { position: [river.center, 0.72, z], yaw };
        this.player.position = [...this.checkpoint.position];
        this.player.yaw = yaw;
        this.initialBridgePending = false;
      }
    }

    this.worldObjects = window.objects.filter(
      (object) => !this.destroyedObjects.has(object.id),
    );
    for (const object of this.worldObjects) {
      if (
        object.type === WorldObjectType.BridgeEdge
        && this.destroyedObjects.has(this.bridgeCenterId(object))
      ) {
        object.yaw = Math.sign(object.yaw ?? 1) * 2;
      }
      const state = object.type === WorldObjectType.Tank
        ? this.tankStates.get(object.id)
        : undefined;
      if (state) {
        object.position[0] = state.x;
        object.position[1] = state.y;
        object.yaw = state.yaw;
        object.tankOnBank = state.tankOnBank;
        object.direction = state.direction;
      }
    }
    if (this.waitingForStart) {
      this.positionMovingEnemies(this.gameTime);
    }
    this.device.queue.writeBuffer(
      this.riverSampleBuffer,
      0,
      window.data,
    );
  }

  private fire(): void {
    if (this.gameOver || this.respawnTimer > 0 || this.projectiles.length >= 1) {
      return;
    }

    const forwardX = Math.sin(this.player.yaw);
    const forwardZ = -Math.cos(this.player.yaw);
    this.projectiles.push({
      object: {
        id: `projectile:${this.projectileId}`,
        type: WorldObjectType.Projectile,
        position: [
          this.player.position[0] + forwardX * 0.65,
          this.player.position[1],
          this.player.position[2] + forwardZ * 0.65,
        ],
        halfSize: [0.04, 0.04, 0.18],
      },
      yaw: this.player.yaw,
      life: 1.1,
    });
    this.audio.shoot();
    this.projectileId += 1;
  }

  private updateEnemies(time: number, dt: number): void {
    const destroyedTanks: string[] = [];
    this.positionMovingEnemies(time);

    for (const object of this.worldObjects) {
      if (object.type === WorldObjectType.AdvancedHelicopter) {
        this.fireEnemyProjectile(object, time);
        continue;
      }

      if (
        object.type === WorldObjectType.Helicopter
        || object.type === WorldObjectType.Fighter
        || object.type === WorldObjectType.Balloon
        || object.type === WorldObjectType.Ship
      ) {
        continue;
      }

      if (object.type === WorldObjectType.Tank) {
        if (this.updateTank(object, time, dt)) {
          destroyedTanks.push(object.id);
        }
        continue;
      }

    }

    if (destroyedTanks.length > 0) {
      for (const id of destroyedTanks) {
        this.destroyedObjects.add(id);
      }
      this.worldObjects = this.worldObjects.filter(
        (object) => !destroyedTanks.includes(object.id),
      );
      this.addScore(destroyedTanks.length * this.targetScore(WorldObjectType.Tank));
    }
  }

  private positionMovingEnemies(time: number): void {
    for (const object of this.worldObjects) {
      if (
        object.type === WorldObjectType.Helicopter
        || object.type === WorldObjectType.AdvancedHelicopter
      ) {
        this.moveAcrossWater(object, time, 0.3, 0.11);
      } else if (object.type === WorldObjectType.Fighter) {
        const z = object.position[2];
        const river = this.worldGenerator.sampleRiver(z);
        const span = river.halfWidth + 3;
        const phase = ((time * 0.7 + z * 0.09) % 2 + 2) % 2;
        const direction = object.direction ?? 1;
        const travel = direction > 0 ? phase : 2 - phase;
        object.position[0] = river.center + (travel - 1) * span;
        object.yaw = direction * Math.PI * 0.5;
      } else if (object.type === WorldObjectType.Balloon) {
        this.moveAcrossWater(object, time, 0.22, 0.1);
      } else if (object.type === WorldObjectType.Ship) {
        this.moveAcrossWater(object, time, 0.25, 0.13);
      }
    }
  }

  private updateTank(object: WorldObject, time: number, dt: number): boolean {
    const river = this.worldGenerator.sampleRiver(object.position[2]);
    const forwardDistance = this.player.position[2] - object.position[2];

    if (forwardDistance < -5 || forwardDistance > 24) {
      this.saveTankState(object);
      return false;
    }

    if (!object.tankOnBank) {
      const bridge = this.worldObjects.find((candidate) => (
        candidate.type === WorldObjectType.BridgeEdge
        && Math.abs(candidate.position[2] - object.position[2]) < 4
      ));
      const destroyed = bridge
        ? this.destroyedObjects.has(this.bridgeCenterId(bridge))
        : false;

      if (!destroyed) {
        const roadLimit = river.halfWidth + BRIDGE_ROAD_LENGTH - object.halfSize[0];
        let direction = object.direction ?? 1;
        object.position[0] += direction * 1.5 * dt;
        const offset = object.position[0] - river.center;
        if (Math.abs(offset) >= roadLimit) {
          object.position[0] = river.center + Math.sign(offset) * roadLimit;
          direction = -Math.sign(offset);
          object.direction = direction;
        }
        object.yaw = direction * Math.PI * 0.5;
        this.saveTankState(object);
        return false;
      }

      if (
        Math.abs(object.position[0] - river.center)
        < BRIDGE_GAP_HALF_WIDTH + object.halfSize[0]
      ) {
        this.spawnExplosion(object.position);
        return true;
      }

      const side = object.position[0] < river.center ? -1 : 1;
      object.yaw = -side * Math.PI * 0.5;
      if (object.aggressive !== false) {
        this.fireTankProjectile(object, time, river.center, object.position[2], true);
      }
      this.saveTankState(object);
      return false;
    }

    const side = object.position[0] < river.center ? -1 : 1;
    const targetX = river.center + side * (river.halfWidth + object.halfSize[0]);
    const step = Math.min(Math.abs(targetX - object.position[0]), 1.2 * dt);
    object.position[0] += Math.sign(targetX - object.position[0]) * step;
    object.yaw = -side * Math.PI * 0.5;

    if (step < 0.001) {
      const targetX = this.bankTankTargetX(object, river);
      this.fireTankProjectile(object, time, targetX, object.position[2]);
    }

    this.saveTankState(object);
    return false;
  }

  private saveTankState(object: WorldObject): void {
    this.tankStates.set(object.id, {
      x: object.position[0],
      y: object.position[1],
      yaw: object.yaw ?? 0,
      tankOnBank: object.tankOnBank ?? false,
      direction: object.direction ?? 1,
    });
  }

  private bridgeCenterId(object: WorldObject): string {
    return object.id.replace(/:(left|right)$/, ":center");
  }

  private moveAcrossWater(object: WorldObject, time: number, speed: number, phaseScale: number): void {
    const z = object.position[2];
    const river = this.worldGenerator.sampleRiver(z);
    const margin = object.halfSize[0] + 0.2;
    let left = river.center - river.halfWidth + margin;
    let right = river.center + river.halfWidth - margin;

    if (river.islandHalfWidth > 0) {
      if (object.position[0] < river.islandCenter) {
        right = river.islandCenter - river.islandHalfWidth - margin;
      } else {
        left = river.islandCenter + river.islandHalfWidth + margin;
      }
    }

    const channelCenter = (left + right) * 0.5;
    const travel = Math.max(0, (right - left) * 0.5);
    const phase = time * speed + z * phaseScale;
    const nextX = channelCenter + Math.sin(phase) * travel;

    if (
      object.type === WorldObjectType.Ship
      || object.type === WorldObjectType.Helicopter
      || object.type === WorldObjectType.AdvancedHelicopter
    ) {
      object.yaw = Math.cos(phase) >= 0
        ? Math.PI * 0.5
        : -Math.PI * 0.5;
    }

    object.position[0] = nextX;
  }

  private fireEnemyProjectile(source: WorldObject, time: number): void {
    if (this.enemyProjectiles.some((projectile) => !projectile.tankShell)) return;

    let nextFire = this.enemyFireTimes.get(source.id);

    if (nextFire === undefined) {
      nextFire = time + 0.1;
      this.enemyFireTimes.set(source.id, nextFire);
    }

    const forwardDistance = this.player.position[2] - source.position[2];
    if (time < nextFire || forwardDistance < -8 || forwardDistance > 28 || this.enemyProjectiles.length >= 8) {
      return;
    }

    const directionX = Math.sin(source.yaw ?? 0) >= 0 ? 1 : -1;
    const speed = 24;
    this.enemyProjectiles.push({
      object: {
        id: `enemy-projectile:${source.id}:${time}`,
        type: WorldObjectType.EnemyProjectile,
        position: [source.position[0] + directionX * 0.82, 0.58, source.position[2]],
        halfSize: [0.07, 0.07, 0.14],
        yaw: directionX * Math.PI * 0.5,
      },
      velocity: [directionX * speed, 0, 0],
      gravity: 0,
      life: 6,
      sourceId: source.id,
    });
    this.enemyFireTimes.set(source.id, time + 0.1);
  }

  private fireTankProjectile(
    source: WorldObject,
    time: number,
    targetX: number,
    targetZ: number,
    impactInGap = false,
  ): boolean {
    const shellActive = this.enemyProjectiles.some((projectile) => projectile.tankShell);
    const shellExploding = this.explosions.some((explosion) => explosion.damaging);
    if (shellActive || shellExploding) return false;

    let nextFire = this.enemyFireTimes.get(source.id);

    if (nextFire === undefined) {
      nextFire = time + 0.2;
      this.enemyFireTimes.set(source.id, nextFire);
    }

    const forwardDistance = this.player.position[2] - source.position[2];
    if (time < nextFire || forwardDistance < 2 || forwardDistance > 30 || this.enemyProjectiles.length >= 8) {
      return false;
    }

    const startY = source.position[1] + 0.22;
    const dx = targetX - source.position[0];
    const dz = targetZ - source.position[2];
    const travelTime = TANK_SHELL_FLIGHT_TIME;
    const gravity = -5;
    const targetY = impactInGap ? -0.16 : this.player.position[1];
    const verticalSpeed = (targetY - startY) / travelTime
      - gravity * travelTime * 0.5;
    const velocityX = dx / travelTime;
    const velocityZ = dz / travelTime;
    this.enemyProjectiles.push({
      object: {
        id: `tank-projectile:${source.id}:${time}`,
        type: WorldObjectType.EnemyProjectile,
        position: [source.position[0], startY, source.position[2]],
        halfSize: [0.12, 0.12, 0.12],
        yaw: Math.atan2(velocityX, -velocityZ),
      },
      velocity: [
        velocityX,
        verticalSpeed,
        velocityZ,
      ],
      gravity,
      life: travelTime,
      impactOnExpiry: true,
      tankShell: true,
    });
    this.enemyFireTimes.set(source.id, time + 0.2);
    return true;
  }

  private bankTankTargetX(object: WorldObject, river: RiverSample): number {
    let hash = 2166136261;
    for (let index = 0; index < object.id.length; index += 1) {
      hash = Math.imul(hash ^ object.id.charCodeAt(index), 16777619);
    }
    hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
    const random = ((hash ^ (hash >>> 15)) >>> 0) / 0x100000000;
    const margin = 0.45;
    let left = river.center - river.halfWidth + margin;
    let right = river.center + river.halfWidth - margin;

    if (river.islandHalfWidth > 0) {
      if (object.position[0] < river.islandCenter) {
        right = river.islandCenter - river.islandHalfWidth - margin;
      } else {
        left = river.islandCenter + river.islandHalfWidth + margin;
      }
    }

    return left + random * Math.max(0, right - left);
  }

  private updateEnemyProjectiles(dt: number): void {
    for (const projectile of this.enemyProjectiles) {
      const startX = projectile.object.position[0];
      const startZ = projectile.object.position[2];
      const stepDt = projectile.impactOnExpiry
        ? Math.min(dt, projectile.life)
        : dt;
      projectile.object.position[0] += projectile.velocity[0] * stepDt;
      projectile.velocity[1] += projectile.gravity * stepDt;
      projectile.object.position[1] += projectile.velocity[1] * stepDt;
      projectile.object.position[2] += projectile.velocity[2] * stepDt;
      projectile.life -= dt;

      const dx = Math.abs(projectile.object.position[0] - this.player.position[0]);
      const dy = Math.abs(projectile.object.position[1] - this.player.position[1]);
      const dz = Math.abs(projectile.object.position[2] - this.player.position[2]);
      if (
        !projectile.tankShell
        && !this.gameOver
        && this.respawnTimer === 0
        && dx < 0.55
        && dy < 0.35
        && dz < 0.5
      ) {
        projectile.life = 0;
        this.crash();
      }

      if (!projectile.tankShell && projectile.life > 0) {
        const hitsTerrain = this.projectileHitsTerrain(
          startX,
          startZ,
          projectile.object.position[0],
          projectile.object.position[2],
        );
        const hitsObject = this.worldObjects.some((object) => (
          object.id !== projectile.sourceId
          && object.type !== WorldObjectType.Explosion
          && this.projectileHitsObject(
            startX,
            startZ,
            projectile.object.position[0],
            projectile.object.position[2],
            object,
          )
        ));
        if (hitsTerrain || hitsObject) projectile.life = 0;
      }

      if (projectile.tankShell && projectile.life <= 0) {
        this.spawnExplosion(projectile.object.position, 1, true);
      }
    }

    this.enemyProjectiles = this.enemyProjectiles.filter((projectile) => projectile.life > 0);
  }

  private updateProjectiles(dt: number): void {
    for (const projectile of this.projectiles) {
      let impacted = false;
      const startX = projectile.object.position[0];
      const startZ = projectile.object.position[2];
      projectile.yaw = this.player.yaw;
      projectile.object.yaw = projectile.yaw;
      projectile.object.position[0] = this.player.position[0]
        + Math.sin(projectile.yaw) * 0.65;
      projectile.object.position[2] -= (this.playerSpeed + 14) * dt;
      projectile.life -= dt;
      if (projectile.life < 0.22) {
        const descent = (0.72 - WATER_HEIGHT) / 0.22;
        projectile.object.position[1] = Math.max(
          WATER_HEIGHT,
          projectile.object.position[1] - descent * dt,
        );
      }

      const target = this.worldObjects.find((object) => {
        const destructible = object.type === WorldObjectType.Bridge
          || object.type === WorldObjectType.Fuel
          || object.type === WorldObjectType.Ship
          || object.type === WorldObjectType.Helicopter
          || object.type === WorldObjectType.AdvancedHelicopter
          || object.type === WorldObjectType.Tank
          || object.type === WorldObjectType.Fighter
          || object.type === WorldObjectType.Balloon;
        const blocking = object.type === WorldObjectType.BridgeEdge
          || object.type === WorldObjectType.Rock;

        if (!destructible && !blocking) {
          return false;
        }

        return this.projectileHitsObject(
          startX,
          startZ,
          projectile.object.position[0],
          projectile.object.position[2],
          object,
        );
      });

      if (target) {
        const destructible = target.type !== WorldObjectType.BridgeEdge
          && target.type !== WorldObjectType.Rock;
        this.spawnExplosion(target.position, destructible ? 1 : 0.3);
        projectile.life = 0;
        impacted = true;

        if (destructible) {
          const destroyedTargets = [target];
          const targetRiver = this.worldGenerator.sampleRiver(target.position[2]);
          const tankOnBridge = target.type === WorldObjectType.Tank
            && !target.tankOnBank
            && Math.abs(target.position[0] - targetRiver.center) <= targetRiver.halfWidth + 0.8;
          if (tankOnBridge) {
            const bridge = this.worldObjects.find((object) => (
              object.type === WorldObjectType.Bridge
              && Math.abs(object.position[2] - target.position[2]) < 0.01
            ));
            if (bridge) destroyedTargets.push(bridge);
          }

          for (const destroyedTarget of destroyedTargets) {
            this.destroyedObjects.add(destroyedTarget.id);
            this.addScore(this.targetScore(destroyedTarget.type));
          }

          const destroyedIds = new Set(destroyedTargets.map((object) => object.id));
          this.worldObjects = this.worldObjects.filter(
            (object) => !destroyedIds.has(object.id),
          );
          const destroyedBridge = destroyedTargets.find(
            (object) => object.type === WorldObjectType.Bridge,
          );
          if (destroyedBridge) {
            for (const object of this.worldObjects) {
              if (
                object.type === WorldObjectType.BridgeEdge
                && object.position[2] === destroyedBridge.position[2]
              ) {
                object.yaw = Math.sign(object.yaw ?? 1) * 2;
              }
            }
          }
        }
      } else if (
        this.projectileHitsTerrain(
          startX,
          startZ,
          projectile.object.position[0],
          projectile.object.position[2],
        )
      ) {
        this.spawnExplosion(projectile.object.position, 0.25);
        projectile.life = 0;
        impacted = true;
      }

      if (!impacted && projectile.life <= 0) {
        this.spawnSplash([
          projectile.object.position[0],
          WATER_HEIGHT,
          projectile.object.position[2],
        ]);
      }
    }

    this.projectiles = this.projectiles.filter(
      (projectile) => projectile.life > 0,
    );
  }

  private projectileHitsObject(
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
    object: WorldObject,
  ): boolean {
    const yaw = object.type === WorldObjectType.Bridge
      || object.type === WorldObjectType.BridgeEdge
      ? 0
      : object.yaw ?? 0;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const startDeltaX = startX - object.position[0];
    const startDeltaZ = startZ - object.position[2];
    const endDeltaX = endX - object.position[0];
    const endDeltaZ = endZ - object.position[2];
    const localStartX = startDeltaX * cy + startDeltaZ * sy;
    const localStartZ = -startDeltaX * sy + startDeltaZ * cy;
    const localEndX = endDeltaX * cy + endDeltaZ * sy;
    const localEndZ = -endDeltaX * sy + endDeltaZ * cy;
    const segmentX = localEndX - localStartX;
    const segmentZ = localEndZ - localStartZ;
    const [radiusX, radiusZ, elliptical] = this.collisionShape(object);

    if (!elliptical) {
      const lengthSquared = segmentX * segmentX + segmentZ * segmentZ;
      const projection = lengthSquared > 0
        ? (-localStartX * segmentX - localStartZ * segmentZ) / lengthSquared
        : 0;
      const t = Math.max(0, Math.min(1, projection));
      const dx = Math.abs(localStartX + segmentX * t);
      const dz = Math.abs(localStartZ + segmentZ * t);
      return dx < radiusX + 0.04 && dz < radiusZ + 0.12;
    }

    const scaledStartX = localStartX / (radiusX + 0.04);
    const scaledStartZ = localStartZ / (radiusZ + 0.12);
    const scaledSegmentX = segmentX / (radiusX + 0.04);
    const scaledSegmentZ = segmentZ / (radiusZ + 0.12);
    const lengthSquared = scaledSegmentX ** 2 + scaledSegmentZ ** 2;
    const projection = lengthSquared > 0
      ? (-scaledStartX * scaledSegmentX - scaledStartZ * scaledSegmentZ) / lengthSquared
      : 0;
    const t = Math.max(0, Math.min(1, projection));
    const hitX = scaledStartX + scaledSegmentX * t;
    const hitZ = scaledStartZ + scaledSegmentZ * t;
    return hitX * hitX + hitZ * hitZ < 1;
  }

  private collisionShape(object: WorldObject): [number, number, boolean] {
    switch (object.type) {
      case WorldObjectType.Ship:
        return [object.halfSize[0] * 0.92, object.halfSize[2], true];
      case WorldObjectType.Helicopter:
      case WorldObjectType.AdvancedHelicopter:
        return [object.halfSize[0] * 0.52, object.halfSize[2] * 1.35, true];
      case WorldObjectType.Fighter:
        return [object.halfSize[0] * 0.92, object.halfSize[2], true];
      case WorldObjectType.Balloon:
        return [object.halfSize[0], object.halfSize[2], true];
      default:
        return [object.halfSize[0], object.halfSize[2], false];
    }
  }

  private playerHitsObject(object: WorldObject): boolean {
    const yaw = object.type === WorldObjectType.Bridge
      || object.type === WorldObjectType.BridgeEdge
      ? 0
      : object.yaw ?? 0;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const deltaX = this.player.position[0] - object.position[0];
    const deltaZ = this.player.position[2] - object.position[2];
    const localX = deltaX * cy + deltaZ * sy;
    const localZ = -deltaX * sy + deltaZ * cy;
    const [radiusX, radiusZ, elliptical] = this.collisionShape(object);

    if (!elliptical) {
      return Math.abs(localX) < radiusX + 0.4
        && Math.abs(localZ) < radiusZ + 0.28;
    }

    const scaledX = localX / (radiusX + 0.36);
    const scaledZ = localZ / (radiusZ + 0.3);
    return scaledX * scaledX + scaledZ * scaledZ < 1;
  }

  private projectileHitsTerrain(
    startX: number,
    startZ: number,
    endX: number,
    endZ: number,
  ): boolean {
    for (let step = 1; step <= 8; step += 1) {
      const t = step / 8;
      const x = startX + (endX - startX) * t;
      const z = startZ + (endZ - startZ) * t;
      const river = this.worldGenerator.sampleRiver(z);
      const outside = Math.abs(x - river.center) > river.halfWidth - 0.04;
      const island = river.islandHalfWidth > 0
        && Math.abs(x - river.islandCenter) < river.islandHalfWidth + 0.04;

      if (outside || island) {
        return true;
      }
    }

    return false;
  }

  private targetScore(type: WorldObjectType): number {
    switch (type) {
      case WorldObjectType.Bridge: return 1024;
      case WorldObjectType.Fuel: return 64;
      case WorldObjectType.Ship: return 16;
      case WorldObjectType.Helicopter: return 32;
      case WorldObjectType.AdvancedHelicopter: return 256;
      case WorldObjectType.Tank: return 512;
      case WorldObjectType.Fighter: return 128;
      case WorldObjectType.Balloon: return 32;
      default: return 0;
    }
  }

  private loadHighScore(): number {
    try {
      return Math.max(0, Number(localStorage.getItem(HIGH_SCORE_KEY)) || 0);
    } catch {
      return 0;
    }
  }

  private updateHighScore(): void {
    if (this.score <= this.highScore) {
      return;
    }

    this.highScore = this.score;
    this.highScoreElement.textContent = `HI ${this.highScore}`;
    try {
      localStorage.setItem(HIGH_SCORE_KEY, String(this.highScore));
    } catch {
      return;
    }
  }

  private addScore(points: number): void {
    this.score += points;
    this.scoreElement.textContent = `SCORE ${this.score}`;

    while (this.score >= this.nextExtraLifeScore) {
      this.lives += 1;
      this.nextExtraLifeScore += EXTRA_LIFE_SCORE;
      this.renderLives();
      this.audio.extraLife();
      this.showMessage("EXTRA PLANE");
    }

    this.updateHighScore();
  }

  private renderLives(): void {
    this.livesElement.replaceChildren();

    for (let index = 0; index < this.lives; index += 1) {
      const plane = document.createElement("span");
      plane.className = "life-plane";
      plane.ariaLabel = "life";
      this.livesElement.append(plane);
    }
  }

  private spawnExplosion(
    position: [number, number, number],
    scale = 1,
    damaging = false,
  ): void {
    if (this.explosions.length >= 8) {
      return;
    }

    this.explosions.push({
      object: {
        id: `explosion:${this.projectileId}:${position[2]}`,
        type: WorldObjectType.Explosion,
        position: [position[0], position[1] + 0.15, position[2]],
        halfSize: [0.08, 0.08, 0.08],
      },
      life: 0.7,
      scale,
      damaging,
    });
    this.audio.explosion(scale);
    if (scale >= 0.5) this.spawnSmoke(position, scale);
  }

  private updateExplosions(dt: number): void {
    for (const explosion of this.explosions) {
      explosion.life -= dt;
      const progress = 1 - explosion.life / 0.7;
      const radius = 0.08 + progress ** 0.65 * 0.72 * explosion.scale;
      explosion.object.halfSize = [radius, radius, radius];

      if (
        explosion.damaging
        && radius >= 0.22
        && !this.gameOver
        && this.respawnTimer === 0
      ) {
        const dx = this.player.position[0] - explosion.object.position[0];
        const dz = this.player.position[2] - explosion.object.position[2];
        const hitRadius = radius + 0.04;
        if (dx * dx + dz * dz < hitRadius * hitRadius) this.crash();
      }
    }

    this.explosions = this.explosions.filter(
      (explosion) => explosion.life > 0,
    );
  }

  private spawnSplash(position: [number, number, number]): void {
    if (this.splashes.length >= 6) {
      return;
    }

    this.splashes.push({
      object: {
        id: `splash:${this.projectileId}:${position[2]}`,
        type: WorldObjectType.Splash,
        position,
        halfSize: [0.06, 0.06, 0.06],
      },
      life: 0.55,
    });
    this.audio.splash();
  }

  private updateSplashes(dt: number): void {
    for (const splash of this.splashes) {
      splash.life -= dt;
      const progress = 1 - splash.life / 0.55;
      const radius = 0.06 + Math.sin(progress * Math.PI) * 0.55;
      splash.object.halfSize = [radius, radius, radius];
    }

    this.splashes = this.splashes.filter((splash) => splash.life > 0);
  }

  private spawnSmoke(position: [number, number, number], scale: number): void {
    if (this.smokeClouds.length >= 4) return;
    this.smokeClouds.push({
      object: {
        id: `smoke:${this.projectileId}:${position[2]}`,
        type: WorldObjectType.Smoke,
        position: [position[0], position[1] + 0.2, position[2]],
        halfSize: [0.08, 0.08, 0.08],
      },
      life: 1.4,
      scale,
    });
  }

  private updateSmoke(dt: number): void {
    for (const smoke of this.smokeClouds) {
      smoke.life -= dt;
      smoke.object.position[1] += dt * 0.24;
      const progress = 1 - smoke.life / 1.4;
      const radius = (0.08 + Math.sin(progress * Math.PI) * 0.62) * smoke.scale;
      smoke.object.halfSize = [radius, radius, radius];
    }
    this.smokeClouds = this.smokeClouds.filter((smoke) => smoke.life > 0);
  }

  private showMessage(text: string): void {
    this.messageElement.textContent = text;
    this.messageElement.classList.remove("visible");
    void this.messageElement.offsetWidth;
    this.messageElement.classList.add("visible");
  }

  private allObjects(): WorldObject[] {
    return [
      ...this.projectiles.map((projectile) => projectile.object),
      ...this.enemyProjectiles.map((projectile) => projectile.object),
      ...this.explosions.map((explosion) => explosion.object),
      ...this.splashes.map((splash) => splash.object),
      ...this.smokeClouds.map((smoke) => smoke.object),
      ...this.worldObjects,
    ].slice(0, WORLD_OBJECT_CAPACITY);
  }

  private syncGpuObjects(alpha: number): void {
    const objects = this.allObjects().map((object) => {
      const previous = this.previousObjects.get(object.id);
      if (!previous) return object;

      return {
        ...object,
        position: this.lerpPosition(previous.position, object.position, alpha),
        yaw: this.lerpAngle(previous.yaw, object.yaw ?? 0, alpha),
      };
    });
    objects.sort((first, second) => this.objectChunk(first) - this.objectChunk(second));
    this.worldObjectCount = objects.length;
    const chunks = new Uint32Array(OBJECT_CHUNK_COUNT * 2);
    let objectIndex = 0;
    for (let chunk = 0; chunk < OBJECT_CHUNK_COUNT; chunk += 1) {
      const start = objectIndex;
      while (objectIndex < objects.length && this.objectChunk(objects[objectIndex]) === chunk) {
        objectIndex += 1;
      }
      chunks[chunk * 2] = start;
      chunks[chunk * 2 + 1] = objectIndex - start;
    }
    this.device.queue.writeBuffer(
      this.worldObjectBuffer,
      0,
      packWorldObjects(objects),
    );
    this.device.queue.writeBuffer(this.objectChunkBuffer, 0, chunks);
  }

  private objectChunk(object: WorldObject): number {
    const chunk = Math.floor((object.position[2] - this.worldOriginZ) / OBJECT_CHUNK_SIZE);
    return Math.max(0, Math.min(OBJECT_CHUNK_COUNT - 1, chunk));
  }

  private lerp(first: number, second: number, alpha: number): number {
    return first + (second - first) * alpha;
  }

  private lerpPosition(
    first: [number, number, number],
    second: [number, number, number],
    alpha: number,
  ): [number, number, number] {
    const dx = second[0] - first[0];
    const dy = second[1] - first[1];
    const dz = second[2] - first[2];
    if (dx * dx + dy * dy + dz * dz > 16) return [...second];

    return [
      this.lerp(first[0], second[0], alpha),
      this.lerp(first[1], second[1], alpha),
      this.lerp(first[2], second[2], alpha),
    ];
  }

  private lerpAngle(first: number, second: number, alpha: number): number {
    const delta = Math.atan2(Math.sin(second - first), Math.cos(second - first));
    return first + delta * alpha;
  }

  private updateFuel(dt: number): void {
    if (this.gameOver || this.respawnTimer > 0) {
      return;
    }

    this.fuel = Math.max(0, this.fuel - dt * FUEL_DRAIN_PER_SECOND);

    const refueling = this.worldObjects.some((object) => {
      if (object.type !== WorldObjectType.Fuel) {
        return false;
      }

      const dx = Math.abs(this.player.position[0] - object.position[0]);
      const dz = Math.abs(this.player.position[2] - object.position[2]);
      return dx < object.halfSize[0] + 0.65
        && dz < object.halfSize[2] + 0.8;
    });

    if (refueling) {
      this.fuel = Math.min(100, this.fuel + dt * FUEL_INTAKE_PER_SECOND);
    }
    this.audio.setRefueling(refueling);
    this.fuelElement.style.setProperty("--fuel-level", `${this.fuel}%`);

    if (this.fuel === 0) {
      this.crash();
    }

    this.fuelElement.ariaLabel = `Fuel ${Math.ceil(this.fuel)}`;
    this.fuelElement.classList.toggle("low", this.fuel < 25);
  }

  private updateCollisions(): void {
    if (this.gameOver || this.respawnTimer > 0) {
      return;
    }

    const river = this.worldGenerator.sampleRiver(this.player.position[2]);
    const playerX = this.player.position[0];
    const wingRadius = 0.49;
    const outsideRiver = Math.abs(playerX - river.center) + wingRadius
      > river.halfWidth;
    const hitsIsland = river.islandHalfWidth > 0
      && Math.abs(playerX - river.islandCenter)
        < river.islandHalfWidth + wingRadius;
    const hitsObstacle = this.worldObjects.some((object) => {
      const isBridge = object.type === WorldObjectType.Bridge
        || object.type === WorldObjectType.BridgeEdge;
      const dangerous = isBridge
        || object.type === WorldObjectType.Ship
        || object.type === WorldObjectType.Helicopter
        || object.type === WorldObjectType.AdvancedHelicopter
        || object.type === WorldObjectType.Tank
        || object.type === WorldObjectType.Rock
        || object.type === WorldObjectType.Fighter
        || object.type === WorldObjectType.Balloon;

      if (!dangerous) {
        return false;
      }

      return this.playerHitsObject(object);
    });

    if (outsideRiver || hitsIsland || hitsObstacle) {
      this.crash();
    }
  }

  private updateCheckpoint(): void {
    if (this.gameOver || this.respawnTimer > 0) {
      return;
    }

    let bridgeZ = this.checkpointBridgeZ;

    for (const object of this.worldObjects) {
      if (object.type !== WorldObjectType.BridgeEdge) {
        continue;
      }

      const destroyed = this.destroyedObjects.has(
        this.bridgeCenterId(object),
      );
      if (destroyed && object.position[2] < bridgeZ) {
        bridgeZ = object.position[2];
      }
    }

    if (bridgeZ === this.checkpointBridgeZ) {
      return;
    }

    this.checkpointBridgeZ = bridgeZ;
    this.bridgeNumber += 1;
    this.bridgeElement.textContent = `BRIDGE ${this.bridgeNumber}`;
    const z = bridgeZ;
    const river = this.worldGenerator.sampleRiver(z);
    const riverAhead = this.worldGenerator.sampleRiver(z - 2);
    const yaw = Math.atan2(riverAhead.center - river.center, 2);
    this.checkpoint = {
      position: [river.center, 0.72, z],
      yaw,
    };
  }

  private crash(): void {
    if (this.gameOver || this.respawnTimer > 0) {
      return;
    }

    this.spawnExplosion(this.player.position);
    this.lives -= 1;
    this.renderLives();

    if (this.lives === 0) {
      this.gameOver = true;
      this.gameOverCameraZ = this.player.position[2];
      this.cameraOrbitYaw = 0;
      this.cameraOrbitPitch = 0;
      const title = document.createElement("div");
      title.className = "game-over-title";
      title.textContent = "GAME OVER";
      const restart = document.createElement("div");
      restart.className = "game-over-restart";
      restart.textContent = "R / RESTART TO PLAY AGAIN";
      const content = document.createElement("div");
      content.append(title, restart);
      this.pauseElement.replaceChildren(content);
      this.pauseElement.classList.add("visible");
      return;
    }

    this.respawnTimer = 0.9;
    this.projectiles = [];
    this.enemyProjectiles = [];
  }

  private updateRespawn(dt: number): void {
    if (this.respawnTimer === 0) {
      return;
    }

    this.respawnTimer = Math.max(0, this.respawnTimer - dt);
    if (this.respawnTimer === 0) {
      this.resetPlayer();
    }
  }

  private resetPlayer(): void {
    for (const id of this.destroyedObjects) {
      const destroyedBridge = id.endsWith(":center")
        && id.startsWith("bridge:");
      if (!destroyedBridge) this.destroyedObjects.delete(id);
    }
    this.tankStates.clear();
    this.player.position = [...this.checkpoint.position];
    this.player.yaw = this.checkpoint.yaw;
    this.player.bank = 0;
    this.playerSpeed = 0;
    this.respawnTimer = 0;
    this.waitingForStart = true;
    this.pauseElement.textContent = "ARROWS / TAP TO START";
    this.pauseElement.classList.add("visible");
    this.fuel = 100;
    this.fuelElement.ariaLabel = "Fuel 100";
    this.fuelElement.style.setProperty("--fuel-level", "100%");
    this.fuelElement.classList.remove("low");
    this.projectiles = [];
    this.enemyProjectiles = [];
    this.enemyFireTimes.clear();
    this.explosions = [];
    this.splashes = [];
    this.smokeClouds = [];
    this.audio.silenceLoops();
    this.worldOriginZ = Number.NaN;
  }

  private resetGame(): void {
    this.lives = INITIAL_LIVES;
    this.gameOver = false;
    this.renderLives();
    this.score = 0;
    this.nextExtraLifeScore = EXTRA_LIFE_SCORE;
    this.scoreElement.textContent = "SCORE 0";
    this.bridgeNumber = 1;
    this.bridgeElement.textContent = "BRIDGE 1";
    this.checkpointBridgeZ = 0;
    this.checkpoint = {
      position: [0, 0.72, 0],
      yaw: 0,
    };
    this.destroyedObjects.clear();
    this.tankStates.clear();
    this.initialBridgePending = true;
    this.resetPlayer();
  }

  private resize(): void {
    const [maxWidth, maxHeight] = this.qualityMode === "low" ? [640, 360]
      : this.qualityMode === "medium" ? [960, 540] : [1600, 1200];
    const dpr = Math.min(1, maxWidth / Math.max(1, this.canvas.clientWidth), maxHeight / Math.max(1, this.canvas.clientHeight));
    const width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private readonly activeControls = new Map<string, string>();

  setControl(code: string, pressed: boolean, source = code): void {
    if (this.failed) return;
    if (!pressed) {
      this.activeControls.delete(source);
      if (![...this.activeControls.values()].includes(code)) this.keys.delete(code);
      return;
    }
    if (this.activeControls.has(source)) return;
    this.activeControls.set(source, code);
    this.keys.add(code);
    this.audio.unlock();
    if (this.waitingForStart) {
      this.waitingForStart = false;
      this.playerSpeed = 6;
      this.pauseElement.classList.remove("visible");
    }
    if (code === "KeyC") {
      this.cameraMode = (this.cameraMode + 1) % 2;
      this.cameraOrbitYaw = 0;
      this.cameraOrbitPitch = 0;
    }
    if (code === "F3") {
      this.debugVisible = !this.debugVisible;
      this.debugElement.classList.toggle("visible", this.debugVisible);
    }
    if (code === "KeyH" && !this.gameOver) this.togglePause();
    if (code === "KeyR" && this.gameOver) this.resetGame();
    if (code === "Space") this.fire();
  }

  setQuality(mode: "low" | "medium" | "high"): void {
    if (this.failed) return;
    this.qualityMode = mode;
    this.quality = mode === "low" ? 0 : mode === "medium" ? 0.5 : 1;
    this.frameTimeAverage = 1 / 30;
    this.resize();
  }

  setSoundEnabled(enabled: boolean): void {
    this.audio.setEnabled(enabled);
  }

  clearControls(): void {
    this.activeControls.clear();
    this.keys.clear();
  }

  private installInput(): void {
    const codes = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
      "Space", "KeyC", "KeyH", "KeyR", "KeyW", "KeyA", "KeyS", "KeyD", "F3"]);
    window.addEventListener("keydown", (event) => {
      if (!codes.has(event.code) || event.target instanceof HTMLButtonElement
        || event.target instanceof HTMLAnchorElement || event.ctrlKey || event.metaKey || event.altKey) return;
      event.preventDefault();
      this.setControl(event.code, true, `keyboard:${event.code}`);
    });
    window.addEventListener("keyup", (event) => {
      this.setControl(event.code, false, `keyboard:${event.code}`);
    });
    window.addEventListener("blur", () => this.clearControls());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.clearControls();
        if (!this.paused && !this.gameOver && !this.waitingForStart) this.togglePause();
      }
    });
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.pauseElement.textContent = "PAUSED";
    this.pauseElement.classList.toggle("visible", this.paused);

    if (this.paused) {
      this.audio.silenceLoops();
      if (this.animationFrameId !== null) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      return;
    }

    this.resumeRendering();
  }

  private updateCamera(dt: number): void {
    if (this.gameOver) {
      this.updateGameOverCamera(dt);
      return;
    }

    this.updatePlayer(dt);

    if (this.cameraMode === 0) {
      this.updateOrbitCamera(dt);
      return;
    }

    this.camera.position = [
      this.player.position[0],
      12,
      this.player.position[2] - 7,
    ];
    this.camera.yaw = 0;
    this.camera.pitch = -Math.PI * 0.5;
  }

  private updateGameOverCamera(dt: number): void {
    this.gameOverCameraZ -= dt * 4;
    if (this.gameOverCameraZ <= this.worldGenerator.endZ) {
      this.gameOverCameraZ = 0;
    }

    const center = this.gameOverPathX(this.gameOverCameraZ);
    const aheadZ = this.gameOverCameraZ - 16;
    const aheadCenter = this.gameOverPathX(aheadZ);
    this.camera.position = [center, 3.5, this.gameOverCameraZ + 5.5];
    const lookX = aheadCenter - this.camera.position[0];
    const lookY = 0.45 - this.camera.position[1];
    const lookZ = aheadZ - this.camera.position[2];
    this.camera.yaw = Math.atan2(lookX, -lookZ);
    this.camera.pitch = Math.atan2(lookY, Math.hypot(lookX, lookZ));
  }

  private gameOverPathX(z: number): number {
    const spacing = 96;
    const distance = Math.max(0, -z);
    const segment = Math.floor(distance / spacing);
    const t = (distance - segment * spacing) / spacing;
    const centerAt = (index: number): number => (
      this.worldGenerator.sampleRiver(-Math.max(0, index) * spacing).center
    );
    const p0 = centerAt(segment - 1);
    const p1 = centerAt(segment);
    const p2 = centerAt(segment + 1);
    const p3 = centerAt(segment + 2);
    const t2 = t * t;
    const t3 = t2 * t;
    return 0.5 * (
      2 * p1
      + (-p0 + p2) * t
      + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
      + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
    );
  }

  private updatePlayer(dt: number): void {
    if (!this.gameOver && this.respawnTimer === 0 && !this.waitingForStart) {
      const turn = Number(this.keys.has("ArrowRight"))
        - Number(this.keys.has("ArrowLeft"));
      this.playerSpeed = this.keys.has("ArrowUp")
        ? PLAYER_MAX_SPEED
        : this.keys.has("ArrowDown") ? 3 : 6;
      const targetYaw = turn * 0.28;
      this.player.yaw += (targetYaw - this.player.yaw)
        * Math.min(1, dt * 12);
      const targetBank = -turn * 0.9;
      this.player.bank += (targetBank - this.player.bank)
        * Math.min(1, dt * 7);
      this.player.position[0] += turn * 4 * dt;
      this.player.position[2] -= this.playerSpeed * dt;
    }

  }

  private updateOrbitCamera(dt: number): void {
    const horizontalInput = Number(this.keys.has("KeyD"))
      - Number(this.keys.has("KeyA"));
    const verticalInput = Number(this.keys.has("KeyW"))
      - Number(this.keys.has("KeyS"));
    const targetOrbitYaw = horizontalInput * 0.7;
    const targetOrbitPitch = verticalInput >= 0
      ? verticalInput * 0.42
      : verticalInput * 0.24;
    const orbitFollow = Math.min(1, dt * 5.5);
    this.cameraOrbitYaw += (targetOrbitYaw - this.cameraOrbitYaw) * orbitFollow;
    this.cameraOrbitPitch += (targetOrbitPitch - this.cameraOrbitPitch) * orbitFollow;

    const targetYaw = this.cameraOrbitYaw;
    const radius = 5.15;
    const elevation = 0.51 + this.cameraOrbitPitch;
    const horizontalRadius = Math.cos(elevation) * radius;
    const targetX = this.player.position[0] - Math.sin(targetYaw) * horizontalRadius;
    const targetY = this.player.position[1] + Math.sin(elevation) * radius;
    const targetZ = this.player.position[2] + Math.cos(targetYaw) * horizontalRadius;
    this.camera.position[0] = targetX;
    this.camera.position[1] = targetY;
    this.camera.position[2] = targetZ;

    const lookX = this.player.position[0] - this.camera.position[0];
    const lookY = this.player.position[1] + 1.2 - this.camera.position[1];
    const lookZ = this.player.position[2] - this.camera.position[2];
    this.camera.yaw = Math.atan2(lookX, -lookZ);
    this.camera.pitch = Math.atan2(lookY, Math.hypot(lookX, lookZ));
  }

  private updateAdaptiveQuality(dt: number): void {
    this.frameTimeAverage += (dt - this.frameTimeAverage) * 0.06;
    if (this.frameTimeAverage > 1 / 27) {
      this.quality = Math.max(0, this.quality - dt * 0.45);
    } else if (this.frameTimeAverage < 1 / 29) {
      const ceiling = this.qualityMode === "low" ? 0 : this.qualityMode === "medium" ? 0.5 : 1;
      this.quality = Math.min(ceiling, this.quality + dt * 0.12);
    }

    if (!this.debugVisible) return;
    this.debugUpdateTimer -= dt;
    if (this.debugUpdateTimer > 0) return;
    this.debugUpdateTimer = 0.25;
    const fps = Math.round(1 / Math.max(this.frameTimeAverage, 0.001));
    this.debugElement.textContent = [
      `FPS ${fps}`,
      `QUALITY ${Math.round(this.quality * 100)}%`,
      `OBJECTS ${this.worldObjectCount}/${WORLD_OBJECT_CAPACITY}`,
      `SEED ${this.worldGenerator.seed}`,
      `RIVER ${this.worldGenerator.straightRiver ? "STRAIGHT" : "CURVED"}`,
      `X ${this.player.position[0].toFixed(1)} Z ${this.player.position[2].toFixed(1)}`,
      `CAM ${this.cameraMode === 0 ? "3D" : "TOP"}`,
    ].join("\n");
  }
}
