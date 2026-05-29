/**
 * NEEDLE — APPLICATION CONTROLLER & UNIFIED PHYSICS TICKER
 * Integrates AudioEngine, PlatterRenderer, and TonearmPhysics modules.
 * Sets up tactile GUI listeners, drag-and-drop, titlebar actions, keyboard binds,
 * and standardizes 60fps mathematical coupling between platter speed & audio pitch.
 */

import { AudioEngine } from './audio-engine.js';
import { PlatterRenderer } from './platter-renderer.js';
import { TonearmPhysics } from './tonearm-physics.js';
import { parseMetadata } from './metadata-parser.js';

const SETTINGS_STORAGE_KEY = 'needle_player_settings';
const ONBOARDING_STORAGE_KEY = 'needle_player_onboarding_seen';
const LOCAL_ANALYSIS_VERSION = 2;
const LIBRARY_DB_NAME = 'needle_player_library';
const LIBRARY_DB_VERSION = 1;
const LIBRARY_STORE_NAME = 'library';
const LIBRARY_STATE_KEY = 'state';
const SUPPORTED_AUDIO_EXTENSIONS = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'aiff'];
const COLOR_PRESETS = {
  ember: { name: 'Ember', color: '#FF4E00', glow: 'rgba(255, 78, 0, 0.24)', strobe: 'rgba(255, 78, 0, 0.88)' },
  aurora: { name: 'Aurora', color: '#00BFA6', glow: 'rgba(0, 191, 166, 0.24)', strobe: 'rgba(0, 191, 166, 0.88)' },
  violet: { name: 'Violet', color: '#8B5CF6', glow: 'rgba(139, 92, 246, 0.26)', strobe: 'rgba(139, 92, 246, 0.88)' },
  rose: { name: 'Rose', color: '#F43F5E', glow: 'rgba(244, 63, 94, 0.24)', strobe: 'rgba(244, 63, 94, 0.88)' }
};

// Instantiate Core Modules
const audio = new AudioEngine();
const platter = new PlatterRenderer('platter-canvas', 'waveform-bar-canvas');
const tonearm = new TonearmPhysics();

// Application Simulation State
let currentRPM = 33;            // Active RPM setting (16, 33, 45, 78)
let isMotorOn = false;          // True if power toggle is flipped ON
let activeTheme = 'light';
let activeColorPreset = 'ember';
let customAccentColor = '#FF4E00';
let isDraggingTonearm = false;
let pitchSliderPercent = 0.0;    // Fine pitch offset (-50.0 to +50.0)

// Platter Scratching State
let isScratching = false;
let lastScratchAngle = 0;
let scratchVelocity = 0;
let scratchSpeedFactor = 0;

// Dynamic drag coordinates
let lastMouseY = 0;

// Dynamic visual scroll
let displayScrollInterval = null;

// Ticker parameters
let lastTickTime = performance.now();

// Library State
let trackLibrary = [];       // Array of { id, fileName, metadata, fileBuffer, duration }
let activeTrackId = null;    // Currently loaded track's id
let isLibraryOpen = false;
let libraryIdCounter = 0;
let pendingDeleteTrackId = null;
let onboardingStep = 0;
let onboardingPurpose = 'Listening';

// Eject State
let isEjecting = false;

// Settings Sidebar State
let isSettingsOpen = false;
let activeBindingAction = null; // Stored action key when rebinding

// Customizable Settings values (saved to / loaded from localStorage)
let tapeStopDuration = 800;     // in ms
let needleDropVolume = 0.35;    // 0.0 to 1.0
let basePlatterInertia = 0.04;  // Platter deceleration inertia

let keyBindings = {
  motor: 'SPACE',
  play: 'P',
  stop: 'S',
  reverse: 'R',
  eject: 'E',
  library: 'L',
  settings: ','
};

// ----------------------------------------------------
// 1. Initializer Routine
// ----------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
  initApp();
  requestAnimationFrame(simulationLoop);
});

function initApp() {
  // Hook Frameless Titlebar Windows Controls
  document.getElementById('btn-minimize').addEventListener('click', () => window.electronAPI.minimize());
  document.getElementById('btn-maximize').addEventListener('click', () => window.electronAPI.maximize());
  document.getElementById('btn-close').addEventListener('click', () => window.electronAPI.close());

  // Hook Theme Change
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  // Hook Motor Power mechanical switch
  document.getElementById('motor-toggle').addEventListener('click', toggleMotorPower);

  // Hook RPM buttons grid
  const rpmButtons = document.querySelectorAll('.btn-rpm');
  rpmButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const rpm = parseInt(e.currentTarget.getAttribute('data-rpm'));
      setRPM(rpm);
    });
  });

  // Hook Transport Actions
  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('btn-stop').addEventListener('click', stopPlayer);
  document.getElementById('btn-reverse').addEventListener('click', toggleDirection);
  document.getElementById('btn-eject').addEventListener('click', ejectRecord);

  // Hook Library Panel
  document.getElementById('btn-library-toggle').addEventListener('click', toggleLibrary);
  document.getElementById('btn-library-close').addEventListener('click', toggleLibrary);
  document.getElementById('btn-cancel-delete').addEventListener('click', closeDeleteConfirm);
  document.getElementById('btn-confirm-delete').addEventListener('click', confirmDeleteTrack);
  document.getElementById('delete-confirm-modal').addEventListener('click', (e) => {
    if (e.target.id === 'delete-confirm-modal') closeDeleteConfirm();
  });

  // Hook Settings Panel
  document.getElementById('btn-settings-toggle').addEventListener('click', toggleSettings);
  document.getElementById('btn-settings-close').addEventListener('click', toggleSettings);

  // Load and apply settings from localStorage
  loadSettings();
  setupSettingsListeners();
  setupOnboarding();
  loadLibraryFromStorage();

  // Tape stop visual callback
  audio.registerTapeStopCallback(() => {
    const wrapper = document.getElementById('platter-wrapper');
    wrapper.classList.remove('tape-stopping');
    platter.setTargetSpeed(0, audio.playbackDirection);
    updateTransportGUI();
  });

  // Hook Tactile Pitch Slider
  setupPitchSlider();

  // Hook Tactile Crackle Dial Knob
  setupCrackleKnob();
  setupControlDeckTabs();
  setupEffectsControls();

  // Keep tonearm coordinates matched to the responsive turntable bed
  setupResponsiveTonearmGeometry();

  // Hook Drag and Drop interactions
  setupDragAndDrop();

  // Hook Tonearm mouse dragging mechanics
  setupTonearmDragging();

  // Hook Platter interactive scratching mechanics
  setupPlatterScratching();

  // Hook Audio Engine needle contact pop trigger
  tonearm.registerNeedleDropCallback(() => {
    if (audio.ctx) {
      // Trigger instant high-frequency needle scratch static burst
      const popGain = audio.ctx.createGain();
      popGain.gain.value = needleDropVolume;
      popGain.connect(audio.ctx.destination);
      
      const osc = audio.ctx.createOscillator();
      const band = audio.ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 4000;
      band.Q.value = 3.0;

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(100, audio.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(10, audio.ctx.currentTime + 0.08);

      osc.connect(band);
      band.connect(popGain);
      osc.start();
      osc.stop(audio.ctx.currentTime + 0.08);

      // Play audio if motor is rotating
      if (isMotorOn && audio.originalBuffer) {
        audio.play(getCompositePitchSpeed());
      }
      updateTransportGUI();
    }
  });

  // Handle Natural Audio Track Ending
  audio.registerEndedCallback(() => {
    // Lift arm and float back to resting
    tonearm.setLifted(true);
    tonearm.targetAngle = tonearm.angleRest;
    updateTransportGUI();
  });

  // Key Bindings Listeners
  window.addEventListener('keydown', handleKeyboardShortcuts);
}

// ----------------------------------------------------
// 2. Tactile GUI Event Bundling
// ----------------------------------------------------

/**
 * Motor Power Toggle lever logic
 */
function toggleMotorPower() {
  isMotorOn = !isMotorOn;
  const toggleBtn = document.getElementById('motor-toggle');
  const titleIndicator = document.querySelector('.header-status');
  
  if (isMotorOn) {
    toggleBtn.classList.add('toggle-active');
    document.querySelector('.toggle-label.on').classList.add('active');
    document.querySelector('.toggle-label.off').classList.remove('active');
    document.getElementById('motor-status-text').textContent = 'MOTOR ACTIVE';
    titleIndicator.classList.add('status-active');
    
    // Set target speed in platter
    platter.setTargetSpeed(currentRPM, audio.playbackDirection);

    // If needle is dropped, play
    if (tonearm.isDropped && audio.originalBuffer && !audio.isPlaying) {
      audio.play(getCompositePitchSpeed());
    }
  } else {
    toggleBtn.classList.remove('toggle-active');
    document.querySelector('.toggle-label.off').classList.add('active');
    document.querySelector('.toggle-label.on').classList.remove('active');
    document.getElementById('motor-status-text').textContent = 'MOTOR STANDBY';
    titleIndicator.classList.remove('status-active');
    
    // Let motor decelerate naturally (target speed is 0)
    platter.setTargetSpeed(0, audio.playbackDirection);
    
    // Stop audio
    if (audio.isPlaying) {
      audio.pause();
    }
  }
  updateTransportGUI();
}

