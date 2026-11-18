// The question banks for the rescue games. Flags live in public/flags/{iso2}.svg (or .png) and
// country outlines in server/rescue-outlines.mjs; scripts/fetch-rescue-assets.mjs rebuilds both
// from this file.

const c = (name, iso2, iso3) => ({ name, iso2, iso3 });

// Say on the beat: each set is four levels of eight flags, easiest first, with names short enough
// to say on a beat. Level 5 is drawn from the same set's flags and shows no names.
export const BEAT_SETS = [
  { id: "a", levels: [
    [c("Japan", "jp"), c("Brazil", "br"), c("Canada", "ca"), c("France", "fr"), c("Italy", "it"), c("China", "cn"), c("India", "in"), c("Mexico", "mx")],
    [c("Spain", "es"), c("Germany", "de"), c("Greece", "gr"), c("Sweden", "se"), c("Turkey", "tr"), c("Egypt", "eg"), c("Chile", "cl"), c("Peru", "pe")],
    [c("Ghana", "gh"), c("Nepal", "np"), c("Cuba", "cu"), c("Kenya", "ke"), c("Iran", "ir"), c("Laos", "la"), c("Togo", "tg"), c("Chad", "td")],
    [c("Mali", "ml"), c("Oman", "om"), c("Fiji", "fj"), c("Iraq", "iq"), c("Benin", "bj"), c("Gabon", "ga"), c("Niger", "ne"), c("Yemen", "ye")],
  ] },
  { id: "b", levels: [
    [c("USA", "us"), c("UK", "gb"), c("Korea", "kr"), c("Australia", "au"), c("Russia", "ru"), c("Argentina", "ar"), c("Vietnam", "vn"), c("Thailand", "th")],
    [c("Norway", "no"), c("Finland", "fi"), c("Poland", "pl"), c("Ireland", "ie"), c("Israel", "il"), c("Morocco", "ma"), c("Jamaica", "jm"), c("Nigeria", "ng")],
    [c("Austria", "at"), c("Denmark", "dk"), c("Hungary", "hu"), c("Belgium", "be"), c("Bolivia", "bo"), c("Panama", "pa"), c("Qatar", "qa"), c("Syria", "sy")],
    [c("Malta", "mt"), c("Latvia", "lv"), c("Bhutan", "bt"), c("Tonga", "to"), c("Samoa", "ws"), c("Palau", "pw"), c("Nauru", "nr"), c("Haiti", "ht")],
  ] },
  { id: "c", levels: [
    [c("Portugal", "pt"), c("Switzerland", "ch"), c("Colombia", "co"), c("Philippines", "ph"), c("Indonesia", "id"), c("Pakistan", "pk"), c("Ukraine", "ua"), c("Singapore", "sg")],
    [c("Ethiopia", "et"), c("Romania", "ro"), c("Croatia", "hr"), c("Serbia", "rs"), c("Lebanon", "lb"), c("Kuwait", "kw"), c("Uruguay", "uy"), c("Ecuador", "ec")],
    [c("Estonia", "ee"), c("Rwanda", "rw"), c("Uganda", "ug"), c("Sudan", "sd"), c("Libya", "ly"), c("Jordan", "jo"), c("Angola", "ao"), c("Brunei", "bn")],
    [c("Guyana", "gy"), c("Belize", "bz"), c("Malawi", "mw"), c("Zambia", "zm"), c("Lesotho", "ls"), c("Mongolia", "mn"), c("Eritrea", "er"), c("Djibouti", "dj")],
  ] },
];
export const BEAT_BPM = [90, 100, 110, 120, 130];

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
