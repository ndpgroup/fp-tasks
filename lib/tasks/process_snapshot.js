/*eslint camelcase:0*/
"use strict";

const assert = require("assert"),
  fs = require("fs"),
  url = require("url"),
  util = require("util");

const async = require("async"),
  AWS = require("aws-sdk"),
  env = require("require-env"),
  raven = require("raven"),
  request = require("request"),
  tmp = require("tmp");

const spawn = require("../spawn");

const sentry = new raven.Client();

const S3_BUCKET_NAME = env.require("S3_BUCKET_NAME");

AWS.config.update({
  region: process.env.AWS_DEFAULT_REGION || "us-east-1"
});

const S3 = new AWS.S3();

const download = function download(imageUrl, filename, callback) {
  const uri = url.parse(imageUrl);
  let imageStream;

  if (uri.hostname.match(/.+\.s3.*\.amazonaws\.com/)) {
    // use aws-sdk so we can include credentials when fetching
    const pathname = decodeURIComponent(uri.pathname),
      bucket = uri.hostname.split(".")[0],
      key = pathname.split("/").slice(1).join("/");

    imageStream = S3.getObject({
      Bucket: bucket,
      Key: key
    }).createReadStream();
  } else {
    // assume that it's publicly available on the internet
    imageStream = request(uri);
  }

  imageStream.on("error", callback);

  imageStream.pipe(fs.createWriteStream(filename)
                   .on("finish", callback)
                   .on("error", callback));
};

module.exports = function processSnapshot(payload, callback) {
  const snapshot = payload.snapshot;

  return async.parallel({
    source: async.apply(tmp.tmpName),
    tiff: async.apply(tmp.tmpName)
  }, function(err, filenames) {
    if (err) {
      return callback(err);
    }

    const filename = filenames.source,
      tiffName = filenames.tiff;

    return async.waterfall([
      async.apply(download, snapshot.image_url, filename),
      function(done) {
        // TODO this probably exits with 0 even if it fails
        const child = spawn("process_snapshot.py", [], {
          timeout: 120e3
        });

        child.on("exit", function(code, signal) {
          if (code === 0) {
            return done();
          }

          if (signal) {
            return done(new Error(util.format("process_snapshot.py was killed by %s", signal)));
          }

          return done(new Error(util.format("process_snapshot.py exited with %s", code)));
        });

        child.stderr.pipe(process.stdout);

        fs.createReadStream(filename).pipe(child.stdin);
        child.stdout.pipe(fs.createWriteStream(tiffName));
      },
      function(done) {
        return S3.upload({
          Bucket: S3_BUCKET_NAME,
          Key: util.format("snapshots/%s/field-paper-%s.tiff", snapshot.slug, snapshot.slug),
          ACL: "public-read",
          CacheControl: "public,max-age=31536000",
          ContentType: "image/tiff",
          Body: fs.createReadStream(tiffName)
        }, function(err, data) {
          if (err) {
            return done(err);
          }

          return done(null, decodeURIComponent(data.Location));
        });
      }
    ], function(err, geoTiffUrl) {
      // remove the tmp files
      fs.unlink(filename);
      fs.unlink(tiffName);

      const responsePayload = {
        task: payload.task,
        snapshot: {
          slug: snapshot.slug
        }
      };

      if (err) {
        console.warn(err.stack);
        sentry.captureError(err);

        responsePayload.error = {
          message: err.message,
          stack: err.stack
        };
      } else {
        responsePayload.snapshot.geotiff_url = geoTiffUrl;
      }

      return callback(null, responsePayload);
    });
  });
};

module.exports.validate = function validate(payload) {
  assert.ok(payload.snapshot, "Payload must include a 'snapshot'.");
  assert.ok(payload.snapshot.slug, "Payload must include 'snapshot.slug'.");
  assert.ok(payload.snapshot.image_url, "Payload must include 'snapshot.image_url'.");
};
