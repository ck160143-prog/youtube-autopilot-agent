"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { inspectYoutubeOAuthConfig, describeOAuthFailure } = require("../youtubeOAuthConfig");

const validEnv = {
  YOUTUBE_CLIENT_ID: "1234567890-example.apps.googleusercontent.com",
  YOUTUBE_CLIENT_SECRET: "test-secret",
  YOUTUBE_REDIRECT_URI: "https://youtube-autopilot-agent.onrender.com/api/youtube/callback",
  APP_SESSION_SECRET: "x".repeat(40)
};

test("reports configured OAuth without exposing secret values", () => {
  const result = inspectYoutubeOAuthConfig(validEnv, "https://youtube-autopilot-agent.onrender.com");
  assert.equal(result.configured, true);
  assert.equal(result.clientIdFormatValid, true);
  assert.equal(result.redirectUriMatchesService, true);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
});

test("detects missing client and short session secret", () => {
  const result = inspectYoutubeOAuthConfig({ ...validEnv, YOUTUBE_CLIENT_ID: "", APP_SESSION_SECRET: "short" });
  assert.equal(result.configured, false);
  assert.equal(result.clientIdPresent, false);
  assert.equal(result.sessionSecretLengthValid, false);
});

test("detects a redirect URI mismatch against the Render service URL", () => {
  const result = inspectYoutubeOAuthConfig(validEnv, "https://another-service.onrender.com");
  assert.equal(result.redirectUriMatchesService, false);
});

test("gives a useful invalid_client diagnosis without credentials", () => {
  assert.match(describeOAuthFailure("invalid_client"), /Google Cloud Console/);
  assert.doesNotMatch(describeOAuthFailure("invalid_client"), /test-secret/);
});

test("explains redirect_uri_mismatch separately", () => {
  assert.match(describeOAuthFailure("redirect_uri_mismatch"), /Authorized redirect URI/);
});
