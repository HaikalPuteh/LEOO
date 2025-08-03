// Earth3Dsimulation.js
import * as THREE from "three";
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

// Import utility functions
import getStarfield from "./getStarfield.js";
import { gsap } from 'gsap';

// Import astronomical calculation functions
import { getSunCoords, getGMST} from "./sunCalculations.js";

// Import orbital calculation functions
import {
    solveKepler,
    E_to_TrueAnomaly,
    TrueAnomaly_to_E,
    E_to_M,
    updateOrbitalElements,
    calculateSatellitePositionECI,
    calculateDerivedOrbitalParameters,
} from "./orbitalCalculation.js";

import {
    DEG2RAD,
    EarthRadius,
    EARTH_ANGULAR_VELOCITY_RAD_PER_SEC,
    SCENE_EARTH_RADIUS
} from "./parametersimulation.js";


class EarthRotationManager {
    constructor() {
        this.baseEpochUTC = 0;
        this.baseGMST = 0;
        this.lastCalculatedTime = 0;
        this.rotationOffset = 0;
        this.maxAccumulationTime = 3600;
    }

    initialize(epochUTC) {
        this.baseEpochUTC = epochUTC;
        this.baseGMST = getGMST(new Date(epochUTC));
        this.lastCalculatedTime = 0;
        this.rotationOffset = 0;
        console.log(`Earth rotation precision manager initialized: epoch=${new Date(epochUTC).toISOString()}`);
    }

    getRotationAngle(simulatedTimeSeconds) {
        if (simulatedTimeSeconds - this.lastCalculatedTime > this.maxAccumulationTime) {
            this.resetAccumulation(simulatedTimeSeconds);
        }
        const deltaTime = simulatedTimeSeconds - this.lastCalculatedTime;
        const deltaRotation = deltaTime * EARTH_ANGULAR_VELOCITY_RAD_PER_SEC;
        this.rotationOffset = (this.rotationOffset + deltaRotation) % (2 * Math.PI);
        this.lastCalculatedTime = simulatedTimeSeconds;
        const totalRotation = this.baseGMST + this.rotationOffset;
        return ((totalRotation % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
    }

    peekRotationAngle(simulatedTimeSeconds) {
        const totalRotation = this.baseGMST + (simulatedTimeSeconds * EARTH_ANGULAR_VELOCITY_RAD_PER_SEC);
        return ((totalRotation % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
    }

    resetAccumulation(currentSimulatedTime) {
        const newBaseEpochUTC = this.baseEpochUTC + (currentSimulatedTime * 1000);
        this.baseGMST = getGMST(new Date(newBaseEpochUTC));
        this.baseEpochUTC = newBaseEpochUTC;
        this.lastCalculatedTime = 0;
        this.rotationOffset = 0;
        console.log(`Earth rotation reset at t=${currentSimulatedTime}s to prevent precision loss`);
    }
}

const earthRotationManager = new EarthRotationManager();
window.earthRotationManager = earthRotationManager;

// Scene variables
let camera, scene, renderer, controls, earthGroup;
let earthMesh, cloudsMesh, atmosphereGlowMesh;
let sunLight;
let sunLightDirection = new THREE.Vector3();

// Global state variables
window.activeSatellites = new Map();
window.activeGroundStations = new Map();
window.selectedSatelliteId = null;
window.selectedGroundStationId = null;
window.isAnimating = false;
window.totalSimulatedTime = 0;
window.gsapAnimating = false;
window.initialEarthRotationOffset = 0;
window.currentEpochUTC = new Date().getTime();
window.currentSpeedMultiplier = 1;
window.EARTH_ANGULAR_VELOCITY_RAD_PER_SEC = EARTH_ANGULAR_VELOCITY_RAD_PER_SEC;
window.is2DViewActive = false;

// Expose for use in simulation.blade.php
window.calculateDerivedOrbitalParameters = calculateDerivedOrbitalParameters;
window.EarthRadius = EarthRadius;
window.DEG2RAD = DEG2RAD;
window.SCENE_EARTH_RADIUS = SCENE_EARTH_RADIUS;
window.updateSunDirection = updateSunDirection;

// Satellite model loading variables
let satelliteModelLoaded = false;
let globalSatelliteGLB = null;
let lastAnimationFrameTime = performance.now();

// Label visibility
window.labelVisibilityEnabled = true;
window.proximityLabelsEnabled = false;
window.labelProximityDistance = 2.0;
window.maxVisibleLabels = 10;
window.nadirLinesEnabled = true;

window.gsSatLinkLines = new Map();

function init3DScene() {
    const earthContainer = document.getElementById('earth-container');
    if (!earthContainer) {
        console.error("Critical: #earth-container not found.");
        return;
    }
    renderer = new THREE.WebGLRenderer({ antialias: true});
    renderer.setSize(earthContainer.offsetWidth, earthContainer.offsetHeight);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(window.devicePixelRatio);

    window.labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize( earthContainer.clientWidth, earthContainer.clientHeight );
    labelRenderer.domElement.style.position = 'absolute';
    labelRenderer.domElement.style.top      = '0';
    labelRenderer.domElement.style.pointerEvents = 'none';

    earthContainer.style.position = 'relative';
    earthContainer.appendChild(renderer.domElement);
    earthContainer.appendChild( labelRenderer.domElement );

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, earthContainer.offsetWidth / earthContainer.offsetHeight, 0.0001, 1000);
    camera.position.z = 2.5;

    controls = new OrbitControls(camera, renderer.domElement);
    controls.minDistance = 1.2;
    controls.maxDistance = 10;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    earthGroup = new THREE.Group();
    scene.add(earthGroup);

    const textureLoader = new THREE.TextureLoader();
    const earthDayMap = textureLoader.load("/textures/Earth_DayMap.jpg");
    const earthNightMap = textureLoader.load("/textures/Earth_NightMap.jpg");
    const earthSpecularMap = textureLoader.load("/textures/Earth_Specular.jpg");
    const earthBumpMap = textureLoader.load("/textures/earthbump10k.jpg");
    const cloudsMap = textureLoader.load("/textures/Earth_Clouds.jpg");

    const earthGeometry = new THREE.SphereGeometry(SCENE_EARTH_RADIUS, 256, 256);

    const earthShader = new THREE.ShaderMaterial({
        uniforms: {
            uEarthDayMap: { value: earthDayMap },
            uEarthNightMap: { value: earthNightMap },
            uEarthSpecularMap: { value: earthSpecularMap },
            uEarthBumpMap: { value: earthBumpMap },
            uSunDirection: { value: sunLightDirection },
            uTime: { value: 0.0 },
            uCameraPosition: { value: camera.position },
            bumpScale: { value: 0.02 },
            shininess: { value: 1500.0 }
        },
        vertexShader: `
            varying vec2 vUv;
            varying vec3 vWorldNormal;
            varying vec3 vWorldPosition;
            void main() {
                vUv = uv;
                vWorldNormal = normalize(mat3(modelMatrix) * normal);
                vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D uEarthDayMap;
            uniform sampler2D uEarthNightMap;
            uniform sampler2D uEarthSpecularMap;
            uniform sampler2D uEarthBumpMap;
            uniform vec3 uSunDirection;
            uniform vec3 uCameraPosition;
            uniform float bumpScale;
            uniform float shininess;
            varying vec2 vUv;
            varying vec3 vWorldNormal;
            varying vec3 vWorldPosition;
            void main() {
                vec4 dayColor = texture2D(uEarthDayMap, vUv);
                vec4 nightColor = texture2D(uEarthNightMap, vUv);
                vec3 specularMap = texture2D(uEarthSpecularMap, vUv).rgb;
                vec3 normalMap = texture2D(uEarthBumpMap, vUv).rgb * 2.0 - 1.0;
                vec3 perturbedNormal = normalize(vWorldNormal + normalMap * bumpScale);
                vec3 lightDir = normalize(uSunDirection);
                float NdotL = dot(perturbedNormal, lightDir);
                float dayNightFactor = smoothstep(-0.05, 0.05, NdotL);
                vec3 baseColor = mix(nightColor.rgb, dayColor.rgb, dayNightFactor);
                vec3 viewDir = normalize(uCameraPosition - vWorldPosition);
                vec3 reflectDir = reflect(-lightDir, perturbedNormal);
                float specular = pow(max(dot(viewDir, reflectDir), 0.0), shininess);
                vec3 specularColor = specularMap * specular * dayNightFactor * 0.4;
                gl_FragColor = vec4(baseColor + specularColor, 1.0);
            }
        `,
        transparent: false,
        side: THREE.FrontSide,
        depthWrite: true,
        depthTest: true,
        alphaTest: 0,
        blending: THREE.NoBlending,
    });
    earthMesh = new THREE.Mesh(earthGeometry, earthShader);
    earthGroup.add(earthMesh);

    const cloudGeometry = new THREE.SphereGeometry(SCENE_EARTH_RADIUS * 1.004, 256, 256);
    cloudsMesh = new THREE.Mesh(cloudGeometry, new THREE.MeshStandardMaterial({
        map: cloudsMap,
        transparent: true,
        opacity: 0.25,
        blending: THREE.AdditiveBlending,
        side: THREE.FrontSide,
        depthWrite: false,
        depthTest: true
    }));
    earthGroup.add(cloudsMesh);

    function createAtmosphereGlow() {
        const atmosphereGeometry = new THREE.SphereGeometry(SCENE_EARTH_RADIUS * 1.01, 256, 256);
        const atmosphereMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uSunDirection: { value: sunLightDirection },
                uCameraPosition: { value: camera.position },
                uGlowColor: { value: new THREE.Color(0x4da6ff) },
                uRimColor: { value: new THREE.Color(0x87ceeb) }
            },
            vertexShader: `
                varying vec3 vWorldNormal;
                varying vec3 vViewDirection;
                void main() {
                    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                    vWorldNormal = normalize(mat3(modelMatrix) * normal);
                    vViewDirection = normalize(cameraPosition - worldPosition.xyz);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 uSunDirection;
                uniform vec3 uGlowColor;
                uniform vec3 uRimColor;
                varying vec3 vWorldNormal;
                varying vec3 vViewDirection;
                void main() {
                    float fresnel = 1.0 - abs(dot(vViewDirection, vWorldNormal));
                    fresnel = pow(fresnel, 2.5);
                    float sunInfluence = smoothstep(-0.5, 0.5, dot(vWorldNormal, normalize(uSunDirection)));
                    vec3 glowColor = mix(uGlowColor * 0.3, uRimColor, sunInfluence);
                    float intensity = fresnel * (0.2 + 0.8 * sunInfluence);
                    gl_FragColor = vec4(glowColor, intensity * 0.6);
                }
            `,
            transparent: true,
            side: THREE.BackSide,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: true
        });
        return new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
    }
    atmosphereGlowMesh = createAtmosphereGlow();
    scene.add(atmosphereGlowMesh);

