// scheduler.js
// this is the main app which schedules recordings based on the passes data

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
const {
    updatePasses,
    findHighestMaxElevationPass,
    ensurePassesFileExists,
    readPassesFile,
} = require('./passes');
const axios = require('axios');

let logger;
let config;

async function main() {
    printLCD('booting up', 'groundstation');

    let configPath;

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

    // Print config
    console.log(config);

    // Indicate on LCD that config is loaded
    printLCD('config loaded');

    // Initialize the logger with the configuration
    logger = new Logger(config);
    logger.info('Logger loaded');
    logger.info(`as user: ${process.getuid()}`); // Log the user ID of the process
    logger.info(`as group: ${process.getgid()}`); // Log the group ID of the process
    logger.info(`current working directory: ${process.cwd()}`); // Log the current working directory

    // Check Wi-Fi connection
    printLCD('checking', 'Wi-Fi...');
    try {
        await checkWifiConnection(config);
        printLCD('Wi-Fi', 'connected');
    } catch (error) {
        console.error(`Error checking Wi-Fi connection: ${error.message}`);
        logger.error(`Error checking Wi-Fi connection: ${error.message}`);
        printLCD('Wi-Fi error', 'try restart');
        process.exit(1);
    }

    // Check disk space and delete oldest recordings if necessary
    checkDisk(logger, config.saveDir, deleteOldestRecordings);

    printLCD('updating', 'passes...');
    await updatePasses(config, logger);
    printLCD('passes', 'updated');

    const passesFilePath = path.resolve(config.saveDir, config.passesFile);

    // Ensure the passes file exists
    ensurePassesFileExists(passesFilePath, logger);

    // Read and parse the passes file
    const passes = readPassesFile(passesFilePath, logger);

    // Find the highest max elevation pass
    const highestMaxElevationPass = findHighestMaxElevationPass(passes);

    logger.info('Highest max elevation pass of the day:');
    logger.info(JSON.stringify(highestMaxElevationPass));

    printLCD('ground station', `ready! :D v${VERSION}`);

    if (highestMaxElevationPass) {
        const now = new Date();

        const recordTime = new Date(
            `${highestMaxElevationPass.date} ${highestMaxElevationPass.time}`
        );
        const delay = recordTime - now;

        if (delay > 0) {
            setTimeout(async () => {
                await handleRecording(
                    highestMaxElevationPass,
                    now,
                    passesFilePath,
                    passes
                );
            }, delay);

            logger.info(
                `Scheduling recording for ${highestMaxElevationPass.satellite} at ${highestMaxElevationPass.date} ${highestMaxElevationPass.time} for ${highestMaxElevationPass.duration} minutes...`
            );

            // After 2 minutes, display scheduled recording on the LCD
            const localTimeInfo = await getLocalTimeAndTimezone();

            if (localTimeInfo) {
                logger.info(`Current local time: ${localTimeInfo.localTime}`);
                logger.info(`Timezone: ${localTimeInfo.timezone}`);

                // Convert the record time to local time
                const localRecordTime = new Date(
                    recordTime.toLocaleString('en-US', { timeZone: localTimeInfo.timezone })
                );

                setTimeout(() => {
                    printLCD(
                        'will record at',
                        `${localRecordTime.toLocaleTimeString()}`
                    );
                }, 60000);
            } else {
                logger.error('Failed to fetch local time and timezone.');
                process.exit(1);
            }
        } else {
            logger.info(
                'The highest max elevation pass time is in the past, skipping recording.'
            );
        }
    } else {
        logger.info('No valid passes found to record.');
    }
}

async function handleRecording(item, now, passesFilePath, jsonData) {
    const recordTime = new Date(`${item.date} ${item.time}`);
    logger.info(
        `Recording ${item.satellite} at ${item.date} ${item.time} for ${item.duration} minutes...`
    );

    startRecording(item.frequency, recordTime, item.satellite, item.duration, config, logger);

    const marqueeInterval = startMarquee(
        `Recording ${item.satellite} at ${item.date} ${item.time} for ${item.duration} minutes...`,
        500
    );
    setTimeout(() => {
        clearInterval(marqueeInterval);
        clearLCD();
        printLCD('done recording');
    }, item.duration * 60000);

    item.recorded = true;

    // Write the updated jsonData to the passes file
    fs.writeFileSync(passesFilePath, JSON.stringify(jsonData, null, 2));
}

async function getLocalTimeAndTimezone() {
    try {
        const response = await axios.get('https://ipapi.co/timezone');
        const timezone = response.data;

        return {
            timezone,
            localTime: new Date().toLocaleString('en-US', { timeZone: timezone }),
        };
    } catch (error) {
        console.error('Error fetching local time and timezone:', error);
        logger.error(`Error fetching local time and timezone: ${error.message}`);
        // Return UTC as fallback
        return {
            timezone: 'UTC',
            localTime: new Date().toLocaleString('en-US', { timeZone: 'UTC' }),
        };
    }
}

main().catch((err) => {
    console.error(`Error in main execution: ${err.message}`);
    if (logger) logger.error(`Error in main execution: ${err.message}`);
});
