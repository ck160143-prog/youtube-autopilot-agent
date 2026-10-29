"use strict";

function inspectYoutubeOAuthConfig(env = {}, externalUrl = "") {
  const clientId = String(env.YOUTUBE_CLIENT_ID || "").trim();
  const clientSecret = String(env.YOUTUBE_CLIENT_SECRET || "").trim();
  const redirectUri = String(env.YOUTUBE_REDIRECT_URI || "").trim();
  const sessionSecret = String(env.APP_SESSION_SECRET || "");
  let redirectUriMatchesService = null;

  if (externalUrl && redirectUri) {
    try {
      const expected = new URL("/api/youtube/callback", externalUrl).toString();
      redirectUriMatchesService = redirectUri === expected;
    } catch (_) {
      redirectUriMatchesService = false;
    }
  }

  const clientIdFormatValid = /^[0-9]+-[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(clientId);
  const sessionSecretLengthValid = sessionSecret.length >= 32;
  const configured = Boolean(clientId && clientSecret && redirectUri && sessionSecretLengthValid);

  return {
    configured,
    clientIdPresent: Boolean(clientId),
    clientIdFormatValid,
    clientSecretPresent: Boolean(clientSecret),
    redirectUriPresent: Boolean(redirectUri),
    redirectUriMatchesService,
    sessionSecretPresent: Boolean(sessionSecret),
    sessionSecretLengthValid
  };
}

function describeOAuthFailure(code) {
  switch (String(code || "").toLowerCase()) {
    case "invalid_client":
      return "Google OAuth ने invalid_client लौटाया। Google Cloud Console में सही project का Web application Client ID/Secret जाँचें; यह अक्सर गलत, हटाए गए या दूसरे project के client से होता है। Client ID को Render में बिना अतिरिक्त spaces के रखें।";
    case "redirect_uri_mismatch":
      return "Google OAuth redirect_uri_mismatch: Render के YOUTUBE_REDIRECT_URI और Google Cloud के Authorized redirect URI में अक्षर-दर-अक्षर समानता रखें।";
    case "invalid_grant":
      return "Google OAuth invalid_grant: authorization code expire/दोबारा इस्तेमाल हुआ या redirect URI/client मेल नहीं खा रहे। BABA AI से Connect दोबारा शुरू करें और URI जाँचें।";
    case "access_denied":
      return "Google account ने YouTube OAuth अनुमति नहीं दी। Connect दोबारा करके अनुमति स्वीकार करें।";
    case "token_exchange_failed":
      return "Google OAuth token exchange विफल हुआ। Render में Client ID/Secret और exact redirect URI जाँचें; Logs में secret/token साझा न करें।";
    default:
      return "Google OAuth पूरा नहीं हुआ (" + String(code || "unknown").slice(0, 80) + "). Google Cloud OAuth Client और exact redirect URI जाँचें।";
  }
}

module.exports = { inspectYoutubeOAuthConfig, describeOAuthFailure };
