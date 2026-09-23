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
    GOOGLE_CLIENT_ID: '85459451769-pperaup23gefg3etlk2u0q62dve2vp1l.apps.googleusercontent.com'
  };

  var LOCAL = {
    // Point this at a SECOND Apps Script deployment attached to a COPY of the
    // spreadsheet, and anything you log while testing lands in the copy instead
    // of the ministry's real sheet. Until you set one up it stays on LIVE,
    // which is fine for looking at layout but means test writes are real.
    API_URL: LIVE.API_URL,
    GOOGLE_CLIENT_ID: LIVE.GOOGLE_CLIENT_ID
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
