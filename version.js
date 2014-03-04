'use strict';

var semver = require('npm-registry/semver');

/**
 * A simple representation of a module's version number.
 *
 * @constructor
 * @param {String} number The version number.
 * @api public
 */
function Version(number) {
  this.number = number;
}

/**
 * Check if the version number is greater then the given `version`.
 *
 * @param {String} version Version number.
 * @returns {Boolean}
 * @api public
 */
Version.prototype.gt = function gt(version) {
  return semver.gt(this.number, version);
};

/**
 * Check if the version number is less then the given `version`.
 *
 * @param {String} version Version number.
 * @returns {Boolean}
 * @api public
 */
Version.prototype.lt = function lt(number) {
  return semver.lt(this.number, number);
};

/**
 * String representation of the current version number.
 *
 * @api private
 */
Version.prototype.toString = function toString() {
  return this.number;
};

//
// Expose the module.
//
module.exports = Version;
