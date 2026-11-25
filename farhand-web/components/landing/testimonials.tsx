/**
 * "From people who've done it" — cut in #168, built to the design in #172.
 *
 * WHY IT WAS CUT AND WHY IT IS BACK. #168 removed this section because three
 * five-star quotes with names, on a product nobody had used, are invented
 * reviews however they were meant. It is back because Ksenia wants the shape
 * of the section on the page: it is a portfolio project, the layout is part
 * of the work, and a page that explains a marketplace without ever showing
 * what a finished deal sounds like is missing something real.
 *
 * WHAT IS DIFFERENT THIS TIME IS THE LINE UNDER THE HEADING, and it is the
 * only thing standing between this section and a fake review. Farhand is
 * reachable by anybody and takes real sign-ups, and in the EU a fabricated
 * consumer review is not a grey area — the 2022 Omnibus Directive lists
 * commissioning or submitting fake reviews among the practices that are
 * unfair in all circumstances, with no balancing test. One sentence of
 * honesty costs this section very little and takes it out of that category
 * entirely.
 *
 * The quotes themselves do a job worth having even when they are labelled.
 * They are the only place on the page where the product is described from
 * the inside, in the words somebody would actually use, and they are
 * internally consistent on purpose: Kadri's parcel came from Yuki, and
 * Yuki's quote is about sending it. Read them as a worked example, which is
 * what the heading above them now says they are.
 *
 * DO NOT READ THE ATTRIBUTIONS AS A SPECIFICATION — the same warning as
 * `example-cards.tsx`, and the reader at risk is the next developer:
 *
 *  - "Kadri, Tallinn" shows a CITY. The product never does, to anybody but
 *    the owner of the account. `docs/07-trust-and-safety.md` is why: a city
 *    beside a name is often enough to find a real person. A real review
 *    carries a country at most.
 *
 *  - "helper, 12 deals" is a count nothing serves. A profile carries a
 *    rating and the number of reviews behind it (#83, #84), which is not the
 *    same figure and not this one.
 *
 * When there are real reviews, this section stops being markup and starts
 * reading the API — and then the heading is true, the line under it goes,
 * and the attributions have to change to match what the API actually gives.
 */
const VOICES = [
  {
    stars: 5,
    quote:
      "Yuki sent receipt photos and packed it really well. It arrived in Tallinn in 7 days.",
    who: "Kadri, Tallinn · needed from Japan",
  },
  {
    stars: 5,
    quote:
      "I pass these shops every day anyway. It’s nice to know someone in Estonia is happy because of it.",
    who: "Yuki, Tokyo · helper, 12 deals",
  },
  {
    stars: 5,
    quote:
      "Clear about postage from the start, and the history made everything easy to follow.",
    who: "Jonas, Berlin · needed from Japan",
  },
];

export function Testimonials() {
  return (
    <section className="bg-card">
      <div className="mx-auto max-w-column px-4 py-16 lg:py-20">
        <h2 className="font-serif text-page-title text-pine">
          From people who’ve done it
        </h2>

        {/*
          THE ONE SENTENCE THAT KEEPS THIS SECTION HONEST. Delete it and three
          invented quotes with names and star ratings become fake reviews on a
          live site — see the note at the top of this file for why that is a
          legal question in the EU and not only an editorial one.
        */}
        <p className="mt-3 max-w-[52ch] text-body text-muted">
          Farhand is new, so these are examples of what a finished deal sounds
          like rather than reviews somebody has left.
        </p>

        <ul className="mt-12 grid gap-6 sm:grid-cols-2 lg:mt-16 lg:grid-cols-3">
          {VOICES.map((voice) => (
            <li key={voice.who}>
              {/*
                The photograph's slot, empty exactly as the design leaves it.
                Whatever goes in here should be the parcel, the shop or the
                thing that travelled — not a face. A stock portrait under an
                invented name is the part of this section that would be hard
                to defend, and nothing on the page needs it.
              */}
              <div className="aspect-[5/4] w-full rounded-xl bg-cream" />

              {/*
                The rating is drawn rather than written, and said once for a
                screen reader instead of five times. `★★★★★` read aloud is
                "black star black star black star…".
              */}
              <p className="mt-5 text-caption tracking-[0.18em] text-pine">
                <span aria-hidden="true">{"★".repeat(voice.stars)}</span>
                <span className="sr-only">{voice.stars} out of 5</span>
              </p>

              <blockquote className="mt-3 font-serif text-[16px]/[23px] text-pine italic">
                “{voice.quote}”
              </blockquote>

              <p className="mt-5 text-body tracking-[0.02em] text-muted">
                {voice.who}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
