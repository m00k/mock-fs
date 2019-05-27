// TODO (cb): remove before PR
// https://github.com/tschaub/mock-fs/issues/142
// https://github.com/tschaub/mock-fs/issues/239
// https://github.com/tschaub/mock-fs/issues/62
/* eslint-disable prettier/prettier */
/* eslint-disable no-console */
'use strict';

const Binding = require('./binding');
const FSError = require('./error');
const FileSystem = require('./filesystem');
const realBinding = process.binding('fs');
const path = require('path');
const fs = require('fs');

const realProcessProps = {
  cwd: process.cwd,
  chdir: process.chdir
};
const realCreateWriteStream = fs.createWriteStream;
const realStats = realBinding.Stats;
const realStatWatcher = realBinding.StatWatcher;

let excludePaths = [];
let excludePathsBinding;

/**
 * Pre-patch fs binding.
 * This allows mock-fs to work properly under nodejs v10+ readFile
 * As ReadFileContext nodejs v10+ implementation traps original binding methods:
 * const { FSReqWrap, close, read } = process.binding('fs');
 * Note this patch only solves issue for readFile, as the require of
 * ReadFileContext is delayed by readFile implementation.
 * if (!ReadFileContext) ReadFileContext = require('internal/fs/read_file_context')
 *
 * @param {string} key Property name.
 */
function patch(key) {
  const _realBinding = { ...realBinding };
  realBinding[key] = function() {
    let binding;
    if (isExcluded(arguments[0])) {
      binding = excludePathsBinding || _realBinding;
    } else if (this._mockedBinding) {
      binding = this._mockedBinding;
    } else {
      binding = _realBinding;
    }
    return binding[key].apply(this, arguments);
  }.bind(realBinding);
}

for (const key in Binding.prototype) {
  if (typeof realBinding[key] === 'function') {
    // Stats and StatWatcher are constructors
    if (key !== 'Stats' && key !== 'StatWatcher') {
      patch(key);
    }
  }
}

function isExcluded(path) {
  // compare path (not always a path actually) with excludedPaths
  return !!path 
    && typeof path === 'string' 
    && !!excludePaths.find(_ => path.indexOf(_) === 0);
}

function overrideBinding(binding) {
  realBinding._mockedBinding = binding;

  for (const key in binding) {
    if (typeof realBinding[key] === 'function') {
      // Stats and StatWatcher are constructors
      if (key === 'Stats' || key === 'StatWatcher') {
        realBinding[key] = binding[key];
      }
    } else if (typeof realBinding[key] === 'undefined') {
      realBinding[key] = binding[key];
    }
  }
}

function overrideProcess(cwd, chdir) {
  process.cwd = cwd;
  process.chdir = chdir;
}

/**
 * Have to disable write stream _writev on nodejs v10+.
 *
 * nodejs v8 lib/fs.js
 * note binding.writeBuffers will use mock-fs patched writeBuffers.
 *
 *   const binding = process.binding('fs');
 *   function writev(fd, chunks, position, callback) {
 *     // ...
 *     binding.writeBuffers(fd, chunks, position, req);
 *   }
 *
 * nodejs v10+ lib/internal/fs/streams.js
 * note it uses original writeBuffers, bypassed mock-fs patched writeBuffers.
 *
 *  const {writeBuffers} = internalBinding('fs');
 *  function writev(fd, chunks, position, callback) {
 *    // ...
 *    writeBuffers(fd, chunks, position, req);
 *  }
 *
 * Luckily _writev is an optional method on Writeable stream implementation.
 * When _writev is missing, it will fall back to make multiple _write calls.
 */
function overrideCreateWriteStream() {
  fs.createWriteStream = function(path, options) {
    const output = realCreateWriteStream(path, options);
    // disable _writev, this will over shadow WriteStream.prototype._writev
    output._writev = undefined;
    return output;
  };
}

function restoreBinding() {
  delete realBinding._mockedBinding;
  realBinding.Stats = realStats;
  realBinding.StatWatcher = realStatWatcher;
}

function restoreProcess() {
  for (const key in realProcessProps) {
    process[key] = realProcessProps[key];
  }
}

function restoreCreateWriteStream() {
  fs.createWriteStream = realCreateWriteStream;
}

/**
 * Swap out the fs bindings for a mock file system.
 * @param {Object} config Mock file system configuration.
 * @param {Object} options Any filesystem options.
 * @param {boolean} options.createCwd Create a directory for `process.cwd()`
 *     (defaults to `true`).
 * @param {boolean} options.createTmp Create a directory for `os.tmpdir()`
 *     (defaults to `true`).
 * @param {string[]} options.excludePaths Exclude these paths from being mocked
 *     (defaults to []). Optional.
 * @param {Object} options.excludePathsBinding Binding to apply to excluded paths
 *     (defaults to process.binding('fs')). Optional.
 */
exports = module.exports = function mock(config, options) {
  excludePaths = (options && options.excludePaths) || [];
  excludePathsBinding = (options && options.excludePathsBinding);

  const system = FileSystem.create(config, options);
  const binding = new Binding(system);
  

  overrideBinding(binding);

  let currentPath = process.cwd();
  overrideProcess(
    function cwd() {
      return currentPath;
    },
    function chdir(directory) {
      if (!binding.stat(path._makeLong(directory)).isDirectory()) {
        throw new FSError('ENOTDIR');
      }
      currentPath = path.resolve(currentPath, directory);
    }
  );

  overrideCreateWriteStream();
};

/**
 * Get hold of the mocked filesystem's 'root'
 * If fs hasn't currently been replaced, this will return an empty object
 */
exports.getMockRoot = function() {
  if (realBinding._mockedBinding) {
    return realBinding.getSystem().getRoot();
  } else {
    return {};
  }
};

/**
 * Restore the fs bindings for the real file system.
 */
exports.restore = function() {
  restoreBinding();
  restoreProcess();
  restoreCreateWriteStream();
};

/**
 * Create a file factory.
 */
exports.file = FileSystem.file;

/**
 * Create a directory factory.
 */
exports.directory = FileSystem.directory;

/**
 * Create a symbolic link factory.
 */
exports.symlink = FileSystem.symlink;
