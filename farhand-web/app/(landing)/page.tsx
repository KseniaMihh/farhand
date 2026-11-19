import type { Metadata } from "next";
import { ClosingCall } from "@/components/landing/closing-call";
import { GoodQuestions } from "@/components/landing/good-questions";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { TrustAndSafety } from "@/components/landing/trust-and-safety";
import { TwoWays } from "@/components/landing/two-ways";

/**
 * What Farhand is, for somebody who has never heard of it — issue #168.
 *
 * SIX SECTIONS, NOT THE DESIGN'S SEVEN. The testimonials are gone: "From
 * people who've done it", three five-star quotes with names, on a product
 * nobody has used yet. Invented reviews are fake reviews however they were
 * meant, and that section claimed the most while being able to support the
 * least. It comes back when there is somebody to quote.
 *
 * Every other section is here, and every sentence in them was checked
 * against what the product does today rather than what it is planned to do.
 * Where the two differed, the sentence changed — see the comments in
 * `trust-and-safety.tsx` and `good-questions.tsx`, which is where all of the
 * differences were.
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
      <GoodQuestions />
      <ClosingCall />
    </>
  );
}
