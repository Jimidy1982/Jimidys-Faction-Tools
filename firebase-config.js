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
    if (typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length === 0) {
        firebase.initializeApp(firebaseConfig);
    }
})();
