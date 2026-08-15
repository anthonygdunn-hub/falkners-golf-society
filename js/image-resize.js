/* ============================================================
   The Falkners Arms Golf Society - image resizing

   Phone cameras produce 4000px, 4MB photos. Uploading those raw
   makes members wait on mobile data, fills the storage bucket,
   and then makes every visitor download the full thing to show
   a 160px square in the gallery grid.

   So before uploading we make two versions in the browser:
     full  - 1600px long edge, for the lightbox
     thumb -  400px long edge, for the grid

   The thumbnail is stored at thumbs/<same path>. That is a
   convention, not a database column, so adding it needed no
   migration - but it does mean gallery.html works out the
   thumbnail location the same way, and the two must stay in step.

   If anything goes wrong (a HEIC the browser cannot decode, an
   odd colour profile, a very old browser) the original file is
   uploaded unchanged. A slow upload beats a failed one.
   ============================================================ */

window.ImageResize = (function () {
    "use strict";

                        /* Decode a File into something canvas can draw.
       imageOrientation "from-image" applies the EXIF rotation,
       which is what stops photos arriving sideways. */
                        async function decode(file) {
                              if (window.createImageBitmap) {
                                      try {
                                                return await createImageBitmap(file, { imageOrientation: "from-image" });
                                      } catch (e) {
                                                try {
                                                            return await createImageBitmap(file);
                                                } catch (e2) {
                                                            /* fall through to the <img> path */
                                                }
                                      }
                              }
                              return new Promise(function (resolve, reject) {
                                      var url = URL.createObjectURL(file);
                                      var img = new Image();
                                      img.onload = function () {
                                                URL.revokeObjectURL(url);
                                                resolve(img);
                                      };
                                      img.onerror = function () {
                                                URL.revokeObjectURL(url);
                                                reject(new Error("decode failed"));
                                      };
                                      img.src = url;
                              });
                        }

                        /* Draw at the target size and hand back a JPEG blob. */
                        function draw(source, maxEdge, quality) {
                              var w = source.width;
                              var h = source.height;
                              var scale = Math.min(1, maxEdge / Math.max(w, h));

      var canvas = document.createElement("canvas");
                              canvas.width = Math.round(w * scale);
                              canvas.height = Math.round(h * scale);

      var ctx = canvas.getContext("2d");
                              ctx.imageSmoothingQuality = "high";
                              ctx.fillStyle = "#ffffff";
                              ctx.fillRect(0, 0, canvas.width, canvas.height);
                              ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

      return new Promise(function (resolve) {
              canvas.toBlob(function (blob) { resolve(blob); }, "image/jpeg", quality);
      });
                        }

                        /* Returns { full, thumb } as JPEG blobs, or null if we could not. */
                        async function resize(file, opts) {
                              opts = opts || {};
                              var fullEdge = opts.fullEdge || 1600;
                              var thumbEdge = opts.thumbEdge || 400;

      try {
              var source = await decode(file);
              var full = await draw(source, fullEdge, 0.82);
              var thumb = await draw(source, thumbEdge, 0.72);
              if (source.close) source.close();
              if (!full || !thumb) return null;
              if (full.size >= file.size) full = file;
              return { full: full, thumb: thumb };
      } catch (err) {
              console.warn("Could not resize " + file.name + ", using the original.", err);
              return null;
      }
                        }

                        /* Upload a photo and its thumbnail. Same shape of return value as
       supabase storage upload, so the caller only checks .error. */
                        async function uploadPhoto(client, bucket, path, file) {
                              var sized = await resize(file);
                              var body = sized ? sized.full : file;
                              var type = body.type || file.type || "image/jpeg";

      var res = await client.storage.from(bucket).upload(path, body, { contentType: type });
                              if (res.error) return res;

      /* A missing thumbnail is not fatal - the gallery falls back to
                                 the full photo - so a failure here is logged, not returned. */
      if (sized) {
              var thumbRes = await client.storage.from(bucket).upload("thumbs/" + path, sized.thumb, { contentType: "image/jpeg" });
              if (thumbRes.error) {
                        console.warn("Thumbnail failed for " + file.name, thumbRes.error.message);
              }
      }
                              return res;
                        }

                        return { resize: resize, uploadPhoto: uploadPhoto };
})();
