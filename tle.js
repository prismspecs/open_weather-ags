const axios = require('axios');
const satellite = require('satellite.js');
const geolib = require('geolib');
const { DateTime } = require('luxon');
const fs = require('fs');

let config = null;
let logger = null;

// Fetch TLE data from Celestrak
async function fetchTLEData() {
    const url = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=noaa&FORMAT=tle';
    try {
        const response = await axios.get(url);
        return response.data;
    } catch (error) {
        logger.error('Error fetching TLE data: ' + error.message);
        throw error;
    }
}

// Read existing passes from the file
function readExistingPasses() {
    if (fs.existsSync(config.passesFile)) {
        const data = fs.readFileSync(config.passesFile, 'utf8');
        if (data.trim() === '') {
            return [];
        }
        try {
            return JSON.parse(data);
        } catch (error) {
            logger.error('Error parsing existing passes JSON: ' + error.message);
            return [];
        }
    }
    return [];
}

// Save passes to the file
function savePasses(passes) {
    // Sort passes by date and time
    passes.sort((a, b) => {
        const dateTimeA = DateTime.fromFormat(`${a.date} ${a.time}`, 'dd LLL yyyy HH:mm');
        const dateTimeB = DateTime.fromFormat(`${b.date} ${b.time}`, 'dd LLL yyyy HH:mm');
        return dateTimeA - dateTimeB;
    });
    fs.writeFileSync(config.passesFile, JSON.stringify(passes, null, 2));
}

// Find satellite passes over a specific location
async function findSatellitePasses(satName, tleLine1, tleLine2) {
    const satrec = satellite.twoline2satrec(tleLine1, tleLine2);
    const startTime = DateTime.utc();
    const endTime = startTime.plus({ days: config.daysToPropagate });
    const timeStep = { minutes: 1 };
    let currentTime = startTime;
    let passStart = null;
    const passes = [];
    let elevations = [];
    let distances = [];

    while (currentTime < endTime) {
        const positionAndVelocity = satellite.propagate(satrec, currentTime.toJSDate());
        const positionEci = positionAndVelocity.position;

        if (positionEci) {
            const gmst = satellite.gstime(currentTime.toJSDate());
            const positionGd = satellite.eciToGeodetic(positionEci, gmst);
            const satLat = satellite.degreesLat(positionGd.latitude);
            const satLon = satellite.degreesLong(positionGd.longitude);
            const distance = geolib.getDistance(
                { latitude: satLat, longitude: satLon },
                { latitude: config.locLat, longitude: config.locLon }
            );

            if (distance <= config.maxDistance) {
                const observerGd = {
                    longitude: satellite.degreesToRadians(config.locLon),
                    latitude: satellite.degreesToRadians(config.locLat),
                    height: 0
                };
                const positionEcf = satellite.eciToEcf(positionEci, gmst);
                const lookAngles = satellite.ecfToLookAngles(observerGd, positionEcf);
                const elevation = satellite.radiansToDegrees(lookAngles.elevation);

                if (!passStart) {
                    passStart = currentTime;
                    elevations = [];
                    distances = [];
                }

                elevations.push(elevation);
                distances.push(distance);
            } else if (passStart) {
                const avgElevation = elevations.reduce((sum, el) => sum + el, 0) / elevations.length;
                const maxElevation = Math.max(...elevations);
                const avgDistance = distances.reduce((sum, el) => sum + el, 0) / distances.length;
                const minDistance = Math.min(...distances);

                passes.push({
                    start: passStart,
                    end: currentTime,
                    maxElevation: maxElevation.toFixed(2),
                    avgElevation: avgElevation.toFixed(2),
                    avgDistance: avgDistance.toFixed(2),
                    minDistance: minDistance.toFixed(2)
                });
                passStart = null;
            }
        }

        currentTime = currentTime.plus(timeStep);
    }

    if (passStart) {
        const avgElevation = elevations.reduce((sum, el) => sum + el, 0) / elevations.length;
        const maxElevation = Math.max(...elevations);
        passes.push({
            start: passStart,
            end: currentTime,
            maxElevation: maxElevation.toFixed(2),
            avgElevation: avgElevation.toFixed(2)
        });
    }

    return passes;
}

// Process passes and save to file
async function processPasses(configParam, loggerParam) {
    config = configParam;
    logger = loggerParam;

    try {
        logger.info('Starting TLE data processing...');

        // Fetch TLE data
        const tleData = await fetchTLEData();
        const tleLines = tleData.split('\n').filter(line => line.trim() !== '');
        logger.info(`Found TLE data for ${tleLines.length / 3} satellites.`);

        const existingPasses = readExistingPasses();

        for (const satName in config.noaaFrequencies) {
            let tleLine1, tleLine2;
            for (let i = 0; i < tleLines.length; i++) {
                if (tleLines[i].startsWith(satName)) {
                    tleLine1 = tleLines[i + 1];
                    tleLine2 = tleLines[i + 2];
                    break;
                }
            }

            if (!tleLine1 || !tleLine2) {
                logger.error(`TLE data for ${satName} not found.`);
                continue;
            }

            logger.info(`Processing satellite: ${satName}`);
            const passes = await findSatellitePasses(satName, tleLine1, tleLine2);

            passes.forEach(pass => {
                const formattedStart = DateTime.fromISO(pass.start.toISO());
                const formattedEnd = DateTime.fromISO(pass.end.toISO());
                const maxElevation = pass.maxElevation || 'N/A';
                const avgElevation = pass.avgElevation || 'N/A';
                const avgDistance = pass.avgDistance || 'N/A';
                const minDistance = pass.minDistance || 'N/A';

                const bufferStart = formattedStart.minus({ minutes: config.bufferMinutes });
                const bufferEnd = formattedEnd.plus({ minutes: config.bufferMinutes });
                const bufferDuration = Math.round((bufferEnd - bufferStart) / (1000 * 60));

                const newPass = {
                    frequency: config.noaaFrequencies[satName],
                    satellite: satName,
                    date: bufferStart.toFormat('dd LLL yyyy'),
                    time: bufferStart.toFormat('HH:mm'),
                    duration: bufferDuration,
                    avgElevation: avgElevation,
                    maxElevation: maxElevation,
                    avgDistance: avgDistance,
                    minDistance: minDistance,
                    recorded: false
                };

                const duplicate = existingPasses.some(
                    existingPass =>
                        existingPass.satellite === newPass.satellite &&
                        existingPass.date === newPass.date &&
                        existingPass.time === newPass.time
                );

                if (!duplicate) {
                    existingPasses.push(newPass);
                }
            });
        }

        // Save updated passes
        savePasses(existingPasses);
        logger.info('Satellite passes have been updated and saved.');
    } catch (err) {
        logger.error('Error processing TLE data: ' + err.message);
        throw err;
    }
}

if (require.main === module) {
    config = JSON.parse(fs.readFileSync('default.config.json', 'utf8'));
    const Logger = require('./logger');
    const logger = new Logger(config);
    processPasses(config, logger).catch(console.error);
} else {
    module.exports = {
        processPasses
    };
}
