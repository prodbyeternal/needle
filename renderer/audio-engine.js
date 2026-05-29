/**
 * NEEDLE — WEB AUDIO ENGINE
 * Manages the Web Audio API context, audio source nodes, dual-buffers for reverse play,
 * playhead tracking under variable speed/direction, stroboscopic analysis, and procedural crackle.
 */

export class AudioEngine {
  constructor() {
    this.ctx = null;
    
    // Core Playback State
    this.originalBuffer = null;
    this.reversedBuffer = null;
    
    this.source = null;
    this.gainNode = null;
    this.inputGain = null;
    this.lowShelf = null;
    this.midPeaking = null;
    this.highShelf = null;
    this.delayNode = null;
    this.delayFeedback = null;
    this.delayWet = null;
    this.reverbNode = null;
    this.reverbWet = null;
    this.chorusDelay = null;
    this.chorusLfo = null;
    this.chorusLfoGain = null;
    this.chorusWet = null;
    this.analyser = null;
    
    this.isPlaying = false;
    this.isMuted = false;
    this.isTapeStopping = false;
    this.isScratching = false;
    
    this.duration = 0;
    this.currentTime = 0;       // Current playhead position in seconds (0 to duration)
    this.playbackDirection = 1;  // 1 = Forward, -1 = Reverse
    
    // Time tracking variables for manual playhead math
    this.timePlayStarted = 0;    // ctx.currentTime when play was clicked
    this.startOffset = 0;        // currentTime offset when play was clicked
    this.speedMultiplier = 1.0;  // Current composite speed multiplier (motor speed * pitch slider)

    // Procedural Vinyl Surface Noise
    this.crackleSource = null;
    this.crackleGain = null;
    this.crackleLevel = 0.15;    // 0 to 1
    this.fx = {
      low: 0,
      mid: 0,
      high: 0,
      reverb: 0,
      chorus: 0,
      delay: 0
    };

    // Loop & A-B Repeat state variables
    this.isLoopActive = false;
    this.isABRepeatActive = false;
    this.repeatA = null; // Percentage (0.0 - 1.0)
    this.repeatB = null; // Percentage (0.0 - 1.0)

    // Analytics
    this.analyserData = null;
    this.bpm = 0;
    this.bpmConfidence = 0;
    this.key = null;
    this.keyConfidence = 0;
    this.scratchPlaybackDirection = 1;
  }

  init() {
    if (this.ctx) return;
    
    // Create AudioContext (resumes automatically on user click in Electron)
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioContextClass();
    
    // Master Gain and FX chain
    this.inputGain = this.ctx.createGain();
    this.gainNode = this.ctx.createGain();
    this.gainNode.gain.value = 1.0;

    this.lowShelf = this.ctx.createBiquadFilter();
    this.lowShelf.type = 'lowshelf';
    this.lowShelf.frequency.value = 180;

    this.midPeaking = this.ctx.createBiquadFilter();
    this.midPeaking.type = 'peaking';
    this.midPeaking.frequency.value = 1000;
    this.midPeaking.Q.value = 0.9;

    this.highShelf = this.ctx.createBiquadFilter();
    this.highShelf.type = 'highshelf';
    this.highShelf.frequency.value = 4200;

    this.delayNode = this.ctx.createDelay(1.2);
    this.delayNode.delayTime.value = 0.28;
    this.delayFeedback = this.ctx.createGain();
    this.delayFeedback.gain.value = 0.28;
    this.delayWet = this.ctx.createGain();
    this.delayWet.gain.value = 0;

    this.reverbNode = this.ctx.createConvolver();
    this.reverbNode.buffer = this.createReverbImpulse();
    this.reverbWet = this.ctx.createGain();
    this.reverbWet.gain.value = 0;

    this.chorusDelay = this.ctx.createDelay(0.05);
    this.chorusDelay.delayTime.value = 0.018;
    this.chorusWet = this.ctx.createGain();
    this.chorusWet.gain.value = 0;
    this.chorusLfo = this.ctx.createOscillator();
    this.chorusLfo.frequency.value = 0.85;
    this.chorusLfoGain = this.ctx.createGain();
    this.chorusLfoGain.gain.value = 0.004;
    
    // Analyser Node
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyserData = new Uint8Array(this.analyser.frequencyBinCount);
    
    // Connections
    this.inputGain.connect(this.lowShelf);
    this.lowShelf.connect(this.midPeaking);
    this.midPeaking.connect(this.highShelf);
    this.highShelf.connect(this.gainNode);
    this.highShelf.connect(this.delayNode);
    this.delayNode.connect(this.delayFeedback);
    this.delayFeedback.connect(this.delayNode);
    this.delayNode.connect(this.delayWet);
    this.delayWet.connect(this.gainNode);
    this.highShelf.connect(this.reverbNode);
    this.reverbNode.connect(this.reverbWet);
    this.reverbWet.connect(this.gainNode);
    this.highShelf.connect(this.chorusDelay);
    this.chorusDelay.connect(this.chorusWet);
    this.chorusWet.connect(this.gainNode);
    this.chorusLfo.connect(this.chorusLfoGain);
    this.chorusLfoGain.connect(this.chorusDelay.delayTime);
    this.chorusLfo.start();
    this.gainNode.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    
    // Start loop-buffered crackle synthesis
    this.setupProceduralCrackle();

    // Apply loaded/restored FX values to nodes
    this.setEQBand('low', this.fx.low);
    this.setEQBand('mid', this.fx.mid);
    this.setEQBand('high', this.fx.high);
    this.setEffectAmount('reverb', this.fx.reverb);
    this.setEffectAmount('chorus', this.fx.chorus);
    this.setEffectAmount('delay', this.fx.delay);
  }

