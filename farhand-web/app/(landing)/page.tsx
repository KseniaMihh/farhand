import type { Metadata } from "next";
import { ClosingCall } from "@/components/landing/closing-call";
import { GoodQuestions } from "@/components/landing/good-questions";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Testimonials } from "@/components/landing/testimonials";
import { TrustAndSafety } from "@/components/landing/trust-and-safety";
import { TwoWays } from "@/components/landing/two-ways";

/**
 * What Farhand is, for somebody who has never heard of it — issue #168.
 *
 * ALL SEVEN SECTIONS. The testimonials were cut in #168 and are back in
 * #172, which is a reversal with a condition attached. Three five-star
 * quotes with names, on a product nobody has used, are invented reviews
 * however they were meant — so they are shown as examples and say so, in a
 * line under the heading that `testimonials.tsx` explains and asks nobody to
 * delete. Labelled, the section earns its place: it is the only part of the
 * page that describes the product from the inside.
 *
 * Every other section is here, and every sentence in them was checked
 * against what the product does today rather than what it is planned to do.
 * Where the two differed the sentence changed, and each change is written
 * down where it was made: the city and the star in `example-cards.tsx`, the
 * three claims in `trust-and-safety.tsx`, and the dispute answer in
 * `good-questions.tsx`.
 */
export const metadata: Metadata = {
  title: "Farhand — the things you miss from abroad",
  description:
    "Ask someone who lives there to buy it and send it on. You agree the price between you; Farhand never touches the money.",
};

export default function LandingPage() {
  return (
    <>
      <Hero />
      <TwoWays />
      <HowItWorks />
      <TrustAndSafety />
      <Testimonials />
      <GoodQuestions />
      <ClosingCall />
    </>
  );
}
