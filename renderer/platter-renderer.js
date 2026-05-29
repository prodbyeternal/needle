/**
 * NEEDLE — KINETIC TURNTABLE PLATTER RENDERER
 * Canvas 2D engine that draws a 3D-feeling vinyl record with anisotropic light sheen reflection,
 * circular embedded track waveform, stroboscopic calibration dots, and procedurally spins with mass inertia.
 */

export class PlatterRenderer {
  constructor(platterCanvasId, waveCanvasId) {
    this.canvas = document.getElementById(platterCanvasId);
    this.ctx = this.canvas.getContext('2d');
    
    this.waveCanvas = document.getElementById(waveCanvasId);
    if (this.waveCanvas) {
      this.waveCtx = this.waveCanvas.getContext('2d');
    }
    
    // Kinematics & Physical Inertia
    this.angle = 0;             // Platter's current rotation angle in radians
    this.currentRPS = 0;        // Current Rotations Per Second
    this.targetRPS = 0;         // Target Rotations Per Second (motor state * base RPM)
    this.inertia = 0.04;        // Damping factor modeling virtual platter mass (0.01 = heavy, 0.1 = light)
    this.direction = 1;         // 1 = Forward, -1 = Reverse
    this.pitchFactor = 1.0;     // Pitch adjustment multiplier (0.5 to 1.5)

    // Visual assets
    this.coverImage = new Image();
    this.isLoaded = false;
    this.waveformEnvelope = []; // Radial decimation data
    this.scrollingWaveform = []; // High-res scrolling data
    this.activeTheme = 'light';
    this.activeAccentColor = '#FF4E00';
    this.activeAccentRgb = { r: 255, g: 78, b: 0 };
    
    // Playback tracing properties
    this.playheadPct = 0;
    this.needleAngle = 1.3; // Default screen angle where needle sits
    
    // Ambient Pulse State
    this.glowIntensity = 0;

    // Repeat points for scrolling waveform
    this.repeatA = null;
    this.repeatB = null;
  }

  setRepeatPoints(pctA, pctB) {
    this.repeatA = pctA;
    this.repeatB = pctB;
  }

  setTheme(theme) {
    this.activeTheme = theme;
  }

  setAccentColor(color) {
    this.activeAccentColor = color;
    this.activeAccentRgb = this.hexToRgb(color) || this.activeAccentRgb;
  }

