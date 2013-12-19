'use strict';

var Registry = require('./registry')
  , Version = require('./version')
  , semver = require('./semver')
  , async = require('async')
  , path = require('path')
  , fs = require('fs');

/**
 * Generate a new shrinkwrap from a given package or module.
 *
 * Options:
 *
 * - registry: URL of the npm registry we should use to read package information.
 * - production: Should we only include production packages.
 * - limit: Amount of parallel processing tasks we could use to retrieve data.
 *
 * @constructor
 * @param
 * @param {Object} options Options.
 * @api public
 */
function Shrinkwrap(name, options) {
  if ('object' === typeof name) {
    options = name;
    name = null;
  }

  options = options || {};

  this.registry = new Registry(options.registry);
  this.output = options.output || 'npm-shrinkwrap.json';
  this.production = options.production || process.NODE_ENV === 'production';
  this.limit = options.limit || 10;
  this.dependencies = [];
  this.cache = Object.create(null);

  if (name) this.scan(name);
}

Shrinkwrap.prototype.__proto__ = require('eventemitter3').prototype;

/**
 * Fetch the package information from a given `package.json` or from a remote
 * module.
 *
 * @param {String} name Either the location of the package.json or name
 */
Shrinkwrap.prototype.scan = function scan(name) {
  var shrinkwrap = this;

  /**
   * We've read in the data, and are about to process it's contents and create
   * a shrinkwrap graph.
   *
   * @param {Error} err Optional error argument.
   * @param {Object} pkg The package data.
   * @api private
   */
  function search(err, pkg) {
    if (err) return shrinkwrap.emit('error', err);

    //
    // Make sure they have _id property, this is something that the npm registry
    // uses for the packages and is re-used in the shrinkwrap file. But it's not
    // present in regular `package.json`'s
    //
    pkg._id = pkg._id || pkg.name +'@'+ pkg.version;

    shrinkwrap.emit('read', pkg);
    shrinkwrap.ls(pkg);
  }

  if (~name.indexOf('package.json')) {
    this.read(name, search);
  } else {
    this.registry.release(name, '*', search);
  }

  return this;
};

/**
 * List all dependencies for the given type.
 *
 * @api private
 */
Shrinkwrap.prototype.ls = function ls(pkg) {
  pkg = this.dedupe(pkg);

  var registry = this.registry
    , shrinkwrap = this
    , seen = {};

  //
  // The initial data structure of a shrinkwrapped module.
  //
  var data = {
    name: pkg.name,
    version: pkg.version
  };

  var queue = async.queue(function worker(data, next) {
    var from = data.name +'@'+ data.range;

    if (from in seen) {
      data.ref[data.name] = seen[from];
      return next();
    }

    registry.release(data.name, data.range, function (err, pkg) {
      if (err) return next(err);

      seen[from] = {
        version: pkg.version,
        shasum: pkg.shasum,
        license: pkg.license,
        released: pkg.date,
        from: from
      };

      data.ref[data.name] = seen[from];

      pkg = shrinkwrap.dedupe(pkg);
      if (pkg.dependencies) Object.keys(pkg.dependencies).forEach(function (key) {
        queue.push({
          name: key,
          range: pkg.dependencies[key],
          ref: seen[from].dependencies || (seen[from].dependencies = {})
        });
      });

      next();
    });
  }, this.limit);

  queue.drain = function ondrain() {
    shrinkwrap.emit('ls', data);
  };

  Object.keys(pkg.dependencies).forEach(function (key) {
    queue.push({
      name: key,
      range: pkg.dependencies[key],
      ref: data.dependencies || (data.dependencies = {})
    });
  });
};

/**
 * It could be that a package has dependency added as devDependency as well as
 * a regular dependency. We want to make sure that we dont' filter out this
 * dependency when we're resolving packages so we're going to remove it from the
 * devDependencies if they are exactly the same.
 *
 * @param {Object} pkg The package.
 * @returns {Object} The package.
 * @api private
 */
Shrinkwrap.prototype.dedupe = function dedupe(pkg) {
  if (!pkg.dependencies) return pkg;
  if (!pkg.devDependencies) return pkg;

  Object.keys(pkg.dependencies).forEach(function searchanddestroy(name) {
    if (!(name in pkg.devDependencies)) return;
    if (!semver.eq(pkg.devDependencies[name], pkg.dependencies[name])) return;

    //
    // Only remove when we have an exact match on the version number.
    //
    delete pkg.devDependencies[name];
  });

  return pkg;
};

/**
 * Read a file so it can be parsed as dependency list.
 *
 * @param {String} file The location of the file that we need to parse.
 * @param {Function} fn Optional callback for error handling.
 * @api private
 */
Shrinkwrap.prototype.read = function read(file, fn) {
  fs.readFile(file, 'utf-8', function reads(err, content) {
    if (err) return fn(err);

    var data;

    try { data = JSON.parse(content); }
    catch (e) {
      return fn(new Error(file +' contains invalid JSON: '+ e.message));
    }

    fn(undefined, data);
  });

  return this;
};

Shrinkwrap.dependencies = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies'
];

//
// Expose the module interface.
//
Shrinkwrap.Version = Version;
Shrinkwrap.Registry = Registry;

module.exports = Shrinkwrap;