  /**
   * Decodes dropped audio file array buffer and builds forward & reverse buffers
   */
  async loadFile(arrayBuffer) {
    this.init();
    
    // Safe stop before loading new files
    this.stop();
    
    // Decode audio data
    const decodedBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    
    this.originalBuffer = decodedBuffer;
    this.duration = decodedBuffer.duration;
    this.currentTime = 0;
    this.startOffset = 0;
    this.playbackDirection = 1;
    
    // Build reversed buffer for seamless backward playback
    this.reversedBuffer = this.ctx.createBuffer(
      decodedBuffer.numberOfChannels,
      decodedBuffer.length,
      decodedBuffer.sampleRate
    );
    
    for (let channel = 0; channel < decodedBuffer.numberOfChannels; channel++) {
      const channelData = decodedBuffer.getChannelData(channel);
      const revChannelData = this.reversedBuffer.getChannelData(channel);
      
      // Copy and reverse floating array
      revChannelData.set(channelData);
      revChannelData.reverse();
    }
    
    const tempo = this.estimateBPM(decodedBuffer);
    this.bpm = tempo.bpm;
    this.bpmConfidence = tempo.confidence;
    const keyInfo = this.estimateKey(decodedBuffer);
    this.key = keyInfo.key;
    this.keyConfidence = keyInfo.confidence;
    
    return {
      duration: this.duration,
      bpm: this.bpm,
      bpmConfidence: this.bpmConfidence,
      key: this.key,
      keyConfidence: this.keyConfidence,
      channels: decodedBuffer.numberOfChannels,
      sampleRate: decodedBuffer.sampleRate
    };
  }

  async analyzeFile(arrayBuffer) {
    this.init();
    const decodedBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    const tempo = this.estimateBPM(decodedBuffer);
    const keyInfo = this.estimateKey(decodedBuffer);

    return {
      duration: decodedBuffer.duration,
      bpm: tempo.bpm,
      bpmConfidence: tempo.confidence,
      key: keyInfo.key,
      keyConfidence: keyInfo.confidence,
      channels: decodedBuffer.numberOfChannels,
      sampleRate: decodedBuffer.sampleRate
    };
  }

