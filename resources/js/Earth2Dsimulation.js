// Earth2Dsimulation.js
// Import necessary modules and constants
import * as THREE from "three"; // Needed for Vector3 math
import * as d3 from "d3";
import { SCENE_EARTH_RADIUS } from "./parametersimulation.js";

// Import astronomical calculation functions
import {
  degToRad,
  radToDeg,
  getSubsolarPoint,
} from "./sunCalculations.js";

// --- Canvas Setup ---
const canvas = document.getElementById('map-2D-canvas');
if (!canvas) {
  console.error("CRITICAL: 'map-2D-canvas' element not found. 2D simulation disabled.");
  window.draw2D = () => {};
  window.resizeCanvas2D = () => {};
  throw new Error("2D canvas element not found, terminating Earth2Dsimulation.js");
}
const ctx = canvas.getContext('2d');

// --- D3 Projection & Path ---
let projection;
let pathGenerator;

// --- Texture Loading ---
const earthTexture = new Image();
const nightLightsTexture = new Image();
let texturesToLoad = 2;
window.texturesLoaded = false;

function textureLoaded() {
    if (--texturesToLoad === 0) {
        window.texturesLoaded = true;
        const loadingMessage = document.getElementById('loading-message');
        if (loadingMessage) loadingMessage.style.display = 'none';
        if (window.is2DViewActive) draw2D();
    }
}

earthTexture.onload = textureLoaded;
earthTexture.onerror = (e) => { console.error("Failed to load day map", e); textureLoaded(); };
nightLightsTexture.onload = textureLoaded;
nightLightsTexture.onerror = (e) => { console.error("Failed to load night lights map", e); textureLoaded(); };

earthTexture.src = '/textures/Earth_DayMap.jpg';
nightLightsTexture.src = '/textures/Earth_NightMap.jpg';

// --- Canvas Resizing ---
window.resizeCanvas2D = function() {
  const container = document.getElementById('earth2D-container');
  if (!container) return;
  const w = container.offsetWidth, h = container.offsetHeight;
  if (!w||!h) { projection = pathGenerator = null; return; }

  canvas.width = w; canvas.height = h;

  // Create a new D3 projection
  projection = d3.geoEquirectangular()
    .fitExtent([[0,0],[w,h]], { type: 'Sphere' });
 
  pathGenerator = d3.geoPath()
    .projection(projection)
    .context(ctx);

  if (window.is2DViewActive && window.texturesLoaded) draw2D();
};

window.addEventListener('resize', window.resizeCanvas2D);

// --- Coordinate Transformation ---
function positionToLatLon(pos) {
  const v = pos.clone();
  
  const θ = window.earthRotationManager ? 
    window.earthRotationManager.peekRotationAngle(window.totalSimulatedTime) :
    (window.initialEarthRotationOffset || 0) + window.totalSimulatedTime * window.EARTH_ANGULAR_VELOCITY_RAD_PER_SEC;
  
  v.applyAxisAngle(new THREE.Vector3(0, 1, 0), -θ);

  const r = v.length();
  if (r < 1e-6) return { lat: 0, lon: 0 };

  const lat = Math.asin(v.y / r) * (180 / Math.PI);
  let lon = Math.atan2(-v.z, v.x) * (180 / Math.PI);
 
  return { lat, lon };
}

// --- Drawing Helpers ---
function drawOrbitalPath2D(sat) {
    if (!pathGenerator || !sat.orbitalPath3DPoints?.length) return;
    const geo = {
        type: 'LineString',
        coordinates: sat.orbitalPath3DPoints.map(p => {
            const { lat, lon } = positionToLatLon(p);
            return [lon, lat];
        })
    };
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(0,255,0,0.7)';
    ctx.lineWidth = 1.5;
    pathGenerator(geo);
    ctx.stroke();
}

