/* ============================================================
   The Falkners Arms Golf Society — gallery lightbox
   Drop-in. No dependencies, no build step.

   Works with photos injected after page load (Supabase),
   because it delegates clicks from the document rather than
   binding to images that may not exist yet.
   ============================================================ */

(function () {
    "use strict";

   var THUMB = ".gallery-item img";

   var lb, imgEl, capEl, byEl, roundEl, countEl, prevBtn, nextBtn, closeBtn;
    var photos = [];
    var index = 0;
    var lastFocused = null;

   /* ---------- build the overlay once ---------- */

   function build() {
         lb = document.createElement("div");
         lb.className = "lb";
         lb.setAttribute("role", "dialog");
         lb.setAttribute("aria-modal", "true");
         lb.setAttribute("aria-label", "Photo viewer");
         lb.hidden = true;

      lb.innerHTML =
              '<figure class="lb__stage">' +
              '<img class="lb__img" alt="">' +
              '<figcaption class="lb__meta">' +
              '<span class="lb__round"></span>' +
              '<span class="lb__cap"></span>' +
              '<small class="lb__by"></small>' +
              "</figcaption>" +
              "</figure>" +
              '<button type="button" class="lb__btn lb__prev" aria-label="Previous photo">&#8249;</button>' +
              '<button type="button" class="lb__btn lb__next" aria-label="Next photo">&#8250;</button>' +
              '<button type="button" class="lb__btn lb__close" aria-label="Close viewer">&times;</button>' +
              '<span class="lb__count"></span>';

      document.body.appendChild(lb);

      imgEl = lb.querySelector(".lb__img");
         capEl = lb.querySelector(".lb__cap");
         byEl = lb.querySelector(".lb__by");
         roundEl = lb.querySelector(".lb__round");
         countEl = lb.querySelector(".lb__count");
         prevBtn = lb.querySelector(".lb__prev");
         nextBtn = lb.querySelector(".lb__next");
         closeBtn = lb.querySelector(".lb__close");

      prevBtn.addEventListener("click", function (e) {
              e.stopPropagation();
              step(-1);
      });
         nextBtn.addEventListener("click", function (e) {
                 e.stopPropagation();
                 step(1);
         });
         closeBtn.addEventListener("click", function (e) {
                 e.stopPropagation();
                 close();
         });

      // click the dark surround (not the photo) to close
      lb.addEventListener("click", function (e) {
              if (e.target === lb || e.target.classList.contains("lb__stage")) close();
      });

      // swipe on phones
      var startX = null;
         lb.addEventListener(
                 "touchstart",
                 function (e) {
                           startX = e.changedTouches[0].clientX;
                 },
           { passive: true },
               );
         lb.addEventListener(
                 "touchend",
                 function (e) {
                           if (startX === null) return;
                           var dx = e.changedTouches[0].clientX - startX;
                           if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
                           startX = null;
                 },
           { passive: true },
               );
   }

   /* ---------- read details off a thumbnail ---------- */

   function detailsFor(img) {
         var item = img.closest(".gallery-item");
         var card = img.closest(".scorecard");
         var small = item ? item.querySelector(".gallery-caption small") : null;
         var head = card ? card.querySelector(".scorecard-head h3") : null;

      return {
              src: img.dataset.full || img.currentSrc || img.src,
              caption: img.alt || "",
              by: small ? small.textContent.trim() : "",
              round: head ? head.textContent.trim() : "",
      };
   }

   function collect() {
         photos = Array.prototype.slice.call(document.querySelectorAll(THUMB));
   }

   /* ---------- show / open / close / step ---------- */

   function show(i) {
         index = i;
         var d = detailsFor(photos[i]);

      imgEl.src = d.src;
         imgEl.alt = d.caption;
         capEl.textContent = d.caption;
         byEl.textContent = d.by;
         roundEl.textContent = d.round;
         countEl.textContent = i + 1 + " / " + photos.length;

      capEl.hidden = !d.caption;
         byEl.hidden = !d.by;
         roundEl.hidden = !d.round;

      // only one photo? hide the arrows entirely
      var solo = photos.length < 2;
         prevBtn.hidden = solo;
         nextBtn.hidden = solo;
         countEl.hidden = solo;

      preload(i + 1);
         preload(i - 1);
   }

   function preload(i) {
         if (i < 0 || i >= photos.length) return;
         var p = new Image();
         var t = photos[i];
         p.src = t.dataset.full || t.src;
   }

   function open(img) {
         collect();
         var i = photos.indexOf(img);
         if (i === -1) return;

      lastFocused = document.activeElement;
         lb.hidden = false;
         // next frame, so the fade-in actually runs
      requestAnimationFrame(function () {
              lb.classList.add("is-open");
      });
         document.body.classList.add("lb-lock");
         show(i);
         closeBtn.focus();
   }

   function close() {
         lb.classList.remove("is-open");
         lb.hidden = true;
         document.body.classList.remove("lb-lock");
         imgEl.removeAttribute("src");
         if (lastFocused && lastFocused.focus) lastFocused.focus();
   }

   function step(dir) {
         if (photos.length < 2) return;
         var next = (index + dir + photos.length) % photos.length; // wraps around
      show(next);
   }

   /* ---------- wiring ---------- */

   function init() {
         build();

      // delegated: survives photos being added later by the Supabase fetch
      document.addEventListener("click", function (e) {
              var img = e.target.closest ? e.target.closest(THUMB) : null;
              if (img) {
                        e.preventDefault();
                        open(img);
              }
      });

      document.addEventListener("keydown", function (e) {
              // Enter / Space on a focused thumbnail
                                      var img = e.target.closest ? e.target.closest(THUMB) : null;
              if (img && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault();
                        open(img);
                        return;
              }
              if (lb.hidden) return;
              if (e.key === "Escape") close();
              if (e.key === "ArrowRight") step(1);
              if (e.key === "ArrowLeft") step(-1);
      });

      // make thumbnails focusable as they appear
      var mark = function () {
              document.querySelectorAll(THUMB).forEach(function (img) {
                        if (img.dataset.lbReady) return;
                        img.dataset.lbReady = "1";
                        img.tabIndex = 0;
                        img.setAttribute("role", "button");
                        if (!img.getAttribute("aria-label")) {
                                    img.setAttribute(
                                                  "aria-label",
                                                  img.alt ? "View photo: " + img.alt : "View photo",
                                                );
                        }
              });
      };
         mark();
         new MutationObserver(mark).observe(document.body, {
                 childList: true,
                 subtree: true,
         });
   }

   if (document.readyState === "loading") {
         document.addEventListener("DOMContentLoaded", init);
   } else {
         init();
   }
})();