  /**
   * Sets up highly optimized procedural static vinyl noise
   */
  setupProceduralCrackle() {
    this.crackleGain = this.ctx.createGain();
    this.crackleGain.gain.value = 0; // Start muted
    this.crackleGain.connect(this.gainNode);
    
    // Synthesize a looped 3-second custom crackle buffer containing white noise + low rumble + dust clicks
    const sampleRate = this.ctx.sampleRate;
    const bufferSize = sampleRate * 3.0; // 3 seconds
    const crackleBuffer = this.ctx.createBuffer(1, bufferSize, sampleRate);
    const data = crackleBuffer.getChannelData(0);
    
    let lastNoise = 0;
    for (let i = 0; i < bufferSize; i++) {
      // 1. Low frequency rumble (Low-pass filtered white noise)
      const white = Math.random() * 2 - 1;
      const lowRumble = lastNoise + 0.08 * (white - lastNoise);
      lastNoise = lowRumble;
      
      // 2. High-frequency click impulse spikes (dust/scratches)
      let dustClick = 0;
      if (Math.random() < 0.00015) { // Occasional random spikes
        // Generate a sharp snap
        const decaySamples = Math.floor(sampleRate * 0.003); // 3ms snap
        for (let j = 0; j < decaySamples && (i + j) < bufferSize; j++) {
          const envelope = Math.exp(-j / (decaySamples * 0.2));
          data[i + j] += (Math.random() * 2 - 1) * 0.65 * envelope;
        }
      }
      
      // Merge low rumble (soft background static) and tiny clicks
      data[i] += lowRumble * 0.02;
    }
    
    // Create looped source
    this.crackleSource = this.ctx.createBufferSource();
    this.crackleSource.buffer = crackleBuffer;
    this.crackleSource.loop = true;
    this.crackleSource.connect(this.crackleGain);
    this.crackleSource.start(0);

    // Sync volume to current state
    this.updateCrackleVolume();
  }

  /**
   * Set Vinyl static crackle volume (0 to 100)
   */
  setCrackleLevel(percent) {
    this.crackleLevel = percent / 100;
    this.updateCrackleVolume();
  }

  /**
   * Updates the crackle volume based on playback and scratching states
   */
  updateCrackleVolume() {
    if (!this.crackleGain) return;
    
    // Crackle should only play if the turntable is active (playing or scratching) and not muted
    const shouldPlay = (this.isPlaying || this.isScratching) && !this.isMuted;
    const targetVolume = shouldPlay ? (this.crackleLevel * 0.25) : 0;
    
    if (this.ctx) {
      this.crackleGain.gain.setTargetAtTime(targetVolume, this.ctx.currentTime, 0.05);
    } else {
      this.crackleGain.gain.value = targetVolume;
    }
  }

