//
// Copyright 2022 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
//

/* eslint-disable no-console */

const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const tar = require('tar');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { URL: NodeURL } = require('url');

let config;
let VERSION;

// When installing from the registry, `npm` doesn't set `npm_package_config_*`
// environment variables. However, unlike `yarn`, `npm` always provides a path
// to the `package.json` so we can read `config` from it.
if (process.env.npm_package_json) {
  const json = fs.readFileSync(process.env.npm_package_json, {
    encoding: 'utf8',
  });

  const pkg = JSON.parse(json);
  config = pkg.config;
  VERSION = pkg.version;
} else {
  config = {
    prebuildUrl: process.env.npm_package_config_prebuildUrl,
    prebuildChecksum: process.env.npm_package_config_prebuildChecksum,
  };
  VERSION = process.env.npm_package_version;
}

const PREBUILD_URL = config.prebuildUrl.replaceAll(
  '${npm_package_version}', // eslint-disable-line no-template-curly-in-string
  VERSION
);
const HASH = config.prebuildChecksum;

const tmpFile = path.join(__dirname, 'unverified-prebuild.tmp');
const finalFile = path.join(__dirname, 'prebuild.tar.gz');

async function main() {
  if (!HASH) {
    console.log('(no checksum provided; assuming local build)');
    process.exit(0);
  }

  await downloadIfNeeded();
  console.log('extracting...');
  await tar.extract({ file: finalFile, onwarn: process.emitWarning });
}

async function downloadIfNeeded() {
  if (fs.statSync(finalFile, { throwIfNoEntry: false })) {
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(finalFile), hash);
    if (hash.digest('hex') === HASH) {
      console.log('local build artifact is up-to-date');
      return;
    }

    console.log('local build artifact is outdated');
  }
  await download();
}

function download(url = PREBUILD_URL) {
  console.log(`downloading ${url}`);
  return new Promise((resolve, reject) => {
    let options = {};
    if (process.env.HTTPS_PROXY != undefined) {
      options.agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);
    }

    // Parse URL if it's a string
    const parsedUrl = typeof url === 'string' ? new NodeURL(url) : url;

    https.get(parsedUrl, options, async res => {
      try {
        // Handle redirects (GitHub releases use 302 redirects)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          console.log(`following redirect to ${res.headers.location}`);
          resolve(download(res.headers.location));
          return;
        }

        if (res.statusCode !== 200) {
          throw new Error(`HTTP error: ${res.statusCode} ${res.statusMessage}`);
        }

        const out = fs.createWriteStream(tmpFile);

        const hash = crypto.createHash('sha256');

        const t = new Transform({
          transform(chunk, encoding, callback) {
            hash.write(chunk, encoding);
            callback(null, chunk);
          },
        });

        await pipeline(res, t, out);

        const actualDigest = hash.digest('hex');
        if (actualDigest !== HASH) {
          fs.unlinkSync(tmpFile);
          throw new Error(
            `Digest mismatch. Expected ${HASH} got ${actualDigest}`
          );
        }

        fs.renameSync(tmpFile, finalFile);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

main();
