'use strict';

var semver = require('npm-registry/semver')
  , debug = require('debug')('shrinkwrap')
  , Registry = require('npm-registry')
  , Module = require('./module')
  , fuse = require('fusing');

//
// Variable cache.
//
var toString = Object.prototype.toString;

/**
 * Ensure that items in the array are unique.
 *
 * @param {Mixed} value A value in the array.
 * @param {Number} index The index of the item in the array.
 * @param {Array} arr Reference to the array we're filtering.
 * @returns {Boolean}
 */
function unique(value, index, arr) {
  return arr.indexOf(value) === index;
}

/**
 * Generate a new Shrinkwrap from a given package or module.
 *
 * Options:
 *
 * - registry: URL of the npm registry we should use to read package information.
 * - production: Should we only include production packages.
 * - limit: Amount of parallel processing tasks we could use to retrieve data.
 * - optimize: Should we attempt to optimize the data structure in the same way
 *   that npm would have done it.
 * - mirrors: A list of npm mirrors to be used with our registry.
 * - githulk: Optional preconfigured GitHulk.
 *
 * @constructor
 * @param {Object} options Options.
 * @api public
 */
function Shrinkwrap(options) {
  this.fuse();

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

  this.registry = 'string' !== typeof options.registry
    ? options.registry
    : new Registry({
    registry: options.registry || Registry.mirrors.nodejitsu,
    githulk: options.githulk,
    mirrors: options.mirrors
  });

  this.production = options.production;     // Don't include devDependencies.
  this.limit = options.limit;               // Maximum concurrency.
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
    range = 'latest';
  }

  var shrinkwrap = this;

  this.registry.packages.release(name, range, function release(err, pkg) {
    if (err) return fn(err);

    debug('successfully resolved %s@%s', name, range);
    shrinkwrap.resolve(pkg, fn);
  });
};

/**
 * Get accurate type information for the given JavaScript class.
 *
 * @param {Mixed} of The thing who's type class we want to figure out.
 * @returns {String} lowercase variant of the name.
 * @api private
 */
Shrinkwrap.prototype.type = function type(of) {
  return toString.call(of).slice(8, -1).toLowerCase();
};

/**
 * Resolve all dependencies and their versions for the given root package.
 *
 * @param {Object} pkg  Package data from npm.
 * @param {Function} fn Callback
 * @api public
 */
Shrinkwrap.prototype.resolve = function resolve(source, fn) {
  source = Array.isArray(source) ? source[0] : source;

  var shrinkwrap = this;

  /**
   * Scan the given package.json like structure for possible dependency
   * locations which will be automatically queued for fetching and processing.
   *
   * @param {Object} packages The packages.json body.
   * @param {Object} ref The location of the new packages in the tree.
   * @param {Number} depth How deep was this package nested
   * @api private
   */
  function queue(packages, ref, depth) {
    packages = shrinkwrap.dedupe(packages);

    Shrinkwrap.dependencies.forEach(function each(key) {
      if (this.production && 'devDependencies' === key) return;
      if ('object' !== this.type(packages[key])) return;

      Object.keys(packages[key]).forEach(function each(name) {
        var range = packages[key][name]
          , _id = name +'@'+ range;

        ref.dependencies = ref.dependencies || {};
        queue.push({
          name: name,       // Name of the module
          range: range,     // Semver range
          _id: _id,         // Semi unique id.
          parents: [ref],   // Reference to the parent module.
          depth: depth      // The depth of the reference.
        });
      });
    }, shrinkwrap);

    return queue;
  }

  //
  // Our internal data structures that make it possible to search for packages.
  //
  queue.dependencytree = Object.create(null);
  queue.todolist = [];
  queue.errors = [];

  //
  // The original root that get's resolved.
  //
  queue.data = Object.create(null);
  queue.data.name = source.name;
  queue.data.version = source.version;

  /**
   * Check if we've already processed the specification before processing.
   *
   * @param {Object} data Processing specification for the worker.
   * @api private
   */
  queue.push = function push(data) {
    //
    // Optimization: prevent queueing the same module lookup.
    //
    if (queue.todolist.some(function some(todo) {
      if (todo._id !== data._id) return false;

      todo.parents = todo.parents.concat(data.parents).filter(unique);

      return true;
    })) return;

    //
    // Optimization: It has already been processed and listed before.
    //
    if (data._id in queue.dependencytree) {
      queue.dependencytree[data._id].dependent = (
        queue.dependencytree[data._id].dependent
      ).concat(data.parents).filter(unique);

      return shrinkwrap.optimize(queue.dependencytree[data._id]);
    }

    queue.todolist.push(data);
  };

  /**
   * Take an item from the todo list and process it's specification.
   *
   * @api private
   */
  queue.worker = function worker(err) {
    if (err) queue.errors.push(err);

    var spec = queue.todolist.shift();

    //
    // We've successfully processed all requests.
    //
    if (!spec) {
      fn(undefined, queue.dependencytree, queue.errors);

      shrinkwrap.destroy();
      return [
        'data',
        'errors',
        'dependencytree'
      ].forEach(function cleanup(remove) {
        delete queue[remove];
      });
    }

    debug('processing %s. %s left to process', spec.name, queue.todolist.length);

    shrinkwrap.release(spec.name, spec.range, function release(err, data, cached) {
      if (err || !data) {
        if (err) debug('failed to resolve %s due to error: ', spec.name, err);
        return worker(err);
      }

      var clone = queue.dependencytree[spec._id] = data.module.clone({
        parents: spec.parents,
        depth: spec.depth
      });

      spec.parents.forEach(function each(parent) {
        parent.dependencies[spec.name] = queue.dependencytree[spec._id];
      });

      if (!cached) queue(data, queue.dependencytree[spec._id], spec.depth + 1);
      worker();
    });
  };

  queue(source, queue.data, 0).worker();
};