  createReverbImpulse() {
    const sampleRate = this.ctx.sampleRate;
    const length = sampleRate * 1.8;
    const impulse = this.ctx.createBuffer(2, length, sampleRate);

    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const decay = Math.pow(1 - i / length, 2.6);
        data[i] = (Math.random() * 2 - 1) * decay * 0.45;
      }
    }

    return impulse;
  }

  setEQBand(band, db) {
    this.fx[band] = db;
    const nodeMap = {
      low: this.lowShelf,
      mid: this.midPeaking,
      high: this.highShelf
    };
    const node = nodeMap[band];
    if (node) {
      node.gain.setTargetAtTime(db, this.ctx.currentTime, 0.03);
    }
  }

  setEffectAmount(effect, percent) {
    const amount = Math.max(0, Math.min(100, percent)) / 100;
    this.fx[effect] = percent;

    if (effect === 'reverb' && this.reverbWet) {
      this.reverbWet.gain.setTargetAtTime(amount * 0.55, this.ctx.currentTime, 0.05);
    } else if (effect === 'delay' && this.delayWet) {
      this.delayWet.gain.setTargetAtTime(amount * 0.55, this.ctx.currentTime, 0.05);
      this.delayFeedback.gain.setTargetAtTime(0.18 + amount * 0.42, this.ctx.currentTime, 0.05);
    } else if (effect === 'chorus' && this.chorusWet) {
      this.chorusWet.gain.setTargetAtTime(amount * 0.48, this.ctx.currentTime, 0.05);
      this.chorusLfoGain.gain.setTargetAtTime(0.001 + amount * 0.009, this.ctx.currentTime, 0.05);
    }
  }

  resetEffects() {
    this.setEQBand('low', 0);
    this.setEQBand('mid', 0);
    this.setEQBand('high', 0);
    this.setEffectAmount('reverb', 0);
    this.setEffectAmount('chorus', 0);
    this.setEffectAmount('delay', 0);
  }

  /**
   * Play from current offset
   */
  play(speedMultiplier = 1.0) {
    if (!this.originalBuffer || this.isPlaying) return;
    
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    
    this.speedMultiplier = speedMultiplier;
    this.isPlaying = true;
    this.timePlayStarted = this.ctx.currentTime;
    
    // Choose appropriate buffer based on direction
    const activeBuffer = this.playbackDirection === 1 ? this.originalBuffer : this.reversedBuffer;
    
    // Math to compute correct starting offset in the buffer
    // For reversed buffers, we map: startOffsetReversed = duration - startOffsetForward
    let offset = this.playbackDirection === 1 ? this.currentTime : (this.duration - this.currentTime);
    
    // Prevent starting out of boundaries
    if (offset < 0) offset = 0;
    if (offset >= this.duration) {
      // Reached end, loop or stop
      this.isPlaying = false;
      this.currentTime = this.playbackDirection === 1 ? 0 : this.duration;
      return;
    }

    this.source = this.ctx.createBufferSource();
    this.source.buffer = activeBuffer;
    
    // Map speed/pitch
    this.source.playbackRate.setValueAtTime(this.speedMultiplier, this.ctx.currentTime);
    
    this.source.connect(this.inputGain);
    
    // Handle automatic source ending
    this.source.onended = () => {
      // If was playing and ended naturally (not stopped manually)
      if (this.isPlaying) {
        this.isPlaying = false;
        this.currentTime = this.playbackDirection === 1 ? this.duration : 0;
        this.updateCrackleVolume();
        // Broadcast natural EOF to app
        if (this.onEndedCallback) this.onEndedCallback();
      }
    };
    
    // Start buffer playback at calculated offset
    this.source.start(0, offset);
    this.startOffset = this.currentTime;

    // Enable crackle during playback
    this.updateCrackleVolume();
  }

  /**
   * Pauses the active source and locks current playhead time
   */
  pause() {
    if (!this.isPlaying) return;
    
    this.updatePlayhead();
    this.isPlaying = false;
    
    if (this.source) {
      this.source.onended = null; // Clear trigger
      try {
        this.source.stop();
      } catch (e) {}
      this.source = null;
    }

    // Mute crackle when paused
    this.updateCrackleVolume();
  }

  /**
   * Tape Stop Effect: gradually ramps playback rate to 0, simulating
   * a turntable motor losing power. Pitch drops smoothly over ~800ms.
   */
  tapeStop(durationMs = 800) {
    if (!this.isPlaying || !this.source) {
      this.pause();
      return;
    }

    this.isTapeStopping = true;

    const startTime = this.ctx.currentTime;
    const endTime = startTime + (durationMs / 1000);
    const currentRate = this.speedMultiplier;

    // Exponential ramp down to near-zero (can't ramp to exactly 0)
    this.source.playbackRate.cancelScheduledValues(startTime);
    this.source.playbackRate.setValueAtTime(currentRate, startTime);
    this.source.playbackRate.linearRampToValueAtTime(0.01, endTime);

    // After the ramp completes, fully stop
    this._tapeStopTimer = setTimeout(() => {
      this.updatePlayhead();
      this.isPlaying = false;
      this.isTapeStopping = false;
      this.updateCrackleVolume();
      
      if (this.source) {
        this.source.onended = null;
        try { this.source.stop(); } catch (e) {}
        this.source = null;
      }
      
      // Notify app controller the tape stop completed
      if (this.onTapeStopComplete) this.onTapeStopComplete();
    }, durationMs + 50);
  }

  /**
   * Cancel any in-progress tape stop (e.g. if user hits play again quickly)
   */
  cancelTapeStop() {
    if (this._tapeStopTimer) {
      clearTimeout(this._tapeStopTimer);
      this._tapeStopTimer = null;
    }
    this.isTapeStopping = false;
  }

  registerTapeStopCallback(callback) {
    this.onTapeStopComplete = callback;
  }

  /**
   * Completely stops motor, mutes, and resets tonearm offset
   */
  stop() {
    this.pause();
    this.currentTime = 0;
    this.startOffset = 0;
  }

  /**
   * Dynamically seek playhead position
   */
  seek(seconds) {
    if (seconds < 0) seconds = 0;
    if (seconds > this.duration) seconds = this.duration;
    
    const wasPlaying = this.isPlaying;
    const prevSpeed = this.speedMultiplier;
    
    if (wasPlaying) {
      this.pause();
    }
    
    this.currentTime = seconds;
    this.startOffset = seconds;
    
    if (wasPlaying) {
      this.play(prevSpeed);
    }
  }

  /**
   * Swaps buffer direction (Forward <-> Reverse)
   */
  setDirection(direction) {
    if (this.playbackDirection === direction) return;
    
    const wasPlaying = this.isPlaying;
    const prevSpeed = this.speedMultiplier;
    
    if (wasPlaying) {
      this.pause();
    }
    
    this.playbackDirection = direction;
    
    if (wasPlaying) {
      this.play(prevSpeed);
    }
  }

  /**
   * Adjusts the speed/pitch factor of the active buffer in real time
   */
  setSpeedMultiplier(factor) {
    if (this.isTapeStopping) return; // Do not override active tape stop param ramp
    
    this.speedMultiplier = Math.max(0.01, factor); // Prevent negative or zero pitch crashes
    
    if (this.isPlaying && this.source) {
      // Smooth linear transition of speed to avoid digital popping
      this.source.playbackRate.setTargetAtTime(this.speedMultiplier, this.ctx.currentTime, 0.05);
      
      // Re-anchor playhead tracking to avoid compounding errors
      this.updatePlayhead();
      this.timePlayStarted = this.ctx.currentTime;
      this.startOffset = this.currentTime;
    }
  }

  /**
   * High-fidelity real-time scratch audio generator
   */
  scratchTo(speedFactor) {
    if (!this.originalBuffer) return;
    this.init();

    this.isPlaying = false; // We are in manual scratching mode
    if (!this.isScratching) {
      this.isScratching = true;
      this.updateCrackleVolume();
    }
    const targetDirection = speedFactor >= 0 ? 1 : -1;
    
    // Scale scratching volumes: make slow scratches quieter, simulating mechanical cartridge drag!
    const absSpeed = Math.max(0.01, Math.min(5.0, Math.abs(speedFactor)));
    const targetVolume = Math.min(1.0, absSpeed * 1.6); 
    
    if (this.gainNode) {
      // Quick smooth gain changes for scratching organic dynamics
      this.gainNode.gain.setValueAtTime(this.isMuted ? 0 : targetVolume, this.ctx.currentTime);
    }

    // If speed is zero, temporarily shut off source to prevent audio buzzing
    if (absSpeed < 0.05) {
      if (this.source) {
        try { this.source.stop(); } catch(e){}
        this.source = null;
      }
      return;
    }

    // If direction flipped OR source doesn't exist, start a new source!
    if (!this.source || this.scratchPlaybackDirection !== targetDirection) {
      if (this.source) {
        try { this.source.stop(); } catch(e){}
      }
      
      this.scratchPlaybackDirection = targetDirection;
      const activeBuffer = targetDirection === 1 ? this.originalBuffer : this.reversedBuffer;
      let offset = targetDirection === 1 ? this.currentTime : (this.duration - this.currentTime);

      if (offset < 0) offset = 0;
      if (offset >= this.duration) offset = this.duration - 0.01;

      this.source = this.ctx.createBufferSource();
      this.source.buffer = activeBuffer;
      this.source.connect(this.inputGain);
      this.source.start(0, offset);
    }

    // Update playback rate dynamically
    if (this.source) {
      this.source.playbackRate.setValueAtTime(absSpeed, this.ctx.currentTime);
    }
  }

  /**
   * Terminate active scratching session, reset volume
   */
  endScratch() {
    if (this.source) {
      try { this.source.stop(); } catch(e){}
      this.source = null;
    }
    if (this.gainNode) {
      this.gainNode.gain.setValueAtTime(this.isMuted ? 0 : 1.0, this.ctx.currentTime);
    }
    this.scratchPlaybackDirection = this.playbackDirection;
    this.isScratching = false;
    this.updateCrackleVolume();
  }

  restartSourceAt(seconds) {
    if (!this.isPlaying || !this.originalBuffer) return;
    
    // Stop current source cleanly
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch (e) {}
      this.source = null;
    }
    
    this.timePlayStarted = this.ctx.currentTime;
    
    const activeBuffer = this.playbackDirection === 1 ? this.originalBuffer : this.reversedBuffer;
    let offset = this.playbackDirection === 1 ? seconds : (this.duration - seconds);
    
    if (offset < 0) offset = 0;
    if (offset >= this.duration) offset = this.duration - 0.01;
    
    this.source = this.ctx.createBufferSource();
    this.source.buffer = activeBuffer;
    this.source.playbackRate.setValueAtTime(this.speedMultiplier, this.ctx.currentTime);
    this.source.connect(this.inputGain);
    
    this.source.onended = () => {
      if (this.isPlaying) {
        if (this.isABRepeatActive && this.repeatA !== null && this.repeatB !== null) {
          this.currentTime = this.playbackDirection === 1 ? this.repeatA * this.duration : this.repeatB * this.duration;
          this.restartSourceAt(this.currentTime);
        } else if (this.isLoopActive) {
          this.currentTime = this.playbackDirection === 1 ? 0 : this.duration;
          this.restartSourceAt(this.currentTime);
        } else {
          this.isPlaying = false;
          this.currentTime = this.playbackDirection === 1 ? this.duration : 0;
          this.updateCrackleVolume();
          if (this.onEndedCallback) this.onEndedCallback();
        }
      }
    };
    
    this.source.start(0, offset);
    this.startOffset = seconds;
  }

  /**
   * Computes exact elapsed time on the track based on time-delays and speed rate
   */
  updatePlayhead() {
    if (!this.isPlaying) return this.currentTime;
    
    const elapsedRealTime = this.ctx.currentTime - this.timePlayStarted;
    const elapsedVirtualTime = elapsedRealTime * this.speedMultiplier;
    
    // Add or subtract depending on direct direction
    if (this.playbackDirection === 1) {
      this.currentTime = this.startOffset + elapsedVirtualTime;
    } else {
      this.currentTime = this.startOffset - elapsedVirtualTime;
    }

    // Check repeat loops
    if (this.isABRepeatActive && this.repeatA !== null && this.repeatB !== null) {
      const limitA = this.repeatA * this.duration;
      const limitB = this.repeatB * this.duration;
      if (this.playbackDirection === 1) {
        if (this.currentTime >= limitB) {
          this.currentTime = limitA;
          this.restartSourceAt(limitA);
        }
      } else {
        if (this.currentTime <= limitA) {
          this.currentTime = limitB;
          this.restartSourceAt(limitB);
        }
      }
    } else if (this.isLoopActive) {
      if (this.playbackDirection === 1) {
        if (this.currentTime >= this.duration) {
          this.currentTime = 0;
          this.restartSourceAt(0);
        }
      } else {
        if (this.currentTime <= 0) {
          this.currentTime = this.duration;
          this.restartSourceAt(this.duration);
        }
      }
    } else {
      // Normal clamp
      if (this.playbackDirection === 1) {
        if (this.currentTime >= this.duration) {
          this.currentTime = this.duration;
        }
      } else {
        if (this.currentTime <= 0) {
          this.currentTime = 0;
        }
      }
    }
    
    return this.currentTime;
  }

  setMute(mute) {
    this.isMuted = mute;
    if (this.gainNode) {
      this.gainNode.gain.setValueAtTime(mute ? 0 : 1.0, this.ctx.currentTime);
    }
    this.updateCrackleVolume();
  }

  /**
   * Get FFT wave analysis data for ambient light pulsing and circular visualizer rings
   */
  getAnalyserData() {
    if (this.analyser && this.isPlaying) {
      this.analyser.getByteFrequencyData(this.analyserData);
      return this.analyserData;
    }
    return new Uint8Array(128).fill(0);
  }

  registerEndedCallback(callback) {
    this.onEndedCallback = callback;
  }

  /**
   * Local BPM estimator using an onset envelope and autocorrelation.
   * Returns 0 when confidence is too low instead of inventing a tempo.
   */
  estimateBPM(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const targetRate = 200;
    const hopSize = Math.max(1, Math.floor(sampleRate / targetRate));
    const startSample = Math.floor(Math.min(8, audioBuffer.duration * 0.08) * sampleRate);
    const endSample = Math.min(audioBuffer.length, startSample + Math.floor(Math.min(120, audioBuffer.duration) * sampleRate));
    const frameCount = Math.floor((endSample - startSample) / hopSize);

    if (frameCount < targetRate * 8) {
      return { bpm: 0, confidence: 0 };
    }

    const channels = Math.min(audioBuffer.numberOfChannels, 2);
    const channelData = Array.from({ length: channels }, (_unused, channel) => audioBuffer.getChannelData(channel));
    const envelope = new Float32Array(frameCount);

    for (let frame = 0; frame < frameCount; frame++) {
      const offset = startSample + frame * hopSize;
      let sum = 0;
      for (let i = 0; i < hopSize; i++) {
        let sample = 0;
        for (let channel = 0; channel < channels; channel++) {
          sample += channelData[channel][offset + i] || 0;
        }
        sample /= channels;
        sum += sample * sample;
      }
      envelope[frame] = Math.sqrt(sum / hopSize);
    }

    const onset = new Float32Array(frameCount);
    let onsetMean = 0;
    for (let i = 1; i < frameCount; i++) {
      const diff = envelope[i] - envelope[i - 1];
      const value = diff > 0 ? diff : 0;
      onset[i] = value;
      onsetMean += value;
    }
    onsetMean /= frameCount;

    let variance = 0;
    for (let i = 0; i < frameCount; i++) {
      onset[i] = Math.max(0, onset[i] - onsetMean);
      variance += onset[i] * onset[i];
    }

    if (variance <= 0.000001) {
      return { bpm: 0, confidence: 0 };
    }

    const minBpm = 60;
    const maxBpm = 200;
    const scores = [];
    let scoreTotal = 0;
    let best = { bpm: 0, score: 0 };

    for (let bpm = minBpm; bpm <= maxBpm; bpm++) {
      const lag = Math.round((60 * targetRate) / bpm);
      let score = 0;
      for (let i = lag; i < frameCount; i++) {
        score += onset[i] * onset[i - lag];
      }

      const halfLag = lag * 2;
      if (halfLag < frameCount) {
        let halfScore = 0;
        for (let i = halfLag; i < frameCount; i++) {
          halfScore += onset[i] * onset[i - halfLag];
        }
        score += halfScore * 0.35;
      }

      const doubleLag = Math.round(lag / 2);
      if (doubleLag > 1) {
        let doubleScore = 0;
        for (let i = doubleLag; i < frameCount; i++) {
          doubleScore += onset[i] * onset[i - doubleLag];
        }
        score += doubleScore * 0.18;
      }

      scores.push({ bpm, score });
      scoreTotal += score;
      if (score > best.score) best = { bpm, score };
    }

    const averageScore = scoreTotal / scores.length || 1;
    const confidence = Math.min(1, Math.max(0, (best.score / averageScore - 1) / 3));

    if (confidence < 0.12 || !best.bpm) {
      return { bpm: 0, confidence };
    }

    const normalizedBpm = this.normalizeBpmCandidate(best.bpm, scores);

    return {
      bpm: normalizedBpm,
      confidence
    };
  }

  normalizeBpmCandidate(bpm, scores) {
    const candidates = [
      bpm,
      bpm / 2,
      bpm * 2,
      bpm * 0.75,
      bpm * (4 / 3)
    ]
      .filter(candidate => candidate >= 70 && candidate <= 165)
      .map(candidate => Math.round(candidate));

    let bestCandidate = candidates[0] || Math.round(bpm);
    let bestScore = -Infinity;

    for (const candidate of candidates) {
      const directScore = getScoreNear(scores, candidate);
      const doubleScore = getScoreNear(scores, candidate * 2) * 0.35;
      const halfScore = getScoreNear(scores, candidate / 2) * 0.25;
      const subdivisionScore = getScoreNear(scores, candidate * (4 / 3)) * 0.7;
      const rangeBias = candidate >= 90 && candidate <= 150 ? 1.12 : 1;
      const score = (directScore + doubleScore + halfScore + subdivisionScore) * rangeBias;

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }

    return bestCandidate;
  }

  estimateKey(audioBuffer) {
    const sampleRate = audioBuffer.sampleRate;
    const channels = Math.min(audioBuffer.numberOfChannels, 2);
    const channelData = Array.from({ length: channels }, (_unused, channel) => audioBuffer.getChannelData(channel));
    const frameSize = 4096;
    const maxFrames = 80;
    const usableDuration = Math.min(audioBuffer.duration, 120);
    const startTime = Math.min(8, audioBuffer.duration * 0.08);
    const stepSamples = Math.max(frameSize, Math.floor((usableDuration * sampleRate) / maxFrames));
    const chroma = new Float32Array(12);
    let frames = 0;

    const frequencies = [];
    for (let midi = 36; midi <= 95; midi++) {
      const frequency = 440 * Math.pow(2, (midi - 69) / 12);
      frequencies.push({ midi, pitchClass: midi % 12, frequency });
    }
    const bassChroma = new Float32Array(12);

    for (let start = Math.floor(startTime * sampleRate); start + frameSize < audioBuffer.length && frames < maxFrames; start += stepSamples) {
      const rms = this.getFrameRms(channelData, channels, start, frameSize);
      if (rms < 0.006) continue;

      for (const note of frequencies) {
        const magnitude = this.goertzelMagnitude(channelData, channels, start, frameSize, sampleRate, note.frequency);
        const weightedMagnitude = Math.log1p(magnitude) * (note.frequency < 120 ? 0.65 : 1);
        chroma[note.pitchClass] += weightedMagnitude;
        if (note.midi <= 59) {
          bassChroma[note.pitchClass] += weightedMagnitude;
        }
      }
      frames++;
    }

    if (frames < 4) {
      return { key: null, confidence: 0 };
    }

    const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    const names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    const scored = [];

    for (let root = 0; root < 12; root++) {
      scored.push({
        key: names[root],
        score: this.scoreKeyCandidate(chroma, bassChroma, majorProfile, root, false)
      });
      scored.push({
        key: `${names[root]}m`,
        score: this.scoreKeyCandidate(chroma, bassChroma, minorProfile, root, true)
      });
    }

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];
    const confidence = Math.max(0, Math.min(1, (best.score - second.score) / Math.max(0.0001, Math.abs(best.score))));

    if (!best || confidence < 0.075) {
      return { key: null, confidence };
    }

    return {
      key: best.key,
      confidence
    };
  }

  scoreKeyCandidate(chroma, bassChroma, profile, root, isMinor) {
    const profileScore = correlateKeyProfile(chroma, profile, root);
    const scale = isMinor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    const third = isMinor ? 3 : 4;
    const scaleScore = getScaleEnergyRatio(chroma, root, scale);
    const bassRootScore = getNormalizedPitchEnergy(bassChroma, root);
    const tonicScore = getNormalizedPitchEnergy(chroma, root);
    const fifthScore = getNormalizedPitchEnergy(chroma, (root + 7) % 12);
    const thirdScore = getNormalizedPitchEnergy(chroma, (root + third) % 12);

    return profileScore
      + scaleScore * 0.22
      + bassRootScore * 0.28
      + tonicScore * 0.16
      + fifthScore * 0.08
      + thirdScore * 0.06;
  }

  getFrameRms(channelData, channels, start, frameSize) {
    let sum = 0;
    for (let i = 0; i < frameSize; i++) {
      let sample = 0;
      for (let channel = 0; channel < channels; channel++) {
        sample += channelData[channel][start + i] || 0;
      }
      sample /= channels;
      sum += sample * sample;
    }
    return Math.sqrt(sum / frameSize);
  }

  goertzelMagnitude(channelData, channels, start, frameSize, sampleRate, frequency) {
    const omega = (2 * Math.PI * frequency) / sampleRate;
    const coeff = 2 * Math.cos(omega);
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;

    for (let i = 0; i < frameSize; i++) {
      let sample = 0;
      for (let channel = 0; channel < channels; channel++) {
        sample += channelData[channel][start + i] || 0;
      }
      sample /= channels;
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameSize - 1));
      s0 = sample * window + coeff * s1 - s2;
      s2 = s1;
      s1 = s0;
    }

    return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2);
  }
}

