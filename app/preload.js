// This was inspiried by
// https://github.com/electron-webapps/meteor-electron/blob/master/app/preload.js

const ipc = require('electron').ipcRenderer;

/**
 * See https://github.com/atom/electron/issues/1753#issuecomment-104719851.
 */

/**
 * Callback passed to ipc on/once methods.
 *
 * @callback ipcListener
 * @param {string} event - event name
 * @param {...*=}  args  - event's arguments
 */

/**
 * Simple abstraction over electron's IPC. Securely wraps ipcRenderer.
 * Available as `Desktop` global.
 * @class
 */
const Desktop = new (class {

    constructor() {
        this.onceEventListeners = {};
        this.eventListeners = {};
        this.registeredInIpc = {};
        this.fetchCallCounter = 0;
        this.fetchTimeoutTimers = {};
    }

    /**
     * Just a convenience method for getting an url for a file from the local file system.
     * @param {string} absolutePath - absolute path to the file
     * @returns {string}
     */
    getFileUrl(absolutePath) { // eslint-disable-line
        return `/local-filesystem/${absolutePath}`;
    }

    /**
     * Just a convenience method for getting an url for a file from the assets directory.
     * @param {string} assetPath - file path relative to assets directory
     * @returns {string}
     */
    getAssetUrl(assetPath) { // eslint-disable-line
        return `/___desktop/${assetPath}`;
    }

    /**
     * Just a convenience method for getting a file from the local file system.
     * Returns a promise from `fetch`.
     * @param {string} absolutePath - absolute path to the file
     * @returns {Promise}
     */
    fetchFile(absolutePath) {
        return fetch(this.getFileUrl(absolutePath, false));
    }

    /**
     * Just a convenience method for getting a file from the assets directory.
     * Returns a promise from `fetch`.
     * @param {string} assetPath - file path relative to assets directory
     * @returns {Promise}
     */
    fetchAsset(assetPath) {
        return fetch(this.getAssetUrl(assetPath, false));
    }

    /**
     * Adds a callback to internal listeners placeholders and registers real ipc hooks.
     *
     * @param {string}      module   - module name
     * @param {string}      event    - name of an event
     * @param {ipcListener} callback - callback to fire when event arrives
     * @param {boolean}     once     - whether this should be fired only once
     * @param {boolean}     response - whether we are listening for fetch response
     * @private
     */
    addToListeners(module, event, callback, once, response = false) {
        let listeners = 'eventListeners';
        if (once) {
            listeners = 'onceEventListeners';
        }
        const eventName = response ? this.getResponseEventName(module, event) :
            this.getEventName(module, event);
        if (eventName in this[listeners]) {
            this[listeners][eventName].add(callback);
        } else {
            this[listeners][eventName] = new Set([callback]);
        }
        if (!(eventName in this.registeredInIpc)) {
            this.registeredInIpc[eventName] = true;
            ipc.on(eventName, (...args) => {
                if (eventName in this.eventListeners) {
                    this.eventListeners[eventName].forEach(eventHandler => eventHandler(...args));
                }
                if (eventName in this.onceEventListeners) {
                    this.onceEventListeners[eventName].forEach((eventHandler) => {
                        eventHandler(...args);
                        this.onceEventListeners[eventName].delete(eventHandler);
                    });
                }
            });
        }
    }

    /**
     * Invokes callback when the specified IPC event is fired.
     *
     * @param {string} module        - module name
     * @param {string} event         - name of an event
     * @param {ipcListener} callback - function to invoke when `event` is triggered
     * @public
     */
    on(module, event, callback) {
        this.addToListeners(module, event, callback);
    }

    /**
     * Invokes a callback once when the specified IPC event is fired.
     *
     * @param {string} module        - module name
     * @param {string} event         - name of an event
     * @param {ipcListener} callback - function to invoke when `event` is triggered
     * @param {boolean} response     - whether we are listening for fetch response
     * @public
     */
    once(module, event, callback, response = false) {
        this.addToListeners(module, event, callback, true, response);
    }

    /**
     * Unregisters a callback.
     *
     * @param {string} module     - module name
     * @param {string} event      - name of an event
     * @param {function} callback - listener to unregister
     * @public
     */
    removeListener(module, event, callback) {
        const eventName = this.getEventName(module, event);
        ['eventListeners', 'onceEventListeners'].forEach((listeners) => {
            if (eventName in this[listeners]) {
                if (~this[listeners][eventName].indexOf(callback)) {
                    this[listeners][eventName].splice(
                        this[listeners][eventName].indexOf(callback), 1);
                }
            }
        });
    }

    /**
     * Unregisters all callbacks.
     *
     * @param {string} module - module name
     * @param {string} event  - name of an event
     * @public
     */
    removeAllListeners(module, event) {
        const eventName = this.getEventName(module, event);
        this.onceEventListeners[eventName] = new Set();
        this.eventListeners[eventName] = new Set();
    }

    /**
     * Send an event to the main Electron process.
     *
     * @param {string} module - module name
     * @param {string} event  - name of an event
     * @param {...*} args     - arguments to send with the event
     * @public
     */
    send(module, event, ...args) {
        const eventName = this.getEventName(module, event);
        ipc.send(eventName, ...args);
    }

    /**
     * Fetches some data from main process by sending an IPC event and waiting for a response.
     * Returns a promise that resolves when the response is received.
     *
     * @param {string} module  - module name
     * @param {string} event   - name of an event
     * @param {number} timeout - how long to wait for the response in milliseconds
     * @param {...*} args      - arguments to send with the event
     * @returns {Promise}
     * @public
     */
    fetch(module, event, timeout = 2000, ...args) {
        const eventName = this.getEventName(module, event);
        if (this.fetchCallCounter === Number.MAX_SAFE_INTEGER) {
            this.fetchCallCounter = 0;
        }
        this.fetchCallCounter += 1;
        const fetchId = this.fetchCallCounter;

        return new Promise((resolve, reject) => {
            this.once(module, `${event}_${fetchId}`,
                (responseEvent, id, ...responseArgs) => {
                    if (id === fetchId) {
                        clearTimeout(this.fetchTimeoutTimers[fetchId]);
                        delete this.fetchTimeoutTimers[fetchId];
                        resolve(...responseArgs);
                    }
                }, true
            );
            this.fetchTimeoutTimers[fetchId] = setTimeout(() => {
                reject('timeout');
            }, timeout);
            ipc.send(eventName, fetchId, ...args);
        });
    }

    /**
     * Send an global event to the main Electron process.
     *
     * @param {...*} args - arguments to the ipc.send(event, arg1, arg2)
     * @public
     */
    sendGlobal(...args) { // eslint-disable-line
        ipc.send(...args);
    }

    /**
     * Concatenates module name with event name.
     *
     * @param {string} module - module name
     * @param {string} event - event name
     * @returns {string}
     * @private
     */
    getEventName(module, event) { // eslint-disable-line
        return `${module}__${event}`;
    }

    /**
     * Concatenates event name with response postfix.
     *
     * @param {string} module - module name
     * @param {string} event  - event name
     * @returns {string}
     * @private
     */
    getResponseEventName(module, event) {
        return `${this.getEventName(module, event)}___response`;
    }

})();


process.once('loaded', () => {
    let devtron = null;

    try {
        devtron = require('devtron'); // eslint-disable-line global-require
        global.__devtron = { require, process }; // eslint-disable-line no-underscore-dangle
    } catch (e) {
        // If that fails, then probably this is production build and devtron is not available.
    }
    if (process.env.NODE_ENV === 'test') {
        global.electronRequire = require;
        global.process = process;
    }

    Desktop.devtron = devtron;
    global.Desktop = Desktop;
});