  accentRgba(alpha) {
    const { r, g, b } = this.activeAccentRgb;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  hexToRgb(color) {
    const match = /^#?([0-9a-f]{6})$/i.exec(String(color || '').trim());
    if (!match) return null;
    const hex = match[1];
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16)
    };
  }

  /**
   * Set target motor RPM (0, 16, 33, 45, 78)
   */
  setTargetSpeed(rpm, direction = 1) {
    this.direction = direction;
    if (rpm === 0) {
      this.targetRPS = 0;
    } else {
      // Calculate Rotations Per Second
      this.targetRPS = (rpm / 60) * this.direction;
    }
  }

  setPitchFactor(factor) {
    this.pitchFactor = factor;
  }

  /**
   * Directly sets the platter angle (used for manual finger scrubbing)
   */
  nudgeAngle(deltaRadians) {
    this.angle += deltaRadians;
    // Calculate instantaneous speed during manual nudge
    this.currentRPS = deltaRadians / (Math.PI * 2) * 60; // Approximate
  }

  /**
   * Triggers track loading visual. Prepares radial waveform and cover image.
   */
  loadTrack(metadata, audioBuffer, visualState = null) {
    this.isLoaded = false;
    this.waveformEnvelope = [];
    this.scrollingWaveform = [];
    
    // Set cover art
    if (metadata.coverUrl) {
      this.coverImage.onload = null;
      this.coverImage.onerror = null;
      this.coverImage.crossOrigin = metadata.coverUrl.startsWith('http') ? 'anonymous' : null;
      this.coverImage.src = metadata.coverUrl;
      this.coverImage.onload = () => {
        this.isLoaded = true;
      };
      this.coverImage.onerror = () => {
        this.coverImage.removeAttribute('src');
        this.isLoaded = true;
      };
      if (this.coverImage.complete) {
        this.isLoaded = true;
      }
    } else {
      this.isLoaded = true;
    }

    if (visualState?.waveformEnvelope?.length && visualState?.scrollingWaveform?.length) {
      this.waveformEnvelope = [...visualState.waveformEnvelope];
      this.scrollingWaveform = [...visualState.scrollingWaveform];
    } else if (audioBuffer) {
      const channel = audioBuffer.getChannelData(0);
      
      // Decimate for radial waveform (360 steps)
      const step360 = Math.floor(channel.length / 360);
      for (let i = 0; i < 360; i++) {
        let maxVal = 0;
        const start = i * step360;
        const end = Math.min(start + step360, channel.length);
        for (let j = start; j < end; j += 10) {
          const val = Math.abs(channel[j]);
          if (val > maxVal) maxVal = val;
        }
        this.waveformEnvelope.push(maxVal);
      }

      // Decimate for scrolling waveform bar (1000 steps)
      const points = 1000;
      const step1000 = Math.floor(channel.length / points);
      for (let i = 0; i < points; i++) {
        let maxVal = 0;
        const start = i * step1000;
        const end = Math.min(start + step1000, channel.length);
        for (let j = start; j < end; j += 8) {
          const val = Math.abs(channel[j]);
          if (val > maxVal) maxVal = val;
        }
        this.scrollingWaveform.push(maxVal);
      }
    }
  }

  getVisualState() {
    return {
      waveformEnvelope: [...this.waveformEnvelope],
      scrollingWaveform: [...this.scrollingWaveform]
    };
  }

  unloadTrack() {
    this.isLoaded = false;
    this.waveformEnvelope = [];
    this.scrollingWaveform = [];
    this.coverImage.src = '';
  }

  /**
   * Standard kinematics ticker executed at 60fps
   */
  tick(dt = 16.6, playheadPct = 0, needleAngle = null) {
    this.playheadPct = playheadPct;
    if (needleAngle !== null) {
      this.needleAngle = needleAngle;
    }

    // 1. Angular Inertia interpolation: current velocity approaches target speed
    const currentTarget = this.targetRPS * this.pitchFactor;
    this.currentRPS += (currentTarget - this.currentRPS) * this.inertia;
    
    // Safeguard microscopic speeds to prevent endless creeping
    if (Math.abs(this.currentRPS) < 0.001 && currentTarget === 0) {
      this.currentRPS = 0;
    }
    
    // 2. Increment rotation angle based on velocity
    const deltaAngle = this.currentRPS * (Math.PI * 2) * (dt / 1000);
    this.angle += deltaAngle;
    
    // Keep angle within bounds to prevent numeric overflows
    this.angle = this.angle % (Math.PI * 2);
    
    // 3. Render frames
    this.render();
    this.renderScrollingWaveform();
    
    // Returns active rotational speed for synchronizing pitch factor in app.js
    return this.currentRPS;
  }

  /**
   * Primary Canvas Draw Routine
   */
  render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cx = w / 2;
    const cy = h / 2;

    ctx.clearRect(0, 0, w, h);
    
    // ----------------------------------------------------
    // LAYER 1: Turntable Chassis Inner Ring & Shadow
    // ----------------------------------------------------
    ctx.shadowBlur = 12;
    ctx.shadowColor = this.activeTheme === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.06)';
    ctx.shadowOffsetY = 6;
    
    ctx.fillStyle = this.activeTheme === 'dark' ? '#141416' : '#E0E1E4';
    ctx.beginPath();
    ctx.arc(cx, cy, 260, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0; // Reset shadows

    // ----------------------------------------------------
    // LAYER 2: Brushed Aluminium Platter Edge
    // ----------------------------------------------------
    const platterGrad = ctx.createRadialGradient(cx, cy, 230, cx, cy, 255);
    if (this.activeTheme === 'dark') {
      platterGrad.addColorStop(0, '#1E1E22');
      platterGrad.addColorStop(0.8, '#2C2C32');
      platterGrad.addColorStop(1, '#1A1A1C');
    } else {
      platterGrad.addColorStop(0, '#ECECF0');
      platterGrad.addColorStop(0.8, '#FDFDFF');
      platterGrad.addColorStop(1, '#D8D8DC');
    }
    ctx.fillStyle = platterGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, 255, 0, Math.PI * 2);
    ctx.fill();

    // Platter edge highlights
    ctx.strokeStyle = this.activeTheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 253, 0, Math.PI * 2);
    ctx.stroke();

    // ----------------------------------------------------
    // LAYER 3: Stroboscopic Timing Indicators (Outer rim dots)
    // ----------------------------------------------------
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.angle);
    
    ctx.fillStyle = this.activeTheme === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)';
    // Render 120 tiny stroboscope calibration ticks on the outer rim
    const ticksCount = 120;
    for (let i = 0; i < ticksCount; i++) {
      const a = (i / ticksCount) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 247, Math.sin(a) * 247, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    
    // Middle calibration row (for 45 RPM)
    const midTicks = 90;
    for (let i = 0; i < midTicks; i++) {
      const a = (i / midTicks) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 242, Math.sin(a) * 242, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // ----------------------------------------------------
    // LAYER 4: The Rubber Slipmat
    // ----------------------------------------------------
    ctx.fillStyle = this.activeTheme === 'dark' ? '#18181A' : '#ECECEF';
    ctx.beginPath();
    ctx.arc(cx, cy, 230, 0, Math.PI * 2);
    ctx.fill();
    
    // Slipmat geometric styling
    ctx.strokeStyle = this.activeTheme === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)';
    ctx.lineWidth = 1;
    for (let r = 30; r < 230; r += 20) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ----------------------------------------------------
    // LAYER 5: The Vinyl Record (Only drawn if track is loaded)
    // ----------------------------------------------------
    if (this.isLoaded) {
      this.drawVinylRecord(ctx, cx, cy);
    } else {
      // Empty Platter Center spindle placeholder
      ctx.fillStyle = this.activeTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(18,18,18,0.04)';
      ctx.beginPath();
      ctx.arc(cx, cy, 50, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.fillStyle = this.activeTheme === 'dark' ? '#5A5A60' : '#8A8A90';
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Dynamic rendering of loaded physical Vinyl disk
   */
  drawVinylRecord(ctx, cx, cy) {
    ctx.save();
    
    // 1. Vinyl Base body (Matte charcoal black)
    ctx.shadowBlur = 10;
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowOffsetY = 4;
    
    ctx.fillStyle = '#0F0F10'; // Vinyl black
    ctx.beginPath();
    ctx.arc(cx, cy, 222, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0; // Reset shadows

    // 2. High-precision Concentric Micro-Grooves
    ctx.strokeStyle = 'rgba(255,255,255,0.018)';
    ctx.lineWidth = 0.75;
    for (let r = 88; r < 220; r += 1.5) {
      // Create random microscopic groove spacing to mimic track sectors
      if (Math.floor(r) % 15 === 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.035)'; // Gap spacing
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.015)';
      }
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    this.drawVinylReflections(ctx, cx, cy);

    // 3. Central Album Art & Label Chassis
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.angle); // Rotates exactly in sync with the motor speed

    // Label boundary ring
    ctx.fillStyle = this.activeTheme === 'dark' ? '#121214' : '#F4F5F6';
    ctx.beginPath();
    ctx.arc(0, 0, 84, 0, Math.PI * 2);
    ctx.fill();

    // If album image is loaded, circular crop and draw it as label
    if (this.isLoaded && this.coverImage.src) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, 80, 0, Math.PI * 2);
      ctx.closePath();
      ctx.clip(); // Mask boundaries
      
      try {
        ctx.drawImage(this.coverImage, -80, -80, 160, 160);
      } catch (e) {
        // Fallback placeholder
        ctx.fillStyle = this.activeAccentColor;
        ctx.fillRect(-80, -80, 160, 160);
      }
      ctx.restore();
    }

    // Outer metal spindle ring overlay on label
    ctx.strokeStyle = 'rgba(0,0,0,0.1)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 80, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore(); // Spindle centering

    // ----------------------------------------------------
    // LAYER 8: Center Spindle Pin (Perfect stationary pivot center)
    // ----------------------------------------------------
    ctx.fillStyle = this.activeTheme === 'dark' ? '#EAEAEC' : '#707074';
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fill();

    const pinGrad = ctx.createLinearGradient(cx - 5, cy - 5, cx + 5, cy + 5);
    pinGrad.addColorStop(0, '#FFFFFF');
    pinGrad.addColorStop(0.5, '#7F8184');
    pinGrad.addColorStop(1, '#3E4042');
    
    ctx.fillStyle = pinGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.restore(); // Restore master
  }

  drawVinylReflections(ctx, cx, cy) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 221, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(cx, cy);

    ctx.globalCompositeOperation = 'screen';

    if (typeof ctx.createConicGradient === 'function') {
      const conic = ctx.createConicGradient(-Math.PI * 0.26, 0, 0);
      conic.addColorStop(0.00, 'rgba(255,255,255,0)');
      conic.addColorStop(0.07, 'rgba(255,255,255,0.018)');
      conic.addColorStop(0.125, 'rgba(255,255,255,0.105)');
      conic.addColorStop(0.19, 'rgba(255,255,255,0.016)');
      conic.addColorStop(0.31, 'rgba(255,255,255,0)');
      conic.addColorStop(0.50, 'rgba(255,255,255,0)');
      conic.addColorStop(0.57, 'rgba(255,255,255,0.016)');
      conic.addColorStop(0.625, 'rgba(255,255,255,0.085)');
      conic.addColorStop(0.69, 'rgba(255,255,255,0.014)');
      conic.addColorStop(0.81, 'rgba(255,255,255,0)');
      conic.addColorStop(1.00, 'rgba(255,255,255,0)');
      ctx.fillStyle = conic;
      ctx.beginPath();
      ctx.arc(0, 0, 221, 0, Math.PI * 2);
      ctx.fill();
    } else {
      this.fillReflectionCone(ctx, -Math.PI * 0.25, 0.9, 0.085);
      this.fillReflectionCone(ctx, Math.PI * 0.75, 0.9, 0.07);
    }

    ctx.globalCompositeOperation = 'source-over';
    this.drawStaticGrooveGlints(ctx);

    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, 0, 220, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 222, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  fillReflectionCone(ctx, rotation, arcLength, alpha) {
    ctx.save();
    ctx.rotate(rotation);

    const grad = ctx.createLinearGradient(0, -54, 0, 54);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.42, `rgba(255,255,255,${Math.max(0, alpha * 0.18)})`);
    grad.addColorStop(0.5, `rgba(255,255,255,${Math.max(0, alpha)})`);
    grad.addColorStop(0.58, `rgba(255,255,255,${Math.max(0, alpha * 0.18)})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;

    const start = -arcLength / 2;
    const end = arcLength / 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, 221, start, end);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  drawStaticGrooveGlints(ctx) {
    ctx.strokeStyle = 'rgba(255,255,255,0.026)';
    ctx.lineWidth = 0.75;

    const glints = [
      { radius: 116, start: -0.64, length: 0.28 },
      { radius: 142, start: -0.54, length: 0.34 },
      { radius: 168, start: -0.43, length: 0.42 },
      { radius: 128, start: 2.48, length: 0.24 },
      { radius: 156, start: 2.58, length: 0.36 },
      { radius: 186, start: 2.7, length: 0.42 }
    ];

    glints.forEach(({ radius, start, length }) => {
      ctx.beginPath();
      ctx.arc(0, 0, radius, start, start + length);
      ctx.stroke();
    });
  }

  /**
   * Serato/VirtualDJ style scrolling linear waveform bar
   */
  renderScrollingWaveform() {
    if (!this.waveCanvas) return;

    const w = this.waveCanvas.width;
    const h = this.waveCanvas.height;
    const ctx = this.waveCtx;
    ctx.clearRect(0, 0, w, h);

    if (!this.isLoaded || !this.scrollingWaveform.length) {
      // Draw a clean flat center guide line if no track is loaded
      ctx.strokeStyle = this.activeTheme === 'dark' ? this.accentRgba(0.2) : 'rgba(18, 18, 18, 0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(w, h / 2);
      ctx.stroke();
      return;
    }

    // Draw retro background grids
    ctx.strokeStyle = this.activeTheme === 'dark' ? this.accentRgba(0.08) : 'rgba(18, 18, 18, 0.04)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    const midY = h / 2;
    const playheadX = w / 2;
    const activeIdx = this.playheadPct * this.scrollingWaveform.length;
    
    // Zoom factor: 1 index point covers 2.2 horizontal pixels
    const stepX = 2.2;

    // Draw repeat loop background highlight overlay
    if (this.repeatA !== null && this.repeatB !== null) {
      const idxA = this.repeatA * this.scrollingWaveform.length;
      const idxB = this.repeatB * this.scrollingWaveform.length;
      const xA = playheadX + (idxA - activeIdx) * stepX;
      const xB = playheadX + (idxB - activeIdx) * stepX;
      
      const drawXStart = Math.max(0, xA);
      const drawXEnd = Math.min(w, xB);
      if (drawXEnd > drawXStart) {
        ctx.fillStyle = this.accentRgba(0.12);
        ctx.fillRect(drawXStart, 0, drawXEnd - drawXStart, h);
      }
    }

    ctx.fillStyle = this.activeTheme === 'dark' ? this.activeAccentColor : '#121212';

    // Draw double-sided symmetric waveform columns
    for (let x = 0; x < w; x += 2) {
      // Resolve which track frame maps to this screen pixel
      const idx = Math.floor((x - playheadX) / stepX + activeIdx);

      if (idx >= 0 && idx < this.scrollingWaveform.length) {
        const amplitude = this.scrollingWaveform[idx];
        // Dynamic scale height with a 6px safety padding
        const barHeight = Math.max(1, amplitude * (h - 8));

        ctx.fillRect(x, midY - barHeight / 2, 1.5, barHeight);
      }
    }

    // Draw vertical markers and tab labels for A and B points
    if (this.repeatA !== null) {
      const idxA = this.repeatA * this.scrollingWaveform.length;
      const xA = playheadX + (idxA - activeIdx) * stepX;
      if (xA >= 0 && xA <= w) {
        ctx.strokeStyle = this.activeAccentColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(xA, 0);
        ctx.lineTo(xA, h);
        ctx.stroke();
        ctx.setLineDash([]);

        // Tab label "A"
        ctx.fillStyle = this.activeAccentColor;
        ctx.fillRect(xA - 6, 2, 12, 11);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 8px var(--font-sans)';
        ctx.textAlign = 'center';
        ctx.fillText('A', xA, 10);
      }
    }
    if (this.repeatB !== null) {
      const idxB = this.repeatB * this.scrollingWaveform.length;
      const xB = playheadX + (idxB - activeIdx) * stepX;
      if (xB >= 0 && xB <= w) {
        ctx.strokeStyle = this.activeAccentColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(xB, 0);
        ctx.lineTo(xB, h);
        ctx.stroke();
        ctx.setLineDash([]);

        // Tab label "B"
        ctx.fillStyle = this.activeAccentColor;
        ctx.fillRect(xB - 6, 2, 12, 11);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 8px var(--font-sans)';
        ctx.textAlign = 'center';
        ctx.fillText('B', xB, 10);
      }
    }
  }
}
