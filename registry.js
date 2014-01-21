'use strict';

var license = require('./license.js')
  , Assignment = require('assign')
  , request = require('request')
  , semver = require('./semver')
  , url = require('url');

/**
 * A simple npm registry interface for data retrieval.
 *
 * @constructor
 * @param {String} URL The URL of the npm registry.
 * @api public
 */
function Registry(URL) {
  if (!(this instanceof Registry)) return new Registry(URL);

  this.registry = URL || 'https://registry.npmjs.org/';
}

/**
 * Retrieve all release specific information for the given package name.
 *
 * @param {String} name The package name.
 * @param {Function} fn The callback.
 * @api public
 */
Registry.prototype.releases = function releases(name, fn) {
  return this.get(name, fn).emits(function emit(data, add) {
    if (!data.versions) return;

    //
    // Add all versions of the given module.
    //
    Object.keys(data.versions).forEach(function addmore(version) {
      var release = data.versions[version];
      release.date = data.time[version];

      add(release);
    });

    //
    // Also add each tag to the releases.
    //
    if ('dist-tags' in data) Object.keys(data['dist-tags']).forEach(function (key) {
      var version = data['dist-tags'][key]
        , release = JSON.parse(JSON.stringify(data.versions[version]));

      //
      // The JSON.parse(JSON.stringify)) is needed to create a full clone of the
      // data structure as we're adding tags. That would be override during the
      // `reduce` procedure.
      //

      release.date = data.time[version];
      release.tag = key;

      add(release);
    });

    return false;
  }).map(function map(release) {
    return {
        tag: release.tag || ''
      , name: release.name || ''
      , date: release.date || '1970-01-01T00:00:00.000Z'
      , version: release.version || '0.0.0'
      , license: license(release)
      , shasum: release.dist.shasum || ''
      , dependencies: release.dependencies || {}
      , devDependencies: release.devDependencies || {}
      , peerDependencies: release.peerDependencies || {}
    };
  }).reduce(function reduce(memo, release) {
      memo[release.tag || release.version] = release;
      return memo;
  }, {});
};

/**
 * Get a version for a specific release.
 *
 * @param {String} name The name of the package.
 * @param {String} version The version number we should retrieve.
 * @param {Function} fn The callback.
 * @api public
 */
Registry.prototype.release = function release(name, range, fn) {
  return this.releases(name, function releases(err, versions) {
    if (err) return fn(err);
    if (range in versions) return fn(undefined, versions[range]);

    var version = semver.maxSatisfying(Object.keys(versions), range);
    fn(undefined, versions[version]);
  });
};

/**
 * Retrieve something from the CouchDB registry.
 *
 * @param {String} pathname The path.
 * @param {Function} fn The callback.
 * @api private
 */
Registry.prototype.get = function get(pathname, fn) {
  var assignee = new Assignment(this, fn);

  request({
    method: 'GET',
    strictSSL: false,
    uri: url.resolve(this.registry, pathname)
  }, function received(err, res, body) {
    if (err) return assignee.destroy(err);
    if (res.statusCode !== 200) {
      err = new Error('Received an invalid statusCode, expected statusCode 200');
      err.statusCode = res.statusCode;

      return assignee.destroy(err);
    }

    var data;

    try { data = JSON.parse(body); }
    catch (e) {
      assignee.destroy(new Error('Failed to parse the JSON response: '+ e.message));
      return;
    }

    assignee.write(data, true);
  });

  return assignee;
};

//
// Expose the module interface.
//
module.exports = Registry;