    scene.add(getStarfield({ numStars: 4000 }));

    sunLight = new THREE.DirectionalLight(0xffffff, 1);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = 1024;
    sunLight.shadow.mapSize.height = 1024;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 500;
    scene.add(sunLight);

    const ambientLight = new THREE.AmbientLight(0x333333, 1.0);
    scene.add(ambientLight);

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

function updateSunDirection(simTime) {
    const now = new Date(window.currentEpochUTC + simTime * 1000);
    const { ra, dec } = getSunCoords(now);
    const cosRA = Math.cos(ra);
    const sinRA = Math.sin(ra);
    const cosDec = Math.cos(dec);
    const sinDec = Math.sin(dec);
    const xJ2000 = cosDec * cosRA;
    const yJ2000 = cosDec * sinRA;
    const zJ2000 = sinDec;
    const x3 = xJ2000;
    const y3 = zJ2000;
    const z3 = -yJ2000;
    sunLightDirection.set(x3, y3, z3).normalize();
    const sunDistance = 10;
    sunLight.position.copy(sunLightDirection).multiplyScalar(sunDistance);
    if (earthMesh && earthMesh.material.uniforms) {
        earthMesh.material.uniforms.uSunDirection.value.copy(sunLightDirection);
        earthMesh.material.uniforms.uCameraPosition.value.copy(camera.position);
    }
    if (atmosphereGlowMesh && atmosphereGlowMesh.material.uniforms) {
        atmosphereGlowMesh.material.uniforms.uSunDirection.value.copy(sunLightDirection);
        atmosphereGlowMesh.material.uniforms.uCameraPosition.value.copy(camera.position);
    }
}

function drawOrbitPath(satellite) {
    const e = satellite.params.eccentricity;
    const points = [];
    const numPathPoints = 360;
    const tempRAAN = satellite.currentRAAN;
    const tempArgPerigee = satellite.params.argPerigeeRad;

    for (let i = 0; i <= numPathPoints; i++) {
        const trueAnomaly_path = (i / numPathPoints) * 2 * Math.PI;
        const tempParams = {
            semiMajorAxis: satellite.params.semiMajorAxis,
            eccentricity: satellite.params.eccentricity,
            inclinationRad: satellite.params.inclinationRad,
            argPerigeeRad: tempArgPerigee,
        };
        const tempPosition = calculateSatellitePositionECI(tempParams, E_to_M(TrueAnomaly_to_E(trueAnomaly_path, e), e), tempRAAN, SCENE_EARTH_RADIUS);
        points.push(new THREE.Vector3(tempPosition.x, tempPosition.y, tempPosition.z));
    }

    satellite.orbitalPath3DPoints = points;
    if (satellite.orbitLine) {
        scene.remove(satellite.orbitLine);
        satellite.orbitLine.geometry.dispose();
        satellite.orbitLine.material.dispose();
    }
    satellite.orbitLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x00ff00 }));
    scene.add(satellite.orbitLine);
}

function updateCoverageCone(sat) {
  if (sat.coverageCone) {
    scene.remove(sat.coverageCone);
    sat.coverageCone.geometry.dispose();
    sat.coverageCone.material.dispose();
    sat.coverageCone = null;
  }
  if (sat.coverageRing) {
    scene.remove(sat.coverageRing);
    sat.coverageRing.geometry.dispose();
    sat.coverageRing.material.dispose();
    sat.coverageRing = null;
  }

  const beamDeg = sat.params.beamwidth;
  if (beamDeg <= 0 || beamDeg >= 180) return;

  const R = SCENE_EARTH_RADIUS;
  const P = sat.mesh.position.clone();
  const d = P.length();
  
  if (d <= R) return;

  const β = THREE.MathUtils.degToRad(beamDeg / 2);
  let φ = Math.asin(Math.min(1, (d / R) * Math.sin(β))) - β;
  const φ_horizon = Math.acos(R / d);
  if (φ < 0 || φ > φ_horizon) {
    if (β < φ_horizon) return;
    φ = φ_horizon;
  }
  sat.coverageAngleRad = φ;

  const height = d - R * Math.cos(φ);
  const coneRadius = R * Math.sin(φ);
  if (height <= 0 || coneRadius <= 0) return;

  const coneGeo = new THREE.ConeGeometry(coneRadius, height, 256, 1, true);
  coneGeo.translate(0, -height/2, 0);

  const coneMat = new THREE.MeshBasicMaterial({
    color: 0x00ffff,
    transparent: true,
    opacity: 0.2,
    side: THREE.DoubleSide
  });
  const cone = new THREE.Mesh(coneGeo, coneMat);
  cone.position.copy(P);

  const nadir = P.clone().negate().normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), nadir);
  cone.setRotationFromQuaternion(q);

  scene.add(cone);
  sat.coverageCone = cone;
}

function updateNadirLine(satellite) {
    if (satellite.nadirLine) {
        scene.remove(satellite.nadirLine);
        satellite.nadirLine.geometry.dispose();
        satellite.nadirLine.material.dispose();
    }
    const satPositionECI = satellite.mesh.position;
    const nadirPointECI = satPositionECI.clone().normalize().multiplyScalar(SCENE_EARTH_RADIUS);
    const points = [satPositionECI, nadirPointECI];
    satellite.nadirLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0x888888, linewidth: 2 })
    );
    satellite.nadirLine.visible = window.nadirLinesEnabled;
    scene.add(satellite.nadirLine);
}

