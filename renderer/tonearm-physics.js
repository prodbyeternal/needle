/**
 * NEEDLE — TONEARM PHYSICS & KINEMATICS MODULE
 * Manages spatial coordinates of the pivot, mechanical arm sweep angles,
 * distance mapping to platter grooves, mouse dragging, and vertical Z-axis bounce on drop.
 */

export class TonearmPhysics {
  constructor() {
    this.baseBedSize = 532;
    this.geometryScale = 1;

    // Spatial Pivot Setup (Coordinates relative to the 532px Bed)
    this.baseXPivot = 460;
    this.baseYPivot = 80;
    this.baseArmLength = 320; // Length in pixels from pivot to needle point
    
    // Platter center coordinate on the 532px Bed
    this.baseXPlatter = 239.4; // 45% of 532px
    this.baseYPlatter = 266.0; // 50% of 532px
    
    // Record Grooves Bounds (Distance from Platter Center in pixels)
    this.baseROuter = 210.0;
    this.baseRInner = 90.0;

    this.setGeometryScale(1);

    // Sweeping Angles in Radians (0 = resting straight down)
    // Angles are clockwise relative to vertical down
    this.angleRest = -0.04;    // Off-record resting support position (~ -2.3 degrees)
    this.angleOuter = 0.165;   // Stylus is sitting at the record outer rim (~ 9.4 degrees)
    this.angleInner = 0.585;   // Stylus is sitting at the lead-out groove near spindle (~ 33.5 degrees)
    this.angleSpindle = 0.65;  // Hard limit near center pin

    // Dynamic State
    this.currentAngle = this.angleRest;
    this.targetAngle = this.angleRest;
    this.isDragging = false;
    this.isDropped = false;    // True if needle is down on record

    // Needle drop physical bounce simulator (Mass-Spring-Damper on Z-axis)
    this.zHeight = 1.0;        // 1.0 = lifted high in the air, 0.0 = resting on record
    this.zVelocity = 0;
    this.zTarget = 1.0;        // Starts lifted
    
    // Spring physics constants
    this.kSpring = 0.22;       // Spring stiffness
    this.dDamping = 0.16;      // Damping coefficient
    this.elasticity = 0.35;    // Coefficient of restitution on record contact bounce
    this.bounceWobble = 0;     // Micro wobble of the arm angle on contact impact
  }

  setGeometryScale(scale) {
    this.geometryScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

    this.xPivot = this.baseXPivot * this.geometryScale;
    this.yPivot = this.baseYPivot * this.geometryScale;
    this.armLength = this.baseArmLength * this.geometryScale;
    this.xPlatter = this.baseXPlatter * this.geometryScale;
    this.yPlatter = this.baseYPlatter * this.geometryScale;
    this.rOuter = this.baseROuter * this.geometryScale;
    this.rInner = this.baseRInner * this.geometryScale;
  }

  setLifted(lifted) {
    this.zTarget = lifted ? 1.0 : 0.0;
    if (lifted) {
      this.isDropped = false;
    }
  }

  /**
   * Translates absolute mouse position relative to the turntable bed into raw sweep angle
   */
  calculateAngleFromMouse(mouseX, mouseY) {
    const dx = this.xPivot - mouseX;
    const dy = mouseY - this.yPivot;
    
    // Calculate angle relative to vertical down
    let angle = Math.atan2(dx, dy);
    
    // Constrain angle between rest and spindle limit
    if (angle < this.angleRest - 0.05) angle = this.angleRest - 0.05;
    if (angle > this.angleSpindle + 0.05) angle = this.angleSpindle + 0.05;
    
    return angle;
  }

  /**
   * Maps current sweep angle to stylus cartridge Cartesian coordinates
   */
  getStylusCoordinates(angle = this.currentAngle) {
    // Trigonometric mapping of the mechanical offset
    // straight down (angle = 0) maps to: x = xPivot, y = yPivot + armLength
    const x = this.xPivot - this.armLength * Math.sin(angle);
    const y = this.yPivot + this.armLength * Math.cos(angle);
    return { x, y };
  }

