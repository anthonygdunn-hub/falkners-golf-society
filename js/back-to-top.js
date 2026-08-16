/* Back to top.

   Several pages are long now - the fixtures list, the members
      directory, the admin page - and getting back to the navigation meant
         a lot of scrolling, especially on a phone.

            The button sits centred at the bottom of the window, fades in once
               you have scrolled a little way, and stays there for the whole scroll
                  so it is always one tap away. It is hidden at the very top where it
                     would only be in the way.

                        Everything is injected from here, so no page markup or stylesheet
                           needs to change. */

                           (function () {
                             "use strict";

                               if (window.__fgsBackToTop) return;
                                 window.__fgsBackToTop = true;

                                   var SHOW_AFTER = 200;

                                     function build() {
                                         if (document.getElementById("back-to-top")) return;
                                             if (!document.body) return;

                                                 var css = document.createElement("style");
                                                     css.textContent = "#back-to-top{position:fixed;left:50%;transform:translateX(-50%) translateY(8px);bottom:calc(16px + env(safe-area-inset-bottom, 0px));z-index:60;display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:var(--navy, #1B3A6C);color:#fff;font-family:var(--font-display, inherit);font-size:13px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;box-shadow:0 6px 18px rgba(16,35,63,.28);opacity:0;pointer-events:none;transition:opacity .18s ease, transform .18s ease;}"
                                                           + "#back-to-top.is-visible{opacity:1;pointer-events:auto;transform:translateX(-50%) translateY(0);}"
                                                                 + "#back-to-top:hover{background:var(--navy-dark, #10233F);}"
                                                                       + "#back-to-top:focus-visible{outline:2px solid var(--gold, #B8923C);outline-offset:3px;}"
                                                                             + "@media (max-width:640px){#back-to-top{font-size:12px;padding:9px 16px;bottom:calc(12px + env(safe-area-inset-bottom, 0px));}}"
                                                                                   + "@media (prefers-reduced-motion:reduce){#back-to-top{transition:none;}}";
                                                                                       document.head.appendChild(css);

                                                                                           var btn = document.createElement("button");
                                                                                               btn.id = "back-to-top";
                                                                                                   btn.type = "button";
                                                                                                       btn.setAttribute("aria-label", "Back to the top of the page");
                                                                                                           btn.innerHTML = '<span aria-hidden="true">&uarr;</span><span>Top</span>';
                                                                                                           
                                                                                                               btn.addEventListener("click", function () {
                                                                                                                     var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
                                                                                                                           window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
                                                                                                                               });
                                                                                                                               
                                                                                                                                   document.body.appendChild(btn);
                                                                                                                                   
                                                                                                                                       var ticking = false;
                                                                                                                                           function update() {
                                                                                                                                                 var y = window.pageYOffset || document.documentElement.scrollTop || 0;
                                                                                                                                                       if (y > SHOW_AFTER) { btn.classList.add("is-visible"); } else { btn.classList.remove("is-visible"); }
                                                                                                                                                             ticking = false;
                                                                                                                                                                 }
                                                                                                                                                                 
                                                                                                                                                                     window.addEventListener("scroll", function () {
                                                                                                                                                                           if (ticking) return;
                                                                                                                                                                                 ticking = true;
                                                                                                                                                                                       window.requestAnimationFrame(update);
                                                                                                                                                                                           }, { passive: true });
                                                                                                                                                                                           
                                                                                                                                                                                               window.addEventListener("resize", update, { passive: true });
                                                                                                                                                                                                   update();
                                                                                                                                                                                                     }
                                                                                                                                                                                                     
                                                                                                                                                                                                       if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", build); } else { build(); }
                                                                                                                                                                                                       })();
                                                                                                                                                                                                       