function drawGroundTrack2D(sat) {
    if (!pathGenerator || !sat.groundTrackHistory?.length) return;
    const n = sat.groundTrackHistory.length;
    
    for (let i = 1; i < n; i++) {
        const p1 = sat.groundTrackHistory[i-1];
        const p2 = sat.groundTrackHistory[i];
        
        const lonDiff = Math.abs(p2.lon - p1.lon);
        if (lonDiff > 180) continue;
        
        ctx.beginPath();
        ctx.strokeStyle = `rgba(255,165,0,${0.1 + 0.7*(i/n)})`;
        ctx.lineWidth = 2;
        pathGenerator({
            type: 'LineString',
            coordinates: [[p1.lon, p1.lat], [p2.lon, p2.lat]]
        });
        ctx.stroke();
    }
}

function drawCoverageArea2D(sat) {
  if (!pathGenerator) return;
  const beamDeg = sat.params.beamwidth;
  if (beamDeg <= 0 || beamDeg >= 180) return;

  const φ = sat.coverageAngleRad;
  if (!φ || φ <= 0 || φ > Math.PI/2) return;

  const radiusDeg = radToDeg(φ);
  if (radiusDeg <= 0) return;

  const { lat, lon } = positionToLatLon(sat.mesh.position);
  
  if (isNaN(lat) || isNaN(lon)) return;
  
  const circle = d3.geoCircle()
                   .center([lon, lat])
                   .radius(radiusDeg)
                   .precision(0.5);

  try {
    ctx.beginPath();
    pathGenerator(circle());
    ctx.fillStyle = 'rgba(222, 222, 222, 0.41)';
    ctx.fill();
    ctx.strokeStyle = 'rgb(255,11,11)';
    ctx.lineWidth = 1;
    ctx.stroke();
  } catch (error) {
    console.debug('Coverage area projection error:', error.message);
  }
}

function drawGroundStation2D(gs) {
    if (!pathGenerator) return;
    const minElev = gs.minElevationAngle;
    if (minElev <= 0) return;

    const lat = gs.latitude;
    const lon = gs.longitude;
    
    if (isNaN(lat) || isNaN(lon)) return;
    
    const projected = projection([lon, lat]);
    if (!projected) return;
    
    const [x, y] = projected;

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, 2*Math.PI);
    ctx.fillStyle = 'yellow';
    ctx.fill();
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 1;
    ctx.stroke();

    const centralAng = Math.PI/2 - degToRad(minElev);
    if (centralAng <= 0 || centralAng > Math.PI/2) return;

    const radiusDeg = radToDeg(centralAng);
    const circle = d3.geoCircle()
                     .center([lon, lat])
                     .radius(radiusDeg)
                     .precision(0.5);

    try {
      ctx.beginPath();
      pathGenerator(circle());
      ctx.fillStyle = 'rgba(255,0,255,0.05)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,0,255,0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();
    } catch (error) {
      console.debug('Ground station coverage projection error:', error.message);
    }
}

