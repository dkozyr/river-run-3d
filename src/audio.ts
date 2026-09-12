export class ProceduralAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineOscillator: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private refuelOscillator: OscillatorNode | null = null;
  private refuelGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private enabled = false;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) this.unlock();
    if (this.context && this.master) {
      this.master.gain.setValueAtTime(enabled ? 0.55 : 0, this.context.currentTime);
    }
  }

  unlock(): void {
    if (!this.enabled) return;
    if (!this.context) {
      this.initialize();
    }

    void this.context?.resume();
  }

  setEngine(speed: number, active: boolean): void {
    if (!this.context || !this.engineOscillator || !this.engineGain) return;
    const now = this.context.currentTime;
    this.engineOscillator.frequency.setTargetAtTime(62 + speed * 7.5, now, 0.08);
    this.engineGain.gain.setTargetAtTime(active ? 0.055 : 0.0001, now, 0.06);
  }

  setRefueling(active: boolean): void {
    if (!this.context || !this.refuelGain) return;
    this.refuelGain.gain.setTargetAtTime(active ? 0.026 : 0.0001, this.context.currentTime, 0.04);
  }

  silenceLoops(): void {
    this.setEngine(0, false);
    this.setRefueling(false);
  }

  shoot(): void {
    if (!this.enabled) return;
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = "sawtooth";
    oscillator.frequency.setValueAtTime(920, now);
    oscillator.frequency.exponentialRampToValueAtTime(170, now + 0.11);
    gain.gain.setValueAtTime(0.11, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.14);
  }

  explosion(scale = 1): void {
    if (!this.enabled) return;
    if (!this.context || !this.master || !this.noiseBuffer) return;
    const now = this.context.currentTime;
    const noise = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const thump = this.context.createOscillator();
    const thumpGain = this.context.createGain();
    noise.buffer = this.noiseBuffer;
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1100, now);
    filter.frequency.exponentialRampToValueAtTime(180, now + 0.42);
    gain.gain.setValueAtTime(Math.min(0.24, 0.11 * scale), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.46);
    thump.type = "sine";
    thump.frequency.setValueAtTime(78, now);
    thump.frequency.exponentialRampToValueAtTime(34, now + 0.28);
    thumpGain.gain.setValueAtTime(Math.min(0.18, 0.08 * scale), now);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    noise.connect(filter).connect(gain).connect(this.master);
    thump.connect(thumpGain).connect(this.master);
    noise.start(now);
    noise.stop(now + 0.48);
    thump.start(now);
    thump.stop(now + 0.32);
  }

  splash(): void {
    if (!this.enabled) return;
    if (!this.context || !this.master || !this.noiseBuffer) return;
    const now = this.context.currentTime;
    const noise = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    noise.buffer = this.noiseBuffer;
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(1700, now);
    filter.Q.value = 0.7;
    gain.gain.setValueAtTime(0.07, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
    noise.connect(filter).connect(gain).connect(this.master);
    noise.start(now);
    noise.stop(now + 0.25);
  }

  extraLife(): void {
    if (!this.enabled) return;
    if (!this.context) return;
    const now = this.context.currentTime;
    [440, 554, 659, 880].forEach((frequency, index) => {
      this.tone(frequency, now + index * 0.09, 0.16, 0.065);
    });
  }

  private initialize(): void {
    this.context = new AudioContext();
    this.master = this.context.createGain();
    const compressor = this.context.createDynamicsCompressor();
    this.master.gain.value = this.enabled ? 0.55 : 0;
    this.master.connect(compressor).connect(this.context.destination);
    this.noiseBuffer = this.createNoiseBuffer();

    this.engineOscillator = this.context.createOscillator();
    this.engineGain = this.context.createGain();
    const engineFilter = this.context.createBiquadFilter();
    this.engineOscillator.type = "sawtooth";
    this.engineOscillator.frequency.value = 100;
    this.engineGain.gain.value = 0.0001;
    engineFilter.type = "lowpass";
    engineFilter.frequency.value = 520;
    this.engineOscillator.connect(engineFilter).connect(this.engineGain).connect(this.master);
    this.engineOscillator.start();

    this.refuelOscillator = this.context.createOscillator();
    this.refuelGain = this.context.createGain();
    this.refuelOscillator.type = "square";
    this.refuelOscillator.frequency.value = 128;
    this.refuelGain.gain.value = 0.0001;
    this.refuelOscillator.connect(this.refuelGain).connect(this.master);
    this.refuelOscillator.start();
  }

  private createNoiseBuffer(): AudioBuffer {
    const context = this.context!;
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) {
      data[index] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  private tone(frequency: number, start: number, duration: number, volume: number): void {
    if (!this.context || !this.master) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = "square";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(volume, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(start);
    oscillator.stop(start + duration);
  }
}
