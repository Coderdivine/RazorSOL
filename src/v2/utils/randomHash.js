const crypto = require('crypto');

/**
 * Generates a random hash using a cryptographic algorithm.
 * @param {string} algorithm - The hash algorithm to use (default is 'sha256').
 * @param {number} length - The length of the random bytes (default is 16).
 * @returns {string} The generated hash as a hexadecimal string.
 */

function generateRandomHash(algorithm = 'sha256', length = 16) {
    const randomBytes = crypto.randomBytes(length);
    const hash = crypto.createHash(algorithm).update(randomBytes).digest('hex');
    return hash;
}

const randomHash = generateRandomHash();
module.exports = randomHash;
