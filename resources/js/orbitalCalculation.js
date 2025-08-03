//orbitalCalculation.js
import * as THREE from "three";
import {
    J2,
    MU_EARTH,
    EarthRadius,
    SCENE_EARTH_RADIUS
} from "./parametersimulation.js";

/**
 * Validates orbital parameters for physical realism
 * @param {object} params - Orbital parameters to validate
 * @throws {Error} If parameters are invalid
 */
export function validateOrbitalParameters(params) {
    if (params.eccentricity < 0 || params.eccentricity >= 1) {
        throw new Error(`Invalid eccentricity: ${params.eccentricity}. Must be 0 ≤ e < 1`);
    }
    
    // CORRECTED: Convert semiMajorAxis from scene units to km for validation
    const semiMajorAxisKm = params.semiMajorAxis * (EarthRadius / SCENE_EARTH_RADIUS);
    const perigeeAltitudeKm = semiMajorAxisKm * (1 - params.eccentricity) - EarthRadius;

    if (perigeeAltitudeKm < 100) {
        throw new Error(`Perigee altitude too low: ${perigeeAltitudeKm.toFixed(1)} km. Minimum is 100 km`);
    }
    
    if (params.beamwidth < 0 || params.beamwidth > 180) {
        // Allow 0 for beamwidth, but log a warning.
        if (params.beamwidth !== 0) {
            console.warn(`Invalid beamwidth: ${params.beamwidth}°. Must be 0-180°`);
        }
    }
}


/**
 * Solves Kepler's Equation (M = E - e*sin(E)) for the Eccentric Anomaly (E)
 * using the Newton-Raphson iterative method with improved convergence.
 * @param {number} M - Mean Anomaly in radians.
 * @param {number} e - Eccentricity (dimensionless).
 * @param {number} [epsilon=1e-8] - Desired accuracy for E.
 * @param {number} [maxIterations=50] - Maximum number of iterations to prevent infinite loops.
 * @returns {number} The Eccentric Anomaly in radians.
 */
