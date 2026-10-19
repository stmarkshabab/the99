/**
 * The 99 — configuration.
 *
 * ⚠️  THESE ARE LIVE VALUES. Do not re-upload this file from a fresh copy of
 *     the project — the template version contains PASTE_... placeholders and
 *     overwriting this file with it takes the site down until it is restored.
 *
 * Running on localhost picks the LOCAL block below, so you can try a change
 * before anyone else sees it. See "Previewing changes" in README.md.
 */
(function () {
  var host = location.hostname;
  var isLocal = host === 'localhost' || host === '127.0.0.1' || host === '';

  var LIVE = {
    // Apps Script: Deploy > Manage deployments > the /exec URL.
    API_URL: 'https://script.google.com/macros/s/AKfycbwYhZknRAJVe8AJcIbsT49UmhtGrdrYBYbjz3lghM-GdMHNFICG-9eS0G0dSUDyK6AYWQ/exec',

    // Google Cloud console > Credentials > OAuth client ID (Web application).
    GOOGLE_CLIENT_ID: '85459451769-pperaup23gefg3etlk2u0q62dve2vp1l.apps.googleusercontent.com',

    // Push notifications. Firebase console > Project settings > Your apps (Web).
    // These are public identifiers, not secrets. Until apiKey, appId and
    // VAPID_KEY are filled in, the notifications card simply does not appear.
    FIREBASE: {
      apiKey: 'AIzaSyCzixlvJ528NC5iszGfShhfV1omk1Xp6ko',
      projectId: 'the99-followup',
      messagingSenderId: '85459451769',
      appId: '1:85459451769:web:f6795b3c9f3fba369879a8'
    },
    // Firebase console > Project settings > Cloud Messaging > Web Push certificates.
    VAPID_KEY: 'BMvSiXP0-GV3BoutvKWQj8SFyljIL1C4SY3axTkPu_PVs2DmRkBM_Sm1tbuG3ROTxHNGPoOvJddQrEMV1VwS5-U'
  };

  var LOCAL = {
    // Point this at a SECOND Apps Script deployment attached to a COPY of the
    // spreadsheet, and anything you log while testing lands in the copy instead
    // of the ministry's real sheet. Until you set one up it stays on LIVE,
    // which is fine for looking at layout but means test writes are real.
    API_URL: LIVE.API_URL,
    GOOGLE_CLIENT_ID: LIVE.GOOGLE_CLIENT_ID,
    FIREBASE: LIVE.FIREBASE,
    VAPID_KEY: LIVE.VAPID_KEY
  };

  window.APP_CONFIG = isLocal ? LOCAL : LIVE;
  window.APP_CONFIG.isLocal = isLocal;

  if (isLocal) {
    var sameSheet = LOCAL.API_URL === LIVE.API_URL;
    console.log('%cThe 99 — local preview' + (sameSheet ? ' (LIVE data)' : ' (test data)'),
      'background:#3B2A1A;color:#D4A853;padding:3px 8px;border-radius:4px;font-weight:700');
    if (sameSheet) {
      console.warn('This preview writes to the REAL sheet. ' +
                   'Set LOCAL.API_URL in config.js to a test deployment first.');
    }
  }
})();
