'use strict';

var FreeList = require('freelist').FreeList
  , Route = require('routable')
  , Primus = require('primus')
  , Temper = require('temper')
  , colors = require('colors')
  , path = require('path')
  , url = require('url')
  , fs = require('fs');

//
// Library internals.
//
var Compiler = require('./src/compiler')
  , Resource = require('./resource')
  , Pagelet = require('./pagelet')
  , Pool = require('./pool')
  , Page = require('./page')
  , ACL = require('./acl');

//
// Try to detect if we've got domains support. So we can easily serve 500 error
// pages when we have an error.
//
var domain;

try { domain = require('domain'); }
catch (e) {}

/**
 * Our pagelet management.
 *
 * The following options are available:
 *
 * - transport: The transport engine we should use for real-time.
 * - cache: A object were we store our URL->page mapping.
 * - stream: Where we should write our logs to.
 * - parser: Which parser should be used to send data in real-time.
 * - pages: String or array of pages we serve.
 * - domain: Use domains to handle requests.
 * - pathname: The pathname we use for Primus requests
 * - static: The pathname for our static assets
 *
 * @constructor
 * @param {Server} server HTTP/S based server instance.
 * @param {Object} options Configuration.
 * @api public
 */
function Pipe(server, options) {
  options = this.options(options || {});

  this.resources = new Pool({ type: 'resources' }); // Resource pool.
  this.stream = options('stream', process.stdout);  // Our log stream.
  this.domains = !!options('domain') && domain;     // Call all requests in a domain.
  this.statusCodes = Object.create(null);           // Stores error pages.
  this.cache = options('cache', null);              // Enable URL lookup caching.
  this.temper = new Temper();                       // Template parser.§
  this.acl = new ACL(this);                         // Access Control List.

  //
  // Now that everything is processed, we can setup our internals.
  //
  this.server = server;
  this.primus = new Primus(this.server, {
    transformer: options('transport', 'websockets'),
    pathname: options('pathname', '/pagelets'),
    parser: options('parser', 'json')
  });

  //
  // Compile the Page's assets.
  //
  this.compiler = new Compiler(options('directory', __dirname), this, {
    pathname: options('static', '/')
  });

  //
  // Process the pages.
  //
  this.pages = [];
  this.define(options('pages'));
  this.discover(this.pages);

  //
  // Start listening for incoming requests.
  //
  this.server.on('request', this.dispatch.bind(this));
  this.primus.on('connection', this.connection.bind(this));
}

Pipe.prototype.__proto__ = require('events').EventEmitter.prototype;

/**
 * Simple emit wrapper that returns a function that emits an event once it's
 * called
 *
 * @param {String} event Name of the event that we should emit.
 * @param {Function} parser Argument parser.
 * @api public
 */
Pipe.prototype.emits = function emits(event, parser) {
  var self = this;

  return function emit(arg) {
    self.emit(event, parser ? parser.apply(self, arguments) : arg);
  };
};

/**
 * Checks if options exists.
 *
 * @param {Object} obj
 * @returns {Function}
 * @api private
 */
Pipe.prototype.options = function options(obj) {
  return function get(key, backup) {
    return key in obj ? obj[key] : backup;
  };
};

/**
 * Simple log method.
 *
 * @param {String} type The log type.
 * @returns {Pipe} fluent interface
 * @api private
 */
Pipe.prototype.log = function log(type) {
  var data = Array.prototype.slice.call(arguments, 1)
    , level = Pipe.prototype.log.levels[type];

  if (this.stream) {
    //
    // Add some padding, write the log type, and join as pretty string.
    //
    this.stream.write(['  '+ level +' '].concat(data).join(' ') + '\n');
  } else {
    this.emit.apply(this, ['log', type].concat(data));
  }

  return this;
};

/**
 * Pretty logger prefixes.
 *
 * @type {Object}
 * @private
 */
Pipe.prototype.log.levels = {
  'warn': '𝓦'.yellow,
  'error': '𝓔'.red,
  'info': '𝓘'.blue
};

/**
 * Transform strings, array of strings, objects, things in to the actual
 * constructors.
 *
 * @param {String|Array|Object} files The files.
 * @param {Function} transform Transformation function
 * @returns {Array}
 * @api private
 */