function updateGsSatLinkLines() {
  window.gsSatLinkLines.forEach((line) => {
    if (line && line.parent) {
      scene.remove(line);
      if (line.geometry) line.geometry.dispose();
      if (line.material) line.material.dispose();
    }
  });
  window.gsSatLinkLines.clear();

  if (!window.activeGroundStations || window.activeGroundStations.size === 0 ||
      !window.activeSatellites || window.activeSatellites.size === 0) {
    return;
  }

  const gsPos = new THREE.Vector3();
  const satPos = new THREE.Vector3();
  const satToGs = new THREE.Vector3();
  const nadirDir = new THREE.Vector3();

  window.activeGroundStations.forEach(gs => {
    if (!gs || !gs.mesh || !gs.mesh.position) return;
    try {
      gs.mesh.getWorldPosition(gsPos);
    } catch (error) {
      return;
    }

    window.activeSatellites.forEach(sat => {
      if (!sat || !sat.mesh || !sat.mesh.position || !sat.params || typeof sat.params.beamwidth !== 'number') return;
      try {
        sat.mesh.getWorldPosition(satPos);
      } catch (error) {
        return;
      }

      const key = `${gs.id}|${sat.id}`;
      const halfBeam = THREE.MathUtils.degToRad(sat.params.beamwidth / 2);
      satToGs.copy(gsPos).sub(satPos).normalize();
      nadirDir.copy(satPos).negate().normalize();
      const coneOK = THREE.MathUtils.acosSafe(nadirDir.dot(satToGs)) <= halfBeam;
      const gsDir = gsPos.clone().normalize();
      const satDir = satPos.clone().normalize();
      const central = THREE.MathUtils.acosSafe(gsDir.dot(satDir));
      const horizonOK = central <= sat.coverageAngleRad;

      if (coneOK && horizonOK) {
        let line = window.gsSatLinkLines.get(key);
        if (!line) {
          line = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([gsPos, satPos]),
            new THREE.LineBasicMaterial({ color: 0xffff00, linewidth: 1 })
          );
          scene.add(line);
          window.gsSatLinkLines.set(key, line);
        } else {
          line.geometry.setFromPoints([gsPos, satPos]);
        }
      }
    });
  });
}

THREE.MathUtils.acosSafe = function(x) {
  return Math.acos(THREE.MathUtils.clamp(x, -1, 1));
};

class Satellite {
    constructor(id, name, params, initialMeanAnomaly, initialRAAN, initialEpochUTC) {
        this.id = id;
        this.name = name;
        this.params = { ...params };
        this.initialEpochUTC = initialEpochUTC;
        this.initialMeanAnomaly = initialMeanAnomaly;
        this.currentMeanAnomaly = initialMeanAnomaly;
        this.currentRAAN = initialRAAN;
        this.initialRAAN = initialRAAN;
        this.initialArgPerigee = this.params.argPerigeeRad;
        this.currentArgPerigee = this.params.argPerigeeRad;
        this.latitudeDeg = 0;
        this.longitudeDeg = 0;

        const epochOffsetSeconds = (window.currentEpochUTC - initialEpochUTC) / 1000;
        if (epochOffsetSeconds !== 0) {
            updateOrbitalElements(this, epochOffsetSeconds);
            this.initialMeanAnomaly = this.currentMeanAnomaly;
            this.initialRAAN = this.currentRAAN;
            this.initialArgPerigee = this.currentArgPerigee;
        }

        this.currentTrueAnomaly = E_to_TrueAnomaly(solveKepler(this.currentMeanAnomaly, this.params.eccentricity), this.params.eccentricity);
        this.sphereMesh = null;
        this.glbMesh = null;
        this.mesh = null;
        this.orbitLine = null;
        this.coverageCone = null;
        this.nadirLine = null;
        this.prevPosition = new THREE.Vector3();
        this.velocity = new THREE.Vector3();
        this.orbitalVelocityMagnitude = 0;
        this.orbitalPath3DPoints = [];
        this.groundTrackHistory = [];
        this.maxGroundTrackPoints = 300;
        this.isCloseView = false;

        this.createMeshes();
        this.updatePosition(window.totalSimulatedTime, 0);
    }

    createMeshes() {
        const sphereGeometry = new THREE.SphereGeometry(0.005, 16, 16);
        const sphereMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
        this.sphereMesh = new THREE.Mesh(sphereGeometry, sphereMaterial);
        scene.add(this.sphereMesh);

        if (satelliteModelLoaded && globalSatelliteGLB) {
            this.setGlbMesh(globalSatelliteGLB);
        }
        this.mesh = this.sphereMesh;
        this.mesh.visible = true;
    }

    updatePosition(totalSimulatedTimeFromSimulationStart, frameDeltaTime) {
        this.prevPosition.copy(this.mesh.position);
        const currentAbsoluteTimeMs = window.currentEpochUTC + (totalSimulatedTimeFromSimulationStart * 1000);
        
        const timeSinceSatelliteEpoch = (currentAbsoluteTimeMs - this.initialEpochUTC) / 1000;
        updateOrbitalElements(this, timeSinceSatelliteEpoch);

        const E = solveKepler(this.currentMeanAnomaly, this.params.eccentricity);
        this.currentTrueAnomaly = E_to_TrueAnomaly(E, this.params.eccentricity);
    
        const { x, y, z } = calculateSatellitePositionECI(
            this.params,
            this.currentMeanAnomaly,
            this.currentRAAN,
            SCENE_EARTH_RADIUS
        );
        const newPositionEciThreeJs = new THREE.Vector3(x, y, z);
        
        this.mesh.position.copy(newPositionEciThreeJs);

        if (this.glbMesh && this.glbMesh.visible) {
            this.glbMesh.position.copy(this.mesh.position);
            const nadirDirection = this.mesh.position.clone().negate().normalize();
            const velocityDirection = this.velocity.clone().normalize();
            if (velocityDirection.length() < 0.1) {
                velocityDirection.set(1, 0, 0);
            }
            const rotationMatrix = new THREE.Matrix4();
            rotationMatrix.lookAt(new THREE.Vector3(0, 0, 0), nadirDirection, velocityDirection);
            this.glbMesh.setRotationFromMatrix(rotationMatrix);
            this.glbMesh.rotateX(Math.PI / 2);
        }
    
        if (frameDeltaTime > 0) {
            this.velocity.copy(this.mesh.position).sub(this.prevPosition).divideScalar(frameDeltaTime);
            this.orbitalVelocityMagnitude = this.velocity.length() * (EarthRadius / SCENE_EARTH_RADIUS);
        } else {
            this.orbitalVelocityMagnitude = 0;
        }

        const θ = earthRotationManager.peekRotationAngle(window.totalSimulatedTime);
        const ecef = this.mesh.position.clone().applyAxisAngle(new THREE.Vector3(0,1,0), -θ);
        const r = ecef.length();
        const latRad = Math.asin(ecef.y / r);
        let lonRad = Math.atan2(-ecef.z, ecef.x);
        this.latitudeDeg  = latRad * (180/Math.PI);
        this.longitudeDeg = lonRad * (180/Math.PI);
        this.groundTrackHistory.push({ lat: this.latitudeDeg, lon: this.longitudeDeg });

        if (this.groundTrackHistory.length > this.maxGroundTrackPoints) {
            this.groundTrackHistory.shift();
        }

        updateCoverageCone(this);
        updateNadirLine(this);
        drawOrbitPath(this);
    }

    setGlbMesh(glbModel) {
        if (!this.glbMesh) {
            this.glbMesh = glbModel.clone();
            this.glbMesh.scale.set(0.000002, 0.000002, 0.000002);
            const modelLight = new THREE.PointLight(0xffffff, 1, SCENE_EARTH_RADIUS * 0.1);
            modelLight.position.set(0, 50, 0);
            this.glbMesh.add(modelLight);
            const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
            this.glbMesh.add(ambientLight);
            this.glbMesh.traverse((child) => {
                if (child.isMesh && child.material) {
                    child.material.emissive = new THREE.Color(0x444444);
                    child.material.emissiveIntensity = 0.1;
                }
            });
            this.glbMesh.visible = false;
            scene.add(this.glbMesh);
        }
    }

    setActiveMesh(isCloseView) {
        if (isCloseView && this.glbMesh) {
            this.mesh = this.glbMesh;
            this.sphereMesh.visible = false;
            this.glbMesh.visible = true;
        } else {
            this.mesh = this.sphereMesh;
            this.sphereMesh.visible = true;
            if (this.glbMesh) this.glbMesh.visible = false;
        }
    }

