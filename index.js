'use strict';

var debug = require('debug')('shrinkwrap')
  , semver = require('npmjs/semver')
  , Registry = require('npmjs')
  , fuse = require('fusing')
  , async = require('async');

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
 * @param {Object} options Options.
 * @api public
 */
function Shrinkwrap(options) {
  options = options || {};

  options.registry = 'registry' in options
    ? options.registry
    : 'http://registry.nodejitsu.com/';

  options.production = 'production' in options
    ? options.production
    : process.NODE_ENV === 'production';

  options.optimize = 'optimize' in options
    ? options.optimize
    : true;

  options.limit = 'limit' in options
    ? options.limit
    : 10;

  options.mirrors = 'mirrors' in options
    ? options.mirrors
    : false;

  this.registry = new Registry({
    registry: options.registry || Registry.mirrors.nodejitsu,
    githulk: options.githulk,
    mirrors: options.mirrors
  });

  this.production = options.production;     // Don't include devDependencies.
  this.limit = options.limit;               // Maximum concurrency.
  this.dependencies = [];                   // The dependencies.
  this.cache = Object.create(null);         // Dependency cache.
}

fuse(Shrinkwrap, require('eventemitter3'));

/**
 * No previous package, resolve one for us instead.
 *
 * @param {String} name Package name.
 * @param {String} range Version range.
 * @param {Function} fn The completion callback.
 * @api public
 */
Shrinkwrap.prototype.get = function get(name, range, fn) {
  if ('function' === typeof range) {
    fn = range;
    range = '*';
  }

  var shrinkwrap = this;

  this.registry.packages.release(name, range, function release(err, pkg) {
    if (err) return fn(err);

    debug('successfully resolved %s@%s', name, range, pkg);
    shrinkwrap.resolve(pkg, fn);
  });
};

/**
 * Resolve all dependencies and their versions for the given root package.
 *
 * @param {Object} pkg  Package data from npm.
 * @param {Function} fn Callback
 * @api public
 */
Shrinkwrap.prototype.resolve = Shrinkwrap.prototype.ls = function resolve(pkg, fn) {
  pkg = this.dedupe(Array.isArray(pkg) ? pkg.pop() : pkg);

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
   * @param {Object} parent The location of new packages.
   * @api private
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
      dependency[_id].dependent.push(data.parent);  // Add it to depended modules.
      shrinkwrap.optimize(dependency[_id]);         // Optimize module's location.
      return next();
    }

    debug('retreiving dependency %s@%s', data.name, data.range);
    registry.packages.release(data.name, data.range, function found(err, pkg) {
      if (err) return next(err);

      dependency[_id] = {
        dependent: [data.parent],             // The modules that depend on this version.
        licenses: pkg.licenses,               // The module's license.
        license: pkg.license,                 // The module's license.
        version: pkg.version,                 // Version number.
        parent: data.parent,                  // The parent which hold this a dependency.
        released: pkg.date,                   // Publish date of the version.
        name: pkg.name,                       // Module name, to prevent duplicate.
        _id: _id                              // _id of the package.
      };

      //
      // Add it as dependency and add possible dependency to the queue so it can
      // be resolved.
      //
      data.parent.dependencies[data.name] = dependency[_id];
      push(shrinkwrap.dedupe(pkg), dependency[_id]);

      next();
    });
  }, this.limit);

  //
  // Fully flushed
  //
  queue.drain = function ondrain() {
    fn(undefined, data, dependency);
  };

  //
  // Add new dependencies that should be resolved.
  //
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
    push(pkg, data);
  } else {
    fn(undefined, data, {});
  }

  return this;
};

/**
 * Optimize the dependency tree so we're not installing duplicate dependencies
 * in every module when they can be properly resolved by placing it upwards in
 * our dependency tree.
 *
 * @param {Object} dependency The dependency that has multiple dependents.
 * @api private
 */
Shrinkwrap.prototype.optimize = function optimize(dependency) {
  var dependent = dependency.dependent
    , version = dependency.version
    , name = dependency.name
    , common;

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
      if (!available(node.parent)) break;

      result.push(node.parent);
      node = node.parent;
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
    if (!dependencies) return false;

    return Object.keys(dependencies).every(function every(key) {
      var dependency = dependencies[key];

      if (!dependency) return false;

      if (dependency.name !== name) return true;
      if (dependency.version === version) return true;

      return false;
    });
  }

  var parents = dependent.map(function (dep) {
    var parents = parent(dep);

    //
    // No parents, this means we cannot move this module to a new location as it
    // will most likely conflict with other version. The only solution is to
    // keep it as duplicate as it's own dependencies. The way to do this is to
    // remove out of
    //
    if (!parents.length) {
      dependency.dependent.splice(dependency.dependent.indexOf(dep), 1);
    }

    return parents;
  }).filter(function filter(results) {
    return !!results.length;
  });

  //
  // Detect if all parents have a common root element where we can optimize the
  // module to.
  //
};

/**
 * It could be that a package has dependency added as devDependency as well as
 * a regular dependency. We want to make sure that we don't filter out this
 * dependency when we're resolving packages so we're going to remove it from the
 * devDependencies if they are exactly the same.
 *
 * @param {Object} pkg The package.
 * @returns {Object} The package.
 * @api private
 */
Shrinkwrap.prototype.dedupe = function dedupe(pkg) {
  if (!pkg) return pkg;
  if (!pkg.dependencies) return pkg;
  if (!pkg.devDependencies) return pkg;

  Object.keys(pkg.dependencies).forEach(function searchanddestroy(name) {
    if (!(name in pkg.devDependencies)) return;
    try {
      if (!semver.eq(pkg.devDependencies[name], pkg.dependencies[name])) return;
    } catch (e) { return; }

    //
    // Only remove when we have an exact match on the version number.
    //
    delete pkg.devDependencies[name];
  });

  return pkg;
};

/**
 * The various of locations where dependencies for a given module can be
 * defined.
 *
 * @type {Array}
 * @private
 */
Shrinkwrap.dependencies = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies'
];

//
// Expose the module interface.
//
module.exports = Shrinkwrap;