Pipe.prototype.resolve = function resolve(files, transform) {
  /**
   * It's not required to supply resolve with instances, we can just
   * automatically require them if they are using the:
   *
   *   module.exports = base.extend();
   *
   * pattern for defining the pages/pagelets.
   *
   * @param {String} constructor
   * @returns {Object} initialized object
   * @api private
   */
  function init (constructor) {
    return ('string' === typeof constructor) ? require(constructor) : constructor;
  }

  if ('string' === typeof files) {
    files = fs.readdirSync(files).map(function locate(file) {
      return path.resolve(files, file);
    });
  } else if (!Array.isArray(files)) {
    files = Object.keys(files).map(function merge(name) {
      var constructor = init(files[name]);

      //
      // Add a name to the prototype, if we have this property in the prototype.
      // This mostly applies for the Pagelets.
      //
      if ('name' in constructor.prototype) {
        constructor.prototype.name = constructor.prototype.name || name;
      }

      return constructor;
    });
  }

  files = files.filter(function jsonly(file) {
    var extname = path.extname(file)
      , type = typeof file;

    //
    // Make sure we only use valid JavaScript files as sources. We want to
    // ignore stuff like potential .log files. Also include Page constructors.
    // If there's no extension name we assume that it's a folder with an
    // `index.js` file.
    //
    return 'string' === type && (!extname || extname === '.js')
    || 'function' === type;
  }).map(function map(constructor) {
    constructor = init(constructor);

    //
    // We didn't receive a proper page instance.
    //
    if ('function' !== typeof constructor) {
      var invalid = (JSON.stringify(constructor) || constructor.toString());
      this.log('warn', 'Ignorning invalid constructor: '+ invalid);
      return undefined;
    }

    return constructor;
  }, this).filter(Boolean);

  return transform
    ? files.map(transform.bind(this))
    : files;
};

/**
 * Discover if the user supplied us with custom error pages so we use that
 * in case we need to handle a 404 or and 500 error page.
 *
 * @param {Array} pages All enabled pages.
 * @returns {Pipe} fluent interface
 * @api private
 */
Pipe.prototype.discover = function discover(pages) {
  var catalog = []
    , fivehundered
    , fourofour;

  pages.forEach(function each(page) {
    if (page.router.test('/500')) fivehundered = page;
    if (page.router.test('/404')) fourofour = page;
  });

  //
  // We don't have any 500 or 404 handlers, so use some default pages that are
  // provided by us. But as these page are not processed yet, we need to kick
  // them through our transform process.
  //
  if (!fivehundered) {
    fivehundered = this.transform(require('./pages/500'));
    catalog.push(fivehundered);
  }

  if (!fourofour) {
    fourofour = this.transform(require('./pages/404'));
    catalog.push(fourofour);
  }

  this.statusCodes[500] = fivehundered;
  this.statusCodes[404] = fourofour;

  if (catalog.length) this.compiler.catalog(catalog);
  return this;
};

/**
 * We need to extract items from the Page prototype and transform it in to
 * something useful.
 *
 * @param {Page} page Page constructor.
 * @returns {Page} The upgrade page.
 * @api private
 */
