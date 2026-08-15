/* Tabs for the two leaderboard tables.

   Both tables want the full width - the prize table has eight prize
   columns plus a total - so they are shown one at a time rather than
   side by side. Side by side would force the prize table to scroll
   sideways on a laptop and stack anyway on a phone.

   The markup is left alone: this finds the two cards by their heading
   and hides one. If the script never runs both tables are still on
   the page, stacked, which is a sensible fallback. */

(function () {
    "use strict";

   function cardFor(headingText) {
         var heads = document.querySelectorAll(".scorecard-head h3");
         for (var i = 0; i < heads.length; i++) {
                 if (heads[i].textContent.trim() === headingText) {
                           return heads[i].closest(".scorecard");
                 }
         }
         return null;
   }

   function init() {
         var roundsCard = cardFor("Season Rounds Standings");
         var prizeCard = cardFor("Season Prize Standings");
         if (!roundsCard || !prizeCard) return;

      var roundsNote = document.getElementById("lb-rule");
         var prizeNote = prizeCard.nextElementSibling;
         if (prizeNote && prizeNote.tagName !== "P") prizeNote = null;

      var bar = document.createElement("div");
         bar.className = "fixtures-actions";
         bar.style.marginTop = "24px";

      var roundsBtn = document.createElement("button");
         roundsBtn.type = "button";
         roundsBtn.textContent = "Rounds";

      var prizeBtn = document.createElement("button");
         prizeBtn.type = "button";
         prizeBtn.textContent = "Prizes";

      bar.appendChild(roundsBtn);
         bar.appendChild(prizeBtn);
         roundsCard.parentNode.insertBefore(bar, roundsCard);

      function show(which) {
              var rounds = which === "rounds";
              roundsCard.style.display = rounds ? "" : "none";
              prizeCard.style.display = rounds ? "none" : "";
              if (roundsNote) roundsNote.style.display = rounds ? "" : "none";
              if (prizeNote) prizeNote.style.display = rounds ? "none" : "";
              roundsBtn.className = rounds ? "btn btn-brass" : "btn btn-outline";
              prizeBtn.className = rounds ? "btn btn-outline" : "btn btn-brass";
              roundsBtn.setAttribute("aria-pressed", rounds ? "true" : "false");
              prizeBtn.setAttribute("aria-pressed", rounds ? "false" : "true");
      }

      roundsBtn.addEventListener("click", function () { show("rounds"); });
         prizeBtn.addEventListener("click", function () { show("prizes"); });

      show("rounds");
   }

   if (document.readyState === "loading") {
         document.addEventListener("DOMContentLoaded", init);
   } else {
         init();
   }
})();