    dispose() {
        if (window.gsSatLinkLines) {
            const keysToRemove = [];
            window.gsSatLinkLines.forEach((line, key) => {
                if (key.startsWith(this.id + '|') || key.endsWith('|' + this.id)) {
                    scene.remove(line);
                    if (line.geometry) line.geometry.dispose();
                    if (line.material) line.material.dispose();
                    keysToRemove.push(key);
                }
            });
            keysToRemove.forEach(key => window.gsSatLinkLines.delete(key));
        }

        if (this.sphereMesh) { 
            scene.remove(this.sphereMesh); 
            if (this.sphereMesh.geometry) this.sphereMesh.geometry.dispose(); 
            if (this.sphereMesh.material) this.sphereMesh.material.dispose(); 
            this.sphereMesh = null;
        }
        
        if (this.glbMesh) {
            scene.remove(this.glbMesh);
            this.glbMesh.traverse((child) => {
                if (child.isMesh) {
                    if (child.geometry) child.geometry.dispose();
                    if (child.material) {
                        if (child.material.isMaterial) child.material.dispose();
                        else if (Array.isArray(child.material)) child.material.forEach(mat => mat.dispose());
                    }
                }
            });
            this.glbMesh = null;
        }
        
        if (this.orbitLine) { 
            scene.remove(this.orbitLine); 
            if (this.orbitLine.geometry) this.orbitLine.geometry.dispose(); 
            if (this.orbitLine.material) this.orbitLine.material.dispose(); 
            this.orbitLine = null;
        }
        
        if (this.coverageCone) { 
            scene.remove(this.coverageCone); 
            if (this.coverageCone.geometry) this.coverageCone.geometry.dispose(); 
            if (this.coverageCone.material) this.coverageCone.material.dispose(); 
            this.coverageCone = null;
        }
        
        if (this.nadirLine) { 
            scene.remove(this.nadirLine); 
            if (this.nadirLine.geometry) this.nadirLine.geometry.dispose(); 
            if (this.nadirLine.material) this.nadirLine.material.dispose(); 
            this.nadirLine = null;
        }

        if (this.labelObject) {
            if (this.mesh) this.mesh.remove(this.labelObject);
            this.labelObject = null;
        }

        if (this._labelElement) {
            this._labelElement.remove();
            this._labelElement = null;
        }
        this.mesh = null;
    }

    updateParametersFromCurrentPosition(newParams, newEpochUTC) {
        const currentE = solveKepler(this.currentMeanAnomaly, this.params.eccentricity);
        const currentTrueAnomaly = E_to_TrueAnomaly(currentE, this.params.eccentricity);
        this.params = { ...newParams };
        this.initialEpochUTC = newEpochUTC;
        const E_new = TrueAnomaly_to_E(currentTrueAnomaly, this.params.eccentricity);
        this.initialMeanAnomaly = E_to_M(E_new, this.params.eccentricity);
        this.initialMeanAnomaly %= (2 * Math.PI);
        if (this.initialMeanAnomaly < 0) this.initialMeanAnomaly += 2 * Math.PI;
        this.initialRAAN = newParams.raanRad;
        this.currentRAAN = this.initialRAAN;
        this.updatePosition(window.totalSimulatedTime, 0);
    }

    updateTrueAnomalyOnly(newTrueAnomalyRad) {
        const E_new = TrueAnomaly_to_E(newTrueAnomalyRad, this.params.eccentricity);
        this.currentMeanAnomaly = E_to_M(E_new, this.params.eccentricity);
        this.currentMeanAnomaly %= (2 * Math.PI);
        if (this.currentMeanAnomaly < 0) this.currentMeanAnomaly += 2 * Math.PI;
        this.initialMeanAnomaly = this.currentMeanAnomaly;
        this.updatePosition(window.totalSimulatedTime, 0);
    }
}

function createSatelliteLabel(sat) {
    const div = document.createElement('div');
    div.className = 'satellite-label';
    div.textContent = sat.name;
    div.style.color = 'white';
    div.style.fontSize = '12px';
    div.style.whiteSpace = 'nowrap';
    div.style.textAlign = 'center';
    
    const label = new CSS2DObject(div);
    label.position.set(0, 0.05, 0); 
    label.visible = window.labelVisibilityEnabled;
    
    sat.labelObject = label;
    sat.mesh.add(label);
    sat._labelElement = div;
    
    if (window.labelVisibilityManager) {
        window.labelVisibilityManager.updateLabelVisibility();
    }
}

window.highlightSatelliteInScene = function(id) {
    window.activeSatellites.forEach(sat => {
        if (sat.sphereMesh) {
            const mat = sat.sphereMesh.material;
            mat.color.setHex(sat.id === id ? 0x00ff00 : 0x0000ff);
            if (mat.emissive) mat.emissive.setHex(sat.id === id ? 0x00ff00 : 0x000000);
        }
        
        if (sat._labelElement) {
            sat._labelElement.style.color = sat.id === id ? 'limegreen' : 'white';
        }
        
        // Show label prominently when selected in close view
        if (sat.id === id && window.closeViewEnabled && sat.labelObject) {
            sat.labelObject.visible = true;
            if (sat._labelElement) {
                sat._labelElement.style.fontSize = '16px';
                sat._labelElement.style.fontWeight = 'bold';
                sat._labelElement.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
                sat._labelElement.style.padding = '4px 8px';
                sat._labelElement.style.borderRadius = '4px';
                sat._labelElement.style.border = '1px solid limegreen';
            }
        } else if (sat._labelElement) {
            // Reset label style for non-selected satellites
            sat._labelElement.style.fontSize = '12px';
            sat._labelElement.style.fontWeight = 'normal';
            sat._labelElement.style.backgroundColor = 'transparent';
            sat._labelElement.style.padding = '0';
            sat._labelElement.style.border = 'none';
        }
        
    
    });
};

class LabelVisibilityManager {
    constructor() {
        this.globalVisible = true;
        this.proximityMode = false;
        this.proximityDistance = 2.0;
        this.maxLabels = 10;
        this.nadirLinesVisible = true;
    }

    setNadirLinesVisibility(visible) {
        this.nadirLinesVisible = visible;
        window.nadirLinesEnabled = visible;
        this.updateNadirLinesVisibility();
    }

    updateNadirLinesVisibility() {
        window.activeSatellites.forEach(sat => {
            if (sat.nadirLine) sat.nadirLine.visible = this.nadirLinesVisible;
        });
    }

    updateLabelVisibility() {
        if (!this.globalVisible) {
            this.hideAllLabels();
            return;
        }
        if (this.proximityMode) {
            this.updateProximityLabels();
        } else {
            this.showAllLabels();
        }
        this.updateNadirLinesVisibility();
    }

    hideAllLabels() {
        window.activeSatellites.forEach(sat => { if (sat.labelObject) sat.labelObject.visible = false; });
        window.activeGroundStations.forEach(gs => { if (gs.labelObject) gs.labelObject.visible = false; });
    }

    showAllLabels() {
        window.activeSatellites.forEach(sat => { if (sat.labelObject) sat.labelObject.visible = true; });
        window.activeGroundStations.forEach(gs => { if (gs.labelObject) gs.labelObject.visible = true; });
    }

    updateProximityLabels() {
    const cameraPosition = camera.position;
    const satellitesWithDistance = Array.from(window.activeSatellites.values()).map(sat => ({
        satellite: sat,
        distance: cameraPosition.distanceTo(sat.mesh.position)
    })).sort((a, b) => a.distance - b.distance);

    this.hideAllLabels();

    let visibleCount = 0;
    for (const item of satellitesWithDistance) {
        // Always show label for selected satellite in close view
        if (window.closeViewEnabled && item.satellite.id === window.selectedSatelliteId) {
            if (item.satellite.labelObject) {
                item.satellite.labelObject.visible = true;
            }
            continue;
        }
        
        if (item.distance <= this.proximityDistance && visibleCount < this.maxLabels) {
            if (item.satellite.labelObject) {
                item.satellite.labelObject.visible = true;
                visibleCount++;
            }
        }
    }
    window.activeGroundStations.forEach(gs => { if (gs.labelObject) gs.labelObject.visible = true; });
    }

    setGlobalVisibility(visible) {
        this.globalVisible = visible;
        window.labelVisibilityEnabled = visible;
        this.updateLabelVisibility();
    }

    setProximityMode(enabled, distance = 2.0, maxLabels = 10) {
        this.proximityMode = enabled;
        this.proximityDistance = distance;
        this.maxLabels = maxLabels;
        window.proximityLabelsEnabled = enabled;
        window.labelProximityDistance = distance;
        window.maxVisibleLabels = maxLabels;
        this.updateLabelVisibility();
    }
}

const labelVisibilityManager = new LabelVisibilityManager();
window.labelVisibilityManager = labelVisibilityManager;

window.toggleLabels = function() {
    labelVisibilityManager.setGlobalVisibility(!window.labelVisibilityEnabled);
};

