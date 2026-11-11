import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const text = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('Android shell has a local Capacitor configuration and retains the /public service-worker layout', async () => {
  const config = JSON.parse(await text('capacitor.config.json'));
  assert.equal(config.webDir, 'android-web');
  assert.equal(config.server.hostname, 'localhost');
  assert.equal(config.server.androidScheme, 'https');
  assert.equal(config.android.allowMixedContent, false);
  assert.equal(Object.hasOwn(config.server, 'url'), false, 'a packaged shell must not load a remote server URL');

  const prepare = await text('scripts/prepare-android-web.mjs');
  for (const localAsset of ["'index.html'", "'shell-manifest.js'", "'sw.js'", "'public'"]) {
    assert.match(prepare, new RegExp(localAsset.replace(/[.]/g, '\\.'), 'u'));
  }
  assert.doesNotMatch(prepare, /https?:\/\//iu);
});

test('Android manifest accepts only text shares and native intake uses the existing local share query', async () => {
  const manifest = await text('android/app/src/main/AndroidManifest.xml');
  const activity = await text('android/app/src/main/java/org/effort/publicdemo/MainActivity.java');
  assert.match(manifest, /android:usesCleartextTraffic="false"/u);
  assert.match(manifest, /android:name="android\.intent\.action\.SEND"/u);
  assert.match(manifest, /android:mimeType="text\/plain"/u);
  assert.doesNotMatch(manifest, /android\.permission\.INTERNET/u);
  assert.match(activity, /Intent\.ACTION_SEND/u);
  assert.match(activity, /Intent\.EXTRA_TEXT/u);
  assert.match(activity, /https:\/\/localhost\/public\/\?share=/u);
  assert.match(activity, /substring\(0, 4000\)/u);
  assert.doesNotMatch(activity, /https?:\/\/(?!localhost)/u);
});

test('Android icon and splash resources derive their colors from the public favicon', async () => {
  const favicon = await text('public/favicon.svg');
  const colors = await text('android/app/src/main/res/values/colors.xml');
  const styles = await text('android/app/src/main/res/values/styles.xml');
  assert.match(favicon, /#0c0c0b/iu);
  assert.match(favicon, /#ece6d6/iu);
  assert.match(colors, /#0C0C0B/u);
  assert.match(colors, /#ECE6D6/u);
  assert.match(styles, /windowSplashScreenAnimatedIcon/u);
  assert.match(styles, /@drawable\/effort_mark/u);
});
