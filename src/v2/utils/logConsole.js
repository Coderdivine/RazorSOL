const debugMode = false;

const logConsole = (...args) => {
    if (debugMode) {
        return console.log(...args);
    }
    return;
};

module.exports = logConsole;