window.toggleProximityLabels = function() {
    labelVisibilityManager.setProximityMode(!window.proximityLabelsEnabled, window.labelProximityDistance, window.maxVisibleLabels);
};

window.configureLabelProximity = function(distance, maxLabels) {
    window.labelProximityDistance = distance;
    window.maxVisibleLabels = maxLabels;
    if (window.proximityLabelsEnabled) {
        labelVisibilityManager.setProximityMode(true, distance, maxLabels);
    }
};

window.toggleNadirLines = function() {
    labelVisibilityManager.setNadirLinesVisibility(!window.nadirLinesEnabled);
    updateNadirButtonStates();
};

window.highlightGroundStationInScene = function(id) {
    window.activeGroundStations.forEach(gs => {
        if (gs.mesh) {
            gs.mesh.material.color.setHex(gs.id === id ? 0x00ffff : 0xffff00);
            gs.mesh.material.emissive.setHex(gs.id === id ? 0x00ffff : 0x000000);
        }
        if (gs._labelElement) {
            gs._labelElement.style.color = gs.id === id ? 'cyan' : 'white';
        }
      
    });
};

function createGroundStationLabel(gs) {
    const div = document.createElement('div');
    div.className = 'satellite-label';
    div.textContent = gs.name;
    div.style.color = 'white';
    div.style.fontSize = '12px';
    div.style.whiteSpace = 'nowrap';
    const label = new CSS2DObject(div);
    label.position.set(0, 0.02, 0);
    label.visible = window.labelVisibilityEnabled;
    gs.labelObject = label;
    gs.mesh.add(label);
    gs._labelElement = div;
    if (window.labelVisibilityManager) {
        window.labelVisibilityManager.updateLabelVisibility();
    }
}

window.refreshAllLabels = function() {
    if (window.labelVisibilityManager) {
        window.labelVisibilityManager.updateLabelVisibility();
    }
};

class GroundStation {
    constructor(id, name, latitude, longitude) {
        this.id = id;
        this.name = name;
        this.latitude = latitude;
        this.longitude = longitude;
        this.mesh = null;
        this.coverageCone = null;
        this._labelElement = null;
        this.createMesh();
    }

    createMesh() {
        const earthRadiusScene = SCENE_EARTH_RADIUS;
        const latRad = this.latitude * DEG2RAD;
        const lonRad = -this.longitude * DEG2RAD;
        const x = earthRadiusScene * Math.cos(latRad) * Math.cos(lonRad);
        const y = earthRadiusScene * Math.sin(latRad);
        const z = earthRadiusScene * Math.cos(latRad) * Math.sin(lonRad);
        const sphereGeometry = new THREE.SphereGeometry(0.005, 16, 16);
        const gsMaterial = new THREE.MeshBasicMaterial({ color: 0xffff00 });
        this.mesh = new THREE.Mesh(sphereGeometry, gsMaterial);
        this.mesh.name = `groundstation-${this.id}-${this.name}`;
        this.mesh.position.set(x, y, z);
        earthGroup.add(this.mesh);
        createGroundStationLabel(this);
    }

    dispose() {
        if (window.gsSatLinkLines) {
            const keysToRemove = [];
            window.gsSatLinkLines.forEach((line, key) => {
                if (key.startsWith(this.id + '|') || key.endsWith('|' + this.id)) {
                    scene.remove(line);
                    if (line.geometry) line.geometry.dispose();
                    if (line.material) line.material.dispose();
                    keysToRemove.push(key);
                }
            });
            keysToRemove.forEach(key => window.gsSatLinkLines.delete(key));
        }
        if (this.mesh) {
            if (earthGroup && earthGroup.children.includes(this.mesh)) earthGroup.remove(this.mesh);
            if (this.mesh.geometry) this.mesh.geometry.dispose();
            if (this.mesh.material) this.mesh.material.dispose();
            this.mesh = null;
        }
        if (this.labelObject) {
            if (this.mesh) this.mesh.remove(this.labelObject);
            this.labelObject = null;
        }
        if (this._labelElement) {
            this._labelElement.remove();
            this._labelElement = null;
        }
    }
}

function loadGlobalGLBModel() {
    if (globalSatelliteGLB) return Promise.resolve(globalSatelliteGLB);
    const gltfLoader = new GLTFLoader();
    const loadingMessageElement = document.getElementById('loading-message');
    if (loadingMessageElement) loadingMessageElement.style.display = 'block';

    return new Promise((resolve, reject) => {
        gltfLoader.load('/Satellitemodel/CALIPSO.glb',
            (gltf) => {
                globalSatelliteGLB = gltf.scene;
                satelliteModelLoaded = true;
                if (loadingMessageElement) loadingMessageElement.style.display = 'none';
                window.activeSatellites.forEach(sat => sat.setGlbMesh(globalSatelliteGLB));
                window.activeSatellites.forEach(sat => sat.setActiveMesh(window.closeViewEnabled));
                resolve(globalSatelliteGLB);
            },
            (xhr) => {
                if (xhr.total > 0 && loadingMessageElement) {
                    loadingMessageElement.innerText = `Loading satellite model... ${Math.round(xhr.loaded / xhr.total * 100)}%`;
                }
            },
            (error) => {
                console.error('Error loading GLB model:', error);
                if (loadingMessageElement) loadingMessageElement.innerText = 'Error loading satellite model. Using spheres.';
                satelliteModelLoaded = false;
                reject(error);
            }
        );
    });
}

init3DScene();
earthRotationManager.initialize(window.currentEpochUTC);
updateSunDirection(window.totalSimulatedTime);
renderer.render(scene, camera);
loadGlobalGLBModel().catch(() => console.warn("GLB model failed to load, proceeding with sphere models."));

window.clearSimulationScene = function() {
    window.activeSatellites.forEach(sat => sat.dispose());
    window.activeSatellites.clear();
    window.activeGroundStations.forEach(gs => gs.dispose());
    window.activeGroundStations.clear();
    window.selectedSatelliteId = null;
    window.selectedGroundStationId = null;
    window.closeViewEnabled = false;
    controls.object.up.set(0, 1, 0);
    controls.minDistance = 1.2;
    controls.maxDistance = 10;
    controls.target.set(0, 0, 0);
    camera.position.set(0, 0, 2.5);
    controls.update();
    window.isAnimating = false;
    window.totalSimulatedTime = 0;
    window.currentSpeedMultiplier = 1;
    if(cloudsMesh) cloudsMesh.rotation.y = 0;
    earthRotationManager.initialize(window.currentEpochUTC);
    updateSunDirection(0);
    renderer.render(scene, camera);
    if (typeof window.updateAnimationDisplay === 'function') {
        window.updateAnimationDisplay();
    }
    window.gsSatLinkLines.forEach(line => {
        scene.remove(line);
        line.geometry.dispose();
        line.material.dispose();
    });
    window.gsSatLinkLines.clear();
    window.highlightSatelliteInScene(null);
    window.highlightGroundStationInScene(null);
};

