'use strict';

var nolicense = 'No license';

/**
 * @param {Object} data The object that should contain the license.
 * @returns {String}
 * @api private
 */
function fromObject(data) {
  if ('string' === typeof data && data) return data;
  if ('type' in data && data.type) return data.type;

  return;
}

/**
 * Attempt to retreive the license from the Markdown contents of the README.md
 *
 * @param {String} readme The README.md
 * @returns {String}
 * @api private
 */
function fromMarkdown(readme) {

}

/**
 * Attempt to discover the license for a given npm/package result.
 *
 * @param {Object} data The object that npm creates in the registry about the pkg.
 * @returns {String}
 * @api public
 */
module.exports = function search(data) {
  var license;

  //
  // When the license's value is a string, assume that this holds the licensing
  // information. eg:
  //
  // ```js
  // { license: "MIT" }
  // ```
  //
  if ('string' === typeof data.license && data.license) {
    return data.license;
  }

  //
  // Another option is that license is an object or that a licenses object is
  // used. This is usually an indication of a dual licensing.
  //
  var licensing = data.license || data.licenses;

  if ('object' === typeof licensing) {
    if (Array.isArray(licensing)) {
      license = licensing.reduce(function (memo, obj) {
        var license = fromObject(obj);

        //
        // Don't add duplicates of the same library.
        //
        if (license && !~memo.indexOf(license)) memo.push(license);
        return memo;
      }, []).join(', ');
    } else {
      license = fromObject(licensing);
    }

    if (license) return license;
  }

  //
  // No license detected. Attempt to parse it our of a possible `readme`
  // property from the Object which usually holds a reference to some licensing
  // information.
  //
  if ('readme' in data) {
    license = fromMarkdown(data.readme);
    if (license) return license;
  }

  return nolicense;
};
