// index.js (or your main application file)
require('dotenv').config(); // Load environment variables from .env file
const { uploadFile } = require('./upload');

const filePath = './recordings/test.wav';
const jsonData = {
    "ID": '3159',
    "locLat": 52.495480,
    "locLon": 13.468430,
    "gain": 38.0
};

uploadFile(filePath, jsonData)
    .then(response => {
        // Handle success if needed
        console.log('Response:', response);
    })
    .catch(error => {
        // Handle error if needed
        console.error('Error:', error);
    });