window.addOrUpdateSatelliteInScene = function(satelliteData) {
    const uniqueId = satelliteData.id || satelliteData.fileName;
    if (!uniqueId) {
        console.error("Satellite data missing unique ID or fileName.");
        return;
    }
    let existingSat = window.activeSatellites.get(uniqueId);
    const initialEpochUTC = typeof satelliteData.utcTimestamp === 'number' ? satelliteData.utcTimestamp : window.currentEpochUTC;

    let semiMajorAxisInSceneUnits;
    const altitudeKm = satelliteData.altitude;
    const eccentricity = satelliteData.eccentricity;

    if (eccentricity < 1e-4) { // Treat as circular
        const semiMajorAxisKm = EarthRadius + altitudeKm;
        // Convert semi-major axis from km to scene units
        semiMajorAxisInSceneUnits = semiMajorAxisKm / (EarthRadius / SCENE_EARTH_RADIUS);
    } else { // Elliptical orbit: input altitude is perigee
        const perigeeRadiusKm = EarthRadius + altitudeKm;
        const semiMajorAxisKm = perigeeRadiusKm / (1 - eccentricity);
        // Convert semi-major axis from km to scene units
        semiMajorAxisInSceneUnits = semiMajorAxisKm / (EarthRadius / SCENE_EARTH_RADIUS);
    }

    const params = {
        altitude: satelliteData.altitude, // Always store the original user input altitude
        semiMajorAxis: semiMajorAxisInSceneUnits, // The calculated semi-major axis in scene units
        inclinationRad: satelliteData.inclination * DEG2RAD,
        eccentricity: satelliteData.eccentricity,
        raan: satelliteData.raan * DEG2RAD,
        argPerigeeRad: satelliteData.argumentOfPerigee * DEG2RAD,
        beamwidth: satelliteData.beamwidth,
    };

    if (existingSat) {
        existingSat.updateParametersFromCurrentPosition(params, initialEpochUTC);
        existingSat.name = satelliteData.name || uniqueId;
    } else {
        const newSat = new Satellite(
            uniqueId,
            satelliteData.name || uniqueId,
            params,
            satelliteData.trueAnomaly ? E_to_M(TrueAnomaly_to_E(satelliteData.trueAnomaly * DEG2RAD, satelliteData.eccentricity), satelliteData.eccentricity) : 0,
            satelliteData.raan * DEG2RAD,
            initialEpochUTC
        );
        if (satelliteModelLoaded && globalSatelliteGLB) {
            newSat.setGlbMesh(globalSatelliteGLB);
        }
        newSat.setActiveMesh(window.closeViewEnabled);
        window.activeSatellites.set(newSat.id, newSat);
    }

    const satToUpdate = existingSat || window.activeSatellites.get(uniqueId);
    if (satToUpdate) {
        if (!satToUpdate._labelElement) {
            createSatelliteLabel(satToUpdate);
        } else {
            satToUpdate._labelElement.textContent = satToUpdate.name;
        }
        satToUpdate.setActiveMesh(window.closeViewEnabled);
    }
    if (window.is2DViewActive && window.texturesLoaded) {
        window.dispatchEvent(new Event('epochUpdated'));
    }
};

window.addOrUpdateGroundStationInScene = function(groundStationData) {
    const uniqueId = groundStationData.id || groundStationData.name;
    if (!uniqueId) return;

    let existingGs = window.activeGroundStations.get(uniqueId);
    if (existingGs) {
        existingGs.dispose();
        window.activeGroundStations.delete(uniqueId);
    }
    const newGs = new GroundStation(
        uniqueId,
        groundStationData.name || uniqueId,
        groundStationData.latitude,
        groundStationData.longitude
    );
    window.activeGroundStations.set(newGs.id, newGs);
    if (!newGs._labelElement) createGroundStationLabel(newGs);
    if (window.activeSatellites.size === 0 && window.activeGroundStations.size === 1) {
        const gsPosition = newGs.mesh.position;
        camera.position.set(gsPosition.x * 2, gsPosition.y * 2, gsPosition.z * 2 + 1);
        controls.target.copy(gsPosition);
        controls.update();
    }
    if (typeof window.updateAnimationDisplay === 'function') window.updateAnimationDisplay();
    renderer.render(scene, camera);
};

window.viewSimulation = function(data) {
    window.clearSimulationScene();
    if (typeof data.utcTimestamp === 'number') {
        window.currentEpochUTC = data.utcTimestamp;
        window.totalSimulatedTime = 0;
    } else {
        window.currentEpochUTC = Date.now();
        window.totalSimulatedTime = 0;
    }
    earthRotationManager.initialize(window.currentEpochUTC);

    if (data.fileType === 'single') {
        window.addOrUpdateSatelliteInScene({
            id: data.fileName,
            name: data.fileName,
            altitude: data.altitude,
            inclination: data.inclination,
            eccentricity: data.eccentricity,
            raan: data.raan,
            argumentOfPerigee: data.argumentOfPerigee,
            trueAnomaly: data.trueAnomaly,
            utcTimestamp: window.currentEpochUTC,
            beamwidth: data.beamwidth,
        });
        window.isAnimating = false;
        data.satellites = [data.fileName];
        window.fileOutputs.set(data.fileName, data);
        if (window.saveFilesToLocalStorage) window.saveFilesToLocalStorage();
        window.updateOutputTabForFile(data.fileName, data.fileType);
    } else if (data.fileType === 'constellation') {
        const params    = data;
        const satList   = [];
        const baseParams = {
            altitude:         params.altitude,
            inclination:      params.inclination,
            eccentricity:     params.eccentricity,
            raan:             params.raan,
            argumentOfPerigee:params.argumentOfPerigee,
            trueAnomaly:      params.trueAnomaly,
            utcTimestamp:     window.currentEpochUTC,
            beamwidth:        params.beamwidth,
        };

        if (params.constellationType === 'train') {
            const N         = params.numSatellites;
            const sepType   = params.separationType;
            const sepValue  = params.separationValue;
            const backward  = (params.trainDirection === 'backward');
            const derived   = calculateDerivedOrbitalParameters(baseParams.altitude, baseParams.eccentricity, EarthRadius);
            const periodSec = derived.orbitalPeriod;
            let spacingRad = 0;

            if (sepType === 'meanAnomaly') {
                spacingRad = sepValue * DEG2RAD;
            } else {
                spacingRad = ((2*Math.PI)/periodSec)*sepValue;
            }
            if (backward) spacingRad *= -1;

            let M0 = E_to_M(
                      TrueAnomaly_to_E(baseParams.trueAnomaly*DEG2RAD, baseParams.eccentricity),
                      baseParams.eccentricity
                     );

            for (let i = 0; i < N; i++) {
                const M_i = ((M0 + i*spacingRad) % (2*Math.PI) + 2*Math.PI) % (2*Math.PI);
                const TA  = E_to_TrueAnomaly(solveKepler(M_i, baseParams.eccentricity), baseParams.eccentricity) * (180/Math.PI);
                const satId   = `${data.fileName}-${Date.now()}-${i+1}`;
                const satName = `${data.fileName}_Sat${i+1}`;

                window.addOrUpdateSatelliteInScene({
                    id:               satId,
                    name:             satName,
                    altitude:         baseParams.altitude,
                    inclination:      baseParams.inclination,
                    eccentricity:     baseParams.eccentricity,
                    raan:             baseParams.raan,
                    argumentOfPerigee:baseParams.argumentOfPerigee,
                    trueAnomaly:      TA,
                    utcTimestamp:     window.currentEpochUTC,
                    beamwidth:        baseParams.beamwidth,
                    fileType:         data.fileType
                });
                satList.push(satId);
                window.isAnimating = false;
            }
        } else if (params.constellationType === 'walker') {
            const P     = parseInt(params.numPlanes,      10) || 1;
            const S     = parseInt(params.satellitesPerPlane,10) || 1;
            const F     = parseInt(params.phasingFactor,  10) || 0;
            const RAANdeg = parseFloat(params.raanSpread) || 360;
            const RAANstep = (RAANdeg/P)*DEG2RAD;
            const MAstep   = (2*Math.PI)/S;
            const PHstep   = (F*(2*Math.PI))/(P*S);

            let M0 = E_to_M(
                      TrueAnomaly_to_E(baseParams.trueAnomaly*DEG2RAD, baseParams.eccentricity),
                      baseParams.eccentricity
                     );

            for (let p = 0; p < P; p++) {
                const RAANp = ((baseParams.raan*DEG2RAD + p*RAANstep)%(2*Math.PI)+2*Math.PI)%(2*Math.PI);

                for (let s = 0; s < S; s++) {
                    let M_i = M0 + s*MAstep + p*PHstep;
                    M_i = ((M_i)%(2*Math.PI)+2*Math.PI)%(2*Math.PI);

                    const TA  = E_to_TrueAnomaly(solveKepler(M_i, baseParams.eccentricity), baseParams.eccentricity)*(180/Math.PI);
                    const satId   = `${data.fileName}-${Date.now()}-${p+1}-${s+1}`;
                    const satName = `${data.fileName}_Sat${p+1}_${s+1}`;

                    window.addOrUpdateSatelliteInScene({
                        id:               satId,
                        name:             satName,
                        altitude:         baseParams.altitude,
                        inclination:      baseParams.inclination,
                        eccentricity:     baseParams.eccentricity,
                        raan:             RAANp*(180/Math.PI),
                        argumentOfPerigee:baseParams.argumentOfPerigee,
                        trueAnomaly:      TA,
                        utcTimestamp:     window.currentEpochUTC,
                        beamwidth:        baseParams.beamwidth,
                        fileType:         data.fileType
                    });
                    satList.push(satId);
                    window.isAnimating = false;
                }
            }
        }
        params.satellites = satList;
        window.fileOutputs.set(data.fileName, params);
        if (window.saveFilesToLocalStorage) window.saveFilesToLocalStorage();
        window.updateOutputTabForFile(data.fileName, data.fileType);
    } else if (data.fileType === 'groundStation') {
        window.addOrUpdateGroundStationInScene(data);
    }
    
    updateSunDirection(window.totalSimulatedTime);
    renderer.render(scene, camera);
    if (window.updateAnimationDisplay) window.updateAnimationDisplay();
};

