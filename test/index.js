describe('shrinkwrap', function () {
  'use strict';

  var Shrinkwrap = require('../')
    , assume = require('assume')
    , path = require('path')
    , sw;

  this.timeout(10000);

  beforeEach(function () {
    sw = new Shrinkwrap();
  });

  afterEach(function () {
    sw.destroy();
  });

  it('is exported as function', function () {
    assume(Shrinkwrap).is.a('function');
  });

  it('can be extended in to a new instance', function () {
    assume(Shrinkwrap.extend).is.a('function');

    var SW = Shrinkwrap.extend({
      get: function (pkg, fn) {
        this.resolve(pkg, fn);
      }
    });

    assume(SW.prototype.get).does.not.equal(Shrinkwrap.prototype.get);
  });

  describe('.destroy', function () {
    it('can be destoryed multiple times without side-affects', function () {
      assume(sw.destroy()).is.true();
      assume(sw.destroy()).is.true();
      assume(sw.destroy()).is.true();
    });
  });

  describe('.resolve', function () {
    var pkg = require(
      path.join(__dirname, 'packages', 'duplicate-dependencies', 'package.json')
    );

    it('accepts the package.json of any package', function (next) {
      sw.resolve(pkg, next);
    });

    it('receives an array and tree with all dependencies', function (next) {
      sw.resolve(pkg, function (err, tree) {
        assume(tree).is.a('object');
        assume(tree).has.length(2);

        next();
      });
    });
  });

  describe('.type', function () {
    it('finds differences in arrays/objects', function () {
      assume(sw.type([])).equals('array');
      assume(sw.type({})).equals('object');
      assume(sw.type(new Date())).equals('date');
    });
  });
});