/**
 * RPM Speed Changes
 */
function setRPM(rpm) {
  currentRPM = rpm;
  
  // Highlight active button
  const buttons = document.querySelectorAll('.btn-rpm');
  buttons.forEach(btn => {
    if (parseInt(btn.getAttribute('data-rpm')) === rpm) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Display screen update
  document.getElementById('display-rpm').textContent = `${formatRpm(rpm)} RPM`;
  updateBpmDisplay(getActiveTrackMetadata());
  updateKeyDisplay(getActiveTrackMetadata());

  // Apply speed changes if motor is running
  if (isMotorOn) {
    platter.setTargetSpeed(currentRPM, audio.playbackDirection);
  }
}

/**
 * Play/Pause Transport Toggle — with Tape Stop effect on pause
 */
function togglePlay() {
  if (!audio.originalBuffer) return;
  
  // If tape stop is in progress, cancel it and resume
  if (audio.isTapeStopping) {
    audio.cancelTapeStop();
    audio.play(getCompositePitchSpeed());
    const wrapper = document.getElementById('platter-wrapper');
    wrapper.classList.remove('tape-stopping');
    if (isMotorOn) {
      platter.setTargetSpeed(currentRPM, audio.playbackDirection);
    }
    updateTransportGUI();
    return;
  }

  // Quick safety: if motor is off, turn it on! (A modern turntable convenience feature)
  if (!isMotorOn) {
    toggleMotorPower();
    // Drop needle if it was resting
    if (!tonearm.isDropped) {
      const pct = audio.duration ? (audio.currentTime / audio.duration) : 0;
      tonearm.targetAngle = tonearm.getAngleFromProgress(pct);
      tonearm.setLifted(false);
    }
    return;
  }

  // If needle is currently lifted, drop it!
  if (!tonearm.isDropped) {
    const pct = audio.duration ? (audio.currentTime / audio.duration) : 0;
    tonearm.targetAngle = tonearm.getAngleFromProgress(pct);
    tonearm.setLifted(false);
    return;
  }

  // Tape stop on pause, normal play on resume
  if (audio.isPlaying) {
    // Trigger tape stop effect instead of instant pause
    audio.tapeStop(tapeStopDuration);
    const wrapper = document.getElementById('platter-wrapper');
    wrapper.classList.add('tape-stopping');
    // Gradually decelerate platter visual to match
    platter.setTargetSpeed(0, audio.playbackDirection);
    platter.inertia = 0.008 * (800 / tapeStopDuration); // scale inertia dynamically!
    setTimeout(() => { platter.inertia = basePlatterInertia; }, tapeStopDuration + 100); // Restore normal inertia
  } else {
    audio.play(getCompositePitchSpeed());
    if (isMotorOn) {
      platter.setTargetSpeed(currentRPM, audio.playbackDirection);
    }
  }
  updateTransportGUI();
}

/**
 * Stops motor completely, lifts tonearm and resets position
 */
function stopPlayer() {
  if (isMotorOn) {
    toggleMotorPower();
  }
  audio.stop();
  tonearm.setLifted(true);
  tonearm.targetAngle = tonearm.angleRest;
  updateTransportGUI();
}

/**
 * Reverse Playback Toggler
 */
function toggleDirection() {
  const nextDir = audio.playbackDirection === 1 ? -1 : 1;
  audio.setDirection(nextDir);
  
  // Mirror direction to platter target speeds
  if (isMotorOn) {
    platter.setTargetSpeed(currentRPM, nextDir);
  } else {
    platter.direction = nextDir;
  }

  // Update HUD
  const dirText = nextDir === 1 ? 'FORWARD' : 'REVERSE';
  document.getElementById('display-direction').textContent = dirText;
  
  const revBtn = document.getElementById('btn-reverse');
  if (nextDir === -1) {
    revBtn.classList.add('active-fwd-rev');
  } else {
    revBtn.classList.remove('active-fwd-rev');
  }
}

/**
 * Tactile Mechanical fader Setup
 */
function setupPitchSlider() {
  const thumb = document.getElementById('pitch-slider-thumb');
  const track = thumb.parentElement;
  
  const updatePitchFromCoords = (clientX) => {
    const rect = track.getBoundingClientRect();
    let pct = (clientX - rect.left) / rect.width; // 0 to 1
    pct = Math.max(0, Math.min(1, pct));
    
    // Scale percentage to ±50.0%
    pitchSliderPercent = (pct - 0.5) * 100.0;
    applyPitch();
  };

  thumb.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const onMouseMove = (moveEvent) => updatePitchFromCoords(moveEvent.clientX);
    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // Track click to snap pitch
  track.addEventListener('mousedown', (e) => {
    if (e.target !== thumb) {
      updatePitchFromCoords(e.clientX);
    }
  });

  // Double-click/Reset action
  document.getElementById('reset-pitch').addEventListener('click', resetPitch);
  track.addEventListener('dblclick', resetPitch);
}

function resetPitch() {
  pitchSliderPercent = 0.0;
  applyPitch();
}

function applyPitch() {
  const thumb = document.getElementById('pitch-slider-thumb');
  // Position percentage: Map -50% to 0% and +50% to 100%
  const posPct = ((pitchSliderPercent + 50.0) / 100.0) * 100.0;
  thumb.style.left = `${posPct}%`;
  
  // Update HUD text
  const sign = pitchSliderPercent >= 0 ? '+' : '';
  document.getElementById('display-pitch').textContent = `${sign}${pitchSliderPercent.toFixed(2)}%`;
  updateBpmDisplay(getActiveTrackMetadata());
  updateKeyDisplay(getActiveTrackMetadata());
  
  // Couple pitch to platter renderer and audio
  const factor = 1.0 + (pitchSliderPercent / 100.0);
  platter.setPitchFactor(factor);
}

/**
 * Tactile Rotary Dial Knob Setup for surface noise
 */
function setupCrackleKnob() {
  const knob = document.getElementById('crackle-knob');
  
  knob.addEventListener('mousedown', (e) => {
    e.preventDefault();
    lastMouseY = e.clientY;
    
    const onMouseMove = (moveEvent) => {
      const dy = lastMouseY - moveEvent.clientY; // upward drag increases value
      lastMouseY = moveEvent.clientY;
      
      let val = parseInt(knob.getAttribute('data-value')) || 0;
      val = Math.max(0, Math.min(100, val + dy * 0.75));
      
      knob.setAttribute('data-value', val);
      
      // Rotate Visual Marker (-140deg to +140deg range)
      const angle = (val / 100) * 280 - 140;
      knob.style.transform = `rotate(${angle}deg)`;
      
      // Update HUD and Audio
      document.getElementById('crackle-value').textContent = `${Math.round(val)}%`;
      audio.setCrackleLevel(val);
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
    
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  // Handle scroll wheel on knob
  knob.addEventListener('wheel', (e) => {
    e.preventDefault();
    let val = parseInt(knob.getAttribute('data-value')) || 0;
    const change = e.deltaY < 0 ? 2 : -2; // Scroll up increases
    val = Math.max(0, Math.min(100, val + change));
    
    knob.setAttribute('data-value', val);
    const angle = (val / 100) * 280 - 140;
    knob.style.transform = `rotate(${angle}deg)`;
    document.getElementById('crackle-value').textContent = `${Math.round(val)}%`;
    audio.setCrackleLevel(val);
  });
}

function setupControlDeckTabs() {
  const deck = document.getElementById('control-deck');
  document.querySelectorAll('.deck-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const selected = tab.getAttribute('data-deck-tab');
      document.querySelectorAll('.deck-tab').forEach(btn => btn.classList.toggle('active', btn === tab));
      deck.classList.toggle('fx-active', selected === 'fx');
    });
  });
}

function setupEffectsControls() {
  document.querySelectorAll('[data-fx-eq]').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const band = e.target.getAttribute('data-fx-eq');
      const value = parseInt(e.target.value, 10);
      audio.init();
      audio.setEQBand(band, value);
      document.getElementById(`fx-${band}-val`).textContent = `${value > 0 ? '+' : ''}${value}dB`;
    });
  });

  document.querySelectorAll('[data-fx-amount]').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const effect = e.target.getAttribute('data-fx-amount');
      const value = parseInt(e.target.value, 10);
      audio.init();
      audio.setEffectAmount(effect, value);
      document.getElementById(`fx-${effect}-val`).textContent = `${value}%`;
    });
  });

  document.getElementById('btn-fx-reset').addEventListener('click', () => {
    audio.init();
    audio.resetEffects();
    document.querySelectorAll('[data-fx-eq]').forEach(slider => {
      slider.value = 0;
      const band = slider.getAttribute('data-fx-eq');
      document.getElementById(`fx-${band}-val`).textContent = '0dB';
    });
    document.querySelectorAll('[data-fx-amount]').forEach(slider => {
      slider.value = 0;
      const effect = slider.getAttribute('data-fx-amount');
      document.getElementById(`fx-${effect}-val`).textContent = '0%';
    });
  });
}

