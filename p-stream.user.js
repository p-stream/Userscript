// ==UserScript==
// @name         P-Stream Userscript
// @namespace    https://pstream.mov/
// @version      1.0.2
// @description  Userscript replacement for the P-Stream extension
// @author       Duplicake, P-Stream Team
// @icon         https://raw.githubusercontent.com/p-stream/p-stream/production/public/mstile-150x150.jpeg
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @run-at       document-start
// @connect      *
// @updateURL    https://raw.githubusercontent.com/p-stream/Userscript/main/p-stream.user.js
// @downloadURL  https://raw.githubusercontent.com/p-stream/Userscript/main/p-stream.user.js
// ==/UserScript==

(function () {
  'use strict';

  // Environment bootstrap, report higher version to bypass extension version requirement.
  const SCRIPT_VERSION = '1.4.0';
  // Use unsafeWindow when available so our patches run in the page context.
  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  const gmXhr =
    typeof GM_xmlhttpRequest === 'function'
      ? GM_xmlhttpRequest
      : typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function'
        ? GM.xmlHttpRequest
        : null;

  // --- Constants & state -------------------------------------------------
  const DEFAULT_CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    'access-control-allow-headers': '*',
  };
  const MODIFIABLE_RESPONSE_HEADERS = [
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'content-security-policy',
    'content-security-policy-report-only',
    'content-disposition',
  ];

  const STREAM_RULES = new Map();
  const MEDIA_BLOBS = new Map(); // blobUrl -> { element, originalUrl, createdAt }
  const ELEMENT_BLOBS = new WeakMap(); // element -> blobUrl
  const ELEMENT_PENDING_REQUESTS = new WeakMap(); // element -> Set of pending request URLs
  const PROXY_CACHE = new Map();
  let fetchPatched = false;
  let xhrPatched = false;
  let mediaPatched = false;

  const REQUEST_ORIGIN = (() => {
    try {
      const { origin, href } = pageWindow.location;
      if (origin && origin !== 'null') return origin;
      if (href) return new URL(href).origin;
    } catch {}
    return '*';
  })();

  // --- Logging -----------------------------------------------------------
  const log = (...args) => console.debug('[p-stream-userscript]', ...args);

  // --- Basic utilities ---------------------------------------------------
  const canAccessCookies = () => true;

  const normalizeUrl = (input) => {
    if (!input) return null;
    try {
      return new URL(input, pageWindow.location.href).toString();
    } catch {
      return null;
    }
  };

  const isSameOrigin = (url) => {
    try {
      return new URL(url).origin === new URL(pageWindow.location.href).origin;
    } catch {
      return false;
    }
  };

  const makeFullUrl = (url, ops = {}) => {
    let leftSide = ops.baseUrl ?? '';
    let rightSide = url;
    if (leftSide.length > 0 && !leftSide.endsWith('/')) leftSide += '/';
    if (rightSide.startsWith('/')) rightSide = rightSide.slice(1);
    const fullUrl = leftSide + rightSide;
    if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://'))
      throw new Error(`Invalid URL -- URL doesn't start with a http scheme: '${fullUrl}'`);

    const parsedUrl = new URL(fullUrl);
    Object.entries(ops.query ?? {}).forEach(([k, v]) => parsedUrl.searchParams.set(k, v));
    return parsedUrl.toString();
  };

  const parseHeaders = (raw) => {
    const headers = {};
    (raw || '')
      .split(/\r?\n/)
      .filter(Boolean)
      .forEach((line) => {
        const idx = line.indexOf(':');
        if (idx === -1) return;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        headers[key.toLowerCase()] = headers[key.toLowerCase()]
          ? `${headers[key.toLowerCase()]}, ${value}`
          : value;
      });
    return headers;
  };

  const buildResponseHeaders = (rawHeaders, ruleHeaders, includeCredentials) => {
    const headerMap = {
      ...DEFAULT_CORS_HEADERS,
      ...(ruleHeaders ?? {}),
      ...parseHeaders(rawHeaders),
    };

    if (includeCredentials) {
      headerMap['access-control-allow-credentials'] = 'true';
      if (!headerMap['access-control-allow-origin'] || headerMap['access-control-allow-origin'] === '*') {
        headerMap['access-control-allow-origin'] = REQUEST_ORIGIN;
      }
    }

    return headerMap;
  };

  // --- Request helpers ---------------------------------------------------
  const mapBodyToPayload = (body, bodyType) => {
    if (body == null) return undefined;
    switch (bodyType) {
      case 'FormData': {
        const formData = new FormData();
        body.forEach(([key, value]) => formData.append(key, value));
        return formData;
      }
      case 'URLSearchParams':
        return new URLSearchParams(body);
      case 'object':
        return JSON.stringify(body);
      case 'string':
        return body;
      default:
        return body;
    }
  };

  const normalizeBody = (body) => {
    if (body == null) return undefined;
    if (body instanceof URLSearchParams) return body.toString();
    if (typeof body === 'string' || body instanceof FormData || body instanceof Blob) return body;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body;
    if (typeof body === 'object') return JSON.stringify(body);
    return body;
  };

  const gmRequest = (options) =>
    new Promise((resolve, reject) => {
      if (!gmXhr) {
        reject(new Error('GM_xmlhttpRequest missing; cannot proxy request'));
        return;
      }
      gmXhr({
        ...options,
        onload: (response) => resolve(response),
        onerror: (error) => reject(error),
        ontimeout: () => reject(new Error('Request timed out')),
      });
    });

  const shouldSendCredentials = (url, credentialsMode, withCredentialsFlag = false) => {
    if (!url) return false;
    if (withCredentialsFlag) return true;
    const sameOrigin = isSameOrigin(url);

    if (credentialsMode === 'omit') return false;
    if (credentialsMode === 'include') return true;
    if (!credentialsMode || credentialsMode === 'same-origin') return sameOrigin || canAccessCookies();
    return canAccessCookies();
  };

  const findRuleForUrl = (url) => {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;
    const host = new URL(normalized).hostname;
    for (const rule of STREAM_RULES.values()) {
      if (rule.targetDomains?.some((d) => host === d || host.endsWith(`.${d}`))) return rule;
      if (rule.targetRegex) {
        try {
          const regex = new RegExp(rule.targetRegex);
          if (regex.test(normalized)) return rule;
        } catch (err) {
          log('Invalid targetRegex in rule, skipping', err);
        }
      }
    }
    return null;
  };

  // --- Media helpers -----------------------------------------------------
  const makeBlobUrl = (data, contentType, originalUrl, element) => {
    const dataSize = data instanceof ArrayBuffer ? data.byteLength : (data.length || 0);
    const blob = new Blob([data], { type: contentType || 'application/octet-stream' });
    const blobUrl = URL.createObjectURL(blob);
    // Store metadata about the blob URL
    MEDIA_BLOBS.set(blobUrl, {
      element: element || null,
      originalUrl: originalUrl || '',
      createdAt: Date.now(),
      size: dataSize,
    });
    // Track blob URL per element if element is provided
    if (element) {
      ELEMENT_BLOBS.set(element, blobUrl);
    }
    return blobUrl;
  };

  const cleanupElementBlob = (element) => {
    const blobUrl = ELEMENT_BLOBS.get(element);
    if (blobUrl) {
      const blobMetadata = MEDIA_BLOBS.get(blobUrl);
      try {
        URL.revokeObjectURL(blobUrl);
        MEDIA_BLOBS.delete(blobUrl);
        ELEMENT_BLOBS.delete(element);
        log('Cleaned up blob URL for element:', blobUrl);
      } catch (err) {
        log('Failed to revoke blob URL for element', err);
      }
    }
    
    // Cancel any pending requests for this element
    const pendingRequests = ELEMENT_PENDING_REQUESTS.get(element);
    if (pendingRequests && pendingRequests.size > 0) {
      const cancelledCount = pendingRequests.size;
      pendingRequests.forEach((url) => {
        PROXY_CACHE.delete(url);
      });
      pendingRequests.clear();
      log('Cancelled pending requests for element');
    }
  };

  const proxyMediaIfNeeded = async (url, element = null) => {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;
    
    // Check cache first
    if (PROXY_CACHE.has(normalized)) {
      return PROXY_CACHE.get(normalized);
    }
    
    const rule = findRuleForUrl(normalized);
    if (!rule) return null;
    
    // Track this request for the element so we can cancel it if src changes
    if (element) {
      if (!ELEMENT_PENDING_REQUESTS.has(element)) {
        ELEMENT_PENDING_REQUESTS.set(element, new Set());
      }
      ELEMENT_PENDING_REQUESTS.get(element).add(normalized);
    }
    
    // Store the expected src value to check if it changed during download
    const expectedSrc = element ? (element.src || element.getAttribute('src')) : null;
    
    // Create promise and cache it immediately to prevent duplicate requests
    const proxyPromise = (async () => {
      try {
        const includeCredentials = shouldSendCredentials(normalized, 'include', true);
        const response = await gmRequest({
          url: normalized,
          method: 'GET',
          headers: rule.requestHeaders,
          responseType: 'arraybuffer',
          withCredentials: includeCredentials,
        });
        
        // Check if element's src has changed during download - if so, cancel this blob creation
        if (element) {
          const currentSrc = element.src || element.getAttribute('src');
          if (currentSrc !== expectedSrc && currentSrc !== normalized) {
            log('Source changed during download, cancelling blob creation for:', normalized);
            // CRITICAL: Try to clear the response data from memory
            // Note: GM API responses may be read-only, but we try anyway
            try {
              if (response.response instanceof ArrayBuffer) {
                // Transfer the ArrayBuffer to a new empty one to release memory
                // This doesn't actually clear it, but helps GC understand it's no longer needed
                const emptyBuffer = new ArrayBuffer(0);
                // The old buffer will be GC'd when there are no more references
              }
              if (response.responseText) {
                response.responseText = '';
              }
            } catch (e) {
              // Response may be read-only, that's okay
            }
            // Remove from cache immediately to prevent reuse
            PROXY_CACHE.delete(normalized);
            // Remove from pending requests
            const pendingRequests = ELEMENT_PENDING_REQUESTS.get(element);
            if (pendingRequests) {
              pendingRequests.delete(normalized);
            }
            return null;
          }
        }
        
        const headers = parseHeaders(response.responseHeaders);
        const contentType = headers['content-type'] || '';

        if (
          contentType.includes('application/vnd.apple.mpegurl') ||
          contentType.includes('application/x-mpegurl') ||
          normalized.includes('.m3u8')
        ) {
          return null;
        }
        if (contentType.includes('application/dash+xml') || normalized.includes('.mpd')) return null;

        // Double-check element hasn't changed before creating blob
        if (element) {
          const currentSrc = element.src || element.getAttribute('src');
          if (currentSrc !== expectedSrc && currentSrc !== normalized) {
            log('Source changed right before blob creation, cancelling:', normalized);
            // CRITICAL: Try to clear the response data from memory
            try {
              if (response.response instanceof ArrayBuffer) {
                const emptyBuffer = new ArrayBuffer(0);
              }
              if (response.responseText) {
                response.responseText = '';
              }
            } catch (e) {
              // Response may be read-only, that's okay
            }
            // Remove from cache immediately to prevent reuse
            PROXY_CACHE.delete(normalized);
            const pendingRequests = ELEMENT_PENDING_REQUESTS.get(element);
            if (pendingRequests) {
              pendingRequests.delete(normalized);
            }
            return null;
          }
        }

        const blobUrl = makeBlobUrl(
          response.response instanceof ArrayBuffer ? response.response : new TextEncoder().encode(response.responseText ?? ''),
          contentType,
          normalized,
          element,
        );
        
        // Remove from pending requests on success
        if (element) {
          const pendingRequests = ELEMENT_PENDING_REQUESTS.get(element);
          if (pendingRequests) {
            pendingRequests.delete(normalized);
          }
        }
        
        return blobUrl;
      } catch (err) {
        log('Media proxy failed, falling back to original src', err);
        // Remove from pending requests on error
        if (element) {
          const pendingRequests = ELEMENT_PENDING_REQUESTS.get(element);
          if (pendingRequests) {
            pendingRequests.delete(normalized);
          }
        }
        return null;
      } finally {
        // Remove from cache after a short delay
        // Also clear any response data that might still be in the cached promise
        setTimeout(() => {
          PROXY_CACHE.delete(normalized);
        }, 1000);
      }
    })();
    
    PROXY_CACHE.set(normalized, proxyPromise);
    return proxyPromise;
  };

  // --- Proxy initializers ------------------------------------------------
  const ensureFetchProxy = () => {
    if (fetchPatched) return;
    fetchPatched = true;
    const win = pageWindow;
    const nativeFetch = win.fetch.bind(win);

    win.fetch = async (input, init = {}) => {
      const targetUrl = normalizeUrl(typeof input === 'string' ? input : input?.url);
      if (!targetUrl) return nativeFetch(input, init);
      const rule = findRuleForUrl(targetUrl);
      if (!rule) return nativeFetch(input, init);

      const headers = {};
      const initHeaders = init.headers instanceof Headers ? Object.fromEntries(init.headers.entries()) : init.headers;
      Object.assign(headers, rule.requestHeaders ?? {}, initHeaders ?? {});

      const method = init.method || 'GET';
      const payload = normalizeBody(init.body);
      const includeCredentials = shouldSendCredentials(targetUrl, init.credentials);

      try {
        const response = await gmRequest({
          url: targetUrl,
          method,
          data: payload,
          headers,
          responseType: 'arraybuffer',
          withCredentials: includeCredentials,
        });

        const headerMap = buildResponseHeaders(response.responseHeaders, rule.responseHeaders, includeCredentials);
        const bodyBuffer =
          response.response instanceof ArrayBuffer
            ? response.response
            : new TextEncoder().encode(response.responseText ?? '');

        return new Response(bodyBuffer, {
          status: response.status,
          statusText: response.statusText ?? '',
          headers: headerMap,
        });
      } catch (err) {
        log('Proxy fetch failed, falling back to native', err);
        return nativeFetch(input, init);
      }
    };
  };

  const ensureXhrProxy = () => {
    if (xhrPatched) return;
    xhrPatched = true;
    const win = pageWindow;
    const NativeXHR = win.XMLHttpRequest;

    const EVENTS = ['readystatechange', 'load', 'error', 'timeout', 'abort', 'loadend', 'progress', 'loadstart'];

    const emit = (instance, type, event = new Event(type)) => {
      try {
        instance[`on${type}`]?.call(instance, event);
      } catch (err) {
        log('XHR handler error', err);
      }
      (instance._listeners.get(type) || []).forEach((cb) => {
        try {
          cb.call(instance, event);
        } catch (err) {
          log('XHR listener error', err);
        }
      });
    };

    class ProxyXHR {
      constructor() {
        this._native = new NativeXHR();
        this._usingNative = true;
        this._listeners = new Map();
        this._headers = {};
        this._rule = null;
        this._url = '';
        this._method = 'GET';
        this._responseHeaders = {};
        this._readyState = ProxyXHR.UNSENT;
        this._status = 0;
        this._statusText = '';
        this._response = null;
        this._responseText = '';
        this._responseURL = '';
        this._overrideMime = '';
        this.responseType = '';
        this.withCredentials = false;
        this.timeout = 0;
        this.upload = this._native.upload;
      }

      get readyState() {
        return this._usingNative ? this._native.readyState : this._readyState;
      }

      set readyState(value) {
        this._readyState = value;
      }

      get status() {
        return this._usingNative ? this._native.status : this._status;
      }

      set status(value) {
        this._status = value;
      }

      get statusText() {
        return this._usingNative ? this._native.statusText : this._statusText;
      }

      set statusText(value) {
        this._statusText = value;
      }

      get response() {
        return this._usingNative ? this._native.response : this._response;
      }

      set response(value) {
        this._response = value;
      }

      get responseText() {
        return this._usingNative ? this._native.responseText : this._responseText;
      }

      set responseText(value) {
        this._responseText = value;
      }

      get responseURL() {
        return this._usingNative ? this._native.responseURL : this._responseURL;
      }

      set responseURL(value) {
        this._responseURL = value;
      }

      addEventListener(type, callback) {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type).push(callback);
        if (this._usingNative) return this._native.addEventListener(type, callback);
      }

      removeEventListener(type, callback) {
        const listeners = this._listeners.get(type);
        if (!listeners) return;
        const idx = listeners.indexOf(callback);
        if (idx !== -1) listeners.splice(idx, 1);
        if (this._usingNative) return this._native.removeEventListener(type, callback);
      }

      _bindNativeEvents() {
        if (this._nativeBound) return;
        this._nativeBound = true;
        EVENTS.forEach((type) => {
          this._native.addEventListener(type, (event) => emit(this, type, event));
        });
      }

      open(method, url, async = true, user, password) {
        this._method = method;
        const normalized = normalizeUrl(url);
        this._url = normalized ?? url;
        this._rule = normalized ? findRuleForUrl(normalized) : null;
        this._usingNative = !this._rule;

        if (this._usingNative) {
          return this._native.open(method, url, async, user, password);
        }

        this.readyState = ProxyXHR.OPENED;
        emit(this, 'readystatechange');
      }

      setRequestHeader(name, value) {
        if (this._usingNative) return this._native.setRequestHeader(name, value);
        this._headers[name] = value;
      }

      getResponseHeader(name) {
        if (this._usingNative) return this._native.getResponseHeader(name);
        const key = name?.toLowerCase?.() ?? '';
        return this._responseHeaders[key] ?? null;
      }

      getAllResponseHeaders() {
        if (this._usingNative) return this._native.getAllResponseHeaders();
        return Object.entries(this._responseHeaders)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');
      }

      overrideMimeType(mime) {
        if (this._usingNative) return this._native.overrideMimeType(mime);
        this._overrideMime = mime;
      }

      abort() {
        if (this._usingNative) return this._native.abort();
        if (this._timeoutId) clearTimeout(this._timeoutId);
        this._aborted = true;
        this.readyState = ProxyXHR.UNSENT;
        emit(this, 'abort');
      }

      _applyTimeout(promise) {
        if (!this.timeout) return promise;
        return Promise.race([
          promise,
          new Promise((_, reject) => {
            this._timeoutId = setTimeout(() => reject(new Error('timeout')), this.timeout);
          }),
        ]);
      }

      async send(body = null) {
        if (this._usingNative) {
          this._native.withCredentials = this.withCredentials;
          this._native.responseType = this.responseType;
          this._native.timeout = this.timeout;
          this._bindNativeEvents();
          return this._native.send(body);
        }

        const rule = this._rule;
        if (!rule) return;
        const headers = { ...(rule.requestHeaders ?? {}), ...this._headers };
        const includeCredentials = shouldSendCredentials(this._url, this.withCredentials ? 'include' : undefined, this.withCredentials);

        try {
          emit(this, 'loadstart');
          const response = await this._applyTimeout(
            gmRequest({
              url: this._url,
              method: this._method || 'GET',
              data: normalizeBody(body),
              headers,
              responseType: this.responseType === 'arraybuffer' || this.responseType === 'blob' ? 'arraybuffer' : 'text',
              withCredentials: includeCredentials,
            }),
          );

          if (this._timeoutId) clearTimeout(this._timeoutId);
          if (this._aborted) return;

          const headerMap = buildResponseHeaders(response.responseHeaders, rule.responseHeaders, includeCredentials);
          this._responseHeaders = Object.fromEntries(Object.entries(headerMap).map(([k, v]) => [k.toLowerCase(), v]));

          const responseUrl = response.finalUrl || this._url;
          this.responseURL = responseUrl;
          this.status = response.status;
          this.statusText = response.statusText ?? '';
          const bodyBuffer =
            response.response instanceof ArrayBuffer
              ? response.response
              : new TextEncoder().encode(response.responseText ?? '');

          this.readyState = ProxyXHR.HEADERS_RECEIVED;
          emit(this, 'readystatechange');
          this.readyState = ProxyXHR.LOADING;
          emit(this, 'readystatechange');

          if (this.responseType === 'arraybuffer') {
            this.response = bodyBuffer;
          } else if (this.responseType === 'blob') {
            this.response = new Blob([bodyBuffer], {
              type: this.getResponseHeader('content-type') || this._overrideMime || 'application/octet-stream',
            });
          } else if (this.responseType === 'json') {
            const text = new TextDecoder().decode(bodyBuffer);
            this.responseText = text;
            try {
              this.response = JSON.parse(text);
            } catch {
              this.response = null;
            }
          } else {
            this.response = new TextDecoder().decode(bodyBuffer);
            this.responseText = this.response;
          }

          this.readyState = ProxyXHR.DONE;
          emit(this, 'readystatechange');
          emit(this, 'load');
          emit(this, 'loadend');
        } catch (err) {
          if (this._timeoutId) clearTimeout(this._timeoutId);
          if (this._aborted) return;
          this.status = 0;
          this.statusText = err?.message ?? '';
          this.readyState = ProxyXHR.DONE;
          emit(this, 'readystatechange');
          emit(this, err?.message === 'timeout' ? 'timeout' : 'error');
          emit(this, 'loadend');
        }
      }
    }

    ProxyXHR.UNSENT = 0;
    ProxyXHR.OPENED = 1;
    ProxyXHR.HEADERS_RECEIVED = 2;
    ProxyXHR.LOADING = 3;
    ProxyXHR.DONE = 4;

    win.XMLHttpRequest = ProxyXHR;
  };

  const ensureMediaProxy = () => {
    if (mediaPatched) return;
    mediaPatched = true;
    const win = pageWindow;

    const srcDescriptor = Object.getOwnPropertyDescriptor(win.HTMLMediaElement.prototype, 'src');
    if (srcDescriptor && srcDescriptor.set) {
      Object.defineProperty(win.HTMLMediaElement.prototype, 'src', {
        ...srcDescriptor,
        set(value) {
          // Clean up previous blob URL and cancel pending requests before setting new src
          cleanupElementBlob(this);
          
          // Track blob URLs that are set directly (not created by us, e.g., from HLS.js)
          if (typeof value === 'string' && value.startsWith('blob:') && !MEDIA_BLOBS.has(value)) {
            // Track this blob URL even though we didn't create it
            MEDIA_BLOBS.set(value, {
              element: this,
              originalUrl: 'external',
              createdAt: Date.now(),
              size: 0, // Unknown size
            });
            ELEMENT_BLOBS.set(this, value);
          }
          
          if (typeof value === 'string') {
            // Store the expected value to check later
            const expectedValue = value;
            // Start proxying in background but set original URL immediately
            proxyMediaIfNeeded(value, this).then(proxied => {
              // Only update if src hasn't changed and we got a proxied URL
              if (proxied && this.src === expectedValue) {
                srcDescriptor.set.call(this, proxied);
              } else if (!proxied && this.src === expectedValue) {
                // If proxying failed or was cancelled, ensure original URL is still set
                // (it should be, but double-check)
                if (this.src !== expectedValue) {
                  srcDescriptor.set.call(this, expectedValue);
                }
              }
            }).catch((err) => {
              log('Error proxying media, using original URL', err);
            });
            return srcDescriptor.set.call(this, value);
          }
          return srcDescriptor.set.call(this, value);
        },
      });
    }

    // CRITICAL FIX: Keep setAttribute synchronous
    const originalMediaSetAttribute = win.HTMLMediaElement.prototype.setAttribute;
    win.HTMLMediaElement.prototype.setAttribute = function (name, value) {
      if (typeof name === 'string' && name.toLowerCase() === 'src' && typeof value === 'string') {
        // Clean up previous blob URL and cancel pending requests before setting new src
        cleanupElementBlob(this);
        
        // Store the expected value to check later
        const expectedValue = value;
        // Start proxying in background but set attribute immediately
        proxyMediaIfNeeded(value, this).then(proxied => {
          // Only update if src attribute hasn't changed and we got a proxied URL
          if (proxied && this.getAttribute('src') === expectedValue) {
            originalMediaSetAttribute.call(this, name, proxied);
          } else if (!proxied && this.getAttribute('src') === expectedValue) {
            // If proxying failed or was cancelled, ensure original URL is still set
            // (it should be, but double-check)
            if (this.getAttribute('src') !== expectedValue) {
              originalMediaSetAttribute.call(this, name, expectedValue);
            }
          }
        }).catch((err) => {
          log('Error proxying media, using original URL', err);
        });
      }
      return originalMediaSetAttribute.call(this, name, value);
    };

    // Track previous src values to detect changes
    const previousSrcMap = new WeakMap();

    // Clean up blob URLs when media elements are removed from DOM or src changes
    const setupMutationObserver = () => {
      const target = win.document.body || win.document.documentElement;
      if (!target) {
        // If body doesn't exist yet, try again later
        setTimeout(setupMutationObserver, 100);
        return;
      }

      const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          // Handle removed nodes
          mutation.removedNodes.forEach((node) => {
            if (node.nodeType === 1) { // Element node
              // Check if it's a media element
              if (node instanceof win.HTMLMediaElement) {
                cleanupElementBlob(node);
                previousSrcMap.delete(node);
              }
              // Check for media elements within removed subtree
              const mediaElements = node.querySelectorAll?.('video, audio');
              if (mediaElements) {
                mediaElements.forEach((el) => {
                  cleanupElementBlob(el);
                  previousSrcMap.delete(el);
                });
              }
            }
          });

          // Handle attribute changes (especially src changes)
          if (mutation.type === 'attributes' && mutation.attributeName === 'src') {
            const target = mutation.target;
            if (target instanceof win.HTMLMediaElement) {
              const previousSrc = previousSrcMap.get(target);
              const currentSrc = target.src || target.getAttribute('src');
              
              // If src changed and we had a previous blob URL, clean it up
              if (previousSrc && previousSrc !== currentSrc && previousSrc.startsWith('blob:')) {
                // Check if this blob URL is still tracked
                const blobMetadata = MEDIA_BLOBS.get(previousSrc);
                if (blobMetadata && blobMetadata.element === target) {
                  cleanupElementBlob(target);
                }
              }
              
              previousSrcMap.set(target, currentSrc);
            }
          }
        });
      });

      // Observe the entire document for removed nodes and attribute changes
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
      });
    };

    // Setup observer when DOM is ready
    if (win.document.readyState === 'loading') {
      win.document.addEventListener('DOMContentLoaded', setupMutationObserver);
    } else {
      setupMutationObserver();
    }

    // Periodic cleanup to catch any orphaned blob URLs
    // Run every 5 seconds to clean up blobs that are no longer in use
    setInterval(() => {
      cleanupOldStreamData();
    }, 5000);

    win.addEventListener('beforeunload', () => {
      MEDIA_BLOBS.forEach((_, blobUrl) => {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch (err) {
          log('Failed to revoke blob URL on unload', err);
        }
      });
      MEDIA_BLOBS.clear();
    });
  };

  const ensureAllProxies = () => {
    ensureFetchProxy();
    ensureXhrProxy();
    ensureMediaProxy();
  };

  // --- Cleanup helper ----------------------------------------------------
  const cleanupOldStreamData = () => {
    const beforeBlobs = MEDIA_BLOBS.size;
    const beforeCache = PROXY_CACHE.size;
    let totalBlobSize = 0;
    
    // Get all currently active media elements and their blob URLs
    const activeBlobUrls = new Set();
    try {
      const mediaElements = pageWindow.document.querySelectorAll('video, audio');
      mediaElements.forEach((el) => {
        const blobUrl = ELEMENT_BLOBS.get(el);
        if (blobUrl) {
          activeBlobUrls.add(blobUrl);
        }
        // Also check if element's src is a blob URL
        if (el.src && el.src.startsWith('blob:')) {
          activeBlobUrls.add(el.src);
        }
      });
    } catch (err) {
      log('Error checking active media elements', err);
    }

    // Calculate total size of blobs to be cleaned
    MEDIA_BLOBS.forEach((metadata, blobUrl) => {
      if (!activeBlobUrls.has(blobUrl)) {
        totalBlobSize += metadata.size || 0;
      }
    });

    // Revoke all blob URLs except those currently in use
    let cleanedCount = 0;
    MEDIA_BLOBS.forEach((metadata, blobUrl) => {
      if (!activeBlobUrls.has(blobUrl)) {
        try {
          URL.revokeObjectURL(blobUrl);
          MEDIA_BLOBS.delete(blobUrl);
          cleanedCount++;
        } catch (err) {
          log('Failed to revoke blob URL', err);
        }
      }
    });

    // Clean up WeakMap entries for removed elements
    // Note: WeakMap doesn't allow iteration, so we rely on the cleanup above

    PROXY_CACHE.clear();
    log(`Cleaned up ${cleanedCount} unused blob URLs, ${MEDIA_BLOBS.size} remaining`);
  };

  // --- Message handlers --------------------------------------------------
  const handleHello = async () => ({
    success: true,
    version: SCRIPT_VERSION,
    allowed: true,
    hasPermission: true,
  });

  const handleMakeRequest = async (reqBody) => {
    if (!reqBody) throw new Error('No request body found in the request.');
    const url = makeFullUrl(reqBody.url, reqBody);
    const includeCredentials = shouldSendCredentials(url, reqBody.credentials, reqBody.withCredentials);

    const response = await gmRequest({
      url,
      method: reqBody.method || 'GET',
      headers: reqBody.headers,
      data: mapBodyToPayload(reqBody.body, reqBody.bodyType),
      responseType: 'arraybuffer',
      withCredentials: includeCredentials,
    });

    const headers = buildResponseHeaders(response.responseHeaders, null, includeCredentials);
    const contentType = headers['content-type'] || '';
    let parsedBody;

    try {
      if (contentType.includes('application/json')) {
        const textBody =
          response.response instanceof ArrayBuffer
            ? new TextDecoder().decode(response.response)
            : response.responseText ?? '';
        parsedBody = JSON.parse(textBody);
      } else if (response.response instanceof ArrayBuffer) {
        parsedBody = new TextDecoder().decode(response.response);
      } else {
        parsedBody = response.responseText ?? '';
      }
    } catch (err) {
      log('Failed to parse response body, returning raw text', err);
      parsedBody = response.responseText ?? '';
    }

    return {
      success: true,
      response: {
        statusCode: response.status,
        headers,
        finalUrl: response.finalUrl || url,
        body: parsedBody,
      },
    };
  };

  const handlePrepareStream = async (reqBody) => {
    if (!reqBody) throw new Error('No request body found in the request.');
    
    // Clean up old stream data before preparing new stream
    // This is called when a new source is scraped, so clean up unused blobs
    cleanupOldStreamData();
    
    const responseHeaders = Object.entries(reqBody.responseHeaders ?? {}).reduce((acc, [k, v]) => {
      const key = k.toLowerCase();
      if (MODIFIABLE_RESPONSE_HEADERS.includes(key)) acc[key] = v;
      return acc;
    }, {});

    STREAM_RULES.set(reqBody.ruleId, {
      ...reqBody,
      responseHeaders,
    });
    
    log('Stream prepared:', reqBody.ruleId);
    ensureAllProxies();
    
    // Schedule cleanup after a short delay to catch any old blobs
    setTimeout(() => {
      cleanupOldStreamData();
    }, 500);
    
    return { success: true };
  };

  const handleOpenPage = async (reqBody) => {
    if (reqBody?.redirectUrl) {
      window.location.href = reqBody.redirectUrl;
    }
    return { success: true };
  };

  // --- Messaging bridge --------------------------------------------------
  const shouldHandleMessage = (event, config) => {
    if (config.__internal) return false;
    if (event.source !== pageWindow) return false;
    if (event.data?.name !== config.name) return false;
    if (config.relayId !== undefined && event.data?.relayId !== config.relayId) return false;
    return true;
  };

  const relay = (config, handler) => {
    const listener = async (event) => {
      if (!shouldHandleMessage(event, config)) return;
      if (event.data?.relayed) return;

      try {
        const result = await handler?.(event.data?.body);
        pageWindow.postMessage(
          {
            name: config.name,
            relayId: config.relayId,
            instanceId: event.data?.instanceId,
            body: result,
            relayed: true,
          },
          config.targetOrigin || '/',
        );
      } catch (err) {
        pageWindow.postMessage(
          {
            name: config.name,
            relayId: config.relayId,
            instanceId: event.data?.instanceId,
            body: {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            },
            relayed: true,
          },
          config.targetOrigin || '/',
        );
      }
    };

    pageWindow.addEventListener('message', listener);
    return () => pageWindow.removeEventListener('message', listener);
  };

  relay({ name: 'hello' }, handleHello);
  relay({ name: 'makeRequest' }, handleMakeRequest);
  relay({ name: 'prepareStream' }, handlePrepareStream);
  relay({ name: 'openPage' }, handleOpenPage);

  log('Userscript proxy loaded');
})();
