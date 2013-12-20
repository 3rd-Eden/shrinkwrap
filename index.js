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
    , dependency = {};

  //
  // The initial data structure of a shrinkwrapped module.
  //
  var data = {
    name: pkg.name,
    version: pkg.version
  };

  /**
   * Push new items in to the queue.
   *
   * @param {Object} pkg The package we need to scan.
   * @param {Object} ref The location of new packages.
   * @param {Object} depended Reference to the module
   */
  function push(pkg, parent) {
    if (pkg.dependencies) Object.keys(pkg.dependencies).forEach(function (key) {
      parent.dependencies = parent.dependencies || {};

      queue.push({
        name: key,
        parent: parent,
        range: pkg.dependencies[key]
      });
    });
  }

  var queue = async.queue(function worker(data, next) {
    var _id = data.name +'@'+ data.range;

    //
    // @TODO check if we need to move the module upwards to this dependency can
    // be loaded from a parent folder.
    //
    if (_id in dependency) {
      dependency[_id].dependet.push(data.parent);   // Add it to depended modules.
      shrinkwrap.optimize(dependency[_id]);         // Optimize module's location.
      return next();
    }

    registry.release(data.name, data.range, function found(err, pkg) {
      if (err) return next(err);

      dependency[_id] = {
        dependent: [data.parent], // The modules that depend on this version.
        license: pkg.license,     // The module's license.
        version: pkg.version,     // Version number.
        parent: data.parent,      // The parent which hold this a dependency.
        shasum: pkg.shasum,       // SHASUM of the package contents.
        released: pkg.date,       // Publish date of the version.
        name: pkg.name,           // Module name, to prevent duplicate.
        _id: _id                  // _id of the package.
      };

      //
      // Add it as dependency and add possible dependency to the queue so it can
      // be resolved.
      //
      data.parent.dependency[data.name] = dependency[_id];
      push(shrinkwrap.dedupe(pkg), dependency[_id]);

      next();
    });
  }, this.limit);

  queue.drain = function ondrain() {
    shrinkwrap.emit('ls', data, dependency);
  };

  if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
    push(pkg);
  } else {
    this.emit('ls', data, {});
  }

  return this;
};

/**
 * Optimize the dependency tree so we're not installing duplicate dependencies
 * in every module when they can be properly resolved by placing it upwards in
 * our dependency tree.
 *
 * @param {Object} dependency The dependency that has multiple dependends.
 * @api private
 */
Shrinkwrap.prototype.optimize = function optimize(dependency) {
  var dependend = dependency.depended
    , version = dependency.version
    , name = dependency.name;

  /**
   * Find suitable parent nodes which can hold this module without creating
   * a possible conflict because there two different versions of the module in
   * the dependency tree.
   *
   * @param {Object} dependent A dependent of a module.
   * @returns {Array} parents.
   * @api private
   */
  function parent(dependent) {
    var node = dependent
      , result = [];

    while (node.parent) {
      if (!available(parent.parent)) break;

      result.push(parent.parent);
      node = parent.parent;
    }

    return result;
  }

  /**
   * Checks if the dependency tree does not already contain a different version
   * of this module.
   *
   * @param {Object} dependencies The dependencies of a module.
   * @returns {Boolean} Available as module location.
   * @api private
   */
  function available(dependencies) {
    return Object.keys(dependencies).every(function every(key) {
      var dependency = dependencies[key];

      if (dependency.name !== name) return true;
      if (dependency.version === version) return true;

      return false;
    });
  }
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
