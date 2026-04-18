(function (window) {
  'use strict';

  function isPlainObject(value) {
    return !!value && Object.prototype.toString.call(value) === '[object Object]';
  }

  function cloneObject(source) {
    var result = {};
    if (!isPlainObject(source)) return result;
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        result[key] = source[key];
      }
    }
    return result;
  }

  function getConfig() {
    return isPlainObject(window.OGI_APP_CONFIG) ? window.OGI_APP_CONFIG : {};
  }

  function hasNativeAppsScriptRuntime() {
    return !!(
      window.google &&
      window.google.script &&
      window.google.script.run &&
      !window.google.script.__ogiExternalShim
    );
  }

  function splitUrlParts(url) {
    var value = String(url || '').trim();
    var hashIndex = value.indexOf('#');
    var hash = '';
    if (hashIndex >= 0) {
      hash = value.slice(hashIndex);
      value = value.slice(0, hashIndex);
    }

    var queryIndex = value.indexOf('?');
    var query = '';
    if (queryIndex >= 0) {
      query = value.slice(queryIndex + 1);
      value = value.slice(0, queryIndex);
    }

    return {
      base: value,
      query: query,
      hash: hash
    };
  }

  function buildUrl(parts) {
    var url = parts.base || '';
    if (parts.query) url += '?' + parts.query;
    if (parts.hash) url += parts.hash;
    return url;
  }

  function appendQueryParams(url, params) {
    var parts = splitUrlParts(url);
    var search = new URLSearchParams(parts.query || '');
    var source = params || {};

    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined && source[key] !== null) {
        search.set(key, String(source[key]));
      }
    }

    parts.query = search.toString();
    return buildUrl(parts);
  }

  function appendPath(url, pathPart) {
    var parts = splitUrlParts(url);
    var base = String(parts.base || '').replace(/\/+$/, '');
    var segment = String(pathPart || '').replace(/^\/+/, '');

    if (!segment) {
      return buildUrl(parts);
    }

    parts.base = base + '/' + segment;
    return buildUrl(parts);
  }

  function buildRpcUrl() {
    var config = getConfig();
    var rpcUrl = String(config.rpcUrl || '').trim();
    if (rpcUrl) {
      return rpcUrl;
    }

    var apiBaseUrl = String(config.apiBaseUrl || '').trim();
    if (!apiBaseUrl) {
      return '';
    }

    if (/script\.google\.com\/macros\/s\//i.test(apiBaseUrl)) {
      return appendQueryParams(apiBaseUrl, {
        api: '1',
        action: 'rpc'
      });
    }

    if (/\/rpc(?:[/?#]|$)/i.test(apiBaseUrl)) {
      return apiBaseUrl;
    }

    if (/\/api(?:[/?#]|$)/i.test(apiBaseUrl)) {
      return appendPath(apiBaseUrl, 'rpc');
    }

    return appendPath(apiBaseUrl, 'api/rpc');
  }

  function buildHeaders() {
    var config = getConfig();
    var headers = {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    };
    var extraHeaders = cloneObject(config.apiHeaders);

    for (var key in extraHeaders) {
      if (Object.prototype.hasOwnProperty.call(extraHeaders, key) && extraHeaders[key] !== undefined && extraHeaders[key] !== null) {
        headers[key] = String(extraHeaders[key]);
      }
    }

    return headers;
  }

  function parseJsonResponse(responseText) {
    if (!responseText) return {};

    try {
      return JSON.parse(responseText);
    } catch (error) {
      throw new Error('Respons API eksternal tidak valid');
    }
  }

  function invokeRpcMethod(methodName, args, options) {
    var rpcUrl = buildRpcUrl();
    var config = getConfig();
    var credentialsMode = config.credentials || 'same-origin';

    if (!rpcUrl) {
      return Promise.reject(new Error('Konfigurasi API eksternal belum tersedia'));
    }

    return fetch(rpcUrl, {
      method: 'POST',
      headers: buildHeaders(),
      credentials: credentialsMode,
      body: JSON.stringify({
        method: methodName,
        args: Array.isArray(args) ? args : [],
        page: options && options.pageName ? options.pageName : ''
      })
    }).then(function (response) {
      return response.text().then(function (text) {
        var payload = parseJsonResponse(text);

        if (!response.ok) {
          throw new Error(
            (payload && (payload.error || payload.message)) ||
            ('HTTP ' + response.status)
          );
        }

        return payload;
      });
    });
  }

  function createRunnerFactory(options) {
    var methodNames = Array.isArray(options && options.methods) ? options.methods.slice() : [];

    function createRunner() {
      var state = {
        successHandler: null,
        failureHandler: null,
        userObject: null
      };
      var target = {};
      var runner = null;

      function handleSuccess(result) {
        if (typeof state.successHandler === 'function') {
          state.successHandler(result, state.userObject);
        }
      }

      function handleFailure(error) {
        if (typeof state.failureHandler === 'function') {
          state.failureHandler(error, state.userObject);
          return;
        }

        if (window.console && typeof window.console.error === 'function') {
          window.console.error('External RPC error:', error);
        }
      }

      function invoke(methodName, methodArgs) {
        invokeRpcMethod(methodName, methodArgs, options)
          .then(handleSuccess)
          .catch(handleFailure);
      }

      target.withSuccessHandler = function (handler) {
        state.successHandler = typeof handler === 'function' ? handler : null;
        return runner;
      };

      target.withFailureHandler = function (handler) {
        state.failureHandler = typeof handler === 'function' ? handler : null;
        return runner;
      };

      target.withUserObject = function (userObject) {
        state.userObject = userObject;
        return runner;
      };

      if (typeof Proxy === 'function') {
        runner = new Proxy(target, {
          get: function (obj, prop) {
            if (prop === 'then') return undefined;
            if (Object.prototype.hasOwnProperty.call(obj, prop)) {
              return obj[prop];
            }

            return function () {
              invoke(String(prop), Array.prototype.slice.call(arguments));
            };
          }
        });
        return runner;
      }

      for (var i = 0; i < methodNames.length; i++) {
        (function (methodName) {
          target[methodName] = function () {
            invoke(methodName, Array.prototype.slice.call(arguments));
          };
        })(methodNames[i]);
      }

      runner = target;
      return runner;
    }

    return createRunner;
  }

  function installGoogleScriptRunShim(options) {
    if (hasNativeAppsScriptRuntime()) {
      return false;
    }

    var createRunner = createRunnerFactory(options || {});

    window.google = window.google || {};
    window.google.script = window.google.script || {};
    window.google.script.__ogiExternalShim = true;

    Object.defineProperty(window.google.script, 'run', {
      configurable: true,
      enumerable: true,
      get: function () {
        return createRunner();
      }
    });

    return true;
  }

  window.OgiRuntimeBridge = {
    buildRpcUrl: buildRpcUrl,
    hasNativeAppsScriptRuntime: hasNativeAppsScriptRuntime,
    invokeRpcMethod: invokeRpcMethod,
    installGoogleScriptRunShim: installGoogleScriptRunShim
  };
})(window);
