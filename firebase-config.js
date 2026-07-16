/**
 * Firebase config for Jimidy's Faction Tools.
 * Used for activity tracker backend (Firestore read/write).
 * Compat build: firebase and firebase.firestore are on window when scripts load in order.
 */
(function () {
    'use strict';
    var firebaseConfig = {
        apiKey: 'AIzaSyClml4gAPFJQenRIkTIu3leq44xZVMexdI',
        authDomain: 'jimidy-s-faction-tools.firebaseapp.com',
        projectId: 'jimidy-s-faction-tools',
        storageBucket: 'jimidy-s-faction-tools.firebasestorage.app',
        messagingSenderId: '151975397539',
        appId: '1:151975397539:web:8dddf4cc64347543381716'
    };

    /** Activity registration runs as Gen2 HTTP (onRequest), not callable — always use fetch + callable-shaped JSON. */
    var HTTP_ACTIVITY_NAMES = {
        addTrackedFaction: true,
        removeTrackedFaction: true,
        listMyActivityFactions: true
    };
    var CLOUD_FUNCTIONS_ORIGIN = 'https://us-central1-jimidy-s-faction-tools.cloudfunctions.net';

    function shouldUseFunctionsDevProxy() {
        try {
            var h = String(location.hostname || '').toLowerCase();
            return h === 'localhost' || h === '127.0.0.1';
        } catch (e) {
            return false;
        }
    }

    function callableStatusToCode(status) {
        if (!status) return 'functions/internal';
        var s = String(status);
        if (s.indexOf('functions/') === 0) return s;
        return 'functions/' + s.toLowerCase().replace(/_/g, '-');
    }

    function parseCallableFetchResponse(res, text) {
        var body;
        try {
            body = text ? JSON.parse(text) : {};
        } catch (parseErr) {
            var pe = new Error(text || res.statusText || 'Not JSON from function');
            pe.code = 'functions/internal';
            throw pe;
        }
        if (body && body.error) {
            var err = new Error(body.error.message || 'Firebase function error');
            err.code = callableStatusToCode(body.error.status);
            if (body.error.details != null) err.details = body.error.details;
            throw err;
        }
        if (!res.ok) {
            var he = new Error(res.statusText || 'HTTP ' + res.status);
            he.code = 'functions/internal';
            throw he;
        }
        return { data: body.result };
    }

    /** Same-origin POST via Vite proxy (/.functions-proxy/*). */
    function postViaDevProxy(functionName, payload) {
        var url = '/.functions-proxy/' + encodeURIComponent(functionName);
        return fetch(url, {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: payload !== undefined ? payload : {} })
        }).then(function (res) {
            return res.text().then(function (text) {
                return parseCallableFetchResponse(res, text);
            });
        });
    }

    /** Direct POST to Cloud Functions HTTP URL (onRequest activity endpoints + CORS). */
    function postActivityHttpDirect(functionName, payload) {
        var url = CLOUD_FUNCTIONS_ORIGIN + '/' + encodeURIComponent(functionName);
        return fetch(url, {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: payload !== undefined ? payload : {} })
        }).then(function (res) {
            return res.text().then(function (text) {
                return parseCallableFetchResponse(res, text);
            });
        });
    }

    function wrapRegionalFunctions(regionalFns) {
        var origHttpsCallable = regionalFns.httpsCallable.bind(regionalFns);
        regionalFns.httpsCallable = function (name) {
            if (HTTP_ACTIVITY_NAMES[name]) {
                return function (payload) {
                    if (shouldUseFunctionsDevProxy()) {
                        return postViaDevProxy(name, payload);
                    }
                    return postActivityHttpDirect(name, payload);
                };
            }
            var inner = origHttpsCallable(name);
            return function (payload) {
                if (shouldUseFunctionsDevProxy()) {
                    return postViaDevProxy(name, payload);
                }
                return inner(payload);
            };
        };
        return regionalFns;
    }

    if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length === 0) {
        firebase.initializeApp(firebaseConfig);
    }
    if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0) {
        var __fbApp = firebase.app();
        var __origFunctionsFactory = firebase.functions;
        if (typeof __origFunctionsFactory === 'function') {
            firebase.functions = function (maybeApp) {
                var a = maybeApp || __fbApp;
                var regional = a.functions('us-central1');
                return wrapRegionalFunctions(regional);
            };
        }
    }

    /** Bump with version.json when shipping client updates. Stale tabs poll version.json and show a refresh banner. */
    var APP_BUILD_VERSION = '20260715k';
    window.APP_BUILD_VERSION = APP_BUILD_VERSION;

    function showAppUpdateBanner() {
        if (document.getElementById('app-update-banner')) return;
        var bar = document.createElement('div');
        bar.id = 'app-update-banner';
        bar.setAttribute('role', 'alert');
        bar.style.cssText =
            'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:99999;' +
            'width:max-content;max-width:calc(100vw - 24px);box-sizing:border-box;' +
            'margin:0;padding:10px 20px;background:#b45309;color:#fff;text-align:center;font-size:14px;' +
            'border-radius:0 0 10px 10px;box-shadow:0 4px 14px rgba(0,0,0,0.35);' +
            'display:inline-flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:4px 0;' +
            'animation:appUpdateBannerIn 0.28s ease-out;';
        if (!document.getElementById('app-update-banner-style')) {
            var style = document.createElement('style');
            style.id = 'app-update-banner-style';
            style.textContent =
                '@keyframes appUpdateBannerIn{from{opacity:0;transform:translateX(-50%) translateY(-100%)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
            document.head.appendChild(style);
        }
        bar.innerHTML =
            'A new version of Faction Tools is available. ' +
            '<button type="button" style="margin-left:10px;padding:4px 12px;cursor:pointer;font-weight:600;border:none;border-radius:4px;">Refresh now</button>';
        bar.querySelector('button').onclick = function () {
            location.reload();
        };
        if (document.body) document.body.prepend(bar);
        else document.addEventListener('DOMContentLoaded', function () {
            document.body.prepend(bar);
        });
    }
    window.showAppUpdateBanner = showAppUpdateBanner;

    function pollAppBuildVersion() {
        try {
            fetch('version.json?nocache=' + Date.now(), { cache: 'no-store' })
                .then(function (res) {
                    if (!res.ok) return null;
                    return res.json();
                })
                .then(function (data) {
                    var remote = data && data.build;
                    if (remote && remote !== APP_BUILD_VERSION) showAppUpdateBanner();
                })
                .catch(function () { /* ignore */ });
        } catch (e) { /* ignore */ }
    }

    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') pollAppBuildVersion();
    });
    pollAppBuildVersion();
    setInterval(pollAppBuildVersion, 30 * 60 * 1000);
})();