window.removeObjectFromScene = function(idToRemove, type) {
    if (type === 'satellite') {
        const sat = window.activeSatellites.get(idToRemove);
        if (sat) {
            sat.dispose();
            window.activeSatellites.delete(idToRemove);
            window.fileOutputs.forEach((fileData, fileName) => {
                if (fileData.satellites && fileData.satellites.includes(idToRemove)) {
                    fileData.satellites = fileData.satellites.filter(id => id !== idToRemove);
                    window.fileOutputs.set(fileName, fileData);
                    if (typeof window.saveFilesToLocalStorage === 'function') window.saveFilesToLocalStorage();
                    window.updateOutputTabForFile(fileName, fileData.fileType);
                }
            });
            if (window.selectedSatelliteId === idToRemove) {
                window.selectedSatelliteId = null;
                controls.target.set(0, 0, 0);
                camera.position.set(0, 0, 2.5);
                controls.update();
                window.closeViewEnabled = false;
            }
        }
    } else if (type === 'groundStation') {
        const gs = window.activeGroundStations.get(idToRemove);
        if (gs) {
            gs.dispose();
            window.activeGroundStations.delete(idToRemove);
            if (window.selectedGroundStationId === idToRemove) {
                window.selectedGroundStationId = null;
                controls.target.set(0, 0, 0);
                camera.position.set(0, 0, 2.5);
                controls.update();
            }
        }
    }
    if (typeof window.updateAnimationDisplay === 'function') window.updateAnimationDisplay();
};

window.getSimulationCoreObjects = function() {
    return {
        scene, camera, renderer, controls, earthGroup,
        activeSatellites: window.activeSatellites,
        activeGroundStations: window.activeGroundStations,
        isAnimating: window.isAnimating,
        is2DViewActive: window.is2DViewActive,
        currentSpeedMultiplier: window.currentSpeedMultiplier,
        totalSimulatedTime: window.totalSimulatedTime,
        selectedSatelliteId: window.selectedSatelliteId,
        closeViewEnabled: window.closeViewEnabled,
        currentEpochUTC: window.currentEpochUTC,
        setTotalSimulatedTime: (time) => { window.totalSimulatedTime = time; },
        setIsAnimating: (state) => { window.isAnimating = state; },
        setCurrentSpeedMultiplier: (speed) => { window.currentSpeedMultiplier = speed; },
        setSelectedSatelliteId: (id) => { window.selectedSatelliteId = id; },
        setCloseViewEnabled: (state) => {
            window.closeViewEnabled = state;
            window.activeSatellites.forEach(sat => sat.setActiveMesh(state));
        },
        setCurrentEpochUTC: (epoch) => { window.currentEpochUTC = epoch; }
    };
};