export function solveKepler(M, e, epsilon = 1e-8, maxIterations = 50) {
    // Validate inputs
    if (e < 0 || e >= 1) {
        throw new Error(`Invalid eccentricity for Kepler solver: ${e}`);
    }
    
    // Normalize mean anomaly to [0, 2π]
    M = ((M % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
    
    // Better initial guess based on eccentricity
    let E;
    if (e < 0.8) {
        E = M;
    } else {
        // For high eccentricity, use a better initial guess
        E = M + e * Math.sin(M) / (1 - Math.sin(M + e) + Math.sin(M));
    }
    
    for (let i = 0; i < maxIterations; i++) {
        const sinE = Math.sin(E);
        const cosE = Math.cos(E);
        const f = E - e * sinE - M;
        const fp = 1 - e * cosE;
        
        // Newton-Raphson step
        const dE = f / fp;
        E -= dE;
        
        if (Math.abs(dE) < epsilon) {
            return E;
        }
    }
    
    // Warn if not converged but still return best estimate
    console.warn(`Kepler equation did not converge for M=${M.toFixed(6)}, e=${e.toFixed(6)} after ${maxIterations} iterations. Final error: ${Math.abs(E - e * Math.sin(E) - M).toFixed(8)}`);
    return E;
}

/**
 * Converts Eccentric Anomaly (E) to True Anomaly (nu, or theta).
 * @param {number} E - Eccentric Anomaly in radians.
 * @param {number} e - Eccentricity.
 * @returns {number} The True Anomaly in radians.
 */
export function E_to_TrueAnomaly(E, e) {
    const tanHalfNu = Math.sqrt((1 + e) / (1 - e)) * Math.tan(E / 2);
    return 2 * Math.atan(tanHalfNu);
}

/**
 * Converts True Anomaly (nu, or theta) to Eccentric Anomaly (E).
 * @param {number} nu - True Anomaly in radians.
 * @param {number} e - Eccentricity.
 * @returns {number} The Eccentric Anomaly in radians.
 */
export function TrueAnomaly_to_E(nu, e) {
    const tanHalfE = Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2);
    return 2 * Math.atan(tanHalfE);
}

/**
 * Converts Eccentric Anomaly (E) to Mean Anomaly (M).
 * @param {number} E - Eccentric Anomaly in radians.
 * @param {number} e - Eccentricity.
 * @returns {number} The Mean Anomaly in radians.
 */
export function E_to_M(E, e) {
    return E - e * Math.sin(E);
}

/**
 * Calculates the Cartesian (x, y, z) position of a satellite in the Earth-centered inertial (ECI) frame.
 * This is based on its classical orbital elements.
 *
 * @param {object} params - Satellite orbital parameters (semiMajorAxis (in scene units), eccentricity, inclinationRad, argPerigeeRad).
 * @param {number} currentMeanAnomaly - Current Mean Anomaly in radians.
 * @param {number} currentRAAN - Current Right Ascension of the Ascending Node in radians.
 * @param {number} [sceneEarthRadius=1] - The Earth's radius in Three.js scene units (this is SCENE_EARTH_RADIUS).
 * @returns {object} An object with x, y, z properties in Three.js scene units.
 */
export function calculateSatellitePositionECI(params, currentMeanAnomaly, currentRAAN, sceneEarthRadius = 1) {
    // Validate parameters
    try {
        validateOrbitalParameters(params);
    } catch (error) {
        console.warn("Orbital parameter validation warning:", error.message);
    }
    
    // Convert semiMajorAxis from scene units (relative to SCENE_EARTH_RADIUS) to actual kilometers
    const a_km_actual = params.semiMajorAxis * (EarthRadius / sceneEarthRadius);
    const e = params.eccentricity;
    const i_rad = params.inclinationRad;
    const argPerigee_rad = params.argPerigeeRad;

    const E = solveKepler(currentMeanAnomaly, e);
    const nu = E_to_TrueAnomaly(E, e);

    const r_km = a_km_actual * (1 - e * e) / (1 + e * Math.cos(nu));

    const x_perifocal = r_km * Math.cos(nu);
    const y_perifocal = r_km * Math.sin(nu);

    const position_km = new THREE.Vector3(x_perifocal, y_perifocal, 0);

    const rotationMatrix = new THREE.Matrix4();
    const R_argP = new THREE.Matrix4().makeRotationZ(argPerigee_rad);
    const R_inc = new THREE.Matrix4().makeRotationX(i_rad);
    const R_raan = new THREE.Matrix4().makeRotationZ(currentRAAN);

    rotationMatrix.multiply(R_raan).multiply(R_inc).multiply(R_argP);
    position_km.applyMatrix4(rotationMatrix);

    // This mapping is the key to fixing the orbital direction.
    // ECI X -> Three.js X
    // ECI Y -> Three.js -Z (to maintain a right-handed system)
    // ECI Z -> Three.js Y (up)
    const scenePosition = new THREE.Vector3(
        position_km.x / EarthRadius * sceneEarthRadius,
        position_km.z / EarthRadius * sceneEarthRadius,
        -position_km.y / EarthRadius * sceneEarthRadius
    );

    return { x: scenePosition.x, y: scenePosition.y, z: scenePosition.z };
}


/**
 * Calculates additional derived orbital parameters.
 * @param {number} semiMajorAxisKm - The semi-major axis of the orbit in kilometers.
 * @param {number} eccentricity - Eccentricity (dimensionless).
 * @param {number} [nuRad=0] - The true anomaly in radians, used for calculating instantaneous velocity.
 * @returns {object} Object with orbitalPeriod (seconds) and orbitalVelocity (km/s).
 */
export function calculateDerivedOrbitalParameters(semiMajorAxisKm, eccentricity, nuRad = 0) {
    // Validate inputs
    if (semiMajorAxisKm <= EarthRadius) {
        throw new Error(`Invalid semi-major axis: ${semiMajorAxisKm} km. Must be greater than Earth's radius.`);
    }
    if (eccentricity < 0 || eccentricity >= 1) {
        throw new Error(`Invalid eccentricity: ${eccentricity}`);
    }

    // Calculate the instantaneous radius (distance from center of Earth)
    const r_km = semiMajorAxisKm * (1 - eccentricity * eccentricity) / (1 + eccentricity * Math.cos(nuRad));
    
    // Calculate orbital period (depends only on semi-major axis)
    const orbitalPeriodSeconds = 2 * Math.PI * Math.sqrt(Math.pow(semiMajorAxisKm, 3) / MU_EARTH);
    
    // Calculate instantaneous orbital velocity using the vis-viva equation
    const orbitalVelocity = Math.sqrt(MU_EARTH * ((2 / r_km) - (1 / semiMajorAxisKm)));

    return {
        orbitalPeriod: orbitalPeriodSeconds,
        orbitalVelocity: orbitalVelocity,
    };
}


export function updateOrbitalElements(satellite, totalSimulatedTime) {
  const a_km   = satellite.params.semiMajorAxis * (EarthRadius / SCENE_EARTH_RADIUS);
  const e      = satellite.params.eccentricity;
  const i_rad  = satellite.params.inclinationRad;
  const n0     = Math.sqrt(MU_EARTH / Math.pow(a_km, 3));
  const p      = a_km * (1 - e*e);

  // J2 perturbation factor
  const J2_factor = 1.5 * J2 * Math.pow(EarthRadius / p, 2) * n0;

  // Secular rates of change
  const dRAAN_dt   = -J2_factor * Math.cos(i_rad);
  const dArgP_dt   =  J2_factor * (2.5 * Math.pow(Math.sin(i_rad), 2) - 2);
  const dM_J2_dt   =  0.5 * J2_factor * Math.sqrt(1 - e*e) * (3 * Math.pow(Math.cos(i_rad), 2) - 1);

  // Update elements based on time elapsed since the satellite's own epoch
  satellite.currentRAAN         = satellite.initialRAAN       + dRAAN_dt * totalSimulatedTime;
  satellite.currentArgPerigee   = satellite.initialArgPerigee + dArgP_dt * totalSimulatedTime;
  satellite.currentMeanAnomaly  = satellite.initialMeanAnomaly + (n0 + dM_J2_dt) * totalSimulatedTime;

  // Normalize angles to be within [0, 2π]
  satellite.currentRAAN        = ((satellite.currentRAAN % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
  satellite.currentArgPerigee  = ((satellite.currentArgPerigee % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
  satellite.currentMeanAnomaly = ((satellite.currentMeanAnomaly % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
  
  // Update the params object as well, as other parts of the code might read from it
  satellite.params.argPerigeeRad = satellite.currentArgPerigee;
}