Pipe.prototype.transform = function transform(Page) {
  var method = Page.prototype.method
    , router = Page.prototype.path
    , pipe = this;

  //
  // This page has already been processed, bailout.
  //
  if (Page.properties) return Page;

  //
  // Parse the methods to an array of accepted HTTP methods. We'll only accept
  // there requests and should deny every other possible method.
  //
  if (!Array.isArray(method)) method = method.split(/[\s,]+?/);
  method = method.filter(Boolean).map(function transformation(method) {
    return method.toUpperCase();
  });

  //
  // Update the pagelets, if any.
  //
  if (Page.prototype.pagelets) {
    var pagelets = this.resolve(Page.prototype.pagelets, function map(Pagelet) {
      //
      // This pagelet has already been processed before as pages can share
      // pagelets.
      //
      if (Pagelet.properties) return Pagelet;

      var prototype = Pagelet.prototype
        , dir = prototype.directory;

      if (prototype.view) {
        Pagelet.prototype.view = path.resolve(dir, prototype.view);
        pipe.temper.prefetch(Pagelet.prototype.view, Pagelet.prototype.engine);
      }

      if (prototype.css) Pagelet.prototype.css = path.resolve(dir, prototype.css);
      if (prototype.js) Pagelet.prototype.js = path.resolve(dir, prototype.js);

      if (!prototype.render || 'function' !== typeof prototype.render) {
        throw new Error('Pagelet('+ prototype.name + ') is missing a `render` method');
      }

      //
      // Make sure that all our dependencies are also directly mapped to an
      // absolute URL.
      //
      if (prototype.dependencies) {
        Pagelet.prototype.dependencies = prototype.dependencies.map(function each(dep) {
          if (/^(http:|https:)?\/\//.test(dep)) return dep;
          return path.resolve(dir, dep);
        });
      }

      Pagelet.properties = Object.keys(Pagelet.prototype);

      //
      // Setup a FreeList for the pagelets so we can re-use the pagelet
      // instances and reduce garbage collection.
      //
      Pagelet.freelist = new FreeList('pagelet', Pagelet.prototype.freelist || 1000, function allocate() {
        return new Pagelet();
      });

      return Pagelet;
    });

    //
    // Save the transformed pagelets.
    //
    Page.prototype.pagelets = pagelets;
  }

  if (!Page.prototype.view) {
    throw new Error('The page for path '+ Page.prototype.path +' should have a .view property');
  }

  Page.prototype.view = path.resolve(Page.prototype.directory, Page.prototype.view);
  pipe.temper.prefetch(Page.prototype.view, Page.prototype.engine);

  //
  // Add the properties to the page.
  //
  Page.properties = Object.keys(Page.prototype);      // All properties before init.
  Page.router = new Route(router);                    // Actual HTTP route.
  Page.method = method;                               // Available HTTP methods.
  Page.id = router.toString() +'&&'+ method.join();   // Unique id.

  //
  // Setup a FreeList for the page so we can re-use the page instances and
  // reduce garbage collection to a bare minimum.
  //
  Page.freelist = new FreeList('page', Page.prototype.freelist || 1000, function allocate() {
    return new Page(pipe);
  });

  return Page;
};

/**
 * Insert page into collection of pages. If page is a manually instantiated
 * Page push it in, otherwise resolve the path, always transform the page.
 *
 * @param {Mixed} page composed Page object or file.
 * @returns {Pipe} fluent interface
 * @api public
 */
Pipe.prototype.define = function define(page) {
  if (!page) return this;
  if ('function' === typeof page) page = [ page ];

  this.pages.push.apply(this.pages, this.resolve(page, this.transform));

  if (this.compiler) this.compiler.catalog(this.pages);
  return this;
};

/**
 * Find the correct Page constructor based on the given URL.
 *
 * @TODO it should return an array with possible options. So they can be
 * iterated over for when a page has a authorization method.
 *
 * @param {String} url The URL we need to find.
 * @returns {Array} Array full of constructors, or nothing.
 * @api public
 */
Pipe.prototype.find = function find(url, method) {
  if (this.cache && this.cache.has(url)) return this.cache.get(url);

  var routes = [];

  for (var i = 0, page, length = this.pages.length; i < length; i++) {
    page = this.pages[i];

    if (!page.router.test(url)) continue;
    if (method && page.method.length && !~page.method.indexOf(method)) continue;

    routes.push(page);
  }

  if (this.cache && routes.length) this.cache.set(url, routes);
  return routes;
};

/**
 * Dispatch incoming requests.
 *
 * @TODO handle POST requests.
 * @param {Request} req HTTP request.
 * @param {Response} res HTTP response.
 * @returns {Pipe} fluent interface
 * @api private
 */
Pipe.prototype.dispatch = function dispatch(req, res) {
  this.decorate(req, res);

  //
  // Check if these are assets that need to be served from the compiler.
  //
  if (this.compiler.serve(req, res)) return;

  var pages = this.find(req.uri.pathname, req.method)
    , pipe = this;

  //
  // Always add the 404 page as last page to check so we always have working
  // page
  //
  pages.push(this.statusCodes[404]);

  (function iterate(done) {
    var freelist = pages.shift().freelist
      , page = freelist.alloc();

    if ('function' === typeof page.authorize) {
      return page.authorize(req, function authorize(allowed) {
        if (allowed) return done(page, freelist);

        freelist.free(page);
        iterate(done);
      });
    }

    done(page, freelist);
  }(function completed(page, freelist) {
    //
    // Release the page again when we receive a `free` event.
    //
    page.once('free', function free() {
      freelist.free(page);
    });

    res.once('close', page.emits('close'));

    if (pipe.domains) {
      page.domain = domain.create();
      page.domain.run(function run() {
        run.configure(req, res);
      });
    } else {
      page.configure(req, res);
    }
  }));

  return this;
};

/**
 * Decorate the request object with some extensions.
 *
 * @param {Request} req HTTP request.
 * @param {Response} res HTTP response.
 * @api private
 */
Pipe.prototype.decorate = function decorate(req, res) {
  req.uri = req.uri || url.parse(req.url, true);
  req.query = req.query || req.uri.query;

  //
  // Add some silly HTTP properties for connect.js compatibility.
  //
  req.originalUrl = req.url;
};

/**
 * Handle incoming real-time requests.
 *
 * @param {Spark} spark A real-time "socket".
 * @api private
 */
Pipe.prototype.connection = function connection(spark) {

};

/**
 * Create a new Pagelet/Pipe server.
 *
 * @param {Number} port Port number we should listen on.
 * @param {Object} options Configuration.
 * @returns {Pipe}
 * @api public
 */
Pipe.createServer = function createServer(port, options) {
  options = options || {};

  var certs = 'key' in options && 'cert' in options
    , secure = certs || 443 === port
    , spdy = 'spdy' in options
    , server;

  //
  // We need to have SSL certs for SPDY and secure servers.
  //
  if (secure || spdy && !certs) {
    throw new Error('Missing the SSL key or certificate files in the options.');
  }

  if (spdy) {
    server = require('spdy').createServer(options);
  } else if (secure) {
    server = require('https').createServer(options);
  } else {
    server = require('http').createServer();
  }

  //
  // Now that we've got a server, we can setup the pipe and start listening.
  //
  var pipe = new Pipe(server, options);
  server.listen(port);

  return pipe;
};

//
// Expose our constructors.
//
Pipe.Resource = Resource;
Pipe.Pagelet = Pagelet;
Pipe.Page = Page;

//
// Expose the constructor.
//
module.exports = Pipe;