function load3DSimulationState() {
    // Verify that the data maps from simulation.blade.php are available
    if (typeof window.fileOutputs === 'undefined' || typeof window.groundStations === 'undefined') {
        console.error("Data maps (fileOutputs, groundStations) not found. Cannot load simulation state.");
        return;
    }

    console.log("Loading 3D simulation state from pre-loaded file data...");

    // Clear the scene once at the beginning to ensure a fresh start
    if (typeof window.clearSimulationScene === 'function') {
        window.clearSimulationScene();
    }

    // Use the epoch from the first available file, or default to the current time.
    const firstFile = window.fileOutputs.values().next().value;
    if (firstFile && typeof firstFile.utcTimestamp === 'number') {
        window.currentEpochUTC = firstFile.utcTimestamp;
        window.totalSimulatedTime = 0;
    } else {
        window.currentEpochUTC = Date.now();
        window.totalSimulatedTime = 0;
    }
    // Initialize the Earth rotation manager with the correct epoch
    earthRotationManager.initialize(window.currentEpochUTC);

    // Restore all satellites and constellations from the fileOutputs map
    window.fileOutputs.forEach(data => {
        if (data.fileType === 'single') {
            if (typeof window.addOrUpdateSatelliteInScene === 'function') {
                window.addOrUpdateSatelliteInScene(data);
            }
        } else if (data.fileType === 'constellation') {
            const params = data;
            const satList = [];
            const baseParams = {
                altitude: params.altitude,
                inclination: params.inclination,
                eccentricity: params.eccentricity,
                raan: params.raan,
                argumentOfPerigee: params.argumentOfPerigee,
                trueAnomaly: params.trueAnomaly,
                utcTimestamp: window.currentEpochUTC,
                beamwidth: params.beamwidth,
            };

            if (params.constellationType === 'train') {
                const N = params.numSatellites;
                const sepType = params.separationType;
                const sepValue = params.separationValue;
                const backward = (params.trainDirection === 'backward');
                const derived = calculateDerivedOrbitalParameters(baseParams.altitude, baseParams.eccentricity, EarthRadius);
                const periodSec = derived.orbitalPeriod;
                let spacingRad = 0;

                if (sepType === 'meanAnomaly') {
                    spacingRad = sepValue * DEG2RAD;
                } else {
                    spacingRad = ((2 * Math.PI) / periodSec) * sepValue;
                }
                if (backward) spacingRad *= -1;

                let M0 = E_to_M(
                    TrueAnomaly_to_E(baseParams.trueAnomaly * DEG2RAD, baseParams.eccentricity),
                    baseParams.eccentricity
                );

                for (let i = 0; i < N; i++) {
                    const M_i = ((M0 + i * spacingRad) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
                    const TA = E_to_TrueAnomaly(solveKepler(M_i, baseParams.eccentricity), baseParams.eccentricity) * (180 / Math.PI);
                    const satId = `${data.fileName}-${Date.now()}-${i+1}`;
                    const satName = `${data.fileName}_Sat${i+1}`;

                    window.addOrUpdateSatelliteInScene({
                        id: satId,
                        name: satName,
                        altitude: baseParams.altitude,
                        inclination: baseParams.inclination,
                        eccentricity: baseParams.eccentricity,
                        raan: baseParams.raan,
                        argumentOfPerigee: baseParams.argumentOfPerigee,
                        trueAnomaly: TA,
                        utcTimestamp: window.currentEpochUTC,
                        beamwidth: baseParams.beamwidth,
                        fileType: data.fileType
                    });
                    satList.push(satId);
                }
            } else if (params.constellationType === 'walker') {
                const P = parseInt(params.numPlanes, 10) || 1;
                const S = parseInt(params.satellitesPerPlane, 10) || 1;
                const F = parseInt(params.phasingFactor, 10) || 0;
                const RAANdeg = parseFloat(params.raanSpread) || 360;
                const RAANstep = (RAANdeg / P) * DEG2RAD;
                const MAstep = (2 * Math.PI) / S;
                const PHstep = (F * (2 * Math.PI)) / (P * S);

                let M0 = E_to_M(
                    TrueAnomaly_to_E(baseParams.trueAnomaly * DEG2RAD, baseParams.eccentricity),
                    baseParams.eccentricity
                );

                for (let p = 0; p < P; p++) {
                    const RAANp = ((baseParams.raan * DEG2RAD + p * RAANstep) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);

                    for (let s = 0; s < S; s++) {
                        let M_i = M0 + s * MAstep + p * PHstep;
                        M_i = ((M_i) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);

                        const TA = E_to_TrueAnomaly(solveKepler(M_i, baseParams.eccentricity), baseParams.eccentricity) * (180 / Math.PI);
                        const satId = `${data.fileName}-${Date.now()}-${p+1}-${s+1}`;
                        const satName = `${data.fileName}_Sat${p+1}_${s+1}`;

                        window.addOrUpdateSatelliteInScene({
                            id: satId,
                            name: satName,
                            altitude: baseParams.altitude,
                            inclination: baseParams.inclination,
                            eccentricity: baseParams.eccentricity,
                            raan: RAANp * (180 / Math.PI),
                            argumentOfPerigee: baseParams.argumentOfPerigee,
                            trueAnomaly: TA,
                            utcTimestamp: window.currentEpochUTC,
                            beamwidth: baseParams.beamwidth,
                            fileType: data.fileType
                        });
                        satList.push(satId);
                    }
                }
            }
        }
    });

    // Restore all ground stations
    window.groundStations.forEach(gsData => {
        if (typeof window.addOrUpdateGroundStationInScene === 'function') {
            window.addOrUpdateGroundStationInScene(gsData);
        }
    });

    // Perform a final render to show the loaded state
    updateSunDirection(window.totalSimulatedTime);
    renderer.render(scene, camera);
    if (typeof window.updateAnimationDisplay === 'function') {
        window.updateAnimationDisplay();
    }
    console.log("3D simulation state restored from file definitions.");
}

// Expose the function to the global window object so it can be called from simulation.blade.php
window.load3DSimulationState = load3DSimulationState;

// Utility functions for satellite data calculations Display
function toDeg(rad) {
  return (rad * 180/Math.PI).toFixed(2);
}

function computeAltitude(sat) {
  const kmPerUnit = EarthRadius;
  return ((sat.mesh.position.length() * kmPerUnit) - kmPerUnit).toFixed(2);
}

window.toDeg = toDeg;
window.computeAltitude = computeAltitude;

function updateSatellitePopup() {
    // Exit if there is no active popup
    if (!window.activeSatellitePopup) return;

    const { element, satId } = window.activeSatellitePopup;
    const sat = window.activeSatellites.get(satId);

    // If the satellite associated with the popup no longer exists, remove the popup.
    if (!sat) {
        if (element) {
            element.remove();
        }
        window.activeSatellitePopup = null;
        return;
    }

    const semiMajorAxisSceneUnits = sat.params.semiMajorAxis;
    const semiMajorAxisKm = semiMajorAxisSceneUnits * (EarthRadius / SCENE_EARTH_RADIUS);
    const nuRad = sat.currentTrueAnomaly;
    const { orbitalVelocity, orbitalPeriod } = calculateDerivedOrbitalParameters(
        semiMajorAxisKm,
        sat.params.eccentricity,
        nuRad
    );
    // Update the text content of all the data fields in the popup
    element.querySelector('.altitude').textContent = computeAltitude(sat);
    element.querySelector('.inclination').textContent = toDeg(sat.params.inclinationRad);
    element.querySelector('.latitude').textContent = sat.latitudeDeg.toFixed(2);
    element.querySelector('.longitude').textContent = sat.longitudeDeg.toFixed(2);
    element.querySelector('.raan').textContent = toDeg(sat.currentRAAN);
    element.querySelector('.orbitalPeriod').textContent = (orbitalPeriod / 60).toFixed(2);
    element.querySelector('.orbitalVelocity').textContent = orbitalVelocity.toFixed(2);
    element.querySelector('.beamwidth').textContent = sat.params.beamwidth;
    element.querySelector('.trueAnomaly').textContent = toDeg(sat.currentTrueAnomaly);
    element.querySelector('.eccentricity').textContent = sat.params.eccentricity.toFixed(4);
    element.querySelector('.argPerigee').textContent = toDeg(sat.params.argPerigeeRad);
}

window.updateSatellitePopup = updateSatellitePopup;

window.generateConstellationFromLinkBudget = function(linkBudgetData) {
    const constellationFileName = `${linkBudgetData.name}_Constellation`;

    const constellationParams = {
        fileName: constellationFileName, 
        fileType: 'constellation',
        constellationType: 'walker',
        altitude: linkBudgetData.altitude,
        inclination: linkBudgetData.inclination,
        beamwidth: linkBudgetData.beamwidth,
        eccentricity: 0,
        raan: 0,
        argumentOfPerigee: 0,
        trueAnomaly: 0,
        numPlanes: linkBudgetData.numOrbitalPlanes,
        satellitesPerPlane: linkBudgetData.satsPerPlane,
        raanSpread: linkBudgetData.raanSpread || 360,
        phasingFactor: linkBudgetData.phasingFactor || 1,
        epoch: new Date().toISOString().slice(0, 16),
        utcTimestamp: Date.now(),
        satellites: []
    };
    
    window.viewSimulation(constellationParams);
};

function animate() {
    requestAnimationFrame(animate);
    const currentTime = performance.now();
    const frameDeltaTime = (currentTime - lastAnimationFrameTime) / 1000;
    lastAnimationFrameTime = currentTime;
    const core3D = window.getSimulationCoreObjects();

    if (core3D.isAnimating) {
        core3D.setTotalSimulatedTime(core3D.totalSimulatedTime + frameDeltaTime * core3D.currentSpeedMultiplier);
        if (cloudsMesh) cloudsMesh.rotation.y += 0.05 * EARTH_ANGULAR_VELOCITY_RAD_PER_SEC * frameDeltaTime;
        core3D.activeSatellites.forEach(sat => sat.updatePosition(core3D.totalSimulatedTime, frameDeltaTime));
    }

    earthGroup.rotation.y = earthRotationManager.getRotationAngle(core3D.totalSimulatedTime);
    updateSunDirection(core3D.totalSimulatedTime);
    if (earthMesh.material.uniforms) earthMesh.material.uniforms.uTime.value = core3D.totalSimulatedTime;
    window.dispatchEvent(new Event('epochUpdated'));
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);

    if (window.proximityLabelsEnabled) labelVisibilityManager.updateProximityLabels();
    if (core3D.is2DViewActive && typeof window.draw2D === 'function') window.draw2D();
    if (window.updateSatellitePopup) window.updateSatellitePopup();
    if (typeof window.updateAnimationDisplay === 'function') window.updateAnimationDisplay();

    try {
        updateGsSatLinkLines();
    } catch (error) {
        console.error('Error in updateGsSatLinkLines:', error);
    }

    if (core3D.closeViewEnabled && core3D.selectedSatelliteId) {
        const selectedSat = core3D.activeSatellites.get(core3D.selectedSatelliteId);
        if (selectedSat) {
            const currentPos = selectedSat.mesh.position.clone();
            const forwardDir = selectedSat.velocity.length() > 0 ? selectedSat.velocity.clone().normalize() : new THREE.Vector3(0, 0, 1);
            const upDir = currentPos.clone().normalize();
            const cameraOffset = forwardDir.clone().multiplyScalar(-SCENE_EARTH_RADIUS * 0.08).add(upDir.clone().multiplyScalar(SCENE_EARTH_RADIUS * 0.04));
            const desiredCameraPos = currentPos.clone().add(cameraOffset);

            if (!window.gsapAnimating) {
                controls.enabled = true;
            }

            const distanceThreshold = SCENE_EARTH_RADIUS * 0.001;
            if (camera.position.distanceTo(desiredCameraPos) > distanceThreshold) {
                window.gsapAnimating = true;
                gsap.to(camera.position, {
                    duration: 0.15,
                    x: desiredCameraPos.x,
                    y: desiredCameraPos.y,
                    z: desiredCameraPos.z,
                    ease: "none",
                    onUpdate: () => controls.update(),
                    onComplete: () => {
                        window.gsapAnimating = false;
                        controls.enabled = true;
                    }
                });
                gsap.to(controls.target, {
                    duration: 0.15,
                    x: currentPos.x,
                    y: currentPos.y,
                    z: currentPos.z,
                    ease: "none",
                    onUpdate: () => controls.update()
                });
            }
            controls.object.up.copy(upDir);
            controls.update();
            controls.minDistance = SCENE_EARTH_RADIUS * 0.01;
            controls.maxDistance = SCENE_EARTH_RADIUS * 0.2;
            
            if (selectedSat.labelObject) {
                selectedSat.labelObject.visible = true;
                const distanceToCamera = camera.position.distanceTo(selectedSat.mesh.position);
                const labelHeight = Math.max(0.05, Math.min(0.1, distanceToCamera * 0.1));
                selectedSat.labelObject.position.set(0, labelHeight, 0);
            }
        }
    } else if (!core3D.closeViewEnabled) {
        window.gsapAnimating = false;
        controls.enabled = true;
        if (controls.minDistance !== 1.2 || controls.maxDistance !== 10 || controls.object.up.y !== 1) {
            controls.object.up.set(0, 1, 0);
            controls.minDistance = 1.2;
            controls.maxDistance = 10;
            controls.update();
        }
    }
}

animate();
window.addEventListener('resize', () => {
    const earthContainer = document.getElementById('earth-container');
    if (earthContainer && camera && renderer) {
        const newWidth = earthContainer.offsetWidth;
        const newHeight = earthContainer.offsetHeight;
        renderer.setSize(newWidth, newHeight);
        labelRenderer.setSize(newWidth, newHeight);
        camera.aspect = newWidth / newHeight;
        camera.updateProjectionMatrix();
        controls.update();
    }
});