function getScoreNear(scores, bpm) {
  let score = 0;
  for (const candidate of scores) {
    const distance = Math.abs(candidate.bpm - bpm);
    if (distance <= 2) {
      score += candidate.score * (1 - distance / 3);
    }
  }
  return score;
}

function correlateKeyProfile(chroma, profile, root) {
  let score = 0;
  let chromaSum = 0;
  let profileSum = 0;

  for (let i = 0; i < 12; i++) {
    chromaSum += chroma[i];
    profileSum += profile[i];
  }

  const chromaMean = chromaSum / 12;
  const profileMean = profileSum / 12;
  let chromaEnergy = 0;
  let profileEnergy = 0;

  for (let i = 0; i < 12; i++) {
    const chromaValue = chroma[(i + root) % 12] - chromaMean;
    const profileValue = profile[i] - profileMean;
    score += chromaValue * profileValue;
    chromaEnergy += chromaValue * chromaValue;
    profileEnergy += profileValue * profileValue;
  }

  return score / Math.sqrt(Math.max(0.000001, chromaEnergy * profileEnergy));
}

function getScaleEnergyRatio(chroma, root, scale) {
  let scaleEnergy = 0;
  let totalEnergy = 0;
  const scalePitchClasses = new Set(scale.map(interval => (root + interval) % 12));

  for (let i = 0; i < 12; i++) {
    totalEnergy += chroma[i];
    if (scalePitchClasses.has(i)) {
      scaleEnergy += chroma[i];
    }
  }

  return totalEnergy > 0 ? scaleEnergy / totalEnergy : 0;
}

function getNormalizedPitchEnergy(chroma, pitchClass) {
  let totalEnergy = 0;
  for (let i = 0; i < 12; i++) {
    totalEnergy += chroma[i];
  }

  return totalEnergy > 0 ? chroma[pitchClass] / totalEnergy : 0;
}
