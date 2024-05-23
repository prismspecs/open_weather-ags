// test script to grab TLE from celestrak and find satellite passes over a specific location
// npm install axios satellite.js geolib luxon

const axios = require('axios');
const satellite = require('satellite.js');
const geolib = require('geolib');
const { DateTime } = require('luxon');
const fs = require('fs');

const maximumDistance = 2000000; // was 500000
const locLat = 52.495480;
const locLon = 13.468430;
const noaaFrequencies = {
    'NOAA 19': '137.1M',
    'NOAA 18': '137.9125M',
    'NOAA 15': '137.62M'
};
const passesFile = 'passes.json';
const daysToPropagate = 10;

// Function to check if the satellite passes over the given location within a certain distance
function isOverLocation(satLat, satLon, locLat, locLon, maxDistance = maximumDistance) {
    const distance = geolib.getDistance(
        { latitude: satLat, longitude: satLon },
        { latitude: locLat, longitude: locLon }
    );
    return distance <= maxDistance;
}

// Function to fetch TLE data from Celestrak
async function fetchTLEData() {
    const url = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=noaa&FORMAT=tle';
    const response = await axios.get(url);
    return response.data;
}

// Function to read existing passes from the file
function readExistingPasses() {
    if (fs.existsSync(passesFile)) {
        const data = fs.readFileSync(passesFile, 'utf8');
        if (data.trim() === '') {
            return [];
        }
        try {
            return JSON.parse(data);
        } catch (error) {
            console.error('Error parsing existing passes JSON:', error.message);
            return [];
        }
    }
    return [];
}

// Function to save passes to the file
function savePasses(passes) {
    passes.sort((a, b) => {
        const dateTimeA = DateTime.fromFormat(`${a.date} ${a.time}`, 'dd LLL yyyy HH:mm');
        const dateTimeB = DateTime.fromFormat(`${b.date} ${b.time}`, 'dd LLL yyyy HH:mm');
        return dateTimeA - dateTimeB;
    });
    fs.writeFileSync(passesFile, JSON.stringify(passes, null, 2));
}

// Function to find satellite passes over a specific location
async function findSatellitePasses(satName, tleLine1, tleLine2) {
    // Create a satellite record
    const satrec = satellite.twoline2satrec(tleLine1, tleLine2);

    // Time range for propagation
    const startTime = DateTime.utc();
    const endTime = startTime.plus({ days: daysToPropagate }); // Propagate for specified days
    const timeStep = { minutes: 1 }; // Propagation step

    // Loop through the time range and propagate the satellite's position
    let currentTime = startTime;
    let passStart = null;
    const passes = [];

    while (currentTime < endTime) {
        const positionAndVelocity = satellite.propagate(satrec, currentTime.toJSDate());
        const positionEci = positionAndVelocity.position;

        if (positionEci) {
            const gmst = satellite.gstime(currentTime.toJSDate());
            const positionGd = satellite.eciToGeodetic(positionEci, gmst);

            const satLat = satellite.degreesLat(positionGd.latitude);
            const satLon = satellite.degreesLong(positionGd.longitude);

            if (isOverLocation(satLat, satLon, locLat, locLon)) {
                if (!passStart) {
                    passStart = currentTime;
                }
            } else {
                if (passStart) {
                    passes.push({ start: passStart, end: currentTime });
                    passStart = null;
                }
            }
        }

        currentTime = currentTime.plus(timeStep);
    }

    // Check if there was an ongoing pass at the end of the time range
    if (passStart) {
        passes.push({ start: passStart, end: endTime });
    }

    return passes;
}

// Function to process passes and save to file
async function processPasses() {
    const tleData = await fetchTLEData();
    const tleLines = tleData.split('\n').filter(line => line.trim() !== '');

    console.log(`Found TLE data for ${tleLines.length / 3} satellites.`);

    const existingPasses = readExistingPasses();

    for (const satName in noaaFrequencies) {
        let tleLine1, tleLine2;
        for (let i = 0; i < tleLines.length; i++) {
            if (tleLines[i].startsWith(satName)) {
                tleLine1 = tleLines[i + 1];
                tleLine2 = tleLines[i + 2];
                break;
            }
        }

        if (!tleLine1 || !tleLine2) {
            console.error(`TLE data for ${satName} not found.`);
            continue;
        }

        const passes = await findSatellitePasses(satName, tleLine1, tleLine2);

        passes.forEach(pass => {
            const formattedStart = DateTime.fromISO(pass.start.toISO());
            const formattedEnd = DateTime.fromISO(pass.end.toISO());
            const duration = Math.round((formattedEnd - formattedStart) / (1000 * 60)); // duration in minutes

            const newPass = {
                frequency: noaaFrequencies[satName],
                satellite: satName,
                date: formattedStart.toFormat('dd LLL yyyy'),
                time: formattedStart.toFormat('HH:mm'),
                duration: duration,
                recorded: false
            };

            // Check for duplicates before adding
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

    console.log('Satellite passes have been updated and saved.');
}

// Execute the function to process passes
processPasses().catch(console.error);