// ----------------------------------------------------
// 3. Mechanical Tonearm Mouse-Dragging Mechanics
// ----------------------------------------------------
function setupResponsiveTonearmGeometry() {
  const bed = document.querySelector('.turntable-bed');
  const armContainer = document.getElementById('tonearm-container');
  if (!bed || !armContainer) return;

  const syncGeometry = () => {
    const rect = bed.getBoundingClientRect();
    const scale = rect.width / tonearm.baseBedSize;

    tonearm.setGeometryScale(scale);
    armContainer.style.top = `${46 * scale}px`;
    armContainer.style.right = `${46 * scale}px`;
    armContainer.style.transform = `scale(${scale})`;
    updateAmbientGlowPosition();
  };

  syncGeometry();

  if (window.ResizeObserver) {
    const observer = new ResizeObserver(syncGeometry);
    observer.observe(bed);
  } else {
    window.addEventListener('resize', syncGeometry);
  }
}

function updateAmbientGlowPosition() {
  const chassis = document.getElementById('turntable-chassis');
  const platterEl = document.getElementById('platter-wrapper');
  const ambient = document.getElementById('ambient-glow');
  if (!chassis || !platterEl || !ambient) return;

  const chassisRect = chassis.getBoundingClientRect();
  const platterRect = platterEl.getBoundingClientRect();
  const centerX = platterRect.left + platterRect.width / 2 - chassisRect.left;
  const centerY = platterRect.top + platterRect.height / 2 - chassisRect.top;

  ambient.style.left = `${centerX}px`;
  ambient.style.top = `${centerY}px`;
}