// --- Main Draw Function ---
function draw2D() {
  if (!window.is2DViewActive || !window.texturesLoaded) return;

  ctx.clearRect(0,0,canvas.width,canvas.height);

  ctx.drawImage(earthTexture, 0,0,canvas.width,canvas.height);

  const tmp = document.createElement('canvas');
  tmp.width = canvas.width; tmp.height = canvas.height;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(nightLightsTexture, 0,0,canvas.width,canvas.height);

  tctx.save();
  tctx.globalCompositeOperation = 'destination-out';

  const simDate = new Date(window.currentEpochUTC + window.totalSimulatedTime * 1000);
  const sub = getSubsolarPoint(simDate);
  const centerLon = sub.Sun_ra;
  const centerLat = sub.Sun_dec;

  try {
    d3.geoPath()
      .projection(projection)
      .context(tctx)
      ( d3.geoCircle()
          .center([centerLon, centerLat])
          .radius(90)
          .precision(0.1)()
      );

    tctx.fillStyle = 'black';
    tctx.fill();
  } catch (error) {
    console.debug('Day/night terminator projection error:', error.message);
  }
  
  tctx.restore();

  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(tmp, 0,0);

  window.activeSatellites?.forEach(sat => {
    drawOrbitalPath2D(sat);
    drawGroundTrack2D(sat);
    drawCoverageArea2D(sat);
    
    const { lat, lon } = positionToLatLon(sat.mesh.position);
    if (!isNaN(lat) && !isNaN(lon)) {
      const projected = projection([lon, lat]);
      if (projected) {
        const [x, y] = projected;
        // Draw satellite point
        ctx.beginPath(); 
        ctx.arc(x,y,5,0,2*Math.PI);
        ctx.fillStyle='red'; 
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Only draw the label if global visibility is enabled
        if (window.labelVisibilityEnabled) {
            ctx.font = '12px Arial';
            ctx.fillStyle = 'white';
            ctx.textAlign = 'left';
            ctx.shadowColor = 'black';
            ctx.shadowBlur = 4;
            ctx.fillText(sat.name, x + 10, y + 5); // Offset text from point
            ctx.shadowBlur = 0; // Reset shadow
        }
      }
    }
  });
  
  window.activeGroundStations?.forEach(gs => drawGroundStation2D(gs));
  
  // Draw GS-Sat link lines
  const θ = window.earthRotationManager ? 
      window.earthRotationManager.peekRotationAngle(window.totalSimulatedTime) :
      (window.initialEarthRotationOffset || 0) + window.totalSimulatedTime * window.EARTH_ANGULAR_VELOCITY_RAD_PER_SEC;

  window.activeGroundStations.forEach(gs => {
      const latR = gs.latitude * Math.PI / 180;
      const lonR = -gs.longitude * Math.PI / 180;
      
      const gecef = new THREE.Vector3(
          SCENE_EARTH_RADIUS * Math.cos(latR) * Math.cos(lonR),
          SCENE_EARTH_RADIUS * Math.sin(latR),
          SCENE_EARTH_RADIUS * Math.cos(latR) * Math.sin(lonR)
      );
      
      const geci = gecef.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), θ);

      window.activeSatellites.forEach(sat => {
          const satPos = sat.mesh.position.clone();
          const halfBeam = (sat.params.beamwidth / 2) * Math.PI / 180;

          const satToGs = geci.clone().sub(satPos).normalize();
          const nadir = satPos.clone().negate().normalize();
          const coneOK = Math.acos(THREE.MathUtils.clamp(nadir.dot(satToGs), -1, 1)) <= halfBeam;

          const gDir = geci.clone().normalize();
          const sDir = satPos.clone().normalize();
          const central = Math.acos(THREE.MathUtils.clamp(gDir.dot(sDir), -1, 1));
          const horizonOK = central <= (sat.coverageAngleRad || Math.PI/2);

          if (coneOK && horizonOK) {
              const gsProjected = projection([gs.longitude, gs.latitude]);
              const { lat, lon } = positionToLatLon(satPos);
              
              const lonDiff = Math.abs(lon - gs.longitude);
              if (lonDiff > 180) return;
              
              const satProjected = projection([lon, lat]);
              
              if (gsProjected && satProjected && !isNaN(lat) && !isNaN(lon)) {
                  const [x1, y1] = gsProjected;
                  const [x2, y2] = satProjected;

                  ctx.beginPath();
                  ctx.moveTo(x1, y1);
                  ctx.lineTo(x2, y2);
                  ctx.strokeStyle = 'yellow';
                  ctx.lineWidth = 2;
                  ctx.stroke();
              }
          }
      });
  });
}

// Expose main functions
window.draw2D = draw2D;

// Toggle 2D simulation
window.toggle2DSimulation = (on) => {
    window.is2DViewActive = on;
    if (on) {
        window.resizeCanvas2D();
        if (window.texturesLoaded) draw2D();
    } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
};

// Redraw on epoch update
window.addEventListener('epochUpdated', () => {
  if (window.is2DViewActive && window.texturesLoaded) {
    window.totalSimulatedTime = window.getSimulationCoreObjects().totalSimulatedTime;
    draw2D();
  }
});

// Initialize canvas on load
if (window.is2DViewActive) {
  window.resizeCanvas2D();
}
