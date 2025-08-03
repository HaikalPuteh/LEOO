// sunCalculations.js

export function degToRad(degrees) {
    return degrees * (Math.PI / 180);
}

export function radToDeg(radians) {
    return radians * (180 / Math.PI);
}

function toJulian(date) {
    return (date.valueOf() / 86400000)+ 2440587.5;
}

export function getGMST(date) {
    const jd = toJulian(date);
    const t = (jd - 2451545.0) / 36525.0;
    
    // More accurate GMST calculation (IAU 2000)
    let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 
               0.000387933 * t * t - (t * t * t) / 38710000.0;
    
    // Normalize to [0, 360) degrees
    gmst = gmst % 360;
    if (gmst < 0) gmst += 360;
    
    return degToRad(gmst);
}


export function getSunCoords(date) {
    const jd = toJulian(date);
    
    const n = jd - 2451545.0;
    const t = n / 36525.0; // Julian centuries since J2000.0
    
    // FIXED: Mean longitude of the Sun (L0) - corrected coefficients
    let L0 = 280.46646 + n * 0.9856474 + t * t * 0.0000453;
    L0 = L0 % 360;
    if (L0 < 0) L0 += 360;
    
    let M = 357.52911 + n * 0.98560028 - t * t * 0.0001537;
    M = M % 360;
    if (M < 0) M += 360;
    const M_rad = degToRad(M);
    
    // Equation of center (C) - this looks correct
    const C = Math.sin(M_rad) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
              Math.sin(2 * M_rad) * (0.019993 - 0.000101 * t) +
              Math.sin(3 * M_rad) * 0.000289;
    
    // True longitude of the Sun
    const L = L0 + C;
    
    const omega = 125.04 - 1934.136 * t;
    const lambda = L - 0.00569 - 0.00478 * Math.sin(degToRad(omega));
    
    // FIXED: Obliquity calculation - use standard formula
    const epsilon0 = 23.4392911 - 0.0130042 * t - 0.00000164 * t * t + 0.000000504 * t * t * t;
    const epsilon = epsilon0 + 0.00256 * Math.cos(degToRad(omega));
    
    // Convert to radians for final calculations
    const lambda_rad = degToRad(lambda);
    const epsilon_rad = degToRad(epsilon);
    
    // Convert ecliptic to equatorial coordinates
    const sinLambda = Math.sin(lambda_rad);
    const cosLambda = Math.cos(lambda_rad);
    const sinEpsilon = Math.sin(epsilon_rad);
    const cosEpsilon = Math.cos(epsilon_rad);
    
    // Right ascension - ensure correct quadrant
    let alpha = Math.atan2(cosEpsilon * sinLambda, cosLambda);
    if (alpha < 0) alpha += 2 * Math.PI;
    
    // Declination
    const delta = Math.asin(sinEpsilon * sinLambda);
    
    return {
        ra: alpha,
        dec: delta,
    };
}


export function getSubsolarPoint(date) {
    const sunCoords = getSunCoords(date);
    const GMST = getGMST(date);
    
    let sunLongitude = sunCoords.ra - GMST;
    
    // Normalize longitude to [-π, π] range
    while (sunLongitude > Math.PI) sunLongitude -= 2 * Math.PI;
    while (sunLongitude < -Math.PI) sunLongitude += 2 * Math.PI;
    
    const sunLatitude = sunCoords.dec;
    
    return {
        Sun_dec: radToDeg(sunLatitude),    // Subsolar latitude
        Sun_ra: radToDeg(sunLongitude),    // Subsolar longitude
        latitudeRad: sunLatitude,
        longitudeRad: sunLongitude,
    };
}