/**
 * Get all releases for a given module name.
 *
 * @param {String} name The name of the module we should get
 * @param {Function} fn Callback
 * @api private
 */
Shrinkwrap.prototype.releases = function releases(name, fn) {
  if (this.cache && name in this.cache) {
    debug('CACHEHIT: Retrieving `%s` from cache', name);
    return fn(undefined, this.cache[name]);
  }

  var shrinkwrap = this;

  this.registry.packages.releases(name, function details(err, versions) {
    if (err) return fn(err);

    var keys = Object.keys(versions)
      , latest = keys.filter(function valid(ver) {
          return !!semver.valid(ver);
        }).sort(semver.rcompare)[0]
      , result = { latest: latest };

    //
    // Map the data to something smaller as we don't need all the package info.
    //
    result.releases = keys.reduce(function reduce(memo, key) {
      var data = versions[key];

      memo[key] = {
        released: data.time[key],
        licenses: data.licenses,
        _npmUser: data._npmUser,
        version: data.version,
        name: data.name,
        latest: latest,
      };

      Shrinkwrap.dependencies.forEach(function (dep) {
        memo[key][dep] = data[dep];
      });

      return memo;
    }, Object.create(null));

    result.versions = keys;

    if (shrinkwrap.cache) shrinkwrap.cache[name] = result;
    fn(err, result);
  });
};

/**
 * Get a single release.
 *
 * @param {String} name The name of the module.
 * @param {String} range The version range.
 * @param {Function} fn The callback.
 * @api private
 */
Shrinkwrap.prototype.release = function release(name, range, fn) {
  var key = name +'@'+ range
    , shrinkwrap = this;

  if (this.cache && key in this.cache) {
    debug('CACHEHIT: Retrieving `%s` from cache', key);
    return fn(undefined, this.cache[key], true);
  }

  this.releases(name, function releases(err, result) {
    if (err) return fn(err);

    var version = semver.maxSatisfying(result.versions, range)
      , data = result.releases[version];

    //
    // No matching version for the given module. It could be that the user has
    // set the range to git dependency instead.
    //
    if (!data) {
      debug('Couldnt find the matching version %s in the returned releases for %s', range, name);
      debug('Only found: %s', result.versions.join(', '));
      return fn();
    }

    //
    // Transform to a Module instance.
    //
    var cache = { module: new Module(data, range) };
    Shrinkwrap.dependencies.forEach(function (dep) {
      cache[dep] = data[dep];
    });

    if (shrinkwrap.cache) shrinkwrap.cache[key] = cache;

    fn(err, cache, false);
  });
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
  if (!pkg.devDependencies || this.production) return pkg;

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
 * Clean up any cache of data structures that we might have had laying around.
 * Making this instance ready for garbage collection.
 *
 * @public
 */
Shrinkwrap.prototype.destroy = function destroy() {
  this.registry = this.cache = null;
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