  /**
   * Calculates distance of the needle to the platter center spindle pin
   */
  getNeedleRadius(angle = this.currentAngle) {
    const stylus = this.getStylusCoordinates(angle);
    const dx = stylus.x - this.xPlatter;
    const dy = stylus.y - this.yPlatter;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Maps a radial distance to a playback progress percentage (0.0 = outer edge, 1.0 = inner edge)
   */
  getPlaybackProgress(radius) {
    if (radius > this.rOuter) return 0.0;
    if (radius < this.rInner) return 1.0;
    
    // Linear groove progression
    return (this.rOuter - radius) / (this.rOuter - this.rInner);
  }

  /**
   * Maps a playback progress percentage (0.0 to 1.0) back into a target arm sweep angle
   */
  getAngleFromProgress(pct) {
    if (pct < 0) pct = 0;
    if (pct > 1) pct = 1;
    return this.angleOuter + pct * (this.angleInner - this.angleOuter);
  }

  /**
   * Checks if stylus is hovering directly above the vinyl groove sector
   */
  isOverRecord(angle = this.currentAngle) {
    const radius = this.getNeedleRadius(angle);
    return radius >= this.rInner - 8 && radius <= this.rOuter + 8;
  }

  /**
   * Physics ticker executed at 60fps
   */
  tick(dt = 16.6, audioPlayheadPct = 0, isAudioPlaying = false, liveAmplitude = 0) {
    // 1. Resolve Z-axis needle drop gravity and spring mechanics
    if (this.zHeight !== this.zTarget || Math.abs(this.zVelocity) > 0.001) {
      // Acceleration: F = -k*x - d*v
      const displacement = this.zHeight - this.zTarget;
      const acceleration = -this.kSpring * displacement - this.dDamping * this.zVelocity;
      
      this.zVelocity += acceleration;
      this.zHeight += this.zVelocity;

      // Detect collision with record surface (Z = 0)
      if (this.zHeight <= 0) {
        this.zHeight = 0;
        
        // Bounce!
        this.zVelocity = -this.zVelocity * this.elasticity;
        
        // Trigger visual wobble impulse
        if (Math.abs(this.zVelocity) > 0.05) {
          this.bounceWobble = this.zVelocity * 0.08;
        }

        // Trigger contact state
        if (!this.isDropped && this.zTarget === 0) {
          this.isDropped = true;
          // Notify app shell to trigger needle drop click sound
          if (this.onNeedleDropCallback) this.onNeedleDropCallback();
        }
      }
    }

    // Decay wobble impulse
    this.bounceWobble *= 0.85;

    // 2. Resolve arm angle sweeps
    if (this.isDragging) {
      // Follow mouse instantly
      this.currentAngle = this.targetAngle;
    } else {
      if (this.isDropped) {
        if (isAudioPlaying) {
          // Track the current playing audio position
          this.targetAngle = this.getAngleFromProgress(audioPlayheadPct);
        }
        this.currentAngle += (this.targetAngle - this.currentAngle) * 0.1; // Damped follow
      } else {
        // Slowly float back to rest/target if lifted
        this.currentAngle += (this.targetAngle - this.currentAngle) * 0.15;
      }
    }

    // Apply micro angle wobble (needle drop impact)
    let compositeAngle = this.currentAngle + this.bounceWobble;
    let verticalJitter = 0;

    // Apply live dynamic music groove vibration wobble
    if (isAudioPlaying && this.isDropped && this.isOverRecord()) {
      // Subtle micro horizontal jitter based on live sound volume
      const grooveJitter = (Math.random() * 2 - 1) * liveAmplitude * 0.0038;
      compositeAngle += grooveJitter;

      // Dynamic micro vertical flutter to show needle tracking sound envelope depth
      verticalJitter = Math.sin(performance.now() * 0.06) * liveAmplitude * 0.035;
    }

    // 3. CSS Transform updates
    this.updateDOM(compositeAngle, verticalJitter);
  }

  /**
   * Updates physical HTML tonearm elements with computed transforms
   */
  updateDOM(angle, verticalJitter = 0) {
    const armEl = document.getElementById('tonearm-arm');
    if (!armEl) return;

    // Translate Angle to degrees
    const deg = angle * (180 / Math.PI);
    
    // Scale visual height of arm based on Z-height and music dynamics
    const displayZ = Math.max(0, this.zHeight + verticalJitter);
    const scale = 1.0 + displayZ * 0.05;
    const shadow = displayZ * 12 + 2;
    const shadowOpacity = 0.25 - displayZ * 0.15;

    // Apply 3D-feeling transformations (rotation, scaling, drop shadows)
    armEl.style.transform = `rotate(${deg}deg) scale(${scale})`;
    armEl.style.filter = `drop-shadow(${-shadow / 2}px ${shadow}px ${shadow}px rgba(0,0,0,${shadowOpacity}))`;
  }

  registerNeedleDropCallback(callback) {
    this.onNeedleDropCallback = callback;
  }
}
