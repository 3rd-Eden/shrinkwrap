'use strict';

var Registry = require('./registry')
  , Version = require('./version')
  , async = require('async')
  , path = require('path');

/**
 * Generate a new shrinkwrap from a given package or module.
 *
 * @constructor
 * @param {Object} options Options
 * @api public
 */
function Shrinkwrap(options) {
  options = options || {};

  this.registry = new Registry(options.registry);
  this.output = options.output || 'npm-shrinkwrap.json';
  this.production = options.production || false;
  this.limit = options.limit || 10;
  this.dependencies = [];
  this.cache = Object.create(null);
}

/**
 * Create a new shrinkwrap.
 *
 * @param {String} item The name of a module or a filename.
 * @param {Function} fn The callback.
 * @api public
 */
Shrinkwrap.prototype.create = function create(name, fn) {
  var shrinkwrap = this;

  function search(err, pkg) {
    if (err) return fn(err);

    shrinkwrap.add(pkg);
    shrinkwrap.resolve(fn);
  }

  if (name.charAt(0) === '/') return this.read(name, search);
  this.module(name, search);
};

/**
 * Resolve all the dependencies.
 *
 * @api private
 */
Shrinkwrap.prototype.resolve = function resolve(fn) {
  var resolved = Object.create(null)
    , shrinkwrap = this
    , queue;

  //
  // Process all the dependencies and create a shrinkwrap graph.
  //
  queue = async.queue(function worker(data, next) {
    resolved[data.key] = true;

    shrinkwrap.module(data.name, data.version, function find(err, pkg) {
      if (err) return next(err);

      var wrap = { name: pkg.name , version: pkg.version , shasum: pkg.dist.shasum }
        , dependencies = shrinkwrap.extract(pkg);

      if (dependencies.length) {
        wrap.dependencies = [];
        dependencies.forEach(function each(data) {
          wrap.dependencies.push(data.key);

          if (data.key in resolved) return;
          queue.push(data);
        });
      }

      next();
    });
  }, this.limit);

  queue.ondrain = function drained() {
    fn();
  };

  //
  // Start processing all the dependencies.
  //
  this.dependencies.forEach(function each(data) {
    queue.push(data);
  });
};

/**
 * Read a file so it can be parsed as dependency list.
 *
 * @param {String} file The location of the file that we need to parse.
 * @param {Function} fn Optional callback for error handling.
 * @api private
 */
Shrinkwrap.prototype.read = function read(file, fn) {
  var data;

  try { data = require(file); }
  catch (e) {
    if (fn) return fn(e);
    throw e;
  }

  if (fn) return fn(undefined, data);
  return data;
};

/**
 * Add new dependencies to the shrinkwrap.
 *
 * @param {Object} data The package.json source
 * @api private
 */
Shrinkwrap.prototype.add = function add(data) {
  var dependencies = this.extract(data);

  if (dependencies.length) {
    Array.prototype.push.apply(this.dependencies, dependencies);
  }
};

Shrinkwrap.prototype.extract = function extract(data) {
  var dependencies = [];

  ['dependencies', 'devDependencies'].forEach(function scan(key) {
    var definition = data[key];

    if ('object' !== typeof definition || Array.isArray(definition)) return;
    if (this.production && key === 'devDependencies') return;

    for (var name in definition) {
      var version = definition[name];

      if (!definition.hasOwnProperty(name)) continue;
      if ('object' === typeof version) continue;

      dependencies.push({
          development: key === 'devDependencies'
        , version: new Version(version)
        , key: name +'@'+ version
        , name: name
      });
    }
  }, this);

  return dependencies;
};

//
// Expose the module interface.
//
Shrinkwrap.Version = Version;
module.exports = Shrinkwrap;
