// scheduler.js
const packageJson = require('./package.json');
const VERSION = packageJson.version;
const fs = require('fs');
const path = require('path');
const Logger = require('./logger');
const { isRecording, startRecording } = require('./recorder');
const { printLCD, clearLCD, startMarquee } = require('./lcd');
const { findConfigFile, loadConfig, saveConfig, getConfigPath } = require('./config');
const { checkWifiConnection } = require('./wifi');
const { checkDisk, deleteOldestRecordings } = require('./disk');
const { updatePasses, findHighestMaxElevationPass, ensurePassesFileExists, readPassesFile } = require('./passes'); // Import passes module
const axios = require('axios');

printLCD('booting up', 'groundstation');

let configPath;
let config;

try {
    configPath = getConfigPath();
    console.log(`Config file path: ${configPath}`);
    config = loadConfig();
    if (!config) throw new Error('Failed to load configuration');
} catch (error) {
    console.error(`Error loading configuration: ${error.message}`);
    printLCD('config error', 'check log');
    process.exit(1);
}

// print config
console.log(config);

// print the config path dir to the LCD
printLCD('config loaded');

// check Wi-Fi connection
try {
    await checkWifiConnection(config);
} catch (error) {
    console.error(`Error checking Wi-Fi connection: ${error.message}`);
}

// Initialize the logger with the configuration
const logger = new Logger(config);
logger.info('Logger loaded');
logger.info(`as user: ${process.getuid()}`);  // Log the user ID of the process
logger.info(`as group: ${process.getgid()}`);  // Log the group ID of the process
logger.info(`current working directory: ${process.cwd()}`);  // Log the current working directory

checkDisk(logger, config.saveDir, deleteOldestRecordings);

async function main() {
    printLCD('updating', 'passes...');
    await updatePasses(config, logger);
    printLCD('passes', 'updated');

    const passesFilePath = path.resolve(config.saveDir, config.passesFile);

    // ensure the passes file exists
    ensurePassesFileExists(passesFilePath, logger);

    // read it and parse it
    const passes = readPassesFile(passesFilePath, logger);

    // find the highest max elevation pass
    const highestMaxElevationPass = findHighestMaxElevationPass(passes);

    logger.log("Highest max elevation pass of the day:");
    logger.log(JSON.stringify(highestMaxElevationPass));

    printLCD('ground station', 'ready! :D' + ' v' + VERSION);

    if (highestMaxElevationPass) {
        const now = new Date();

        const recordTime = new Date(`${highestMaxElevationPass.date} ${highestMaxElevationPass.time}`);
        const delay = recordTime - now;

        if (delay > 0) {
            setTimeout(() => {
                handleRecording(highestMaxElevationPass, now, passesFilePath, passes);
            }, delay);

            logger.info(`Scheduling recording for ${highestMaxElevationPass.satellite} at ${highestMaxElevationPass.date} ${highestMaxElevationPass.time} for ${highestMaxElevationPass.duration} minutes...`);

            // after 2 minutes, display scheduled recording on the LCD
            const localTimeInfo = await getLocalTimeAndTimezone();

            if (localTimeInfo) {
                logger.info(`Current local time: ${localTimeInfo.localTime}`);
                logger.info(`Timezone: ${localTimeInfo.timezone}`);

                // convert the record time to local time
                const localRecordTime = new Date(recordTime.toLocaleString('en-US', { timeZone: localTimeInfo.timezone }));

                setTimeout(() => {
                    printLCD('recording pass at', `${localRecordTime.toLocaleTimeString()} ${localTimeInfo.timezone}`);
                }, delay - 120000);

            } else {
                logger.error('Failed to fetch local time and timezone.');
                process.exit(1);
            }


        } else {
            logger.log('The highest max elevation pass time is in the past, skipping recording.');
        }
    } else {
        logger.log('No valid passes found to record.');
    }
}

async function handleRecording(item, now, passesFilePath, jsonData) {
    const recordTime = new Date(`${item.date} ${item.time}`);
    logger.info(`Recording ${item.satellite} at ${item.date} ${item.time} for ${item.duration} minutes...`);

    startRecording(item.frequency, recordTime, item.satellite, item.duration, config, logger);

    const marqueeInterval = startMarquee(`Recording ${item.satellite} at ${item.date} ${item.time} for ${item.duration} minutes...`, 500);
    setTimeout(() => {
        clearInterval(marqueeInterval);
        clearLCD();
        printLCD('done recording');
    }, item.duration * 60000);

    item.recorded = true;

    // write the updated jsonData to the passes file
    fs.writeFileSync(passesFilePath, JSON.stringify(jsonData, null, 2));
}


async function getLocalTimeAndTimezone() {
    try {
        const response = await axios.get('http://worldtimeapi.org/api/ip');
        const data = response.data;
        return {
            localTime: data.datetime,
            timezone: data.timezone
        };
    } catch (error) {
        console.error('Error fetching local time and timezone:', error);
        return null;
    }
}



main().catch(err => logger.error(`Error in main execution: ${err.message}`));