function setupTonearmDragging() {
  const armEl = document.getElementById('tonearm-arm');
  const chassis = document.getElementById('turntable-chassis');
  const tooltip = document.getElementById('scrub-tooltip');
  
  armEl.addEventListener('mousedown', (e) => {
    // Left-click dragging only
    if (e.button !== 0) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    isDraggingTonearm = true;
    tonearm.isDragging = true;
    
    // Lift needle instantly when grabbed to mute/pause audio
    audio.pause();
    tonearm.setLifted(true);
    updateTransportGUI();
    
    // Active styling
    armEl.classList.add('arm-grabbing');
    tooltip.classList.remove('hidden');

    const updateArmFromCoords = (clientX, clientY) => {
      // Resolve coordinates relative to Bed chassis bounding rect
      const bedRect = document.querySelector('.turntable-bed').getBoundingClientRect();
      const mouseX = clientX - bedRect.left;
      const mouseY = clientY - bedRect.top;
      
      // Calculate angle
      const angle = tonearm.calculateAngleFromMouse(mouseX, mouseY);
      tonearm.targetAngle = angle;
      tonearm.currentAngle = angle; // Snappy tracking when grabbed

      // Drag Scrub calculations: update tooltip showing track duration preview
      if (audio.originalBuffer && tonearm.isOverRecord(angle)) {
        const radius = tonearm.getNeedleRadius(angle);
        const progress = tonearm.getPlaybackProgress(radius);
        const time = progress * audio.duration;
        
        document.getElementById('tooltip-time').textContent = formatTime(time);
        
        // Dynamic seek HUD positioning
        const stylus = tonearm.getStylusCoordinates(angle);
        tooltip.style.left = `${stylus.x}px`;
        tooltip.style.top = `${stylus.y - 45}px`;
      } else {
        document.getElementById('tooltip-time').textContent = 'REST';
        const stylus = tonearm.getStylusCoordinates(angle);
        tooltip.style.left = `${stylus.x}px`;
        tooltip.style.top = `${stylus.y - 45}px`;
      }
    };

    const onMouseMove = (moveEvent) => {
      updateArmFromCoords(moveEvent.clientX, moveEvent.clientY);
    };

    const onMouseUp = (upEvent) => {
      isDraggingTonearm = false;
      tonearm.isDragging = false;
      armEl.classList.remove('arm-grabbing');
      tooltip.classList.add('hidden');
      
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // Perform Needle Drop check
      const radius = tonearm.getNeedleRadius(tonearm.currentAngle);
      if (tonearm.isOverRecord(tonearm.currentAngle) && audio.originalBuffer) {
        // Position needle dropped
        tonearm.setLifted(false);
        
        // Seek playhead position
        const progress = tonearm.getPlaybackProgress(radius);
        audio.seek(progress * audio.duration);
        
        // Bounce visual class
        armEl.classList.add('arm-bouncing');
        setTimeout(() => armEl.classList.remove('arm-bouncing'), 500);
      } else {
        // Dragged outside, snap back to resting position
        tonearm.setLifted(true);
        tonearm.targetAngle = tonearm.angleRest;
      }
      updateTransportGUI();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    
    // Send immediate click coords
    updateArmFromCoords(e.clientX, e.clientY);
  });
}

/**
 * Grabs vinyl platter and supports analog mouse-scratching scrubbing
 */
function setupPlatterScratching() {
  const zone = document.getElementById('platter-hover-zone');
  const bed = document.querySelector('.turntable-bed');
  const statusBox = document.getElementById('drag-status-indicator');

  zone.addEventListener('mousedown', (e) => {
    // Only scratch with left mouse click, when not dragging tonearm, when record loaded, and needle drop active
    if (e.button !== 0 || isDraggingTonearm || !audio.originalBuffer || !tonearm.isDropped) return;

    e.preventDefault();
    isScratching = true;
    
    // Halt regular audio loop
    audio.pause();
    updateTransportGUI();
    
    statusBox.textContent = "SCRATCHING RECORD (ACTIVE)";
    statusBox.classList.add('drag-box-active');

    const bedRect = bed.getBoundingClientRect();
    const platterCenterX = platter.canvas.width / 2;
    const platterCenterY = platter.canvas.height / 2;
    
    // Absolute center coordinate of platter on the screen
    const px = bedRect.left + platter.canvas.offsetLeft + platterCenterX;
    const py = bedRect.top + platter.canvas.offsetTop + platterCenterY;

    lastScratchAngle = Math.atan2(e.clientY - py, e.clientX - px);
    scratchVelocity = 0;
    scratchSpeedFactor = 0;

    let lastScratchTime = performance.now();

    const onMouseMove = (moveEvent) => {
      const mx = moveEvent.clientX - px;
      const my = moveEvent.clientY - py;
      const currentAngle = Math.atan2(my, mx);

      let deltaAngle = currentAngle - lastScratchAngle;

      // Handle wrapping at -PI to PI crossings
      if (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;
      if (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2;

      // Rotate platter canvas visually
      platter.nudgeAngle(deltaAngle);
      lastScratchAngle = currentAngle;

      const now = performance.now();
      const frameDt = now - lastScratchTime;
      lastScratchTime = now;

      if (frameDt > 0) {
        const velocity = deltaAngle / (frameDt / 1000); // rad/s
        // Smooth out velocity spikes using a low-pass filter
        scratchVelocity = scratchVelocity * 0.35 + velocity * 0.65;
      }

      // Convert angular velocity to speed factor relative to base speed (33.33 RPM)
      // Rad/sec for 33.33 RPM = (33.33 / 60) * 2 * PI ~ 3.49 rad/s
      const baseRadPerSec = (33.33 / 60) * Math.PI * 2;
      scratchSpeedFactor = scratchVelocity / baseRadPerSec;

      // Pitch pull slider support
      const compositeFactor = scratchSpeedFactor * getCompositePitchSpeed();

      // Scrub audio dynamically
      audio.scratchTo(compositeFactor);

      // Advance playhead time
      const deltaSec = compositeFactor * (frameDt / 1000);
      audio.currentTime += deltaSec;
      if (audio.currentTime < 0) audio.currentTime = 0;
      if (audio.currentTime > audio.duration) audio.currentTime = audio.duration;
    };

    const onMouseUp = () => {
      isScratching = false;
      audio.endScratch();
      
      statusBox.textContent = "DRAG & DROP AUDIO FILE HERE TO LOAD RECORD";
      statusBox.classList.remove('drag-box-active');

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // If motor is ON and needle dropped, resume standard playback
      if (isMotorOn && tonearm.isDropped && audio.originalBuffer) {
        audio.play(getCompositePitchSpeed());
      }
      updateTransportGUI();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}

// ----------------------------------------------------
// 4. Drag-and-Drop Loader & Network Covers
// ----------------------------------------------------
function setupDragAndDrop() {
  const container = document.getElementById('app-container');
  const overlay = document.getElementById('drop-overlay');
  const statusBox = document.getElementById('drag-status-indicator');

  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    overlay.classList.remove('hidden');
    statusBox.classList.add('drag-box-active');
  });

  overlay.addEventListener('dragleave', () => {
    overlay.classList.add('hidden');
    statusBox.classList.remove('drag-box-active');
  });

  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    overlay.classList.add('hidden');
    statusBox.classList.remove('drag-box-active');

    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    await importAudioFiles(Array.from(files), { loadFirst: true });
  });
}

async function importAudioFiles(files, options = {}) {
  const { loadFirst = false, statusTarget = null } = options;
  const overlay = document.getElementById('drop-overlay');
  const statusBox = document.getElementById('drag-status-indicator');
  const validFiles = files.filter(isSupportedAudioFile);
  let importedCount = 0;
  let loadedFirstTrack = false;

  if (validFiles.length === 0) return 0;

  document.querySelector('.overlay-text').textContent = 'DECODING AUDIO BUFFER & PARSING METADATA...';
  overlay.classList.remove('hidden');

  for (const file of validFiles) {
    try {
      const fileBuffer = await file.arrayBuffer();
      const libraryBuffer = fileBuffer.slice(0);
      const shouldLoad = loadFirst && !loadedFirstTrack;
      const info = shouldLoad ? await audio.loadFile(fileBuffer) : await audio.analyzeFile(fileBuffer.slice(0));
      const metadata = await parseMetadata(file);
      applyLocalAnalysisFallback(metadata, info);
      const trackId = addToLibrary(file.name, metadata, libraryBuffer, info.duration);

      if (shouldLoad) {
        loadTrackOntoPlatter(trackId, metadata, info);
        loadedFirstTrack = true;
      }

      importedCount++;
      if (statusTarget) {
        statusTarget.textContent = `Imported ${importedCount} of ${validFiles.length} tracks...`;
      }
    } catch (err) {
      console.error('Error importing audio file:', file.name, err);
    }
  }

  overlay.classList.add('hidden');
  document.querySelector('.overlay-text').textContent = 'DROP FILE TO LOAD VINYL RECORD';
  updateTransportGUI();

  statusBox.textContent = `${importedCount} TRACK${importedCount === 1 ? '' : 'S'} IMPORTED`;
  setTimeout(() => {
    statusBox.textContent = 'DRAG & DROP AUDIO FILE HERE TO LOAD RECORD';
  }, 3500);

  return importedCount;
}

function isSupportedAudioFile(file) {
  const extension = file.name.substring(file.name.lastIndexOf('.') + 1).toLowerCase();
  return SUPPORTED_AUDIO_EXTENSIONS.includes(extension);
}

function setupTitleScroll() {
  const container = document.getElementById('dot-matrix-screen');
  const titleEl = document.getElementById('display-title');
  
  if (displayScrollInterval) clearInterval(displayScrollInterval);
  titleEl.classList.remove('active-scroll');

  // Check overflow
  if (titleEl.scrollWidth > titleEl.clientWidth) {
    titleEl.classList.add('active-scroll');
  }
}

// ----------------------------------------------------
// 5. Unified Animation 60fps Ticker Loop
// ----------------------------------------------------
function simulationLoop(now) {
  const dt = now - lastTickTime;
  lastTickTime = now;

  // Update playhead positions
  audio.updatePlayhead();
  const playheadPct = audio.duration ? (audio.currentTime / audio.duration) : 0;

  // Calculate needle angle relative to platter center
  const stylus = tonearm.getStylusCoordinates();
  const dx = stylus.x - tonearm.xPlatter;
  const dy = stylus.y - tonearm.yPlatter;
  const needleAngle = Math.atan2(dy, dx);

  // 1. Advance visual platter rotation kinematics with dynamic playhead alignment
  const instantRPS = platter.tick(dt, playheadPct, needleAngle);

  // Strobe pulsing frequency match indicator
  // A real 50Hz light cycles. We pulse strobe LED based on rotational matching logic!
  const strobeLed = document.getElementById('strobe-light');
  if (isMotorOn && Math.abs(instantRPS) > 0.05) {
    strobeLed.classList.add('strobe-active');
  } else {
    strobeLed.classList.remove('strobe-active');
  }

  // 2. Linear speed-pitch coupling
  // Compute target pitch based on actual platter speed relative to standard recording speed (33.33 RPM)
  if (audio.originalBuffer && audio.isPlaying && !isScratching && !audio.isTapeStopping) {
    const recordBaseRPM = 33.33; // Fixed base recording RPM for standard LP
    const baseRPS = recordBaseRPM / 60;
    
    // Instantaneous speed factor relative to standard recording speed
    let speedFactor = Math.abs(instantRPS) / baseRPS;
    
    // Prevent zero speed buffer freezes or negative speed directions
    if (speedFactor < 0.01) speedFactor = 0.01;
    
    audio.setSpeedMultiplier(speedFactor);
  }

  // 3. Realtime Audio Analysis & Tonearm physical sweeps with dynamic music vibration
  const analyserData = audio.getAnalyserData();
  let liveAmplitude = 0;
  let baseLevel = 0;
  
  if (analyserData && audio.isPlaying) {
    // Compute overall sound envelope/amplitude
    let sum = 0;
    for (let i = 0; i < analyserData.length; i++) {
      sum += analyserData[i];
    }
    liveAmplitude = sum / analyserData.length / 255;

    // Average first 5 low bin frequencies (representing bass kick) for ambient glow
    for (let i = 0; i < 5; i++) {
      baseLevel += analyserData[i];
    }
    baseLevel = baseLevel / 5 / 255; // Normalize 0 to 1
  }

  tonearm.tick(dt, playheadPct, audio.isPlaying, liveAmplitude);
  const ambient = document.getElementById('ambient-glow');
  if (audio.isPlaying && baseLevel > 0.1) {
    ambient.style.opacity = `${0.3 + baseLevel * 0.7}`;
    ambient.style.transform = `translate(-50%, -50%) scale(${1.0 + baseLevel * 0.15})`;
  } else {
    ambient.style.opacity = audio.isPlaying ? '0.2' : '0.0';
    ambient.style.transform = 'translate(-50%, -50%) scale(1.0)';
  }

  // 6. Refresh Dot-Matrix Display parameters
  updateScreenHUD();

  // Continue unified animation ticker loop
  requestAnimationFrame(simulationLoop);
}

// ----------------------------------------------------
// 6. Utility Functions
// ----------------------------------------------------

function updateScreenHUD() {
  if (!audio.originalBuffer) {
    document.getElementById('display-elapsed').textContent = '00:00.00';
    document.getElementById('display-remaining').textContent = '-00:00.00';
    document.getElementById('display-bpm').textContent = '---';
    document.getElementById('display-key').textContent = '---';
    return;
  }

  const elapsed = audio.currentTime;
  const remaining = Math.max(0, audio.duration - elapsed);

  document.getElementById('display-elapsed').textContent = formatTimePrecise(elapsed);
  document.getElementById('display-remaining').textContent = `-${formatTimePrecise(remaining)}`;
  updateBpmDisplay(getActiveTrackMetadata());
}

function updateTransportGUI() {
  const playBtn = document.getElementById('btn-play');
  const playText = document.getElementById('play-text');
  
  if (audio.isPlaying) {
    playBtn.classList.add('active-play');
    playText.textContent = 'PAUSE';
    document.getElementById('play-icon').innerHTML = `<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>`;
  } else {
    playBtn.classList.remove('active-play');
    playText.textContent = 'PLAY';
    document.getElementById('play-icon').innerHTML = `<path d="M8 5v14l11-7z"/>`;
  }
}

function getCompositePitchSpeed() {
  const pitchMult = 1.0 + (pitchSliderPercent / 100.0);
  return pitchMult;
}

function toggleTheme() {
  activeTheme = activeTheme === 'light' ? 'dark' : 'light';
  applyTheme();
  saveSettingsToStorage();
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', activeTheme);
  platter.setTheme(activeTheme);
  applyAccentColor();

  const themeToggle = document.getElementById('theme-toggle');
  if (themeToggle) {
    themeToggle.setAttribute('aria-checked', activeTheme === 'dark' ? 'true' : 'false');
  }

  const themeText = document.getElementById('theme-text');
  if (themeText) {
    themeText.textContent = activeTheme === 'dark' ? 'Dark theme active' : 'Light theme active';
  }
}

function applyAccentColor() {
  const root = document.documentElement;
  const isCustom = activeColorPreset === 'custom';
  const preset = COLOR_PRESETS[activeColorPreset] || COLOR_PRESETS.ember;
  const accentColor = isCustom ? normalizeHexColor(customAccentColor, COLOR_PRESETS.ember.color) : preset.color;

  root.setAttribute('data-color-preset', isCustom ? 'custom' : activeColorPreset);

  if (isCustom) {
    root.style.setProperty('--accent-color', accentColor);
    root.style.setProperty('--accent-glow', hexToRgba(accentColor, activeTheme === 'dark' ? 0.35 : 0.24));
    root.style.setProperty('--strobe-color', hexToRgba(accentColor, 0.88));
    root.style.setProperty('--screen-accent-glow', hexToRgba(accentColor, 0.08));
    root.style.setProperty('--screen-accent-border', hexToRgba(accentColor, 0.2));
  } else {
    root.style.removeProperty('--accent-color');
    root.style.removeProperty('--accent-glow');
    root.style.removeProperty('--strobe-color');
    root.style.removeProperty('--screen-accent-glow');
    root.style.removeProperty('--screen-accent-border');
  }

  document.querySelectorAll('.color-preset[data-color-preset]').forEach(button => {
    button.classList.toggle('active', button.getAttribute('data-color-preset') === activeColorPreset);
  });

  document.querySelector('.color-preset.custom')?.classList.toggle('active', isCustom);

  document.querySelectorAll('.onboarding-color-choice').forEach(button => {
    button.classList.toggle('selected', button.getAttribute('data-color-preset') === activeColorPreset);
  });

  const customPicker = document.getElementById('custom-accent-color');
  if (customPicker) customPicker.value = accentColor;

  platter.setAccentColor(accentColor);

  const customSwatch = document.querySelector('.color-preset.custom span');
  if (customSwatch) customSwatch.style.background = accentColor;

  const onboardingCustomDot = document.getElementById('onboarding-custom-color-dot');
  if (onboardingCustomDot) onboardingCustomDot.style.background = accentColor;

  const colorText = document.getElementById('color-theme-text');
  if (colorText) {
    colorText.textContent = isCustom ? 'Custom accent active' : `${preset.name} accent active`;
  }
}

function normalizeHexColor(value, fallback) {
  const hex = String(value || '').trim();
  return /^#[0-9A-Fa-f]{6}$/.test(hex) ? hex.toUpperCase() : fallback;
}

function hexToRgba(hex, alpha) {
  const normalized = normalizeHexColor(hex, COLOR_PRESETS.ember.color);
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function formatTimePrecise(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.floor((secs % 1) * 100);
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
}

/**
 * Handle fully functional physical keyboard mappings
 */
function handleKeyboardShortcuts(e) {
  // If user is focused in an input box, ignore
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

  // Handle active key rebind mode
  if (activeBindingAction) {
    e.preventDefault();
    const activeCap = document.getElementById(`bind-${activeBindingAction}`);
    if (activeCap) {
      activeCap.classList.remove('binding-active');
    }
    
    if (e.key === 'Escape') {
      if (activeCap) activeCap.textContent = keyBindings[activeBindingAction];
      activeBindingAction = null;
      return;
    }
    
    let keyName = e.key.toUpperCase();
    if (e.code === 'Space' || e.key === ' ') {
      keyName = 'SPACE';
    }
    
    keyBindings[activeBindingAction] = keyName;
    if (activeCap) activeCap.textContent = keyName;
    activeBindingAction = null;
    saveSettingsToStorage();
    return;
  }

  const key = e.key.toUpperCase();
  const code = e.code;
  
  // Dynamic rebind match helper
  const isMatch = (action) => {
    const bind = keyBindings[action];
    if (!bind) return false;
    if (bind === 'SPACE') return code === 'Space' || key === ' ';
    return key === bind.toUpperCase();
  };

  if (isMatch('motor')) {
    e.preventDefault();
    toggleMotorPower();
  } else if (isMatch('play')) {
    e.preventDefault();
    togglePlay();
  } else if (isMatch('reverse')) {
    e.preventDefault();
    toggleDirection();
  } else if (isMatch('stop') || e.key === 'Escape') {
    e.preventDefault();
    stopPlayer();
  } else if (isMatch('eject')) {
    e.preventDefault();
    ejectRecord();
  } else if (isMatch('library')) {
    e.preventDefault();
    toggleLibrary();
  } else if (isMatch('settings')) {
    e.preventDefault();
    toggleSettings();
  } else if (key === 'C') {
    e.preventDefault();
    // Toggle Crackle volume between 0% and 30%
    const knob = document.getElementById('crackle-knob');
    let val = parseInt(knob.getAttribute('data-value')) || 0;
    val = val > 0 ? 0 : 30;
    knob.setAttribute('data-value', val);
    const angle = (val / 100) * 280 - 140;
    knob.style.transform = `rotate(${angle}deg)`;
    document.getElementById('crackle-value').textContent = `${val}%`;
    audio.setCrackleLevel(val);
  } else if (key === 'M') {
    e.preventDefault();
    audio.setMute(!audio.isMuted);
    const statusBox = document.getElementById('drag-status-indicator');
    statusBox.textContent = audio.isMuted ? 'AUDIO OUTPUT MUTED' : 'AUDIO OUTPUT UNMUTED';
    setTimeout(() => {
      statusBox.textContent = 'DRAG & DROP AUDIO FILE HERE TO LOAD RECORD';
    }, 2500);
  } else if (key === 'T') {
    e.preventDefault();
    toggleTheme();
  } else if (['1', '2', '3', '4'].includes(key)) {
    e.preventDefault();
    const rpmMap = { '1': 16, '2': 33, '3': 45, '4': 78 };
    setRPM(rpmMap[key]);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    pitchSliderPercent = Math.min(50.0, pitchSliderPercent + 1.0);
    applyPitch();
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    pitchSliderPercent = Math.max(-50.0, pitchSliderPercent - 1.0);
    applyPitch();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    // Seek back 5 seconds
    if (audio.originalBuffer) {
      audio.seek(audio.currentTime - 5);
    }
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    // Seek forward 5 seconds
    if (audio.originalBuffer) {
      audio.seek(audio.currentTime + 5);
    }
  }
}

// ----------------------------------------------------
// 8. Library Sidebar System
// ----------------------------------------------------

function openLibraryDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(LIBRARY_DB_NAME, LIBRARY_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LIBRARY_STORE_NAME)) {
        db.createObjectStore(LIBRARY_STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveLibraryToStorage() {
  try {
    const storedLibrary = trackLibrary.map(track => ({
      ...track,
      metadata: normalizeMetadataForLibrary(track.metadata || {})
    }));
    const db = await openLibraryDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(LIBRARY_STORE_NAME, 'readwrite');
      const store = tx.objectStore(LIBRARY_STORE_NAME);
      store.put({
        trackLibrary: storedLibrary,
        libraryIdCounter,
        activeTrackId
      }, LIBRARY_STATE_KEY);

      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('Error saving library:', err);
  }
}

async function loadLibraryFromStorage() {
  try {
    const db = await openLibraryDatabase();
    const saved = await new Promise((resolve, reject) => {
      const tx = db.transaction(LIBRARY_STORE_NAME, 'readonly');
      const store = tx.objectStore(LIBRARY_STORE_NAME);
      const request = store.get(LIBRARY_STATE_KEY);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();

    if (!saved || !Array.isArray(saved.trackLibrary)) return;

    trackLibrary = saved.trackLibrary
      .filter(track => track && track.fileBuffer)
      .map(track => ({
        ...track,
        metadata: reviveStoredMetadata(track.metadata || {}),
        fileBuffer: track.fileBuffer
      }));

    libraryIdCounter = saved.libraryIdCounter || trackLibrary.reduce((max, track) => Math.max(max, track.id || 0), 0);
    activeTrackId = saved.activeTrackId || null;
    renderLibrary();

    if (activeTrackId && trackLibrary.some(track => track.id === activeTrackId)) {
      restoreActiveTrackFromLibrary(activeTrackId);
    } else {
      activeTrackId = null;
    }
  } catch (err) {
    console.warn('Error reading saved library:', err);
  }
}

function reviveStoredMetadata(metadata) {
  const revived = { ...metadata };
  if (revived.coverBlob instanceof Blob) {
    if (revived.coverObjectUrl) URL.revokeObjectURL(revived.coverObjectUrl);
    revived.coverObjectUrl = URL.createObjectURL(revived.coverBlob);
    revived.coverUrl = revived.coverObjectUrl;
  }
  return revived;
}

function normalizeMetadataForLibrary(metadata) {
  return {
    ...metadata,
    coverObjectUrl: undefined
  };
}

async function restoreActiveTrackFromLibrary(trackId) {
  const track = trackLibrary.find(t => t.id === trackId);
  if (!track) return;

  try {
    const info = await audio.loadFile(track.fileBuffer.slice(0));
    applyLocalAnalysisFallback(track.metadata, info);
    loadTrackOntoPlatter(track.id, track.metadata, info, track.visualState, { animate: false, save: false });
  } catch (err) {
    console.warn('Error restoring active library track:', err);
    activeTrackId = null;
    renderLibrary();
  }
}

/**
 * Add a track to the persistent library
 */
function addToLibrary(fileName, metadata, fileBuffer, duration) {
  // Check if file already exists in library (by filename)
  const existing = trackLibrary.find(t => t.fileName === fileName);
  if (existing) {
    existing.metadata = normalizeMetadataForLibrary(metadata);
    existing.fileBuffer = fileBuffer.slice(0);
    existing.duration = duration;
    saveLibraryToStorage();
    renderLibrary();
    return existing.id;
  }

  const id = ++libraryIdCounter;

  trackLibrary.push({
    id,
    fileName,
    metadata: normalizeMetadataForLibrary(metadata),
    fileBuffer: fileBuffer.slice(0), // Clone the buffer
    duration,
    visualState: null
  });

  renderLibrary();
  saveLibraryToStorage();
  return id;
}

/**
 * Load a track from the library onto the platter
 */
async function loadTrackFromLibrary(trackId) {
  const track = trackLibrary.find(t => t.id === trackId);
  if (!track) return;

  const overlay = document.getElementById('drop-overlay');
  const statusBox = document.getElementById('drag-status-indicator');

  document.querySelector('.overlay-text').textContent = 'LOADING FROM LIBRARY...';
  overlay.classList.remove('hidden');

  try {
    const info = await audio.loadFile(track.fileBuffer.slice(0));
    applyLocalAnalysisFallback(track.metadata, info);
    loadTrackOntoPlatter(track.id, track.metadata, info, track.visualState);

    statusBox.textContent = `${track.metadata.title.toUpperCase()} LOADED FROM LIBRARY`;
    setTimeout(() => {
      statusBox.textContent = 'DRAG & DROP AUDIO FILE HERE TO LOAD RECORD';
    }, 3500);
  } catch (err) {
    console.error(err);
    statusBox.textContent = 'ERROR LOADING TRACK FROM LIBRARY';
    setTimeout(() => {
      statusBox.textContent = 'DRAG & DROP AUDIO FILE HERE TO LOAD RECORD';
    }, 3000);
  } finally {
    overlay.classList.add('hidden');
    document.querySelector('.overlay-text').textContent = 'DROP FILE TO LOAD VINYL RECORD';
    updateTransportGUI();
  }
}

/**
 * Shared function to load a track onto the platter with animation
 */
function loadTrackOntoPlatter(trackId, metadata, info, visualState = null, options = {}) {
  const { animate = true, save = true } = options;
  activeTrackId = trackId;

  // Vinyl load-in animation
  const wrapper = document.getElementById('platter-wrapper');
  if (animate) {
    wrapper.classList.remove('ejecting', 'loading-vinyl');
    void wrapper.offsetWidth; // Force reflow
    wrapper.classList.add('loading-vinyl');
    wrapper.addEventListener('animationend', function handler() {
      wrapper.classList.remove('loading-vinyl');
      wrapper.removeEventListener('animationend', handler);
    });
  } else {
    wrapper.classList.remove('ejecting', 'loading-vinyl');
  }

  // Load into Platter
  platter.loadTrack(metadata, audio.originalBuffer, visualState);
  updateTrackBackdrop(metadata);

  const track = trackLibrary.find(t => t.id === trackId);
  if (track) {
    track.visualState = platter.getVisualState();
  }

  // Update screen text
  document.getElementById('display-title').textContent = metadata.title.toUpperCase();
  document.getElementById('display-artist').textContent = metadata.artist.toUpperCase();
  updateBpmDisplay(metadata);
  updateKeyDisplay(metadata);
  
  // Auto-scroll title if it exceeds box boundary
  setupTitleScroll();

  // Lift arm and ready it at the outer groove automatically for convenience!
  tonearm.setLifted(false);
  tonearm.targetAngle = tonearm.angleOuter;
  tonearm.currentAngle = tonearm.angleOuter;

  // Highlight active track in library
  renderLibrary();
  if (save) saveLibraryToStorage();
  isEjecting = false;
}

function formatBpm(bpm) {
  const numericBpm = Number(bpm);
  return Number.isFinite(numericBpm) && numericBpm > 0 ? Math.round(numericBpm) : '---';
}

function updateBpmDisplay(metadata) {
  const bpmEl = document.getElementById('display-bpm');
  if (!bpmEl) return;

  const baseBpm = Number(metadata?.bpm);
  if (!Number.isFinite(baseBpm) || baseBpm <= 0) {
    bpmEl.textContent = '---';
    return;
  }

  bpmEl.textContent = formatBpm(baseBpm * getEffectiveTempoMultiplier());
}

function updateKeyDisplay(metadata) {
  const keyEl = document.getElementById('display-key');
  if (!keyEl) return;
  keyEl.textContent = formatKey(metadata?.key, getEffectiveSemitoneShift());
}

function getEffectiveTempoMultiplier() {
  const rpmFactor = getPlaybackRpm(currentRPM) / 33.33;
  return rpmFactor * getCompositePitchSpeed();
}

function getEffectiveSemitoneShift() {
  return Math.round(12 * Math.log2(getEffectiveTempoMultiplier()));
}

function getPlaybackRpm(rpm) {
  return rpm === 33 ? 33.33 : rpm;
}

function formatRpm(rpm) {
  return rpm === 33 ? '33.3' : String(rpm);
}

function getActiveTrackMetadata() {
  return trackLibrary.find(track => track.id === activeTrackId)?.metadata || null;
}

function formatKey(key, semitoneShift = 0) {
  const parsed = parseKeyName(key);
  if (!parsed) return '---';

  const names = parsed.prefersSharps
    ? ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    : ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const shiftedRoot = (parsed.root + semitoneShift % 12 + 12) % 12;
  const mode = parsed.minor ? 'min' : 'maj';
  return `${names[shiftedRoot]} ${mode}`;
}

function parseKeyName(key) {
  const raw = String(key || '').trim();
  if (!raw) return null;

  const match = raw.match(/^([A-Ga-g])([#b♯♭]?)(m|min|minor|maj|major)?$/);
  if (!match) return null;

  const letter = match[1].toUpperCase();
  const accidental = match[2].replace('♯', '#').replace('♭', 'b');
  const mode = (match[3] || '').toLowerCase();
  const roots = {
    C: 0, 'C#': 1, Db: 1,
    D: 2, 'D#': 3, Eb: 3,
    E: 4,
    F: 5, 'F#': 6, Gb: 6,
    G: 7, 'G#': 8, Ab: 8,
    A: 9, 'A#': 10, Bb: 10,
    B: 11
  };
  const name = `${letter}${accidental}`;
  const root = roots[name];
  if (root === undefined) return null;

  return {
    root,
    minor: mode === 'm' || mode === 'min' || mode === 'minor',
    prefersSharps: accidental === '#'
  };
}

function applyLocalAnalysisFallback(metadata, info) {
  if (!metadata || !info) return;
  const shouldRefreshAnalysis = metadata.analysisVersion !== LOCAL_ANALYSIS_VERSION;

  if ((shouldRefreshAnalysis || !metadata.bpm) && info.bpm) {
    metadata.bpm = info.bpm;
    metadata.bpmSource = 'Audio Analysis';
    metadata.bpmConfidence = info.bpmConfidence || 0;
  }

  if ((shouldRefreshAnalysis || !metadata.key) && info.key) {
    metadata.key = info.key;
    metadata.keySource = 'Audio Analysis';
    metadata.keyConfidence = info.keyConfidence || 0;
  }

  metadata.analysisVersion = LOCAL_ANALYSIS_VERSION;
}

function updateTrackBackdrop(metadata) {
  const backdrop = document.getElementById('track-backdrop');
  if (!backdrop) return;

  const imageUrl = metadata ? (metadata.backgroundUrl || metadata.coverUrl) : null;
  if (!imageUrl) {
    backdrop.classList.remove('active');
    backdrop.style.backgroundImage = '';
    return;
  }

  metadata.backgroundUrl = imageUrl;
  backdrop.style.backgroundImage = `url("${String(imageUrl).replace(/"/g, '%22')}")`;
  backdrop.classList.add('active');
}

/**
 * Render the library sidebar list
 */
function renderLibrary() {
  const listEl = document.getElementById('library-list');
  const countEl = document.getElementById('library-track-count');
  
  countEl.textContent = trackLibrary.length;

  if (trackLibrary.length === 0) {
    listEl.innerHTML = `
      <div class="library-empty font-mono">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round">
          <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
          <line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/>
        </svg>
        <span>NO TRACKS LOADED</span>
        <span class="library-empty-sub">DRAG & DROP AUDIO FILES TO ADD</span>
      </div>
    `;
    return;
  }

  listEl.innerHTML = trackLibrary.map(track => {
    const isActive = track.id === activeTrackId;
    const dur = track.duration ? formatTime(track.duration) : '--:--';
    const coverHtml = track.metadata.coverUrl
      ? `<img src="${track.metadata.coverUrl}" alt="Cover" />`
      : `<div class="library-track-art-placeholder">
           <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
             <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
           </svg>
         </div>`;

    return `
      <div class="library-track ${isActive ? 'active-track' : ''}" data-track-id="${track.id}">
        <div class="library-track-art">${coverHtml}</div>
        <div class="library-track-info">
          <div class="library-track-title">${escapeHtml(track.metadata.title)}</div>
          <div class="library-track-artist">${escapeHtml(track.metadata.artist)}</div>
          <div class="library-track-album">${escapeHtml(track.metadata.album || 'Unknown Album')}</div>
        </div>
        <div class="library-track-actions">
          <div class="library-track-duration font-mono">${dur}</div>
          <button class="btn-track-delete" data-track-id="${track.id}" title="Delete ${escapeHtml(track.metadata.title)}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18"/>
              <path d="M8 6V4h8v2"/>
              <path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v5M14 11v5"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Attach click handlers
  listEl.querySelectorAll('.library-track').forEach(el => {
    el.addEventListener('click', () => {
      const id = parseInt(el.getAttribute('data-track-id'));
      loadTrackFromLibrary(id);
    });
  });

  listEl.querySelectorAll('.btn-track-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = parseInt(e.currentTarget.getAttribute('data-track-id'));
      openDeleteConfirm(id);
    });
  });
}

function openDeleteConfirm(trackId) {
  const track = trackLibrary.find(t => t.id === trackId);
  if (!track) return;

  pendingDeleteTrackId = trackId;
  document.getElementById('delete-confirm-message').textContent =
    `Delete "${track.metadata.title}" from your library? This removes the saved copy from NEEDLE.`;
  document.getElementById('delete-confirm-modal').classList.remove('hidden');
}

function closeDeleteConfirm() {
  pendingDeleteTrackId = null;
  document.getElementById('delete-confirm-modal').classList.add('hidden');
}

function confirmDeleteTrack() {
  if (!pendingDeleteTrackId) return;
  deleteTrackFromLibrary(pendingDeleteTrackId);
  closeDeleteConfirm();
}

function deleteTrackFromLibrary(trackId) {
  const trackIndex = trackLibrary.findIndex(t => t.id === trackId);
  if (trackIndex === -1) return;

  const [deletedTrack] = trackLibrary.splice(trackIndex, 1);
  if (deletedTrack.metadata?.coverObjectUrl) {
    URL.revokeObjectURL(deletedTrack.metadata.coverObjectUrl);
  }

  if (activeTrackId === trackId) {
    unloadActiveTrackAfterDelete();
  }

  saveLibraryToStorage();
  renderLibrary();

  const statusBox = document.getElementById('drag-status-indicator');
  statusBox.textContent = `${deletedTrack.metadata.title.toUpperCase()} DELETED FROM LIBRARY`;
  setTimeout(() => {
    statusBox.textContent = 'DRAG & DROP AUDIO FILE HERE TO LOAD RECORD';
  }, 3000);
}

function unloadActiveTrackAfterDelete() {
  if (audio.isPlaying || audio.isTapeStopping) {
    audio.cancelTapeStop();
    audio.pause();
  }
  audio.stop();
  audio.originalBuffer = null;
  audio.reversedBuffer = null;
  platter.unloadTrack();
  updateTrackBackdrop(null);
  activeTrackId = null;
  tonearm.setLifted(true);
  tonearm.targetAngle = tonearm.angleRest;

  document.getElementById('display-title').textContent = 'NO RECORD LOADED';
  document.getElementById('display-artist').textContent = 'INSERT FILE';
  document.getElementById('display-bpm').textContent = '---';
  document.getElementById('display-key').textContent = '---';
  document.getElementById('display-elapsed').textContent = '00:00.00';
  document.getElementById('display-remaining').textContent = '-00:00.00';
  updateTransportGUI();
}

/**
 * Toggle library sidebar visibility
 */
function toggleLibrary() {
  isLibraryOpen = !isLibraryOpen;
  const panel = document.getElementById('library-panel');
  const toggleBtn = document.getElementById('btn-library-toggle');
  
  if (isLibraryOpen && isSettingsOpen) {
    toggleSettings();
  }
  
  if (isLibraryOpen) {
    panel.classList.add('open');
    toggleBtn.classList.add('active');
  } else {
    panel.classList.remove('open');
    toggleBtn.classList.remove('active');
  }
}

// ----------------------------------------------------
// 9. Eject Record System
// ----------------------------------------------------

/**
 * Eject the currently loaded vinyl record with a physical lift animation
 */
function ejectRecord() {
  if (!audio.originalBuffer || isEjecting) return;

  isEjecting = true;

  // Stop playback first
  if (audio.isPlaying || audio.isTapeStopping) {
    audio.cancelTapeStop();
    audio.pause();
  }

  // Lift tonearm to resting position
  tonearm.setLifted(true);
  tonearm.targetAngle = tonearm.angleRest;

  // Stop motor
  if (isMotorOn) {
    toggleMotorPower();
  }

  // Trigger eject animation on the platter wrapper
  const wrapper = document.getElementById('platter-wrapper');
  wrapper.classList.remove('loading-vinyl', 'tape-stopping');
  wrapper.classList.add('ejecting');

  // After animation completes, unload the track
  wrapper.addEventListener('animationend', function handler() {
    wrapper.classList.remove('ejecting');
    wrapper.removeEventListener('animationend', handler);

    // Unload the track from the platter and audio engine
    audio.stop();
    audio.originalBuffer = null;
    audio.reversedBuffer = null;
    platter.unloadTrack();
    updateTrackBackdrop(null);
    activeTrackId = null;

    // Reset display screen
    document.getElementById('display-title').textContent = 'NO RECORD LOADED';
    document.getElementById('display-artist').textContent = 'INSERT FILE';
    document.getElementById('display-bpm').textContent = '---';
    document.getElementById('display-key').textContent = '---';
    document.getElementById('display-elapsed').textContent = '00:00.00';
    document.getElementById('display-remaining').textContent = '-00:00.00';

    // Reset platter visual (make it visible again for next load)
    wrapper.style.transform = '';
    wrapper.style.opacity = '';

    updateTransportGUI();
    renderLibrary();
    saveLibraryToStorage();
    isEjecting = false;

    const statusBox = document.getElementById('drag-status-indicator');
    statusBox.textContent = 'RECORD EJECTED — DRAG NEW FILE TO LOAD';
    setTimeout(() => {
      statusBox.textContent = 'DRAG & DROP AUDIO FILE HERE TO LOAD RECORD';
    }, 3500);
  });
}

/**
 * Escape HTML entities for safe innerHTML insertion
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

/**
 * Toggle settings sidebar visibility
 */
function toggleSettings() {
  isSettingsOpen = !isSettingsOpen;
  const panel = document.getElementById('settings-panel');
  const toggleBtn = document.getElementById('btn-settings-toggle');
  
  if (isSettingsOpen && isLibraryOpen) {
    toggleLibrary();
  }
  
  if (isSettingsOpen) {
    panel.classList.add('open');
    toggleBtn.classList.add('active');
  } else {
    panel.classList.remove('open');
    toggleBtn.classList.remove('active');
  }
}

function setupOnboarding() {
  document.getElementById('btn-test-onboarding')?.addEventListener('click', () => {
    showOnboarding();
  });
  document.getElementById('btn-onboarding-close')?.addEventListener('click', hideOnboarding);
  document.getElementById('btn-onboarding-start')?.addEventListener('click', nextOnboardingStep);
  document.getElementById('btn-onboarding-back')?.addEventListener('click', previousOnboardingStep);
  document.getElementById('btn-import-music-folder')?.addEventListener('click', () => importFromOnboarding('music'));
  document.getElementById('btn-import-custom-folders')?.addEventListener('click', () => importFromOnboarding('custom'));

  document.querySelectorAll('.onboarding-choice').forEach(button => {
    button.addEventListener('click', () => {
      onboardingPurpose = button.getAttribute('data-purpose') || 'Listening';
      document.querySelectorAll('.onboarding-choice').forEach(choice => choice.classList.remove('selected'));
      button.classList.add('selected');
      saveSettingsToStorage();
    });
  });

  document.querySelectorAll('.onboarding-theme-choice').forEach(button => {
    button.addEventListener('click', () => {
      activeTheme = button.getAttribute('data-theme-choice') || 'light';
      document.querySelectorAll('.onboarding-theme-choice').forEach(choice => choice.classList.remove('selected'));
      button.classList.add('selected');
      applyTheme();
      saveSettingsToStorage();
    });
  });

  document.querySelectorAll('.onboarding-color-choice').forEach(button => {
    button.addEventListener('click', () => {
      const nextPreset = button.getAttribute('data-color-preset') || 'ember';
      activeColorPreset = nextPreset === 'custom' || COLOR_PRESETS[nextPreset] ? nextPreset : 'ember';
      applyAccentColor();
      saveSettingsToStorage();
    });
  });

  if (localStorage.getItem(ONBOARDING_STORAGE_KEY) !== 'seen') {
    showOnboarding();
  }
}

function showOnboarding() {
  onboardingStep = 0;
  syncOnboardingSelections();
  updateOnboardingStep();
  document.getElementById('onboarding-screen')?.classList.remove('hidden');
}

function hideOnboarding() {
  localStorage.setItem(ONBOARDING_STORAGE_KEY, 'seen');
  document.getElementById('onboarding-screen')?.classList.add('hidden');
}

function nextOnboardingStep() {
  if (onboardingStep >= 4) {
    hideOnboarding();
    return;
  }

  onboardingStep++;
  updateOnboardingStep();
}

function previousOnboardingStep() {
  onboardingStep = Math.max(0, onboardingStep - 1);
  updateOnboardingStep();
}

function updateOnboardingStep() {
  document.querySelectorAll('.onboarding-page').forEach(page => {
    page.classList.toggle('active', parseInt(page.getAttribute('data-onboarding-page')) === onboardingStep);
  });
  document.querySelectorAll('.onboarding-dot').forEach((dot, index) => {
    dot.classList.toggle('active', index === onboardingStep);
    dot.classList.toggle('complete', index < onboardingStep);
  });

  const backBtn = document.getElementById('btn-onboarding-back');
  const nextBtn = document.getElementById('btn-onboarding-start');
  if (backBtn) backBtn.disabled = onboardingStep === 0;
  if (nextBtn) {
    nextBtn.textContent = onboardingStep === 4 ? 'START LISTENING' : 'PROCEED';
  }
}

function syncOnboardingSelections() {
  document.querySelectorAll('.onboarding-choice').forEach(button => {
    button.classList.toggle('selected', button.getAttribute('data-purpose') === onboardingPurpose);
  });
  document.querySelectorAll('.onboarding-theme-choice').forEach(button => {
    button.classList.toggle('selected', button.getAttribute('data-theme-choice') === activeTheme);
  });
  document.querySelectorAll('.onboarding-color-choice').forEach(button => {
    button.classList.toggle('selected', button.getAttribute('data-color-preset') === activeColorPreset);
  });
}

async function importFromOnboarding(mode) {
  const statusEl = document.getElementById('onboarding-import-status');
  const sourceLabel = mode === 'music' ? 'Music folder' : 'selected folders';
  statusEl.textContent = `Scanning ${sourceLabel}...`;

  try {
    const result = mode === 'music'
      ? await window.electronAPI.importMusicFolder()
      : await window.electronAPI.selectAudioFolders();

    const importedPayloads = Array.isArray(result?.files) ? result.files : [];
    if (importedPayloads.length === 0) {
      statusEl.textContent = `No supported audio files found in ${sourceLabel}.`;
      return;
    }

    const folderNames = result.folders.map(folder => folder.name).join(', ');
    statusEl.textContent = `Found ${importedPayloads.length} tracks in ${folderNames}. Importing...`;
    const files = importedPayloads.map(createFileFromImportPayload);
    const importedCount = await importAudioFiles(files, { loadFirst: trackLibrary.length === 0, statusTarget: statusEl });
    statusEl.textContent = `${importedCount} track${importedCount === 1 ? '' : 's'} imported from ${folderNames}.`;
  } catch (error) {
    console.error('Onboarding import failed:', error);
    statusEl.textContent = 'Import failed. Choose a smaller folder or try again.';
  }
}

function createFileFromImportPayload(payload) {
  return new File([payload.bytes], payload.name, { type: getAudioMimeType(payload.name) });
}

function getAudioMimeType(fileName) {
  const extension = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
  const types = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    aiff: 'audio/aiff'
  };
  return types[extension] || 'audio/*';
}

function saveSettingsToStorage() {
  const data = {
    activeTheme,
    activeColorPreset,
    customAccentColor,
    tapeStopDuration,
    needleDropVolume,
    basePlatterInertia,
    onboardingPurpose,
    keyBindings
  };
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(data));
}

function loadSettings() {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (raw) {
    try {
      const data = JSON.parse(raw);
      if (data.activeTheme === 'light' || data.activeTheme === 'dark') activeTheme = data.activeTheme;
      if (data.activeColorPreset === 'custom' || COLOR_PRESETS[data.activeColorPreset]) {
        activeColorPreset = data.activeColorPreset;
      }
      if (data.customAccentColor) {
        customAccentColor = normalizeHexColor(data.customAccentColor, customAccentColor);
      }
      if (data.tapeStopDuration !== undefined) tapeStopDuration = data.tapeStopDuration;
      if (data.needleDropVolume !== undefined) needleDropVolume = data.needleDropVolume;
      if (data.basePlatterInertia !== undefined) {
        basePlatterInertia = data.basePlatterInertia;
        platter.inertia = basePlatterInertia;
      }
      if (data.onboardingPurpose) onboardingPurpose = data.onboardingPurpose;
      if (data.keyBindings) keyBindings = { ...keyBindings, ...data.keyBindings };
    } catch (e) {
      console.warn('Error reading saved settings:', e);
    }
  }

  applyTheme();

  // Update Settings UI elements
  document.getElementById('settings-tape-stop-duration').value = tapeStopDuration;
  document.getElementById('label-tape-stop-duration').textContent = `${tapeStopDuration}ms`;

  document.getElementById('settings-needle-drop-volume').value = Math.round(needleDropVolume * 100);
  document.getElementById('label-needle-drop-volume').textContent = `${Math.round(needleDropVolume * 100)}%`;

  // Map inertia value back to slider position 1-10
  const inertiaValues = {
    0.15: 1,
    0.09: 2,
    0.06: 3,
    0.04: 4,
    0.025: 5,
    0.015: 6,
    0.01: 7,
    0.007: 8,
    0.004: 9,
    0.002: 10
  };
  const sliderVal = inertiaValues[basePlatterInertia] || 4;
  document.getElementById('settings-platter-inertia').value = sliderVal;
  
  const inertiaTexts = {
    1: 'Very Fast',
    2: 'Fast',
    3: 'Medium Fast',
    4: 'Normal',
    5: 'Medium Slow',
    6: 'Slow',
    7: 'Very Slow',
    8: 'Laggy',
    9: 'Heavy Platter',
    10: 'Super Heavy'
  };
  document.getElementById('label-platter-inertia').textContent = inertiaTexts[sliderVal];

  updateBindingCaps();
}

function updateBindingCaps() {
  for (const action in keyBindings) {
    const el = document.getElementById(`bind-${action}`);
    if (el) {
      el.textContent = keyBindings[action];
    }
  }
}

function setupSettingsListeners() {
  document.querySelectorAll('.color-preset[data-color-preset]').forEach(button => {
    button.addEventListener('click', () => {
      const nextPreset = button.getAttribute('data-color-preset') || 'ember';
      activeColorPreset = COLOR_PRESETS[nextPreset] ? nextPreset : 'ember';
      applyAccentColor();
      saveSettingsToStorage();
    });
  });

  const customColorInput = document.getElementById('custom-accent-color');
  customColorInput?.addEventListener('input', (e) => {
    customAccentColor = normalizeHexColor(e.target.value, customAccentColor);
    activeColorPreset = 'custom';
    applyAccentColor();
    saveSettingsToStorage();
  });

  // Tape Stop Slider
  const tapeStopSlider = document.getElementById('settings-tape-stop-duration');
  const tapeStopLabel = document.getElementById('label-tape-stop-duration');
  tapeStopSlider.addEventListener('input', (e) => {
    tapeStopDuration = parseInt(e.target.value);
    tapeStopLabel.textContent = `${tapeStopDuration}ms`;
    saveSettingsToStorage();
  });

  // Needle drop volume
  const needleVolSlider = document.getElementById('settings-needle-drop-volume');
  const needleVolLabel = document.getElementById('label-needle-drop-volume');
  needleVolSlider.addEventListener('input', (e) => {
    needleDropVolume = parseFloat(e.target.value) / 100;
    needleVolLabel.textContent = `${e.target.value}%`;
    saveSettingsToStorage();
  });

  // Platter inertia
  const inertiaSlider = document.getElementById('settings-platter-inertia');
  const inertiaLabel = document.getElementById('label-platter-inertia');
  const inertiaTexts = {
    1: 'Very Fast',
    2: 'Fast',
    3: 'Medium Fast',
    4: 'Normal',
    5: 'Medium Slow',
    6: 'Slow',
    7: 'Very Slow',
    8: 'Laggy',
    9: 'Heavy Platter',
    10: 'Super Heavy'
  };
  const inertiaValues = {
    1: 0.15,
    2: 0.09,
    3: 0.06,
    4: 0.04,
    5: 0.025,
    6: 0.015,
    7: 0.01,
    8: 0.007,
    9: 0.004,
    10: 0.002
  };
  inertiaSlider.addEventListener('input', (e) => {
    const level = parseInt(e.target.value);
    basePlatterInertia = inertiaValues[level];
    inertiaLabel.textContent = inertiaTexts[level];
    platter.inertia = basePlatterInertia;
    saveSettingsToStorage();
  });

  // Keycap rebinding hooks
  document.querySelectorAll('.settings-key-cap').forEach(el => {
    el.addEventListener('click', (e) => {
      const action = e.target.getAttribute('data-action');
      
      // Cancel active binding first
      if (activeBindingAction) {
        const activeCap = document.getElementById(`bind-${activeBindingAction}`);
        if (activeCap) {
          activeCap.classList.remove('binding-active');
          activeCap.textContent = keyBindings[activeBindingAction];
        }
      }
      
      activeBindingAction = action;
      el.classList.add('binding-active');
      el.textContent = 'PRESS KEY...';
    });
  });

  // Reset Binds button
  document.getElementById('btn-reset-binds').addEventListener('click', () => {
    keyBindings = {
      motor: 'SPACE',
      play: 'P',
      stop: 'S',
      reverse: 'R',
      eject: 'E',
      library: 'L',
      settings: ','
    };
    updateBindingCaps();
    saveSettingsToStorage();
  });
}
