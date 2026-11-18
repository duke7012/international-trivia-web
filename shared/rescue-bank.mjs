// The question banks for the rescue games. Flags live in public/flags/{iso2}.png and
// country outlines in server/rescue-outlines.mjs; scripts/fetch-rescue-assets.mjs rebuilds both
// from this file.

const c = (name, iso2, iso3) => ({ name, iso2, iso3 });

// Say on the beat, in the style of the "say the word on beat" flag videos: three levels, each
// five rounds of eight flags drawn from two or three look-alike countries with short names.
// Each set is one rescue game: easy, medium, hard.
export const BEAT_SETS = [
  { id: "a", levels: [
    [c("Japan", "jp"), c("Bangladesh", "bd"), c("Korea", "kr")],
    [c("Ireland", "ie"), c("Italy", "it"), c("Ivory Coast", "ci")],
    [c("Chad", "td"), c("Romania", "ro"), c("Andorra", "ad")],
  ] },
  { id: "b", levels: [
    [c("France", "fr"), c("Russia", "ru"), c("Netherlands", "nl")],
    [c("Poland", "pl"), c("Monaco", "mc"), c("Indonesia", "id")],
    [c("Senegal", "sn"), c("Mali", "ml"), c("Guinea", "gn")],
  ] },
  { id: "c", levels: [
    [c("China", "cn"), c("Vietnam", "vn"), c("Turkey", "tr")],
    [c("Norway", "no"), c("Iceland", "is"), c("Denmark", "dk")],
    [c("Colombia", "co"), c("Ecuador", "ec"), c("Venezuela", "ve")],
  ] },
  { id: "d", levels: [
    [c("Germany", "de"), c("Belgium", "be"), c("Spain", "es")],
    [c("Australia", "au"), c("New Zealand", "nz"), c("Fiji", "fj")],
    [c("Slovenia", "si"), c("Slovakia", "sk"), c("Serbia", "rs")],
  ] },
];
export const BEAT_LEVEL_NAMES = ["Easy", "Medium", "Hard"];
export const BEAT_ROUNDS = 5;

// The five rounds of one level, mixing more as they go: round 1 is seven of the first flag and one
// of the second, the third look-alike joins in round 3, and round 5 shows no names.
const MIX = [[7, 1, 0], [4, 4, 0], [3, 2, 3], [3, 3, 2], [3, 3, 2]];
export function beatRounds(trio, random) {
  return MIX.map(([a, b, cc], r) => {
    const cells = [...Array(a).fill(trio[0]), ...Array(b).fill(trio[1]), ...Array(cc).fill(trio[2] || trio[1])];
    for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
    return cells.map((f) => ({ name: f.name, iso2: f.iso2, ...(r === BEAT_ROUNDS - 1 && { hidden: true }) }));
  });
}

// The music: the host's "Say on the beat music" sound, cut from the original flag video. Every
// level is its own stretch of that one file: step 0 of level L sits at `levels[L]` seconds in.
// Each round is 16 steps (8 to look, 8 to say on the beat); one step is an eighth note.
export const BEAT_TRACK = { stepMs: 364.25, leadMs: 2000, levels: [3.101, 36.981, 70.860] };
export const BEAT_STEPS = BEAT_ROUNDS * 16;

// Guess the doodle: countries with shapes people know, by difficulty.
// crop: [west, south, east, north] keeps only the part of a country people picture.
const d = (name, iso2, iso3, level, crop) => ({ name, iso2, iso3, level, ...(crop && { crop }) });
export const DOODLES = [
  d("Italy", "it", "ITA", "easy"), d("Chile", "cl", "CHL", "easy", [-76, -56, -66, -17]), d("Japan", "jp", "JPN", "easy", [128, 30, 146, 46]),
  d("Brazil", "br", "BRA", "easy"), d("Australia", "au", "AUS", "easy", [112, -44, 154, -10]), d("India", "in", "IND", "easy", [68, 6, 98, 37]),
  d("United Kingdom", "gb", "GBR", "easy", [-9, 49.8, 2, 61]), d("France", "fr", "FRA", "easy", [-5.5, 41, 10, 51.5]),
  d("United States", "us", "USA", "easy", [-125, 24, -66, 50]), d("Mexico", "mx", "MEX", "easy"), d("Spain", "es", "ESP", "easy", [-10, 35.8, 4.5, 44]),
  d("New Zealand", "nz", "NZL", "easy", [166, -47.5, 179, -34]),
  d("Greece", "gr", "GRC", "medium"), d("Norway", "no", "NOR", "medium", [4, 57.8, 31.5, 71.5]), d("Vietnam", "vn", "VNM", "medium", [102, 8, 110, 23.5]),
  d("South Korea", "kr", "KOR", "medium"), d("Argentina", "ar", "ARG", "medium", [-74, -55.2, -53, -21.7]), d("Egypt", "eg", "EGY", "medium"),
  d("Madagascar", "mg", "MDG", "medium"), d("Cuba", "cu", "CUB", "medium"), d("Ireland", "ie", "IRL", "medium"), d("Germany", "de", "DEU", "medium"),
  d("Turkey", "tr", "TUR", "medium"), d("Thailand", "th", "THA", "medium"), d("Sri Lanka", "lk", "LKA", "medium"), d("South Africa", "za", "ZAF", "medium", [16, -35, 33, -22]),
  d("Portugal", "pt", "PRT", "hard", [-9.6, 36.9, -6.1, 42.2]), d("Peru", "pe", "PER", "hard"), d("Saudi Arabia", "sa", "SAU", "hard"), d("Somalia", "so", "SOM", "hard"),
  d("Indonesia", "id", "IDN", "hard"), d("Philippines", "ph", "PHL", "hard"), d("Iceland", "is", "ISL", "hard"), d("Mongolia", "mn", "MNG", "hard"),
  d("Croatia", "hr", "HRV", "hard"), d("Nigeria", "ng", "NGA", "hard"), d("Iran", "ir", "IRN", "hard"), d("Ukraine", "ua", "UKR", "hard"),
  d("Malaysia", "my", "MYS", "hard"), d("Panama", "pa", "PAN", "hard"),
];
// How a doodle round of n countries is split by difficulty, easy first.
export const doodleMix = (n) => { const e = Math.round(n * 0.4), m = Math.round(n * 0.3); return { easy: e, medium: m, hard: Math.max(0, n - e - m) }; };

// Semantle: archived puzzles at semantle.com, played in this order unless the host edits the list.
export const SEMANTLE_PUZZLES = [1700, 1650, 1600, 1550, 1500, 1450, 1400, 1350, 1300, 1250];
export const semantleUrl = (n) => `https://semantle.com/archive/game?num=${n}`;
