'use strict';

var semver = require('npm-registry/semver');

/**
 * The representation of a single module.
 *
 * @constructor
 * @param {Object} data The module data.
 * @param {String} range The semver range used to get this version.
 * @param {Number} depth How deeply nested was this module.
 * @api private
 */
function Module(data, range, depth) {
  this._id = data.name +'@'+ range;     // An unique id that identifies this module.
  this.released = data.released;        // The date this version go released.
  this.licenses = data.licenses;        // The licensing.
  this.version = data.version;          // The version of the module.
  this.author = data._npmUser || {};    // Author of the release.
  this.latest = data.latest;            // What the latest version is of the module.
  this.required = range;                // Which range we required to find this module.
  this.name = data.name;                // The name of the module.
  this.parents = [];                    // Modules that depend on this version.
  this.dependent = [];                  // Modules that depend on this version.
  this.depth = depth;                   // The depth of the dependency nesting.
}

//
// Is this dependency up to date.
//
Object.defineProperty(Module.prototype, 'uptodate', {
  enumerable: false,
  get: function get() {
    return this.version === this.latest;
  }
});

//
// Check if the give range is pinned.
//
Object.defineProperty(Module.prototype, 'pinned', {
  enumerable: false,
  get: function get() {
    if (this.range === '*' || this.range === 'latest') return false;

    var range = semver.validRange(this.range, true);

    if (range && range.indexOf('>=') === 0) return false;
    return true;
  }
});

/**
 * Create a clone of the module.
 *
 * @param {Object} data Data that should be merged with the clone.
 * @returns {Module} New Module instance
 * @api public
 */
Module.prototype.clone = function clone(data) {
  var module = new Module({
    _npmUser: JSON.parse(JSON.stringify(this.author || {})),
    released: this.released,
    licenses: this.licenses,
    version: this.version,
    latest: this.latest,
    name: this.name
  }, this.required, this.depth);

  if (data) Object.keys(data).forEach(function each(prop) {
    module[prop] = data[prop];
  });

  return module;
};

/**
 * Transform the instance to a valid object which will be returned for
 * a JSON.stringify.
 *
 * @returns {Object}
 * @api public
 */
Module.prototype.toJSON = function toJSON() {
  return {
    uptodate: this.uptodate,
    required: this.required,
    released: this.released,
    licenses: this.licenses,
    version: this.version,
    pinned: this.pinned,
    author: this.author,
    latest: this.latest,
    depth: this.depth,
    name: this.name,
    _id: this._id,

    parents: (this.parents || this.dependent || []).map(function map(parent) {
      return parent.name +'@'+ parent.version;
    })
  };
};

//
// Expose the Module.
//
module.exports = Module;
