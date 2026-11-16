/**
 * The countries a picker can offer (#156).
 *
 * THE LIST LIVES HERE because nothing hands it over. The API validates a
 * country as `/^[A-Z]{2}$/` and has no endpoint listing them
 * (farhand-api/src/schemas/common.ts), and no browser exposes the set of
 * region codes either — `Intl.supportedValuesOf` covers calendars,
 * currencies, collations, numbering systems, time zones and units, and not
 * regions. So: our codes, their names.
 *
 * `Intl.DisplayNames` is still worth having for the second half. It names
 * each code in the reader's own language and keeps a renaming out of our
 * hands, which is a thing countries do.
 *
 * Every officially assigned alpha-2 code, including the handful nobody lives
 * in. Leaving those out would mean deciding which places count, and the
 * reason to include them is smaller than that: somebody will one day post a
 * need from a research station, and nobody will have to ship a release.
 */
const CODES =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
  "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
  "DE DJ DK DM DO DZ " +
  "EC EE EG EH ER ES ET " +
  "FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
  "HK HM HN HR HT HU " +
  "ID IE IL IM IN IO IQ IR IS IT " +
  "JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ " +
  "LA LB LC LI LK LR LS LT LU LV LY " +
  "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ " +
  "OM " +
  "PA PE PF PG PH PK PL PM PN PR PS PT PW PY " +
  "QA " +
  "RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ " +
  "TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ " +
  "UA UG UM US UY UZ " +
  "VA VC VE VG VI VN VU " +
  "WF WS " +
  "YE YT " +
  "ZA ZM ZW";

export const COUNTRY_CODES: readonly string[] = CODES.split(" ");

export interface Country {
  code: string;
  name: string;
}

/**
 * The list, named and sorted for a reader.
 *
 * Sorted with `Intl.Collator` rather than `<`, which would put "Åland" after
 * "Zimbabwe" in any language that does not think so.
 *
 * `Intl.DisplayNames` is in every browser this app supports, but it is also
 * the kind of API a locale can decline to know a code in: when it does, it
 * returns the code itself, which is a worse label and not a broken one.
 */
export function countries(locale = "en"): Country[] {
  let naming: Intl.DisplayNames | null = null;

  try {
    naming = new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    naming = null;
  }

  const named = COUNTRY_CODES.map((code) => ({
    code,
    name: naming?.of(code) ?? code,
  }));

  const collator = new Intl.Collator(locale);

  return named.sort((a, b) => collator.compare(a.name, b.name));
}
