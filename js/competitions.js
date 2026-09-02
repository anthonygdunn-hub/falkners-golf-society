/* The on-the-day competitions, in one place.

   A round can run any of six side competitions. Which ones are on is
   decided per round by the committee on the admin page, simply by
   typing the hole they are played on: a hole number means the
   competition runs that round, blank means it does not. There is no
   separate on-off tick, so a competition can never be switched on
   without saying where it is played.

   Each competition has two columns behind it. The hole lives on the
   events row, because it is part of setting the fixture up. The winner
   lives on the event_prizes row, because it is filled in afterwards
   with the rest of the prizes. Keeping the list here means the admin
   form, the fixture page, the results page and the honours table all
   read from the same definition and cannot drift apart. */

window.ROUND_COMPETITIONS = [
  { id: "ld-front",   hole: "ld_front_hole",   winner: "longest_drive_front", label: "Longest drive", nine: "front 9",  short: "LD F9",    title: "Longest drive, front nine" },
  { id: "ld-back",    hole: "ld_back_hole",    winner: "longest_drive_back",  label: "Longest drive", nine: "back 9",   short: "LD B9",    title: "Longest drive, back nine" },
  { id: "np-front",   hole: "ntp_front_hole",  winner: "nearest_pin_front",   label: "Nearest the pin", nine: "front 9", short: "NTP F9",  title: "Nearest the pin, front nine" },
  { id: "np-back",    hole: "ntp_back_hole",   winner: "nearest_pin_back",    label: "Nearest the pin", nine: "back 9",  short: "NTP B9",  title: "Nearest the pin, back nine" },
  { id: "np2-front",  hole: "ntp2_front_hole", winner: "nearest_pin2_front",  label: "Nearest the pin in 2", nine: "front 9", short: "NTP2 F9", title: "Nearest the pin in two, front nine" },
  { id: "np2-back",   hole: "ntp2_back_hole",  winner: "nearest_pin2_back",   label: "Nearest the pin in 2", nine: "back 9",  short: "NTP2 B9", title: "Nearest the pin in two, back nine" }
];

/* "Nearest the pin in 2 - back 9", the name as a person would say it. */
window.competitionName = function (comp) {
  return comp.label + " - " + comp.nine;
};

/* A hole counts only if it is a whole number from 1 to 18. Anything
   else is treated as not set, so a stray character cannot switch a
   competition on. */
window.competitionHole = function (event, comp) {
  if (!event) return null;
  var n = parseInt(event[comp.hole], 10);
  return (n >= 1 && n <= 18) ? n : null;
};

/* The competitions this round is running, in list order. */
window.competitionsOn = function (event) {
  return window.ROUND_COMPETITIONS.filter(function (c) {
    return window.competitionHole(event, c) !== null;
  });
};
